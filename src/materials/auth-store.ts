import type { Pool, PoolClient } from 'pg';
import { createId } from '@mio/foundation/identifiers';
import { MaterialError } from './contracts.ts';
import type { MaterialAuthRow } from './auth-contracts.ts';
import type { AccountCredentialSnapshot } from '../providers/contracts.ts';
import type { CredentialEnvelope } from '../providers/credentials.ts';

const clear = 'cipher_format=NULL,master_key_id=NULL,nonce=NULL,ciphertext=NULL,auth_tag=NULL';
const superseded = () => new MaterialError(409, 'MATERIAL_AUTH_SUPERSEDED');
/** Owns only auth session facts; shares its domain pool, never auth/provider pools. */
export class MaterialAuthStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof MaterialError) throw error;
      if ((error as { code?: string }).code === '23505')
        throw new MaterialError(409, 'UPSTREAM_RESOURCE_COLLISION');
      throw new MaterialError(503, 'MATERIAL_UNAVAILABLE');
    } finally {
      client.release();
    }
  }
  async expire(id?: string): Promise<void> {
    await this.pool.query(
      `UPDATE mio_material_auth_sessions SET state='expired',${clear},lease_id=NULL,lease_until=NULL,error_code='AUTH_EXPIRED',updated_at=now()
      WHERE id IN (SELECT id FROM mio_material_auth_sessions WHERE state NOT IN ('completed','expired') AND expires_at<=clock_timestamp() AND ($1::uuid IS NULL OR id=$1) ORDER BY expires_at,id LIMIT 100) AND state NOT IN ('completed','expired') AND expires_at<=clock_timestamp()`,
      [id ?? null],
    );
  }
  async get(id: string, owner?: string): Promise<MaterialAuthRow> {
    await this.expire(id);
    const row = (
      await this.pool.query<MaterialAuthRow>(
        `UPDATE mio_material_auth_sessions SET state='unknown',lease_id=NULL,lease_until=NULL,error_code='UPSTREAM_RESULT_UNKNOWN',updated_at=now()
      WHERE id=$1 AND ($2::text IS NULL OR owner_id=$2) AND state IN ('creating','verifying') AND lease_until<=clock_timestamp() RETURNING *`,
        [id, owner ?? null],
      )
    ).rows[0];
    if (row) return row;
    const stored = (
      await this.pool.query<MaterialAuthRow>(
        'SELECT * FROM mio_material_auth_sessions WHERE id=$1 AND ($2::text IS NULL OR owner_id=$2)',
        [id, owner ?? null],
      )
    ).rows[0];
    if (!stored) throw new MaterialError(404, 'MATERIAL_NOT_FOUND');
    return stored;
  }
  async previous(
    owner: string,
    request: string,
    inputHash: string,
  ): Promise<MaterialAuthRow | undefined> {
    const row = (
      await this.pool.query<MaterialAuthRow>(
        'SELECT * FROM mio_material_auth_sessions WHERE owner_id=$1 AND request_id=$2',
        [owner, request],
      )
    ).rows[0];
    if (row && row.input_hash !== inputHash) throw new MaterialError(409, 'IDEMPOTENCY_CONFLICT');
    return row ? this.get(row.id, owner) : undefined;
  }
  async begin(
    owner: string,
    request: string,
    inputHash: string,
    credential: AccountCredentialSnapshot,
  ): Promise<{ session: MaterialAuthRow; fresh: boolean }> {
    return this.transaction(async (client) => {
      const session = (
        await client.query<MaterialAuthRow>(
          `INSERT INTO mio_material_auth_sessions(id,owner_id,provider_type,provider_config_id,credential_version,request_id,input_hash,state,protocol_snapshot,return_target,lease_id,lease_until,expires_at)
        VALUES($1,$2,'onelink',$3,$4,$5,$6,'creating','{"version":1}','materials',$7,clock_timestamp()+interval '60 seconds',now()+interval '20 minutes')
        ON CONFLICT(owner_id,request_id) DO NOTHING RETURNING *`,
          [
            createId(),
            owner,
            credential.providerConfigId,
            credential.credentialVersion,
            request,
            inputHash,
            createId(),
          ],
        )
      ).rows[0];
      if (session) return { session, fresh: true };
      const old = (
        await client.query<MaterialAuthRow>(
          'SELECT * FROM mio_material_auth_sessions WHERE owner_id=$1 AND request_id=$2',
          [owner, request],
        )
      ).rows[0]!;
      if (old.input_hash !== inputHash) throw new MaterialError(409, 'IDEMPOTENCY_CONFLICT');
      return { session: old, fresh: false };
    });
  }
  async created(
    row: MaterialAuthRow,
    envelope: CredentialEnvelope,
    digest: string,
    requestId: string | null,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE mio_material_auth_sessions SET state='pending',cipher_format=$4,master_key_id=$5,nonce=$6,ciphertext=$7,auth_tag=$8,token_digest=$9,upstream_create_request_id=$11,lease_id=NULL,lease_until=NULL,error_code=NULL,updated_at=now()
      WHERE owner_id=$1 AND id=$2 AND lease_id=$3 AND state='creating' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() AND input_hash=$10`,
      [
        row.owner_id,
        row.id,
        row.lease_id,
        envelope.cipher_format,
        envelope.master_key_id,
        envelope.nonce,
        envelope.ciphertext,
        envelope.auth_tag,
        digest,
        row.input_hash,
        requestId,
      ],
    );
    if (result.rowCount !== 1) throw superseded();
  }
  async createFailed(
    row: MaterialAuthRow,
    uncertain: boolean,
    code: string,
    requestId: string | null,
    known?: { envelope: CredentialEnvelope; digest: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE mio_material_auth_sessions SET state=$4,error_code=$5,
      cipher_format=COALESCE($6,cipher_format),master_key_id=COALESCE($7,master_key_id),nonce=COALESCE($8,nonce),ciphertext=COALESCE($9,ciphertext),auth_tag=COALESCE($10,auth_tag),token_digest=COALESCE($11,token_digest),upstream_create_request_id=COALESCE($13,upstream_create_request_id),lease_id=NULL,lease_until=NULL,updated_at=now()
      WHERE owner_id=$1 AND id=$2 AND input_hash=$12 AND expires_at>clock_timestamp() AND ((state='creating' AND lease_id=$3) OR (state='unknown' AND lease_id IS NULL AND ciphertext IS NULL AND $9::bytea IS NOT NULL))`,
      [
        row.owner_id,
        row.id,
        row.lease_id,
        uncertain ? 'unknown' : 'failed',
        code,
        known?.envelope.cipher_format ?? null,
        known?.envelope.master_key_id ?? null,
        known?.envelope.nonce ?? null,
        known?.envelope.ciphertext ?? null,
        known?.envelope.auth_tag ?? null,
        known?.digest ?? null,
        row.input_hash,
        requestId,
      ],
    );
  }
  async claim(row: MaterialAuthRow): Promise<MaterialAuthRow | undefined> {
    return (
      await this.pool.query<MaterialAuthRow>(
        `UPDATE mio_material_auth_sessions SET state='verifying',lease_id=$3,lease_until=clock_timestamp()+interval '60 seconds',next_query_at=clock_timestamp()+interval '3 seconds',query_count=query_count+1,updated_at=now()
      WHERE owner_id=$1 AND id=$2 AND state IN ('pending','verifying','unknown') AND ciphertext IS NOT NULL AND expires_at>clock_timestamp() AND query_count<8
      AND (next_query_at IS NULL OR next_query_at<=clock_timestamp()) AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND token_digest=$4 RETURNING *`,
        [row.owner_id, row.id, createId(), row.token_digest],
      )
    ).rows[0];
  }
  async verificationFailed(
    row: MaterialAuthRow,
    code: string,
    resultRequestId: string | null,
    groupRequestId: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE mio_material_auth_sessions SET state='unknown',error_code=$4,lease_id=NULL,lease_until=NULL,updated_at=now(),
        upstream_result_request_id=COALESCE($5,upstream_result_request_id),upstream_group_request_id=COALESCE($6,upstream_group_request_id)
      WHERE owner_id=$1 AND id=$2 AND state='verifying' AND lease_id=$3 AND expires_at>clock_timestamp()`,
      [row.owner_id, row.id, row.lease_id, code, resultRequestId, groupRequestId],
    );
    await this.expire(row.id);
  }
  async complete(
    row: MaterialAuthRow,
    upstreamId: string,
    resultRequestId: string | null,
    groupRequestId: string | null,
  ): Promise<MaterialAuthRow> {
    return this.transaction(async (client) => {
      const current = (
        await client.query<MaterialAuthRow>(
          "SELECT * FROM mio_material_auth_sessions WHERE owner_id=$1 AND id=$2 AND state='verifying' AND lease_id=$3 AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() AND token_digest=$4 FOR UPDATE",
          [row.owner_id, row.id, row.lease_id, row.token_digest],
        )
      ).rows[0];
      if (!current) throw superseded();
      const groupId = createId();
      await client.query(
        `INSERT INTO mio_material_groups(id,owner_id,provider_type,provider_config_id,upstream_scope,upstream_group_id,group_type,name,auth_status,state,source_session_id)
        VALUES($1,$2,'onelink',$3,'onelink-volc-ark',$4,'real','真人素材','verified','ready',$5)`,
        [groupId, row.owner_id, row.provider_config_id, upstreamId, row.id],
      );
      const result = (
        await client.query<MaterialAuthRow>(
          `UPDATE mio_material_auth_sessions SET state='completed',group_id=$4,${clear},lease_id=NULL,lease_until=NULL,error_code=NULL,updated_at=now(),
            upstream_result_request_id=COALESCE($5,upstream_result_request_id),upstream_group_request_id=COALESCE($6,upstream_group_request_id)
        WHERE owner_id=$1 AND id=$2 AND state='verifying' AND lease_id=$3 AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() RETURNING *`,
          [row.owner_id, row.id, row.lease_id, groupId, resultRequestId, groupRequestId],
        )
      ).rows[0];
      if (!result) throw superseded();
      return result;
    });
  }
}
