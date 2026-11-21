import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { createId } from '@mio/foundation/identifiers';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { MATERIAL_SYNC_LEASE_EXPIRED, MaterialError, observedMaterialStatus } from './contracts.ts';
import type {
  CountedGroupRow,
  GroupRow,
  MaterialRow,
  OperationKind,
  OperationRow,
  UpstreamMaterial,
  MaterialSourceSnapshot,
} from './contracts.ts';
import type { AccountCredentialSnapshot } from '../providers/contracts.ts';
import { MaterialAuthStore } from './auth-store.ts';
import { checkMaterialAuthSchema } from './auth-schema.ts';
import { checkMaterialSchema } from './schema.ts';

const log = createLogger('app', 'material-store');
const missing = () => new MaterialError(HTTP_STATUS.NOT_FOUND, 'MATERIAL_NOT_FOUND');
const conflict = (code = 'REVISION_CONFLICT') => new MaterialError(HTTP_STATUS.CONFLICT, code);
const syncExpired = `(last_sync_status IS NOT DISTINCT FROM 'running' AND
  (sync_lease_until IS NULL OR sync_lease_until<=statement_timestamp())) AS sync_expired`;
const groupMaterialCount = `(SELECT count(*)::int FROM mio_materials m
  WHERE m.owner_id=g.owner_id AND m.group_id=g.id AND m.state<>'deleted') AS material_count`;
type Query = Pick<Pool, 'query'> | PoolClient;
export interface MaterialCursor {
  createdAt: string;
  id: string;
}

/** Short database transactions own every claim. No upstream request runs inside a transaction. */
export class MaterialStore {
  readonly authentication: MaterialAuthStore;
  private readonly pool: Pool;
  private readonly authCleanupTimer?: ReturnType<typeof setInterval>;
  private authCleanup: Promise<void> | undefined;

