import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { checkConversationSchema } from './schema.ts';
import { ConversationError } from './contracts.ts';
import type {
  Conversation,
  Principal,
  Receipt,
  RequestStatus,
  ModelObservation,
} from './contracts.ts';
import type { ChatSelection, ChatRuntimeSnapshot } from '../providers/contracts.ts';
import { legacyReference } from '../providers/catalog.ts';

const log = createLogger('app', 'conversation-store');

export interface ConversationRow {
  id: string;
  owner_id: string;
  dsh_session_id: string;
  created_at: Date;
  state: Conversation['state'];
  active_request: string | null;
  model_binding: ChatSelection | null;
}
interface RequestRow {
  conversation_id: string;
  request_id: string;
  digest: string;
  status: RequestStatus;
  error_code: string | null;
}
const receipt = (row: RequestRow): Receipt => ({
  conversationId: row.conversation_id,
  requestId: row.request_id,
  status: row.status,
  ...(row.error_code ? { error: row.error_code } : {}),
});
const conversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  createdAt: row.created_at.toISOString(),
  state: row.state,
  ...(row.model_binding ? { modelRef: row.model_binding.modelRef } : {}),
});
const LOCK = "hashtext(current_database()), hashtext(current_schema() || ':mio-conversations')";

/** One process owns one metadata schema and native persistence root; no shared auth pool. */
export class ConversationStore {
  private readonly pool: Pool;
  private readonly lease: PoolClient;
  private active = true;
  private closing: Promise<void> | undefined;

