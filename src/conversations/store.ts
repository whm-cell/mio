import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createLogger } from '@mio/foundation/logging';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { checkConversationSchema } from './schema.ts';
import { ConversationError, isInFlightRequest, outputTruncation } from './contracts.ts';
import { encodeConversationCursor } from './cursor.ts';
import type { ConversationCursor } from './cursor.ts';
import type {
  Conversation,
  ConversationArchive,
  ConversationPurpose,
  ConversationSnapshot,
  Principal,
  Receipt,
  RequestStatus,
  TerminalRequestStatus,
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
  updated_at: Date;
  title: string | null;
  title_pinned: boolean;
  archived_at: Date | null;
  state: Conversation['state'];
  active_request: string | null;
  model_binding: ChatSelection | null;
  purpose: ConversationPurpose;
}
interface RequestRow {
  conversation_id: string;
  request_id: string;
  digest: string;
  status: RequestStatus;
  error_code: string | null;
  truncation_reason: string | null;
}
type ReceiptRow = Omit<RequestRow, 'digest'>;
const receiptColumns = 'conversation_id, request_id, status, error_code, truncation_reason';
const replayRequest = `SELECT ${receiptColumns}, digest
  FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2`;
const receipt = (row: ReceiptRow): Receipt => ({
  conversationId: row.conversation_id,
  requestId: row.request_id,
  status: row.status,
  ...(row.error_code ? { error: row.error_code } : {}),
  ...(row.truncation_reason === outputTruncation.reason ? { truncation: outputTruncation } : {}),
});
export const projectConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  title: row.title,
  state: row.state,
  ...(row.model_binding ? { modelRef: row.model_binding.modelRef } : {}),
  ...(row.purpose === 'drama-script' ? { purpose: row.purpose } : {}),
});
function requireUnarchived(row: ConversationRow): void {
  if (row.archived_at) throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_ARCHIVED');
}
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
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertActive();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      this.assertActive();
      const result = await work(client);
      this.assertActive();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  private async readOwned(
    actor: Principal,
    id: string,
    lock?: PoolClient,
  ): Promise<ConversationRow> {
    const database = lock ?? this.pool;
    const row = (
      await database.query<ConversationRow>(
        `SELECT * FROM mio_conversations WHERE id=$1 AND owner_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [id, actor.userId],
      )
    ).rows[0];
    if (lock) this.assertActive();
    if (!row) throw new ConversationError(HTTP_STATUS.NOT_FOUND, 'CONVERSATION_NOT_FOUND');
    return row;
  }

  async create(
    actor: Principal,
    id: string,
    selection?: ChatSelection,
    purpose: ConversationPurpose = 'general',
  ): Promise<ConversationRow> {
    this.assertActive();
    return (
      await this.pool.query<ConversationRow>(
        `INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state,model_binding,purpose)
         VALUES($1,$2,$3,'creating',$4::jsonb,$5) RETURNING *`,
        [id, actor.userId, `mio-${id}`, selection ? JSON.stringify(selection) : null, purpose],
      )
    ).rows[0]!;
  }
  async bind(
    actor: Principal,
    id: string,
    modelRef: string,
    select: () => Promise<ChatSelection>,
  ): Promise<Conversation> {
    return this.transaction(async (client) => {
      const row = await this.readOwned(actor, id, client);
      requireUnarchived(row);
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
      return projectConversation(row);
    });
  }
  async rename(
    actor: Principal,
    id: string,
    writeNative: (row: Readonly<ConversationRow>) => Promise<string>,
  ): Promise<Conversation> {
    return this.transaction(async (client) => {
      const row = await this.readOwned(actor, id, client);
      requireUnarchived(row);
      row.title = await writeNative(row);
      this.assertActive();
      await client.query('UPDATE mio_conversations SET title=$2,title_pinned=true WHERE id=$1', [
        id,
        row.title,
      ]);
      return projectConversation(row);
    });
  }
  async archive(actor: Principal, id: string): Promise<ConversationArchive> {
    return this.transaction(async (client) => {
      const row = await this.readOwned(actor, id, client);
      if (row.archived_at) return { id, archivedAt: row.archived_at.toISOString() };
      if (row.active_request || row.state === 'creating')
        throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_BUSY');
      const { rows } = await client.query<{ archived_at: Date }>(
        'UPDATE mio_conversations SET archived_at=clock_timestamp() WHERE id=$1 RETURNING archived_at',
        [id],
      );
      return { id, archivedAt: rows[0]!.archived_at.toISOString() };
    });
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
    return this.readOwned(actor, id);
  }
  async list(actor: Principal, cursor: ConversationCursor | undefined, limit: number) {
    this.assertActive();
    if (cursor?.kind === 'legacy') {
      const { rows } = await this.pool.query<ConversationRow>(
        'SELECT * FROM mio_conversations WHERE owner_id=$1 AND archived_at IS NULL AND id>$2::uuid ORDER BY id LIMIT $3',
        [actor.userId, cursor.id, limit + 1],
      );
      return {
        items: rows.slice(0, limit).map(projectConversation),
        nextAfter: rows.length > limit ? rows[limit - 1]!.id : null,
      };
    }
    const args = [actor.userId, limit + 1];
    if (cursor) args.push(cursor.updatedAt, cursor.id);
    const { rows } = await this.pool.query<ConversationRow & { cursor_time: string }>(
      `SELECT *, to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
       FROM mio_conversations WHERE owner_id=$1 AND archived_at IS NULL
       ${cursor ? 'AND (updated_at, id) < ($3::timestamptz, $4::uuid)' : ''}
       ORDER BY updated_at DESC, id DESC LIMIT $2`,
      args,
    );
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      items: rows.slice(0, limit).map(projectConversation),
      nextAfter: last ? encodeConversationCursor(last.cursor_time, last.id) : null,
    };
  }
  async request(actor: Principal, id: string, requestId: string): Promise<Receipt> {
    await this.owned(actor, id);
    const row = (
      await this.pool.query<ReceiptRow>(
        `SELECT ${receiptColumns} FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2`,
        [id, requestId],
      )
    ).rows[0];
    if (!row) throw new ConversationError(HTTP_STATUS.NOT_FOUND, 'REQUEST_NOT_FOUND');
    return receipt(row);
  }
  /** Authorize and check an existing request before any mutable provider or asset lookup. */
  async existing(
    actor: Principal,
    id: string,
    requestId: string,
    digest: string,
  ): Promise<{ row: ConversationRow; replay?: Receipt }> {
    const row = await this.owned(actor, id);
    const old = (await this.pool.query<RequestRow>(replayRequest, [id, requestId])).rows[0];
    if (old && old.digest !== digest)
      throw new ConversationError(HTTP_STATUS.CONFLICT, 'REQUEST_ID_CONFLICT');
    if (!old) requireUnarchived(row);
    return { row, ...(old ? { replay: receipt(old) } : {}) };
  }
  async snapshot(actor: Principal, id: string): Promise<ConversationSnapshot> {
    this.assertActive();
    const row = (
      await this.pool.query<{ active_request: string | null; latest: ReceiptRow | null }>(
        `SELECT c.active_request, row_to_json(r) AS latest
         FROM mio_conversations c
         LEFT JOIN LATERAL (
           SELECT ${receiptColumns}
           FROM mio_conversation_requests WHERE conversation_id=c.id
           ORDER BY created_at DESC, request_id DESC LIMIT 1
         ) r ON true
         WHERE c.id=$1 AND c.owner_id=$2`,
        [id, actor.userId],
      )
    ).rows[0];
    if (!row) throw new ConversationError(HTTP_STATUS.NOT_FOUND, 'CONVERSATION_NOT_FOUND');
    return {
      conversationId: id,
      activeRequestId: row.active_request,
      receipt: row.latest && receipt(row.latest),
    };
  }
  async receive(
    actor: Principal,
    id: string,
    requestId: string,
    digest: string,
    resolveFresh: (row: Readonly<ConversationRow>) => Promise<ChatRuntimeSnapshot | undefined>,
  ) {
    return this.transaction(async (client) => {
      const row = await this.readOwned(actor, id, client);
      const old = (await client.query<RequestRow>(replayRequest, [id, requestId])).rows[0];
      if (old && old.digest !== digest)
        throw new ConversationError(HTTP_STATUS.CONFLICT, 'REQUEST_ID_CONFLICT');
      if (old) return { row, receipt: receipt(old), fresh: false };
      requireUnarchived(row);
      if (row.state !== 'ready')
        throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_UNKNOWN');
      if (row.active_request)
        throw new ConversationError(HTTP_STATUS.CONFLICT, 'CONVERSATION_BUSY');
      this.assertActive();
      const snapshot = await resolveFresh(row);
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
        await client.query<ReceiptRow>(
          `INSERT INTO mio_conversation_requests(conversation_id,request_id,digest,status,model_binding)
           VALUES($1,$2,$3,'accepted',$4::jsonb) RETURNING ${receiptColumns}`,
          [id, requestId, digest, binding ? JSON.stringify(binding) : null],
        )
      ).rows[0]!;
      await client.query('UPDATE mio_conversations SET active_request=$2 WHERE id=$1', [
        id,
        requestId,
      ]);
      return { row, receipt: receipt(accepted), fresh: true, snapshot };
    });
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
  async inputAdmitted(
    id: string,
    requestId: string,
    eventTimeMs: number,
    autoTitle?: string | null,
  ): Promise<void> {
    this.assertActive();
    // The native event's time is stable across repeated callbacks. A stale fallback cannot replace a pin.
    await this.pool.query(
      `UPDATE mio_conversations
       SET updated_at=GREATEST(updated_at, $3::timestamptz),
           title=CASE WHEN title IS NULL AND NOT title_pinned THEN $4::text ELSE title END
       WHERE id=$1 AND active_request=$2
         AND (updated_at<$3::timestamptz OR (title IS NULL AND NOT title_pinned AND $4::text IS NOT NULL))`,
      [id, requestId, new Date(eventTimeMs).toISOString(), autoTitle ?? null],
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
    status: TerminalRequestStatus,
    error?: string,
    truncationReason?: typeof outputTruncation.reason,
  ): Promise<Receipt> {
    this.assertActive();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Match the conversation-first lock order in receive() and reconcileReception().
      await client.query('SELECT id FROM mio_conversations WHERE id=$1 FOR UPDATE', [id]);
      const changed = (
        await client.query<ReceiptRow>(
          `UPDATE mio_conversation_requests SET status=$3,error_code=$4,truncation_reason=$5,updated_at=now()
           WHERE conversation_id=$1 AND request_id=$2 AND status IN ('accepted','input-persisted')
           RETURNING ${receiptColumns}`,
          [id, requestId, status, error ?? null, truncationReason ?? null],
        )
      ).rows[0];
      if (changed)
        await client.query(
          'UPDATE mio_conversations SET active_request=NULL WHERE id=$1 AND active_request=$2',
          [id, requestId],
        );
      const row =
        changed ??
        (
          await client.query<ReceiptRow>(
            `SELECT ${receiptColumns} FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2`,
            [id, requestId],
          )
        ).rows[0];
      if (!row) throw new ConversationError(HTTP_STATUS.NOT_FOUND, 'REQUEST_NOT_FOUND');
      await client.query('COMMIT');
      return receipt(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  /** Read back a committed receipt before attempting to settle an unresolved execution. */
  async reconcileExecution(actor: Principal, id: string, requestId: string): Promise<Receipt> {
    const current = await this.request(actor, id, requestId);
    if (!isInFlightRequest(current.status)) return current;
    try {
      return await this.finish(id, requestId, 'unknown', 'EXECUTION_UNKNOWN');
    } catch (error) {
      const stored = await this.request(actor, id, requestId);
      if (!isInFlightRequest(stored.status)) return stored;
      throw error;
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
      `UPDATE mio_conversations SET active_request=NULL,state=CASE WHEN state='creating' THEN 'unknown' ELSE state END
       WHERE active_request IS NOT NULL OR state='creating'`,
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
