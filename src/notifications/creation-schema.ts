import { accountClosureSchemaSQL } from '../account-deletion/domain-schema.ts';
import type { Pool } from 'pg';

export const creationLogSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_creation_logs (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image','video','audio')),
  job_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('completed','partial','failed')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL,
  read_at timestamptz,
  UNIQUE (owner_id, media_type, job_id, event_kind)
);
CREATE INDEX IF NOT EXISTS mio_creation_logs_owner_idx
  ON mio_creation_logs(owner_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS mio_creation_logs_expiry_idx ON mio_creation_logs(occurred_at, id);
CREATE TABLE IF NOT EXISTS mio_audio_creation_receipts (
  event_id uuid PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mio_audio_creation_receipts_expiry_idx
  ON mio_audio_creation_receipts(recorded_at, event_id);

${accountClosureSchemaSQL([['mio_creation_logs', 'owner_id']])}`;

/** Startup only inspects structures. Existing installations must explicitly migrate. */
export async function checkCreationLogSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  for (const [sql, types] of [
    [
      'SELECT id,owner_id,media_type,job_id,event_kind,title,summary,occurred_at,read_at FROM mio_creation_logs LIMIT 0',
      [2950, 25, 25, 2950, 25, 25, 25, 1184, 1184],
    ],
    ['SELECT event_id,recorded_at FROM mio_audio_creation_receipts LIMIT 0', [2950, 1184]],
  ] as const) {
    const result = await pool.query(sql);
    if (
      result.fields.length !== types.length ||
      result.fields.some((field, i) => field.dataTypeID !== types[i])
    )
      throw new Error('CREATION_LOG_SCHEMA: incompatible columns');
  }
  const constraints = await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid IN ('mio_creation_logs'::regclass,'mio_audio_creation_receipts'::regclass)`,
  );
  for (const definition of [
    'PRIMARY KEY (id)',
    'PRIMARY KEY (event_id)',
    'UNIQUE (owner_id, media_type, job_id, event_kind)',
  ]) {
    if (!constraints.rows.some((row) => row.definition === definition))
      throw new Error('CREATION_LOG_SCHEMA: missing event identity');
  }
  const indexes = await pool.query<{ definition: string; valid: boolean }>(
    `SELECT pg_get_indexdef(indexrelid) AS definition,indisvalid AS valid FROM pg_index
     WHERE indrelid IN ('mio_creation_logs'::regclass,'mio_audio_creation_receipts'::regclass)`,
  );
  for (const columns of [
    '(owner_id, occurred_at DESC, id DESC)',
    '(occurred_at, id)',
    '(recorded_at, event_id)',
  ]) {
    if (!indexes.rows.some((row) => row.valid && row.definition.includes(columns)))
      throw new Error('CREATION_LOG_SCHEMA: missing query or expiry index');
  }
}
