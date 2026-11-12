import { epochMs } from '@mio/foundation/time';
import { DatabaseSync } from 'node:sqlite';
import { createId } from '@mio/foundation/identifiers';
import {
  COMPUTE_MAX_MEDIA_BYTES,
  parseComputeCommandV1,
  parseComputeResultV1,
} from '@mio/compute-contracts';
import type { ComputeCommandV1, ComputeResultV1 } from '@mio/compute-contracts';
import type { Attempt, PendingEvent, Phase } from '../types.ts';
import { prepareJournalFile } from './media.ts';

type Row = Record<string, unknown>;

export function isJournalFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; message?: string };
  return Boolean(
    value.code?.includes('SQLITE') ||
    /^(JOURNAL_|ATTEMPT_MISSING|EVENT_MISSING)/.test(value.message ?? ''),
  );
}

function asAttempt(row: Row): Attempt {
  try {
    const phase = String(row.phase);
    if (
      ![
        'received',
        'launching',
        'running',
        'output_ready',
        'uploading',
        'unknown_process',
        'unknown_upload',
        'unknown_mismatch',
        'succeeded',
        'failed',
      ].includes(phase) ||
      ![0, 1].includes(Number(row.ack_dispatched)) ||
      ![0, 1].includes(Number(row.cleaned)) ||
      !Number.isSafeInteger(row.started_at) ||
      Number(row.started_at) <= 0 ||
      (row.pid !== null && (!Number.isSafeInteger(row.pid) || Number(row.pid) <= 0))
    )
      throw new Error('invalid attempt');
    const command = parseComputeCommandV1(JSON.parse(String(row.command_json)) as unknown);
    if (
      row.attempt_id !== command.attemptId ||
      row.command_id !== command.messageId ||
      (row.pid === null) !== (row.process_identity === null) ||
      (row.output_size === null) !== (row.output_sha256 === null) ||
      (row.output_size !== null &&
        (!Number.isSafeInteger(row.output_size) ||
          Number(row.output_size) <= 0 ||
          Number(row.output_size) > COMPUTE_MAX_MEDIA_BYTES ||
          !/^[0-9a-f]{64}$/.test(String(row.output_sha256)))) ||
      (row.cleaned === 1 && !['succeeded', 'failed'].includes(phase))
    )
      throw new Error('invalid fields');
    return {
      command,
      phase: phase as Phase,
      pid: row.pid === null ? null : Number(row.pid),
      processIdentity: row.process_identity === null ? null : String(row.process_identity),
      outputSize: row.output_size === null ? null : Number(row.output_size),
      outputSha256: row.output_sha256 === null ? null : String(row.output_sha256),
      ackDispatched: row.ack_dispatched === 1,
      cleaned: row.cleaned === 1,
      startedAt: Number(row.started_at),
    };
  } catch {
    throw new Error('JOURNAL_CORRUPT');
  }
}

/** One long-lived connection owns SQLite's exclusive lock; each mutation commits. */
export class Journal {
  readonly #db: DatabaseSync;

