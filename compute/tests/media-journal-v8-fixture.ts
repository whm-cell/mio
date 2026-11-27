/** Literal schema captured by executing Journal.initialize at 69efaf92ac79d7c19e758e065d24d4666112359e.
 * Sources: compute/src/adapters/{journal,media-journal-schema,worker-observability-journal}.ts.
 * Includes every historical v8 table/index; no current-schema column deletion. */
export const mediaJournalV8Schema = String.raw`CREATE TABLE metadata (instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL);
CREATE TABLE attempts (
            attempt_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, command_json TEXT NOT NULL,
            phase TEXT NOT NULL, pid INTEGER, process_identity TEXT, output_size INTEGER,
            output_sha256 TEXT, ack_dispatched INTEGER NOT NULL DEFAULT 0, cleaned INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL
          );
CREATE TABLE events (
            sequence INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE,
            attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), body TEXT NOT NULL,
            confirmed INTEGER NOT NULL DEFAULT 0
          );
CREATE TABLE manual_resolutions (attempt_id TEXT NOT NULL, evidence TEXT NOT NULL, resolved_at INTEGER NOT NULL);
CREATE TABLE image_attempts (
              job_id TEXT PRIMARY KEY, identity TEXT NOT NULL,
              phase TEXT NOT NULL CHECK(phase IN ('submitting','submitted','processing','unknown','returned','materializing','completed','failed','rejected')),
              payload TEXT
            );
CREATE TABLE media_attempts (
        attempt_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, identity TEXT NOT NULL,
        body TEXT NOT NULL CHECK(json_valid(body))
      );
CREATE TABLE media_events (
        sequence INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE,
        attempt_id TEXT NOT NULL REFERENCES media_attempts(attempt_id), body TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0, 1))
      );
CREATE TABLE media_cancellations (
        attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, message_id TEXT NOT NULL
      );
CREATE TABLE media_manual_resolutions (
        attempt_id TEXT PRIMARY KEY REFERENCES media_attempts(attempt_id), evidence TEXT NOT NULL,
        resolved_at INTEGER NOT NULL
      );
CREATE TABLE worker_observation_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        boot_sequence INTEGER NOT NULL DEFAULT 0,
        applied_revision INTEGER NOT NULL DEFAULT 0, applied_command_id TEXT,
        requested_limits TEXT NOT NULL CHECK(json_valid(requested_limits)),
        handled_revision INTEGER NOT NULL DEFAULT 0, handled_command_id TEXT,
        handled_limits TEXT CHECK(json_valid(handled_limits)), handled_reason TEXT,
        pending_gap TEXT CHECK(json_valid(pending_gap))
      );
CREATE TABLE worker_observation_outbox (
        id INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE,
        boot_sequence INTEGER NOT NULL, sequence INTEGER NOT NULL, observed_at INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('worker.telemetry','worker.limits.result')),
        body TEXT NOT NULL CHECK(json_valid(body)), gap TEXT CHECK(json_valid(gap)),
        snapshot INTEGER NOT NULL DEFAULT 0 CHECK(snapshot IN (0,1)),
        body_bytes INTEGER NOT NULL DEFAULT 0 CHECK(body_bytes>=0),
        confirmed_at INTEGER, UNIQUE(boot_sequence,sequence)
      );
CREATE INDEX attempts_process ON attempts(attempt_id) WHERE phase IN ('launching','running','unknown_process');
CREATE INDEX attempts_recovery ON attempts(attempt_id) WHERE phase IN ('launching','running','output_ready','uploading','unknown_process','unknown_upload','unknown_mismatch');
CREATE INDEX attempts_cleanup ON attempts(attempt_id) WHERE phase IN ('succeeded','failed') AND cleaned = 0;
CREATE INDEX events_by_attempt ON events(attempt_id, sequence);
CREATE INDEX events_unconfirmed ON events(attempt_id) WHERE confirmed = 0;
CREATE INDEX media_attempts_phase ON media_attempts(json_extract(body, '$.phase'), attempt_id);
CREATE UNIQUE INDEX media_job_attempt ON media_attempts(
        json_extract(body, '$.command.jobId'), json_extract(body, '$.command.attempt')
      );
CREATE INDEX media_pending ON media_events(attempt_id, sequence) WHERE confirmed = 0;
CREATE INDEX worker_observation_pending ON worker_observation_outbox(id) WHERE confirmed_at IS NULL;
CREATE INDEX worker_observation_pending_type ON worker_observation_outbox(type,id)
        WHERE confirmed_at IS NULL;
CREATE INDEX worker_observation_latest ON worker_observation_outbox(boot_sequence DESC,sequence DESC)
        WHERE snapshot=1 AND confirmed_at IS NULL;
CREATE INDEX worker_observation_confirmed ON worker_observation_outbox(confirmed_at)
        WHERE confirmed_at IS NOT NULL;
INSERT INTO metadata VALUES ('fixture',8);
INSERT INTO worker_observation_state(singleton,requested_limits) VALUES(1,'{"total":2,"encode":1,"probe":1}');
`;
