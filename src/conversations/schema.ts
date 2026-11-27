import { accountClosureSchemaSQL } from '../account-deletion/domain-schema.ts';
import type { Pool } from 'pg';

const purposeCheck = `(purpose = ANY (ARRAY['general'::text, 'drama-script'::text, 'audio'::text]))`;
const currentPurposeConstraint = `conrelid='mio_conversations'::regclass
  AND conname='mio_conversations_purpose_check' AND contype='c' AND convalidated
  AND pg_get_expr(conbin,conrelid) = $purpose$${purposeCheck}$purpose$`;

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
  ON mio_conversations(owner_id, updated_at DESC, id DESC) WHERE archived_at IS NULL;
ALTER TABLE mio_conversations ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'general'
  CHECK (purpose IN ('general', 'drama-script', 'audio'));
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE ${currentPurposeConstraint}) THEN
    ALTER TABLE mio_conversations DROP CONSTRAINT IF EXISTS mio_conversations_purpose_check,
      ADD CONSTRAINT mio_conversations_purpose_check CHECK (purpose IN ('general', 'drama-script', 'audio'));
  END IF;
END $$;
ALTER TABLE mio_conversations ADD COLUMN IF NOT EXISTS audio_selection jsonb
  CHECK (audio_selection IS NULL OR jsonb_typeof(audio_selection)='object');
ALTER TABLE mio_conversation_requests ADD COLUMN IF NOT EXISTS audio_context jsonb
  CHECK (audio_context IS NULL OR jsonb_typeof(audio_context)='object');
ALTER TABLE mio_conversations ADD COLUMN IF NOT EXISTS reasoning_effort text
  CHECK (reasoning_effort IN ('low', 'medium', 'high'));
ALTER TABLE mio_conversations
  ADD COLUMN IF NOT EXISTS forked_from_conversation_id uuid REFERENCES mio_conversations(id),
  ADD COLUMN IF NOT EXISTS forked_until_seq bigint CHECK (forked_until_seq >= 0),
  ADD COLUMN IF NOT EXISTS fork_request_id text,
  ADD COLUMN IF NOT EXISTS fork_requested_until_seq bigint CHECK (fork_requested_until_seq >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS mio_conversations_fork_request
  ON mio_conversations(owner_id, forked_from_conversation_id, fork_request_id)
  WHERE fork_request_id IS NOT NULL;
${accountClosureSchemaSQL([
  ['mio_conversations', 'owner_id'],
  ['mio_conversation_requests', 'mio_conversations', 'conversation_id'],
])}`;

/** Read-only checks before acquiring ownership or writing recovery metadata. */
export async function checkConversationSchema(database: Pick<Pool, 'query'>): Promise<void> {
  for (const [table, columns, types] of [
    [
      'mio_conversations',
      'id,owner_id,dsh_session_id,created_at,state,active_request,model_binding,title,title_pinned,updated_at,archived_at,purpose,reasoning_effort,forked_from_conversation_id,forked_until_seq,fork_request_id,fork_requested_until_seq,audio_selection',
      [2950, 25, 25, 1184, 25, 25, 3802, 25, 16, 1184, 1184, 25, 25, 2950, 20, 25, 20, 3802],
    ],
    [
      'mio_conversation_requests',
      'conversation_id,request_id,digest,status,error_code,created_at,updated_at,model_binding,model_observations,truncation_reason,audio_context',
      [2950, 25, 25, 25, 25, 1184, 1184, 3802, 3802, 25, 3802],
    ],
  ] as const) {
    const result = await database.query(`SELECT ${columns} FROM ${table} LIMIT 0`);
    if (result.fields.some((field, index) => field.dataTypeID !== types[index]))
      throw new Error('CONVERSATION_SCHEMA: incompatible metadata columns');
  }
  const result = await database.query<{ valid: boolean }>(
    `SELECT EXISTS(SELECT FROM pg_constraint WHERE ${currentPurposeConstraint}) AS valid`,
  );
  if (!result.rows[0]?.valid)
    throw new Error('CONVERSATION_SCHEMA: conversation purpose constraint required');
}
