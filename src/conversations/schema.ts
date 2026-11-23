import type { Pool } from 'pg';

/** Local metadata; message content remains solely in native DSH logs. */
export const conversationSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_conversations (
  id uuid PRIMARY KEY, owner_id text NOT NULL, dsh_session_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (state IN ('creating','ready','unknown')),
  active_request text
);
CREATE INDEX IF NOT EXISTS mio_conversations_owner_page ON mio_conversations(owner_id, id);
CREATE TABLE IF NOT EXISTS mio_conversation_requests (
  conversation_id uuid NOT NULL REFERENCES mio_conversations(id), request_id text NOT NULL,
  digest text NOT NULL, status text NOT NULL CHECK (status IN ('accepted','input-persisted','completed','cancelled','failed','unknown')),
  error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, request_id)
);
ALTER TABLE mio_conversations ADD COLUMN IF NOT EXISTS model_binding jsonb;
ALTER TABLE mio_conversation_requests ADD COLUMN IF NOT EXISTS model_binding jsonb;
ALTER TABLE mio_conversation_requests ADD COLUMN IF NOT EXISTS model_observations jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE mio_conversation_requests ADD COLUMN IF NOT EXISTS truncation_reason text
  CHECK (truncation_reason IS NULL OR (status='completed' AND truncation_reason='max-tokens'));
ALTER TABLE mio_conversations
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS title_pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
UPDATE mio_conversations SET updated_at=created_at WHERE updated_at IS NULL;
ALTER TABLE mio_conversations
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS mio_conversations_owner_activity_page
  ON mio_conversations(owner_id, updated_at DESC, id DESC) WHERE archived_at IS NULL;`;

/** Read-only checks before acquiring ownership or writing recovery metadata. */
export async function checkConversationSchema(database: Pick<Pool, 'query'>): Promise<void> {
  for (const [table, columns, types] of [
    [
      'mio_conversations',
      'id,owner_id,dsh_session_id,created_at,state,active_request,model_binding,title,title_pinned,updated_at,archived_at',
      [2950, 25, 25, 1184, 25, 25, 3802, 25, 16, 1184, 1184],
    ],
    [
      'mio_conversation_requests',
      'conversation_id,request_id,digest,status,error_code,created_at,updated_at,model_binding,model_observations,truncation_reason',
      [2950, 25, 25, 25, 25, 1184, 1184, 3802, 3802, 25],
    ],
  ] as const) {
    const result = await database.query(`SELECT ${columns} FROM ${table} LIMIT 0`);
    if (result.fields.some((field, index) => field.dataTypeID !== types[index]))
      throw new Error('CONVERSATION_SCHEMA: incompatible metadata columns');
  }
}
