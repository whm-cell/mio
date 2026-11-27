import { accountClosureSchemaSQL } from '../account-deletion/domain-schema.ts';
import type { Pool } from 'pg';

export const notificationSchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_announcements (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 16000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  enabled boolean NOT NULL DEFAULT true,
  popup boolean NOT NULL DEFAULT false,
  effective_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'published') = (published_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS mio_announcement_reads (
  user_id text NOT NULL,
  announcement_id uuid NOT NULL REFERENCES mio_announcements(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, announcement_id)
);
CREATE INDEX IF NOT EXISTS mio_announcements_visible_idx
  ON mio_announcements(published_at DESC, id DESC) WHERE status='published' AND enabled;
CREATE INDEX IF NOT EXISTS mio_announcements_popup_idx
  ON mio_announcements(published_at DESC, id DESC) WHERE status='published' AND enabled AND popup;

${accountClosureSchemaSQL([['mio_announcement_reads', 'user_id']])}`;

/** Startup and migration share a read-only structure check. No startup DDL or backfill. */
export async function checkNotificationSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  for (const [sql, types] of [
    [
      'SELECT id,title,body,status,enabled,popup,effective_at,published_at,created_at,updated_at FROM mio_announcements LIMIT 0',
      [2950, 25, 25, 25, 16, 16, 1184, 1184, 1184, 1184],
    ],
    [
      'SELECT user_id,announcement_id,read_at FROM mio_announcement_reads LIMIT 0',
      [25, 2950, 1184],
    ],
  ] as const) {
    const result = await pool.query(sql);
    if (result.fields.some((field, index) => field.dataTypeID !== types[index]))
      throw new Error('NOTIFICATIONS_SCHEMA: incompatible columns');
  }
  const constraints = await pool.query<{ table_name: string; definition: string }>(
    `SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE conrelid IN ('mio_announcements'::regclass,'mio_announcement_reads'::regclass)`,
  );
  for (const [table, definition] of [
    ['mio_announcements', 'PRIMARY KEY (id)'],
    ['mio_announcement_reads', 'PRIMARY KEY (user_id, announcement_id)'],
    [
      'mio_announcement_reads',
      'FOREIGN KEY (announcement_id) REFERENCES mio_announcements(id) ON DELETE CASCADE',
    ],
  ] as const) {
    if (!constraints.rows.some((row) => row.table_name === table && row.definition === definition))
      throw new Error('NOTIFICATIONS_SCHEMA: missing receipt identity or cascade constraint');
  }
  const indexes = await pool.query<{ name: string; definition: string; valid: boolean }>(
    `SELECT i.relname AS name, pg_get_indexdef(i.oid) AS definition, x.indisvalid AS valid
     FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
     WHERE x.indrelid='mio_announcements'::regclass`,
  );
  for (const [name, predicate] of [
    ['mio_announcements_visible_idx', "WHERE ((status = 'published'::text) AND enabled)"],
    ['mio_announcements_popup_idx', "WHERE ((status = 'published'::text) AND enabled AND popup)"],
  ] as const) {
    if (
      !indexes.rows.some(
        (row) =>
          row.name === name &&
          row.valid &&
          row.definition.includes('(published_at DESC, id DESC)') &&
          row.definition.endsWith(predicate),
      )
    )
      throw new Error('NOTIFICATIONS_SCHEMA: missing visibility index');
  }
}
