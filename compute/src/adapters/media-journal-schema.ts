import type { DatabaseSync } from 'node:sqlite';

/** Version 7 extends the existing journal on its owning connection. */
export function migrateMediaJournal(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE media_attempts (
        attempt_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, identity TEXT NOT NULL,
        body TEXT NOT NULL CHECK(json_valid(body))
      );
      CREATE INDEX media_attempts_phase ON media_attempts(json_extract(body, '$.phase'), attempt_id);
      CREATE UNIQUE INDEX media_job_attempt ON media_attempts(
        json_extract(body, '$.command.jobId'), json_extract(body, '$.command.attempt')
      );
      CREATE TABLE media_events (
        sequence INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE,
        attempt_id TEXT NOT NULL REFERENCES media_attempts(attempt_id), body TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0, 1))
      );
      CREATE INDEX media_pending ON media_events(attempt_id, sequence) WHERE confirmed = 0;
      CREATE TABLE media_cancellations (
        attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, message_id TEXT NOT NULL
      );
      CREATE TABLE media_manual_resolutions (
        attempt_id TEXT PRIMARY KEY REFERENCES media_attempts(attempt_id), evidence TEXT NOT NULL,
        resolved_at INTEGER NOT NULL
      );
      UPDATE metadata SET schema_version = 7;
      COMMIT;
    `);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function checkMediaJournal(db: DatabaseSync): void {
  db.prepare('SELECT attempt_id, command_id, identity, body FROM media_attempts LIMIT 0').all();
  db.prepare(
    'SELECT sequence, message_id, attempt_id, body, confirmed FROM media_events LIMIT 0',
  ).all();
  db.prepare('SELECT attempt_id, job_id, message_id FROM media_cancellations LIMIT 0').all();
  db.prepare(
    'SELECT attempt_id, evidence, resolved_at FROM media_manual_resolutions LIMIT 0',
  ).all();
}