  constructor(pool: Pool, lease: PoolClient) {
    this.pool = pool;
    this.lease = lease;
    lease.on('error', () => {
      this.active = false;
    });
  }
  private assertActive(): void {
    if (!this.active)
      throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'CONVERSATION_UNAVAILABLE');
  }
  markUnavailable(): void {
    this.active = false;
  }

  async create(actor: Principal, id: string, selection?: ChatSelection): Promise<ConversationRow> {
    this.assertActive();
    return (
      await this.pool.query<ConversationRow>(
        `INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state,model_binding) VALUES($1,$2,$3,'creating',$4::jsonb) RETURNING *`,
        [id, actor.userId, `mio-${id}`, selection ? JSON.stringify(selection) : null],
      )
    ).rows[0]!;
  }
  async bind(
    actor: Principal,
    id: string,
    modelRef: string,
    select: () => Promise<ChatSelection>,
  ): Promise<Conversation> {
    this.assertActive();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (
        await client.query<ConversationRow>(
          'SELECT * FROM mio_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [id, actor.userId],
        )
      ).rows[0];
      if (!row) throw new ConversationError(HTTP_STATUS.NOT_FOUND, 'CONVERSATION_NOT_FOUND');
      if (row.model_binding) {
        const legacy = legacyReference(modelRef);
        if (row.model_binding.modelRef !== modelRef && legacy?.id !== row.model_binding.modelId)
          throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_MODEL_LOCKED');
      } else {
        if (row.active_request)
          throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_BUSY');
        if (row.state !== 'ready')
          throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_UNKNOWN');
        row.model_binding = await select();
        await client.query('UPDATE mio_conversations SET model_binding=$2::jsonb WHERE id=$1', [
          id,
          JSON.stringify(row.model_binding),
        ]);
      }
      await client.query('COMMIT');
      return conversation(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async setReady(id: string, ready: boolean): Promise<void> {
    this.assertActive();
    await this.pool.query('UPDATE mio_conversations SET state=$2 WHERE id=$1', [
      id,
      ready ? 'ready' : 'unknown',
    ]);
  }
  async owned(actor: Principal, id: string): Promise<ConversationRow> {
    this.assertActive();
    const row = (
      await this.pool.query<ConversationRow>(
        'SELECT * FROM mio_conversations WHERE id=$1 AND owner_id=$2',
        [id, actor.userId],
      )
    ).rows[0];
    if (!row) throw new ConversationError(HTTP_STATUS.NOT_FOUND, 'CONVERSATION_NOT_FOUND');
    return row;
  }
  async list(actor: Principal, after: string | undefined, limit: number) {
    this.assertActive();
    const rows = (
      await this.pool.query<ConversationRow>(
        'SELECT * FROM mio_conversations WHERE owner_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3',
        [actor.userId, after ?? null, limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, limit).map(conversation),
      nextAfter: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
  async request(actor: Principal, id: string, requestId: string): Promise<Receipt> {
    await this.owned(actor, id);
    const row = (
      await this.pool.query<RequestRow>(
        'SELECT * FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
        [id, requestId],
      )
    ).rows[0];
    if (!row) throw new ConversationError(HTTP_STATUS.NOT_FOUND, 'REQUEST_NOT_FOUND');
    return receipt(row);
  }
  async latest(actor: Principal, id: string): Promise<Receipt | null> {
    await this.owned(actor, id);
    const row = (
      await this.pool.query<RequestRow>(
        'SELECT * FROM mio_conversation_requests WHERE conversation_id=$1 ORDER BY created_at DESC,request_id DESC LIMIT 1',
        [id],
      )
    ).rows[0];
    return row ? receipt(row) : null;
  }
  async receive(
    actor: Principal,
    id: string,
    requestId: string,
    digest: string,
    resolveFresh:
      boolean | ((row: Readonly<ConversationRow>) => Promise<ChatRuntimeSnapshot | undefined>),
  ) {
    this.assertActive();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      this.assertActive();
      const row = (
        await client.query<ConversationRow>(
          'SELECT * FROM mio_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [id, actor.userId],
        )
      ).rows[0];
      if (!row) throw new ConversationError(HTTP_STATUS.NOT_FOUND, 'CONVERSATION_NOT_FOUND');
      const old = (
        await client.query<RequestRow>(
          'SELECT * FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
          [id, requestId],
        )
      ).rows[0];
      if (old && old.digest !== digest)
        throw new ConversationError(HTTP_STATUS.CONFLICT, 'REQUEST_ID_CONFLICT');
      if (old) {
        await client.query('COMMIT');
        return { row, receipt: receipt(old), fresh: false };
      }
      if (row.state !== 'ready')
        throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_UNKNOWN');
      if (row.active_request)
        throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_BUSY');
      const snapshot = typeof resolveFresh === 'function' ? await resolveFresh(row) : undefined;
      if (resolveFresh === false)
        throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'MODEL_UNAVAILABLE');
      // Only explicit non-secret fields may cross the persistence boundary.
      const binding = snapshot
        ? {
            providerConfigId: snapshot.providerConfigId,
            providerRevision: snapshot.providerRevision,
            credentialVersion: snapshot.credentialVersion,
            catalogVersion: snapshot.catalogVersion,
            modelKey: snapshot.modelKey,
            adaptationVersion: snapshot.adaptationVersion,
            operation: snapshot.operation,
            profile: snapshot.profile,
            modelRef: snapshot.modelRef,
            modelId: snapshot.modelId,
            protocol: snapshot.protocol,
            capabilityVersion: snapshot.capabilityVersion,
          }
        : null;
      const accepted = (
        await client.query<RequestRow>(
          `INSERT INTO mio_conversation_requests(conversation_id,request_id,digest,status,model_binding) VALUES($1,$2,$3,'accepted',$4::jsonb) RETURNING *`,
          [id, requestId, digest, binding ? JSON.stringify(binding) : null],
        )
      ).rows[0]!;
      await client.query('UPDATE mio_conversations SET active_request=$2 WHERE id=$1', [
        id,
        requestId,
      ]);
      this.assertActive();
      await client.query('COMMIT');
      return { row, receipt: receipt(accepted), fresh: true, snapshot };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async observe(id: string, requestId: string, observation: ModelObservation): Promise<void> {
    this.assertActive();
    await this.pool.query(
      `UPDATE mio_conversation_requests SET model_observations=model_observations || $3::jsonb WHERE conversation_id=$1 AND request_id=$2`,
      [id, requestId, JSON.stringify([observation])],
    );
  }
  async inputPersisted(id: string, requestId: string): Promise<void> {
    this.assertActive();
    await this.pool.query(
      `UPDATE mio_conversation_requests SET status='input-persisted',updated_at=now() WHERE conversation_id=$1 AND request_id=$2 AND status='accepted'`,
      [id, requestId],
    );
  }
  /** Reconcile a lost reception acknowledgment only when this process has not started that request. */
  async reconcileReception(
    actor: Principal,
    id: string,
    requestId: string,
    digest: string,
  ): Promise<void> {
    this.assertActive();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query(
        'SELECT id FROM mio_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, actor.userId],
      );
      if (owned.rowCount) {
        const changed = await client.query(
          `UPDATE mio_conversation_requests SET status='unknown',error_code='RECEPTION_UNKNOWN',updated_at=now() WHERE conversation_id=$1 AND request_id=$2 AND digest=$3 AND status IN ('accepted','input-persisted') RETURNING request_id`,
          [id, requestId, digest],
        );
        if (changed.rowCount)
          await client.query(
            'UPDATE mio_conversations SET active_request=NULL WHERE id=$1 AND active_request=$2',
            [id, requestId],
          );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async finish(
    id: string,
    requestId: string,
    status: RequestStatus,
    error?: string,
  ): Promise<Receipt> {
    this.assertActive();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (
        await client.query<RequestRow>(
          'UPDATE mio_conversation_requests SET status=$3,error_code=$4,updated_at=now() WHERE conversation_id=$1 AND request_id=$2 RETURNING *',
          [id, requestId, status, error ?? null],
        )
      ).rows[0]!;
      await client.query(
        'UPDATE mio_conversations SET active_request=NULL WHERE id=$1 AND active_request=$2',
        [id, requestId],
      );
      await client.query('COMMIT');
      return receipt(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.active = false;
      try {
        await this.lease.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => {});
      } finally {
        this.lease.release();
        await this.pool.end();
      }
    })());
  }
}

export async function createConversationStore(databaseURL: string): Promise<ConversationStore> {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: 'mio-conversations',
  });
  pool.on('error', () => log.error('CONVERSATION_DATABASE_CONNECTION_ERROR'));
  let lease: PoolClient | undefined;
  try {
    await checkConversationSchema(pool);
    lease = await pool.connect();
    lease.on('error', () => {});
    const lock = await lease.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${LOCK}) AS locked`,
    );
    if (!lock.rows[0]!.locked)
      throw new Error('CONVERSATION_INSTANCE: metadata schema already owned');
    // Only after exclusive ownership: a restart never re-sends an uncertain request.
    await lease.query(
      `UPDATE mio_conversation_requests SET status='unknown',error_code='PROCESS_INTERRUPTED',updated_at=now() WHERE status IN ('accepted','input-persisted')`,
    );
    await lease.query(
      `UPDATE mio_conversations SET active_request=NULL,state=CASE WHEN state='creating' THEN 'unknown' ELSE state END`,
    );
    return new ConversationStore(pool, lease);
  } catch (error) {
    lease?.release();
    await pool.end();
    throw new Error(
      error instanceof Error && error.message.startsWith('CONVERSATION_INSTANCE')
        ? error.message
        : 'CONVERSATION_SCHEMA: run conversations:migrate; database unavailable or incompatible',
    );
  }
}