  constructor(directory: string, instanceId: string, initialize = false) {
    const path = prepareJournalFile(directory, initialize);
    const db = new DatabaseSync(path, { timeout: 0 });
    try {
      const mode = db.prepare('PRAGMA journal_mode=WAL').get();
      if (String(mode?.journal_mode).toLowerCase() !== 'wal')
        throw new Error('JOURNAL_WAL_REQUIRED');
      db.exec('PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
      if (initialize) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE metadata (instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL);
          CREATE TABLE attempts (
            attempt_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, command_json TEXT NOT NULL,
            phase TEXT NOT NULL, pid INTEGER, process_identity TEXT, output_size INTEGER,
            output_sha256 TEXT, ack_dispatched INTEGER NOT NULL DEFAULT 0, cleaned INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL
          );
          CREATE INDEX attempts_process ON attempts(attempt_id) WHERE phase IN ('launching','running','unknown_process');
          CREATE INDEX attempts_recovery ON attempts(attempt_id) WHERE phase IN ('launching','running','output_ready','uploading','unknown_process','unknown_upload','unknown_mismatch');
          CREATE INDEX attempts_cleanup ON attempts(attempt_id) WHERE phase IN ('succeeded','failed') AND cleaned = 0;
          CREATE TABLE events (
            sequence INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE,
            attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), body TEXT NOT NULL,
            confirmed INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX events_by_attempt ON events(attempt_id, sequence);
          CREATE INDEX events_unconfirmed ON events(attempt_id) WHERE confirmed = 0;
          CREATE TABLE manual_resolutions (attempt_id TEXT NOT NULL, evidence TEXT NOT NULL, resolved_at INTEGER NOT NULL);
          COMMIT;`);
        db.prepare('INSERT INTO metadata VALUES (?, 4)').run(instanceId);
      }
      const integrity = db.prepare('PRAGMA quick_check').get();
      if (integrity?.quick_check !== 'ok') throw new Error('JOURNAL_CORRUPT');
      const meta = db.prepare('SELECT instance_id, schema_version FROM metadata').all();
      if (
        meta.length !== 1 ||
        meta[0]?.instance_id !== instanceId ||
        ![3, 4].includes(Number(meta[0]?.schema_version))
      ) {
        throw new Error('JOURNAL_IDENTITY_MISMATCH');
      }
      if (meta[0]?.schema_version === 3) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(`ALTER TABLE attempts RENAME COLUMN acknowledged TO ack_dispatched;
            DROP INDEX attempts_cleanup;
            CREATE INDEX attempts_cleanup ON attempts(attempt_id) WHERE phase IN ('succeeded','failed') AND cleaned = 0;
            UPDATE metadata SET schema_version = 4; COMMIT;`);
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      db.prepare(
        'SELECT attempt_id, command_id, command_json, phase, pid, process_identity, output_size, output_sha256, ack_dispatched, cleaned, started_at FROM attempts LIMIT 0',
      ).all();
      db.prepare(
        'SELECT sequence, message_id, attempt_id, body, confirmed FROM events LIMIT 0',
      ).all();
      db.prepare('SELECT attempt_id, evidence, resolved_at FROM manual_resolutions LIMIT 0').all();
      const invalid = db
        .prepare(
          "SELECT 1 FROM attempts WHERE phase NOT IN ('received','launching','running','output_ready','uploading','unknown_process','unknown_upload','unknown_mismatch','succeeded','failed') LIMIT 1",
        )
        .get();
      if (invalid) throw new Error('JOURNAL_CORRUPT');
      if (db.prepare('SELECT 1 FROM events WHERE confirmed NOT IN (0, 1) LIMIT 1').get())
        throw new Error('JOURNAL_CORRUPT');
      this.#db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  get(attemptId: string): Attempt | null {
    const row = this.#db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
    return row ? asAttempt(row) : null;
  }

  accept(command: ComputeCommandV1): Attempt {
    const existing = this.get(command.attemptId);
    if (existing) {
      const previous = existing.command;
      if (
        previous.messageId !== command.messageId ||
        previous.jobId !== command.jobId ||
        previous.attempt !== command.attempt ||
        previous.profile !== command.profile ||
        previous.input.assetId !== command.input.assetId ||
        previous.input.key !== command.input.key ||
        previous.input.sizeBytes !== command.input.sizeBytes ||
        previous.input.etag !== command.input.etag
      )
        throw new Error('ATTEMPT_CONFLICT');
      return existing;
    }
    if (this.#db.prepare('SELECT 1 FROM attempts WHERE command_id = ?').get(command.messageId))
      throw new Error('ATTEMPT_CONFLICT');
    this.#db
      .prepare(
        'INSERT INTO attempts (attempt_id, command_id, command_json, phase, started_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(command.attemptId, command.messageId, JSON.stringify(command), 'received', epochMs());
    const attempt = this.get(command.attemptId);
    if (!attempt) throw new Error('JOURNAL_WRITE_FAILED');
    return attempt;
  }

  /** Persist phase and event together before any result can be sent. */
  transition(attemptId: string, phase: Phase, event?: ComputeResultV1): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db
        .prepare('UPDATE attempts SET phase = ? WHERE attempt_id = ?')
        .run(phase, attemptId);
      if (result.changes !== 1) throw new Error('ATTEMPT_MISSING');
      if (event) {
        this.#db
          .prepare('INSERT INTO events (message_id, attempt_id, body) VALUES (?, ?, ?)')
          .run(event.messageId, attemptId, JSON.stringify(event));
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  recordPid(attemptId: string, pid: number, identity: string): void {
    const result = this.#db
      .prepare(
        "UPDATE attempts SET pid = ?, process_identity = ?, phase = 'running' WHERE attempt_id = ? AND phase = 'launching'",
      )
      .run(pid, identity, attemptId);
    if (result.changes !== 1) throw new Error('JOURNAL_LAUNCH_STATE');
  }

  recordOutput(attemptId: string, size: number, sha256: string): void {
    const result = this.#db
      .prepare(
        "UPDATE attempts SET output_size = ?, output_sha256 = ?, phase = 'output_ready' WHERE attempt_id = ? AND phase = 'running'",
      )
      .run(size, sha256, attemptId);
    if (result.changes !== 1) throw new Error('JOURNAL_OUTPUT_STATE');
  }

  #event(row: Row | undefined, attemptId: string): PendingEvent | null {
    if (!row) return null;
    const attempt = this.get(attemptId);
    if (!attempt) throw new Error('ATTEMPT_MISSING');
    try {
      if (row.confirmed !== 0 && row.confirmed !== 1) throw new Error('invalid confirmation');
      const message = parseComputeResultV1(JSON.parse(String(row.body)) as unknown);
      if (
        message.messageId !== row.message_id ||
        message.attemptId !== attemptId ||
        message.commandId !== attempt.command.messageId ||
        message.jobId !== attempt.command.jobId ||
        message.attempt !== attempt.command.attempt
      )
        throw new Error('invalid event identity');
      return { message, confirmed: row.confirmed === 1 };
    } catch {
      throw new Error('JOURNAL_CORRUPT');
    }
  }

  pendingEvent(attemptId: string): PendingEvent | null {
    const row = this.#db
      .prepare(
        'SELECT message_id, body, confirmed FROM events WHERE attempt_id = ? AND confirmed = 0 ORDER BY sequence LIMIT 1',
      )
      .get(attemptId);
    return this.#event(row, attemptId);
  }

  lastEvent(attemptId: string): PendingEvent | null {
    const row = this.#db
      .prepare(
        'SELECT message_id, body, confirmed FROM events WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1',
      )
      .get(attemptId);
    return this.#event(row, attemptId);
  }

  confirm(messageId: string): void {
    const result = this.#db
      .prepare('UPDATE events SET confirmed = 1 WHERE message_id = ?')
      .run(messageId);
    if (result.changes !== 1) throw new Error('EVENT_MISSING');
  }

  markAckDispatched(attemptId: string): void {
    const result = this.#db
      .prepare('UPDATE attempts SET ack_dispatched = 1 WHERE attempt_id = ?')
      .run(attemptId);
    if (result.changes !== 1) throw new Error('JOURNAL_ACK_DISPATCH_STATE');
  }

  markCleaned(attemptId: string): void {
    const result = this.#db
      .prepare(
        "UPDATE attempts SET cleaned = 1 WHERE attempt_id = ? AND phase IN ('succeeded', 'failed')",
      )
      .run(attemptId);
    if (result.changes !== 1) throw new Error('JOURNAL_CLEANUP_STATE');
  }

  resolveNoPid(attemptId: string, evidence: string): void {
    if (!evidence.trim() || evidence.length > 1000 || /[\x00-\x1f\x7f]/.test(evidence))
      throw new Error('RESOLUTION_EVIDENCE_REQUIRED');
    const attempt = this.get(attemptId);
    if (!attempt || attempt.phase !== 'unknown_process' || attempt.pid !== null)
      throw new Error('RESOLUTION_STATE_INVALID');
    const command = attempt.command;
    const event: ComputeResultV1 = {
      version: 1,
      type: 'transcode.result',
      messageId: createId(),
      commandId: command.messageId,
      jobId: command.jobId,
      attemptId,
      attempt: command.attempt,
      state: 'failed',
      errorCode: 'WORKER_INTERRUPTED',
    };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare("UPDATE attempts SET phase = 'failed' WHERE attempt_id = ?").run(attemptId);
      this.#db
        .prepare('INSERT INTO manual_resolutions VALUES (?, ?, ?)')
        .run(attemptId, evidence, epochMs());
      this.#db
        .prepare('INSERT INTO events (message_id, attempt_id, body) VALUES (?, ?, ?)')
        .run(event.messageId, attemptId, JSON.stringify(event));
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  hasUnknownProcess(): boolean {
    return Boolean(
      this.#db
        .prepare(
          "SELECT 1 FROM attempts WHERE phase IN ('launching', 'running', 'unknown_process') LIMIT 1",
        )
        .get(),
    );
  }

  recoverableAfter(cursor: string): Attempt | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM attempts WHERE attempt_id = (
          SELECT attempt_id FROM attempts WHERE phase IN ('launching','running','output_ready','uploading','unknown_process','unknown_upload','unknown_mismatch') AND attempt_id > ?
          UNION ALL SELECT attempt_id FROM attempts WHERE phase IN ('succeeded','failed') AND cleaned = 0 AND attempt_id > ?
          UNION ALL SELECT attempt_id FROM events WHERE confirmed = 0 AND attempt_id > ?
          ORDER BY attempt_id LIMIT 1
        )`,
      )
      .get(cursor, cursor, cursor);
    return row ? asAttempt(row) : null;
  }
}