  constructor(pool: Pool, authentication: MaterialAuthStore, cleanupAuthSessions: boolean) {
    this.pool = pool;
    this.authentication = authentication;
    if (cleanupAuthSessions)
      this.authCleanupTimer = setInterval(() => {
        if (this.authCleanup) return;
        this.authCleanup = this.authentication
          .expire()
          .catch(() => log.error('MATERIAL_AUTH_EXPIRY_CLEANUP_FAILED'))
          .finally(() => {
            this.authCleanup = undefined;
          });
      }, 30_000).unref();
  }

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof MaterialError) throw error;
      if ((error as { code?: string }).code === '23505')
        throw conflict('UPSTREAM_RESOURCE_COLLISION');
      throw new MaterialError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MATERIAL_UNAVAILABLE');
    } finally {
      client.release();
    }
  }

  private async group(client: Query, owner: string, id: string, lock = false): Promise<GroupRow> {
    const row = (
      await client.query<GroupRow>(
        `SELECT *, ${syncExpired} FROM mio_material_groups WHERE owner_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [owner, id],
      )
    ).rows[0];
    if (!row) throw missing();
    return row;
  }

  private async material(
    client: Query,
    owner: string,
    id: string,
    lock = false,
  ): Promise<MaterialRow> {
    const row = (
      await client.query<MaterialRow>(
        `SELECT * FROM mio_materials WHERE owner_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
        [owner, id],
      )
    ).rows[0];
    if (!row) throw missing();
    return row;
  }

  async ownedGroup(owner: string, id: string): Promise<GroupRow> {
    const row = await this.group(this.pool, owner, id);
    if (row.state === 'deleted') throw missing();
    return row;
  }

  async ownedGroupSummary(owner: string, id: string): Promise<CountedGroupRow> {
    const row = (
      await this.pool.query<CountedGroupRow>(
        `SELECT g.*, ${syncExpired}, ${groupMaterialCount} FROM mio_material_groups g
         WHERE g.owner_id=$1 AND g.id=$2 AND g.state<>'deleted'`,
        [owner, id],
      )
    ).rows[0];
    if (!row) throw missing();
    return row;
  }

  async ownedMaterial(owner: string, id: string): Promise<MaterialRow> {
    const row = await this.material(this.pool, owner, id);
    if (row.state === 'deleted') throw missing();
    return row;
  }

  async groups(
    owner: string,
    type: string | undefined,
    limit: number,
    cursor?: MaterialCursor,
  ): Promise<CountedGroupRow[]> {
    return (
      await this.pool.query<CountedGroupRow>(
        `SELECT g.*, ${syncExpired}, to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time, ${groupMaterialCount}
      FROM mio_material_groups g WHERE g.owner_id=$1 AND g.state<>'deleted' AND ($2::text IS NULL OR g.group_type=$2)
      AND ($3::timestamptz IS NULL OR (g.created_at,g.id)<($3::timestamptz,$4::uuid))
      ORDER BY g.created_at DESC,g.id DESC LIMIT $5`,
        [owner, type ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      )
    ).rows;
  }

  async materials(
    owner: string,
    groupId: string,
    limit: number,
    cursor?: MaterialCursor,
  ): Promise<MaterialRow[]> {
    await this.ownedGroup(owner, groupId);
    return (
      await this.pool.query<MaterialRow>(
        `SELECT *, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM mio_materials WHERE owner_id=$1 AND group_id=$2 AND state<>'deleted'
      AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $5`,
        [owner, groupId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      )
    ).rows;
  }

  async operation(owner: string, id: string): Promise<OperationRow> {
    return this.transaction(async (client) => {
      const row = (
        await client.query<OperationRow>(
          'SELECT * FROM mio_material_operations WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [owner, id],
        )
      ).rows[0];
      if (!row) throw missing();
      if (
        ['creating', 'deleting'].includes(row.state) &&
        row.lease_until &&
        row.lease_until.getTime() <=
          Date.parse(
            (await client.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!
              .now,
          )
      ) {
        const updated = (
          await client.query<OperationRow>(
            "UPDATE mio_material_operations SET state='unknown',error_code='UPSTREAM_RESULT_UNKNOWN',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *",
            [id],
          )
        ).rows[0]!;
        if (row.target_material_id)
          await client.query(
            "UPDATE mio_materials SET state='unknown',error_code='UPSTREAM_RESULT_UNKNOWN',updated_at=now() WHERE owner_id=$1 AND id=$2 AND state IN ('registering','deleting')",
            [owner, row.target_material_id],
          );
        else if (row.target_group_id)
          await client.query(
            "UPDATE mio_material_groups SET state='unknown',updated_at=now() WHERE owner_id=$1 AND id=$2 AND state IN ('creating','deleting')",
            [owner, row.target_group_id],
          );
        return updated;
      }
      return row;
    });
  }

  async previous(
    owner: string,
    kind: OperationKind,
    requestId: string,
    inputHash: string,
  ): Promise<OperationRow | undefined> {
    const row = (
      await this.pool.query<OperationRow>(
        'SELECT * FROM mio_material_operations WHERE owner_id=$1 AND kind=$2 AND request_id=$3',
        [owner, kind, requestId],
      )
    ).rows[0];
    if (row && row.input_hash !== inputHash) throw conflict('IDEMPOTENCY_CONFLICT');
    return row;
  }

  async beginRegister(
    owner: string,
    requestId: string,
    inputHash: string,
    group: GroupRow,
    assetId: string,
    name: string,
    source: MaterialSourceSnapshot,
    credential: AccountCredentialSnapshot,
  ): Promise<{ operation: OperationRow; fresh: boolean }> {
    return this.transaction(async (client) => {
      const current = await this.group(client, owner, group.id, true);
      const previous = (
        await client.query<OperationRow>(
          "SELECT * FROM mio_material_operations WHERE owner_id=$1 AND kind='register_material' AND request_id=$2",
          [owner, requestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.input_hash !== inputHash) throw conflict('IDEMPOTENCY_CONFLICT');
        return { operation: previous, fresh: false };
      }
      this.assertMutable(current, group.revision);
      if (current.group_type === 'real' && current.auth_status !== 'verified')
        throw conflict('MATERIAL_GROUP_NOT_READY');
      await this.assertIdle(client, owner, current);
      const asset = await client.query(
        "SELECT 1 FROM mio_assets WHERE owner_id=$1 AND id=$2 AND state='ready' AND raw_key=$3 AND size_bytes=$4 AND content_type=$5 FOR SHARE",
        [owner, assetId, source.rawKey, source.size, source.contentType],
      );
      if (!asset.rowCount) throw conflict('ASSET_NOT_READY');
      const lease = createId();
      const op = (
        await client.query<OperationRow>(
          `INSERT INTO mio_material_operations(id,owner_id,request_id,kind,input_hash,state,provider_config_id,credential_version,protocol_snapshot,lease_id,lease_until)
        VALUES($1,$2,$3,'register_material',$4,'creating',$5,$6,$7,$8,clock_timestamp()+interval '75 seconds')
        ON CONFLICT(owner_id,kind,request_id) DO NOTHING RETURNING *`,
          [
            createId(),
            owner,
            requestId,
            inputHash,
            credential.providerConfigId,
            credential.credentialVersion,
            { version: 1, upstreamGroupId: current.upstream_group_id },
            lease,
          ],
        )
      ).rows[0];
      if (!op) {
        const old = (
          await client.query<OperationRow>(
            "SELECT * FROM mio_material_operations WHERE owner_id=$1 AND kind='register_material' AND request_id=$2",
            [owner, requestId],
          )
        ).rows[0]!;
        if (old.input_hash !== inputHash) throw conflict('IDEMPOTENCY_CONFLICT');
        return { operation: old, fresh: false };
      }
      const id = createId();
      await client.query(
        `INSERT INTO mio_materials(id,owner_id,provider_type,group_id,source_asset_id,asset_type,name,state,raw_snapshot,registration_credential_version)
        VALUES($1,$2,'onelink',$3,$4,'image',$5,'registering',$6,$7)`,
        [id, owner, current.id, assetId, name, source, credential.credentialVersion],
      );
      await this.claimGroupLease(client, owner, current.id, lease, 75);
      return {
        operation: (
          await client.query<OperationRow>(
            'UPDATE mio_material_operations SET target_group_id=$2,target_material_id=$3 WHERE id=$1 RETURNING *',
            [op.id, current.id, id],
          )
        ).rows[0]!,
        fresh: true,
      };
    });
  }

  async finishRegister(
    owner: string,
    op: OperationRow,
    id: string,
    requestId: string | null,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.group(client, owner, op.target_group_id!, true);
      const group = await client.query(
        "SELECT 1 FROM mio_material_groups WHERE owner_id=$1 AND id=$2 AND state='ready' AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp() AND upstream_group_id=$4",
        [owner, op.target_group_id, op.lease_id, op.protocol_snapshot.upstreamGroupId],
      );
      if (!group.rowCount) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const claim = await client.query(
        "SELECT 1 FROM mio_material_operations WHERE owner_id=$1 AND id=$2 AND lease_id=$3 AND state='creating' AND input_hash=$4 AND lease_until>clock_timestamp() FOR UPDATE",
        [owner, op.id, op.lease_id, op.input_hash],
      );
      if (!claim.rowCount) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const entity = await client.query(
        "UPDATE mio_materials SET upstream_asset_id=$3,state='processing',next_query_at=now()+interval '4 seconds',updated_at=now() WHERE owner_id=$1 AND id=$2 AND state='registering' AND group_id=$4",
        [owner, op.target_material_id, id, op.target_group_id],
      );
      if (entity.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const closed = await client.query(
        "UPDATE mio_material_operations SET state='succeeded',result_local_id=target_material_id,upstream_request_id=$5,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND lease_id=$3 AND input_hash=$4 AND lease_until>clock_timestamp()",
        [owner, op.id, op.lease_id, op.input_hash, requestId],
      );
      if (closed.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const released = await client.query(
        'UPDATE mio_material_groups SET sync_lease_id=NULL,sync_lease_until=NULL WHERE owner_id=$1 AND id=$2 AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp()',
        [owner, op.target_group_id, op.lease_id],
      );
      if (released.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
    });
  }

  async beginCreate(
    owner: string,
    requestId: string,
    inputHash: string,
    name: string,
    credential: AccountCredentialSnapshot,
  ): Promise<{ operation: OperationRow; fresh: boolean }> {
    return this.transaction(async (client) => {
      const op = (
        await client.query<OperationRow>(
          `INSERT INTO mio_material_operations(id,owner_id,request_id,kind,input_hash,state,provider_config_id,credential_version,protocol_snapshot,lease_id,lease_until)
        VALUES($1,$2,$3,'create_group',$4,'creating',$5,$6,'{"version":1}',$7,clock_timestamp()+interval '75 seconds')
        ON CONFLICT(owner_id,kind,request_id) DO NOTHING RETURNING *`,
          [
            createId(),
            owner,
            requestId,
            inputHash,
            credential.providerConfigId,
            credential.credentialVersion,
            createId(),
          ],
        )
      ).rows[0];
      if (!op) {
        const old = (
          await client.query<OperationRow>(
            "SELECT * FROM mio_material_operations WHERE owner_id=$1 AND kind='create_group' AND request_id=$2",
            [owner, requestId],
          )
        ).rows[0]!;
        if (old.input_hash !== inputHash) throw conflict('IDEMPOTENCY_CONFLICT');
        return { operation: old, fresh: false };
      }
      const groupId = createId();
      await client.query(
        `INSERT INTO mio_material_groups(id,owner_id,provider_type,provider_config_id,upstream_scope,group_type,name,auth_status,state)
        VALUES($1,$2,'onelink',$3,'onelink-volc-ark','aigc',$4,'not_applicable','creating')`,
        [groupId, owner, credential.providerConfigId, name],
      );
      return {
        operation: (
          await client.query<OperationRow>(
            'UPDATE mio_material_operations SET target_group_id=$2 WHERE id=$1 RETURNING *',
            [op.id, groupId],
          )
        ).rows[0]!,
        fresh: true,
      };
    });
  }

  async finishCreate(
    owner: string,
    operation: OperationRow,
    upstreamId: string,
    requestId: string | null,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const claim = (
        await client.query<OperationRow>(
          "SELECT * FROM mio_material_operations WHERE owner_id=$1 AND id=$2 AND state='creating' AND lease_id=$3 AND lease_until>clock_timestamp() AND input_hash=$4 FOR UPDATE",
          [owner, operation.id, operation.lease_id, operation.input_hash],
        )
      ).rows[0];
      if (!claim) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const saved = await client.query(
        "UPDATE mio_material_groups SET upstream_group_id=$3,state='ready',updated_at=now() WHERE owner_id=$1 AND id=$2 AND state='creating'",
        [owner, operation.target_group_id, upstreamId],
      );
      if (saved.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const closed = await client.query(
        "UPDATE mio_material_operations SET state='succeeded',result_local_id=target_group_id,upstream_request_id=$2,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE owner_id=$1 AND id=$3 AND lease_id=$4 AND input_hash=$5 AND lease_until>clock_timestamp()",
        [owner, requestId, operation.id, operation.lease_id, operation.input_hash],
      );
      if (closed.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
    });
  }

  async failOperation(
    owner: string,
    operation: OperationRow,
    uncertain: boolean,
    code: string,
    knownCreate?: { id: string; requestId: string | null },
  ): Promise<void> {
    await this.transaction(async (client) => {
      const row = (
        await client.query<OperationRow>(
          `UPDATE mio_material_operations SET state=$4,error_code=$5,lease_id=NULL,lease_until=NULL,updated_at=now(),
          protocol_snapshot=CASE WHEN kind IN ('create_group','register_material') AND $6::text IS NOT NULL THEN protocol_snapshot || jsonb_build_object('upstreamId',$6::text) ELSE protocol_snapshot END,
          upstream_request_id=CASE WHEN kind IN ('create_group','register_material') AND $6::text IS NOT NULL THEN $7 ELSE upstream_request_id END
        WHERE owner_id=$1 AND id=$2 AND input_hash=$8 AND ((lease_id=$3 AND state IN ('creating','deleting')) OR
          (kind IN ('create_group','register_material') AND state='unknown' AND lease_id IS NULL AND protocol_snapshot->>'upstreamId' IS NULL AND $6::text IS NOT NULL)) RETURNING *`,
          [
            owner,
            operation.id,
            operation.lease_id,
            uncertain ? 'unknown' : 'failed',
            code,
            knownCreate?.id ?? null,
            knownCreate?.requestId ?? null,
            operation.input_hash,
          ],
        )
      ).rows[0];
      if (!row) return;
      if (row.target_material_id)
        await client.query(
          "UPDATE mio_materials SET state=$3,error_code=$4,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND state IN ('registering','deleting')",
          [
            owner,
            row.target_material_id,
            uncertain ? 'unknown' : (row.protocol_snapshot.previousState ?? 'failed'),
            code,
          ],
        );
      if (row.kind === 'register_material')
        await client.query(
          'UPDATE mio_material_groups SET sync_lease_id=NULL,sync_lease_until=NULL WHERE owner_id=$1 AND id=$2 AND sync_lease_id=$3',
          [owner, row.target_group_id, operation.lease_id],
        );
      else if (row.target_group_id)
        await client.query(
          "UPDATE mio_material_groups SET state=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND state IN ('creating','deleting')",
          [
            owner,
            row.target_group_id,
            uncertain ? 'unknown' : row.kind === 'delete_group_upstream' ? 'ready' : 'failed',
          ],
        );
    });
  }

  private assertMutable(row: GroupRow, expected?: number) {
    if (expected !== undefined && row.revision !== expected) throw conflict();
    if (row.state !== 'ready' || !row.upstream_group_id) throw conflict('MATERIAL_GROUP_NOT_READY');
  }

  private async claimGroupLease(
    client: PoolClient,
    owner: string,
    id: string,
    lease: string,
    seconds: number,
    cursor?: string | null,
  ): Promise<void> {
    // The prior holder is inactive. Settle its expired sync before replacing its deadline.
    const claim = await client.query(
      `UPDATE mio_material_groups SET sync_lease_id=$3,sync_lease_until=clock_timestamp()+($4::integer*interval '1 second'),
      sync_cursor=COALESCE($5::text,sync_cursor),
      last_sync_attempt_at=CASE WHEN $5 IS NOT NULL THEN now() ELSE last_sync_attempt_at END,
      last_sync_status=CASE WHEN $5 IS NOT NULL THEN 'running' WHEN last_sync_status='running' THEN 'failed' ELSE last_sync_status END,
      last_sync_error_code=CASE WHEN $5 IS NOT NULL THEN NULL WHEN last_sync_status='running' THEN $6 ELSE last_sync_error_code END
      WHERE owner_id=$1 AND id=$2 AND (sync_lease_until IS NULL OR sync_lease_until<=clock_timestamp())`,
      [owner, id, lease, seconds, cursor ?? null, MATERIAL_SYNC_LEASE_EXPIRED],
    );
    if (claim.rowCount !== 1) throw conflict('MATERIAL_BUSY');
  }

  async claimGroup(
    owner: string,
    id: string,
    revision: number | undefined,
    cursor?: string | null,
  ): Promise<{ group: GroupRow; lease: string }> {
    return this.transaction(async (client) => {
      const row = await this.group(client, owner, id, true);
      this.assertMutable(row, revision);
      const registration = await client.query(
        "SELECT 1 FROM mio_material_operations WHERE owner_id=$1 AND target_group_id=$2 AND kind='register_material' AND state IN ('creating','unknown') LIMIT 1",
        [owner, id],
      );
      if (registration.rowCount) throw conflict('MATERIAL_BUSY');
      const lease = createId();
      await this.claimGroupLease(client, owner, id, lease, 60, cursor);
      return { group: row, lease };
    });
  }

  async rename(owner: string, id: string, lease: string, name: string): Promise<GroupRow> {
    const row = (
      await this.pool.query<GroupRow>(
        `UPDATE mio_material_groups SET name=$4,revision=revision+1,sync_lease_id=NULL,sync_lease_until=NULL,
      updated_at=now() WHERE owner_id=$1 AND id=$2 AND state='ready' AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp() RETURNING *`,
        [owner, id, lease, name],
      )
    ).rows[0];
    if (!row) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
    return row;
  }

  async releaseGroup(owner: string, id: string, lease: string, syncError?: string): Promise<void> {
    await this.pool.query(
      `UPDATE mio_material_groups SET sync_lease_id=NULL,sync_lease_until=NULL,
      last_sync_status=CASE WHEN $4::text IS NOT NULL THEN 'failed' ELSE last_sync_status END,
      last_sync_error_code=COALESCE($4,last_sync_error_code)
      WHERE owner_id=$1 AND id=$2 AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp() AND state='ready'`,
      [owner, id, lease, syncError ?? null],
    );
  }

  async applySync(
    owner: string,
    group: GroupRow,
    lease: string,
    items: UpstreamMaterial[],
    next: string | null,
    credentialVersion: number,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const current = await client.query(
        `SELECT 1 FROM mio_material_groups WHERE owner_id=$1 AND id=$2 AND provider_type='onelink'
         AND upstream_group_id=$4 AND state='ready' AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp()
         FOR UPDATE`,
        [owner, group.id, lease, group.upstream_group_id],
      );
      if (!current.rowCount) throw conflict('MATERIAL_OPERATION_SUPERSEDED');

      const page = items.map((item) => {
        if (item.groupId !== group.upstream_group_id) throw conflict('UPSTREAM_RESPONSE_INVALID');
        const observation = observedMaterialStatus(item.status);
        return {
          id: createId(),
          upstream_id: item.id,
          name: item.name,
          state: observation.state,
          upstream_status: item.status,
          error_code: observation.errorCode,
        };
      });
      if (page.length) {
        // The UPDATE and INSERT use one snapshot and act on disjoint identities. Only in-scope
        // rows suppress INSERT, so the global upstream index still rejects cross-scope collisions.
        await client.query(
          `WITH page AS MATERIALIZED (
             SELECT * FROM jsonb_to_recordset($3::jsonb)
             AS item(id uuid, upstream_id text, name text, state text, upstream_status text, error_code text)
           ), updated AS (
             UPDATE mio_materials m SET name=p.name,state=p.state,upstream_status=p.upstream_status,
               last_synced_at=now(),revision=m.revision+1,error_code=p.error_code,updated_at=now()
             FROM page p
             WHERE m.owner_id=$1 AND m.group_id=$2 AND m.provider_type='onelink'
               AND m.upstream_asset_id=p.upstream_id AND m.state NOT IN ('deleted','deleting','registering')
               AND NOT EXISTS (
                 SELECT 1 FROM mio_material_operations o
                 WHERE o.owner_id=m.owner_id AND o.target_material_id=m.id AND o.state IN ('creating','deleting','unknown')
               )
           )
           INSERT INTO mio_materials(id,owner_id,provider_type,group_id,upstream_asset_id,asset_type,
             name,state,upstream_status,registration_credential_version,last_synced_at,error_code)
           SELECT p.id,$1,'onelink',$2,p.upstream_id,'image',p.name,p.state,p.upstream_status,$4,now(),p.error_code
           FROM page p WHERE NOT EXISTS (
             SELECT 1 FROM mio_materials m
             WHERE m.owner_id=$1 AND m.group_id=$2 AND m.provider_type='onelink' AND m.upstream_asset_id=p.upstream_id
           ) ORDER BY p.upstream_id`,
          [owner, group.id, JSON.stringify(page), credentialVersion],
        );
      }
      const saved = await client.query(
        `UPDATE mio_material_groups SET sync_cursor=$4,sync_lease_id=NULL,sync_lease_until=NULL,last_sync_status='succeeded',
         last_sync_error_code=NULL,last_synced_at=now(),updated_at=now()
         WHERE owner_id=$1 AND id=$2 AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp() AND state='ready'`,
        [owner, group.id, lease, next],
      );
      if (saved.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
    });
  }

  async removeLocal(
    owner: string,
    kind: 'group' | 'material',
    id: string,
    revision: number,
  ): Promise<GroupRow | MaterialRow> {
    return this.transaction(async (client) => {
      const material = kind === 'material' ? await this.material(client, owner, id) : undefined;
      const group = await this.group(client, owner, material?.group_id ?? id, true);
      const row = material ? await this.material(client, owner, id, true) : group;
      if (row.state === 'deleted') return row;
      if (row.revision !== revision) throw conflict();
      if (['creating', 'registering', 'deleting'].includes(row.state))
        throw conflict('MATERIAL_BUSY');
      await this.assertIdle(client, owner, group, material?.id);
      if (kind === 'group') await this.assertEmpty(client, owner, id);
      const table = kind === 'group' ? 'mio_material_groups' : 'mio_materials';
      return (
        await client.query<GroupRow | MaterialRow>(
          `UPDATE ${table} SET state='deleted',revision=revision+1,deleted_at=now(),updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *`,
          [owner, id],
        )
      ).rows[0]!;
    });
  }

  private async assertIdle(
    client: PoolClient,
    owner: string,
    group: GroupRow,
    materialId?: string,
    exceptOperation?: string,
  ) {
    const busy = await client.query(
      `SELECT 1 FROM mio_material_groups WHERE owner_id=$1 AND id=$2 AND sync_lease_until>clock_timestamp()`,
      [owner, group.id],
    );
    if (busy.rowCount) throw conflict('MATERIAL_BUSY');
    const operation = await client.query(
      `SELECT 1 FROM mio_material_operations WHERE owner_id=$1 AND target_group_id=$2
      AND ($3::uuid IS NULL OR target_material_id=$3) AND ($4::uuid IS NULL OR id<>$4)
      AND state IN ('creating','deleting','unknown') LIMIT 1`,
      [owner, group.id, materialId ?? null, exceptOperation ?? null],
    );
    if (operation.rowCount) throw conflict('MATERIAL_BUSY');
  }

  private async assertEmpty(client: PoolClient, owner: string, id: string) {
    if (
      (
        await client.query(
          "SELECT 1 FROM mio_materials WHERE owner_id=$1 AND group_id=$2 AND state<>'deleted' LIMIT 1",
          [owner, id],
        )
      ).rowCount
    )
      throw conflict('RESOURCE_IN_USE');
  }

  async precheckGroupDelete(owner: string, id: string, revision: number, confirmCascade: boolean) {
    return this.transaction(async (client) => {
      const group = await this.group(client, owner, id, true);
      this.assertMutable(group, revision);
      await this.assertIdle(client, owner, group);
      if (!confirmCascade) await this.assertEmpty(client, owner, id);
      return { upstreamId: group.upstream_group_id!, providerConfigId: group.provider_config_id };
    });
  }

  async beginDelete(
    owner: string,
    requestId: string,
    hash: string,
    kind: 'group' | 'material',
    id: string,
    revision: number,
    credential: AccountCredentialSnapshot,
    groupCheck?: { upstreamId: string; confirmCascade: boolean },
  ): Promise<{ operation: OperationRow; fresh: boolean }> {
    return this.transaction(async (client) => {
      const opKind: OperationKind =
        kind === 'group' ? 'delete_group_upstream' : 'delete_material_upstream';
      const op = (
        await client.query<OperationRow>(
          `INSERT INTO mio_material_operations(id,owner_id,request_id,kind,input_hash,state,provider_config_id,credential_version,protocol_snapshot,lease_id,lease_until)
        VALUES($1,$2,$3,$4,$5,'deleting',$6,$7,'{"version":1}',$8,clock_timestamp()+interval '75 seconds')
        ON CONFLICT(owner_id,kind,request_id) DO NOTHING RETURNING *`,
          [
            createId(),
            owner,
            requestId,
            opKind,
            hash,
            credential.providerConfigId,
            credential.credentialVersion,
            createId(),
          ],
        )
      ).rows[0];
      if (!op) {
        const old = (
          await client.query<OperationRow>(
            'SELECT * FROM mio_material_operations WHERE owner_id=$1 AND kind=$2 AND request_id=$3',
            [owner, opKind, requestId],
          )
        ).rows[0]!;
        if (old.input_hash !== hash) throw conflict('IDEMPOTENCY_CONFLICT');
        return { operation: old, fresh: false };
      }
      const material = kind === 'material' ? await this.material(client, owner, id) : undefined;
      const group = await this.group(client, owner, material?.group_id ?? id, true);
      this.assertMutable(group);
      const row = material ? await this.material(client, owner, id, true) : group;
      if (row.revision !== revision) throw conflict();
      if (['deleted', 'deleting', 'registering'].includes(row.state))
        throw conflict('MATERIAL_BUSY');
      await this.assertIdle(client, owner, group, material?.id, op.id);
      const confirmed = kind === 'group' && groupCheck?.confirmCascade === true;
      if (kind === 'group' && !confirmed) await this.assertEmpty(client, owner, id);
      const upstreamId = material ? material.upstream_asset_id : group.upstream_group_id;
      if (!upstreamId) throw conflict('MATERIAL_GROUP_NOT_READY');
      if (groupCheck && upstreamId !== groupCheck.upstreamId)
        throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      if (confirmed && group.provider_config_id !== credential.providerConfigId)
        throw conflict('PROVIDER_UNAVAILABLE');
      const table = kind === 'group' ? 'mio_material_groups' : 'mio_materials';
      await client.query(
        `UPDATE ${table} SET state='deleting',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2`,
        [owner, id],
      );
      const updated = (
        await client.query<OperationRow>(
          `UPDATE mio_material_operations SET target_group_id=$2,target_material_id=$3,protocol_snapshot=$4 WHERE id=$1 RETURNING *`,
          [
            op.id,
            group.id,
            material?.id ?? null,
            {
              version: 1,
              upstreamId,
              previousState: row.state,
              ...(confirmed ? { confirmCascade: true } : {}),
            },
          ],
        )
      ).rows[0]!;
      return { operation: updated, fresh: true };
    });
  }

  private async tombstoneGroup(
    client: PoolClient,
    op: OperationRow,
    states: GroupRow['state'][],
  ): Promise<void> {
    const { owner_id: owner, target_group_id: id, protocol_snapshot: snapshot } = op;
    const confirmed = snapshot.confirmCascade === true;
    const saved = await client.query(
      `UPDATE mio_material_groups SET state='deleted',deleted_at=now(),revision=revision+1,updated_at=now()
       WHERE owner_id=$1 AND id=$2 AND state=ANY($3::text[]) AND upstream_group_id=$4
       AND ($5::uuid IS NULL OR provider_config_id=$5)`,
      [owner, id, states, snapshot.upstreamId, confirmed ? op.provider_config_id : null],
    );
    if (saved.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
    if (confirmed)
      await client.query(
        `UPDATE mio_materials SET state='deleted',deleted_at=now(),revision=revision+1,updated_at=now()
         WHERE owner_id=$1 AND group_id=$2 AND state<>'deleted'`,
        [owner, id],
      );
    else await this.assertEmpty(client, owner, id!);
  }

  async finishDelete(
    owner: string,
    op: OperationRow,
    requestId: string | null = null,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const claim = (
        await client.query<OperationRow>(
          "SELECT * FROM mio_material_operations WHERE owner_id=$1 AND id=$2 AND state='deleting' AND lease_id=$3 AND lease_until>clock_timestamp() AND input_hash=$4 FOR UPDATE",
          [owner, op.id, op.lease_id, op.input_hash],
        )
      ).rows[0];
      if (!claim) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const id = claim.target_material_id ?? claim.target_group_id;
      if (claim.kind === 'delete_group_upstream')
        await this.tombstoneGroup(client, claim, ['deleting']);
      else {
        const saved = await client.query(
          "UPDATE mio_materials SET state='deleted',deleted_at=now(),revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND state='deleting'",
          [owner, id],
        );
        if (saved.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      }
      const closed = await client.query(
        "UPDATE mio_material_operations SET state='succeeded',result_local_id=$2,upstream_request_id=$6,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE owner_id=$1 AND id=$3 AND lease_id=$4 AND input_hash=$5 AND lease_until>clock_timestamp()",
        [owner, id, op.id, op.lease_id, op.input_hash, requestId],
      );
      if (closed.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
    });
  }

  async claimRefresh(
    owner: string,
    id: string,
    groupId: string,
    lease: string,
  ): Promise<MaterialRow> {
    return this.transaction(async (client) => {
      await this.group(client, owner, groupId, true);
      const group = await client.query(
        "SELECT 1 FROM mio_material_groups WHERE owner_id=$1 AND id=$2 AND state='ready' AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp()",
        [owner, groupId, lease],
      );
      if (!group.rowCount) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const row = await this.material(client, owner, id, true);
      if (row.group_id !== groupId || ['deleted', 'deleting', 'registering'].includes(row.state))
        throw conflict('MATERIAL_BUSY');
      const pending = await client.query(
        "SELECT 1 FROM mio_material_operations WHERE owner_id=$1 AND target_material_id=$2 AND state IN ('creating','deleting','unknown') LIMIT 1",
        [owner, id],
      );
      if (pending.rowCount) throw conflict('MATERIAL_BUSY');
      const limited = await client.query(
        'SELECT 1 FROM mio_materials WHERE owner_id=$1 AND id=$2 AND next_query_at>now()',
        [owner, id],
      );
      if (limited.rowCount) throw new MaterialError(429, 'MATERIAL_QUERY_LIMITED');
      return (
        await client.query<MaterialRow>(
          "UPDATE mio_materials SET next_query_at=now()+interval '4 seconds' WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, id],
        )
      ).rows[0]!;
    });
  }

  async applyRefresh(
    owner: string,
    material: MaterialRow,
    group: GroupRow,
    lease: string,
    item: UpstreamMaterial | null,
  ): Promise<MaterialRow> {
    return this.transaction(async (client) => {
      const current = await this.group(client, owner, group.id, true);
      const valid = await client.query(
        "SELECT 1 FROM mio_material_groups WHERE owner_id=$1 AND id=$2 AND state='ready' AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp()",
        [owner, group.id, lease],
      );
      if (!valid.rowCount || current.upstream_group_id !== group.upstream_group_id)
        throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const row = await this.material(client, owner, material.id, true);
      if (
        row.revision !== material.revision ||
        ['deleted', 'deleting', 'registering'].includes(row.state)
      )
        throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const pending = await client.query(
        "SELECT 1 FROM mio_material_operations WHERE owner_id=$1 AND target_material_id=$2 AND state IN ('creating','deleting','unknown') LIMIT 1",
        [owner, material.id],
      );
      if (pending.rowCount) throw conflict('MATERIAL_BUSY');
      if (item && (item.id !== row.upstream_asset_id || item.groupId !== group.upstream_group_id))
        throw conflict('UPSTREAM_RESPONSE_INVALID');
      const observation = item
        ? observedMaterialStatus(item.status)
        : { state: 'deleted', errorCode: 'UPSTREAM_RESOURCE_NOT_FOUND' };
      const saved = (
        await client.query<MaterialRow>(
          `UPDATE mio_materials SET state=$3,name=$4,upstream_status=$5,error_code=$6,last_synced_at=now(),revision=revision+1,
        deleted_at=CASE WHEN $3='deleted' THEN now() ELSE deleted_at END,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *`,
          [
            owner,
            row.id,
            observation.state,
            item?.name ?? row.name,
            item?.status ?? null,
            observation.errorCode,
          ],
        )
      ).rows[0]!;
      const released = await client.query(
        "UPDATE mio_material_groups SET sync_lease_id=NULL,sync_lease_until=NULL WHERE owner_id=$1 AND id=$2 AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp() AND state='ready'",
        [owner, group.id, lease],
      );
      if (released.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      return saved;
    });
  }

  async claimRecovery(owner: string, id: string): Promise<OperationRow | undefined> {
    return this.transaction(async (client) => {
      const existing = (
        await client.query<OperationRow>(
          'SELECT * FROM mio_material_operations WHERE owner_id=$1 AND id=$2',
          [owner, id],
        )
      ).rows[0];
      if (!existing?.target_group_id) return;
      const group = await this.group(client, owner, existing.target_group_id, true);
      if (
        existing.kind === 'delete_group_upstream' &&
        (group.upstream_group_id !== existing.protocol_snapshot.upstreamId ||
          (existing.protocol_snapshot.confirmCascade === true &&
            group.provider_config_id !== existing.provider_config_id))
      )
        return;
      const busy = await client.query(
        'SELECT 1 FROM mio_material_groups WHERE owner_id=$1 AND id=$2 AND sync_lease_until>clock_timestamp()',
        [owner, existing.target_group_id],
      );
      if (busy.rowCount) return;
      const lease = createId();
      const claim = (
        await client.query<OperationRow>(
          `UPDATE mio_material_operations SET lease_id=$3,lease_until=clock_timestamp()+interval '60 seconds',next_query_at=now()+interval '5 seconds'
        WHERE owner_id=$1 AND id=$2 AND state='unknown' AND kind IN ('create_group','register_material','delete_material_upstream','delete_group_upstream')
        AND (kind NOT IN ('create_group','register_material') OR protocol_snapshot->>'upstreamId' IS NOT NULL)
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND (next_query_at IS NULL OR next_query_at<=now()) RETURNING *`,
          [owner, id, lease],
        )
      ).rows[0];
      if (!claim) return;
      await this.claimGroupLease(client, owner, existing.target_group_id, lease, 60);
      return claim;
    });
  }

  async finishRecovery(
    owner: string,
    op: OperationRow,
    confirmed: boolean,
    code: string | null,
    material?: UpstreamMaterial,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.group(client, owner, op.target_group_id!, true);
      const group = await client.query(
        'SELECT 1 FROM mio_material_groups WHERE owner_id=$1 AND id=$2 AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp()',
        [owner, op.target_group_id, op.lease_id],
      );
      if (!group.rowCount) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      const current = (
        await client.query<OperationRow>(
          "SELECT * FROM mio_material_operations WHERE owner_id=$1 AND id=$2 AND state='unknown' AND lease_id=$3 AND lease_until>clock_timestamp() AND input_hash=$4 FOR UPDATE",
          [owner, op.id, op.lease_id, op.input_hash],
        )
      ).rows[0];
      if (!current) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
      if (
        confirmed &&
        op.kind === 'register_material' &&
        (!material ||
          material.id !== current.protocol_snapshot.upstreamId ||
          material.groupId !== current.protocol_snapshot.upstreamGroupId)
      )
        throw conflict('UPSTREAM_RESPONSE_INVALID');
      if (confirmed) {
        const id = current.target_material_id ?? current.target_group_id;
        const observation = material ? observedMaterialStatus(material.status) : undefined;
        if (current.kind === 'delete_group_upstream')
          await this.tombstoneGroup(client, current, ['unknown', 'deleting']);
        else {
          const saved =
            current.kind === 'register_material'
              ? await client.query(
                  "UPDATE mio_materials SET state=$5,upstream_asset_id=$3,upstream_status=$6,last_synced_at=now(),error_code=$7,next_query_at=now()+interval '4 seconds',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND state='unknown' AND upstream_asset_id IS NULL AND group_id=$4",
                  [
                    owner,
                    id,
                    current.protocol_snapshot.upstreamId,
                    op.target_group_id,
                    observation!.state,
                    material!.status,
                    observation!.errorCode,
                  ],
                )
              : current.kind === 'create_group'
                ? await client.query(
                    "UPDATE mio_material_groups SET state='ready',upstream_group_id=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND state='unknown' AND upstream_group_id IS NULL",
                    [owner, id, current.protocol_snapshot.upstreamId],
                  )
                : await client.query(
                    "UPDATE mio_materials SET state='deleted',deleted_at=now(),revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2 AND state IN ('unknown','deleting')",
                    [owner, id],
                  );
          if (saved.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
        }
        await client.query(
          "UPDATE mio_material_operations SET state='succeeded',error_code=NULL,result_local_id=$4,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND lease_id=$3",
          [owner, op.id, op.lease_id, id],
        );
      } else
        await client.query(
          'UPDATE mio_material_operations SET error_code=$4,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2 AND lease_id=$3',
          [owner, op.id, op.lease_id, code ?? 'UPSTREAM_RESULT_UNKNOWN'],
        );
      const released = await client.query(
        'UPDATE mio_material_groups SET sync_lease_id=NULL,sync_lease_until=NULL WHERE owner_id=$1 AND id=$2 AND sync_lease_id=$3 AND sync_lease_until>clock_timestamp()',
        [owner, op.target_group_id, op.lease_id],
      );
      if (released.rowCount !== 1) throw conflict('MATERIAL_OPERATION_SUPERSEDED');
    });
  }

  async close(): Promise<void> {
    clearInterval(this.authCleanupTimer);
    await this.authCleanup;
    await this.pool.end();
  }
}

export async function createMaterialStore(
  databaseURL: string,
  requireAuthentication = false,
): Promise<MaterialStore> {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: 'mio-materials',
  });
  pool.on('error', () => log.error('MATERIAL_DATABASE_CONNECTION_ERROR'));
  try {
    await checkMaterialSchema(pool);
    if (requireAuthentication) await checkMaterialAuthSchema(pool);
    const hasAuthSessions =
      requireAuthentication ||
      (
        await pool.query<{ present: boolean }>(
          "SELECT to_regclass('mio_material_auth_sessions') IS NOT NULL AS present",
        )
      ).rows[0]!.present;
    const authentication = new MaterialAuthStore(pool);
    if (hasAuthSessions) await authentication.expire();
    return new MaterialStore(pool, authentication, hasAuthSessions);
  } catch {
    await pool.end();
    throw new Error('MATERIAL_SCHEMA: run materials:migrate and check database access');
  }
}
