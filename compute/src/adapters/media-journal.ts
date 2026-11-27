import { MEDIA_VERSION } from '@mio/compute-contracts';
import { epochMs } from '@mio/foundation/time';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { sha256Utf8 } from '@mio/foundation/hash';
import { createId } from '@mio/foundation/identifiers';
import type { MediaCommand, MediaControl, MediaFile, MediaResult } from '@mio/compute-contracts';
import type { MediaExecutionResult, MediaProcessResult, MediaStep } from '../media-execution.ts';

export type MediaPhase =
  | 'received'
  | 'downloading'
  | 'executing'
  | 'output_ready'
  | 'uploading'
  | 'reconciling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export interface MediaDigest {
  size: number;
  sha256: string;
}
export interface MediaStepCheckpoint {
  identity: string;
  step: MediaStep;
  state: 'intent' | 'running' | 'exited' | 'complete';
  pid: number | null;
  processIdentity: string | null;
  exitCode: number | null;
  signal: string | null;
  outputs: Record<string, MediaDigest>;
  result: MediaProcessResult | null;
  reusedFromAttemptId?: string;
}
export interface MediaUploadCheckpoint {
  file: { name: string; role: MediaFile['role']; contentType: string };
  key: string;
  digest: MediaDigest;
  state: 'intent' | 'confirmed' | 'rejected';
  object: MediaFile | null;
}
export interface MediaAttempt {
  command: MediaCommand;
  phase: MediaPhase;
  startedAt: number;
  failedAt?: number;
  steps: Record<string, MediaStepCheckpoint>;
  inputs: Record<string, MediaDigest>;
  uploads: Record<string, MediaUploadCheckpoint>;
  result: MediaExecutionResult | null;
  ackDispatched: boolean;
  cleaned?: boolean;
  unknownCode?: 'PROCESS_UNKNOWN' | 'UPLOAD_UNKNOWN' | 'OUTPUT_MISMATCH' | null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function mediaIdentity(value: unknown): string {
  return sha256Utf8(canonical(value));
}

/** Shares the owning Journal's lock and connection; never opens another SQLite handle. */
export class MediaJournal {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  get(id: string): MediaAttempt | null {
    return this.#read('SELECT * FROM media_attempts WHERE attempt_id = ?', [id])[0] ?? null;
  }
  #read(sql: string, parameters: SQLInputValue[] = []): MediaAttempt[] {
    const rows = this.#db.prepare(sql).all(...parameters);
    if (!rows.length) return [];
    try {
      const uploads = new Map<string, [string, MediaUploadCheckpoint][]>();
      for (const row of this.#db
        .prepare(
          `SELECT attempt_id,name,state,body FROM media_uploads
         WHERE attempt_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
        )
        .all(JSON.stringify(rows.map((row) => row.attempt_id)))) {
        const upload = JSON.parse(String(row.body)) as MediaUploadCheckpoint;
        if (upload.state !== row.state) throw new Error();
        const id = String(row.attempt_id);
        const entries = uploads.get(id) ?? [];
        entries.push([String(row.name), upload]);
        uploads.set(id, entries);
      }
      return rows.map((row) => {
        const value = JSON.parse(String(row.body)) as MediaAttempt;
        if (
          value.command.attemptId !== row.attempt_id ||
          mediaIdentity(value.command) !== row.identity ||
          !Number.isSafeInteger(value.startedAt) ||
          (value.failedAt !== undefined && !Number.isSafeInteger(value.failedAt)) ||
          !value.steps ||
          !value.inputs ||
          value.phase !== row.phase ||
          Number(Boolean(value.cleaned)) !== row.cleaned
        )
          throw new Error();
        return { ...value, uploads: Object.fromEntries(uploads.get(String(row.attempt_id)) ?? []) };
      });
    } catch {
      throw new Error('JOURNAL_MEDIA_CORRUPT');
    }
  }
  accept(command: MediaCommand): MediaAttempt {
    const prior = this.get(command.attemptId);
    if (prior) {
      if (mediaIdentity(prior.command) !== mediaIdentity(command))
        throw new Error('ATTEMPT_CONFLICT');
      return prior;
    }
    const cancellation = this.#db
      .prepare('SELECT job_id FROM media_cancellations WHERE attempt_id = ?')
      .get(command.attemptId);
    if (cancellation && cancellation.job_id !== command.jobId) throw new Error('ATTEMPT_CONFLICT');
    if (
      this.#db
        .prepare('SELECT 1 FROM media_attempts WHERE command_id = ?')
        .get(command.messageId) ||
      this.#db
        .prepare(
          "SELECT 1 FROM media_attempts WHERE json_extract(body,'$.command.jobId')=? AND json_extract(body,'$.command.attempt')=?",
        )
        .get(command.jobId, command.attempt)
    )
      throw new Error('ATTEMPT_CONFLICT');
    const attempt: MediaAttempt = {
      command,
      phase: 'received',
      startedAt: epochMs(),
      steps: {},
      inputs: {},
      uploads: {},
      result: null,
      ackDispatched: false,
    };
    this.#db
      .prepare(
        'INSERT INTO media_attempts(attempt_id,command_id,identity,body,phase,cleaned) VALUES (?, ?, ?, ?, ?, 0)',
      )
      .run(
        command.attemptId,
        command.messageId,
        mediaIdentity(command),
        JSON.stringify({ ...attempt, uploads: undefined }),
        attempt.phase,
      );
    return attempt;
  }
  checkpointSource(command: MediaCommand): MediaAttempt | null {
    const prior = this.#read(
      `SELECT * FROM media_attempts
      WHERE json_extract(body,'$.command.jobId')=? AND json_extract(body,'$.command.attempt')<?
      ORDER BY json_extract(body,'$.command.attempt') DESC LIMIT 1`,
      [command.jobId, command.attempt],
    )[0];
    if (!prior || prior.phase !== 'failed' || prior.cleaned) return null;
    const snapshot = (value: MediaCommand) =>
      mediaIdentity({
        operation: value.operation,
        profile: value.profile,
        inputs: value.inputs,
        parameters: value.parameters,
      });
    if (snapshot(prior.command) !== snapshot(command)) throw new Error('ATTEMPT_CONFLICT');
    return prior;
  }
  save(attempt: MediaAttempt): void {
    const { uploads, ...body } = attempt;
    this.#db.exec('SAVEPOINT media_save');
    try {
      const changed = this.#db
        .prepare(
          'UPDATE media_attempts SET body = ?, phase = ?, cleaned = ? WHERE attempt_id = ? AND identity = ?',
        )
        .run(
          JSON.stringify(body),
          attempt.phase,
          Number(Boolean(attempt.cleaned)),
          attempt.command.attemptId,
          mediaIdentity(attempt.command),
        );
      if (changed.changes !== 1) throw new Error('JOURNAL_MEDIA_WRITE_FAILED');
      this.#db
        .prepare('DELETE FROM media_uploads WHERE attempt_id = ?')
        .run(attempt.command.attemptId);
      const insert = this.#db.prepare(
        'INSERT INTO media_uploads(attempt_id,name,state,body) VALUES (?, ?, ?, ?)',
      );
      for (const [name, upload] of Object.entries(uploads))
        insert.run(attempt.command.attemptId, name, upload.state, JSON.stringify(upload));
      this.#db.exec('RELEASE media_save');
    } catch (error) {
      this.#db.exec('ROLLBACK TO media_save; RELEASE media_save');
      throw error;
    }
  }
  /** Persist one intent/receipt without rewriting the output inventory or other receipts. */
  saveUpload(attempt: MediaAttempt, name: string): void {
    const upload = attempt.uploads[name]!;
    const changed = this.#db
      .prepare(
        `INSERT INTO media_uploads(attempt_id,name,state,body)
       SELECT attempt_id,?,?,? FROM media_attempts WHERE attempt_id=? AND identity=?
       ON CONFLICT(attempt_id,name) DO UPDATE SET state=excluded.state,body=excluded.body`,
      )
      .run(
        name,
        upload.state,
        JSON.stringify(upload),
        attempt.command.attemptId,
        mediaIdentity(attempt.command),
      );
    if (changed.changes !== 1) throw new Error('JOURNAL_MEDIA_WRITE_FAILED');
  }
  transition(attempt: MediaAttempt, phase: MediaPhase, event: MediaResult): void {
    this.#transition(attempt, phase, event);
  }
  #transition(
    attempt: MediaAttempt,
    phase: MediaPhase,
    event: MediaResult,
    evidence?: string,
  ): void {
    const failedAt = phase === 'failed' ? (attempt.failedAt ?? epochMs()) : attempt.failedAt;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.save({
        ...attempt,
        ...(failedAt === undefined ? {} : { failedAt }),
        phase,
        unknownCode: event.state === 'reconciling' ? event.errorCode : null,
      });
      this.#db
        .prepare('INSERT INTO media_events(message_id, attempt_id, body) VALUES (?, ?, ?)')
        .run(event.messageId, attempt.command.attemptId, JSON.stringify(event));
      if (evidence)
        this.#db
          .prepare('INSERT INTO media_manual_resolutions VALUES (?, ?, ?)')
          .run(attempt.command.attemptId, evidence, epochMs());
      this.#db.exec('COMMIT');
      attempt.phase = phase;
      if (failedAt !== undefined) attempt.failedAt = failedAt;
      attempt.unknownCode = event.state === 'reconciling' ? event.errorCode : null;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  resolveNoPid(id: string, evidence: string): void {
    const attempt = this.get(id);
    const unresolved = attempt
      ? Object.values(attempt.steps).filter((step) => ['intent', 'running'].includes(step.state))
      : [];
    if (
      !attempt ||
      attempt.phase !== 'reconciling' ||
      attempt.unknownCode !== 'PROCESS_UNKNOWN' ||
      !unresolved.length ||
      unresolved.some((step) => step.pid !== null)
    )
      throw new Error('MANUAL_RESOLUTION_NOT_APPLICABLE');
    if (!evidence.trim() || evidence.length > 8192 || /[\x00-\x1f\x7f]/.test(evidence))
      throw new Error('MANUAL_RESOLUTION_EVIDENCE_REQUIRED');
    for (const step of unresolved) {
      step.state = 'exited';
      step.signal = 'MANUAL_TERMINATION_CONFIRMED';
    }
    const command = attempt.command;
    const cancelled = this.cancelled(id);
    this.#transition(
      attempt,
      cancelled ? 'cancelled' : 'failed',
      {
        version: MEDIA_VERSION,
        type: 'media.result',
        messageId: createId(),
        commandId: command.messageId,
        jobId: command.jobId,
        attemptId: command.attemptId,
        attempt: command.attempt,
        ...(cancelled
          ? { state: 'cancelled' }
          : { state: 'failed', errorCode: 'WORKER_INTERRUPTED' }),
      },
      evidence,
    );
  }
  cancel(control: MediaControl): void {
    const prior = this.get(control.attemptId);
    const cancelled = this.#db
      .prepare('SELECT job_id FROM media_cancellations WHERE attempt_id = ?')
      .get(control.attemptId);
    if (
      (prior && prior.command.jobId !== control.jobId) ||
      (cancelled && cancelled.job_id !== control.jobId)
    )
      throw new Error('ATTEMPT_CONFLICT');
    this.#db
      .prepare('INSERT OR IGNORE INTO media_cancellations VALUES (?, ?, ?)')
      .run(control.attemptId, control.jobId, control.messageId);
  }
  cancelled(id: string): boolean {
    return Boolean(
      this.#db.prepare('SELECT 1 FROM media_cancellations WHERE attempt_id = ?').get(id),
    );
  }
  unfinished(): MediaAttempt[] {
    return this.#read(
      "SELECT * FROM media_attempts WHERE phase NOT IN ('succeeded','failed','cancelled') ORDER BY attempt_id",
    );
  }
  recoverable(): MediaAttempt[] {
    return this.#read(`SELECT * FROM media_attempts WHERE attempt_id IN (
      SELECT attempt_id FROM media_attempts WHERE phase NOT IN ('succeeded','failed','cancelled')
      UNION SELECT attempt_id FROM media_attempts WHERE phase IN ('succeeded','failed','cancelled') AND cleaned=0
      UNION SELECT attempt_id FROM media_events WHERE confirmed=0
    ) ORDER BY attempt_id`);
  }
  cleanupCandidates(): MediaAttempt[] {
    return this.#read(
      "SELECT * FROM media_attempts WHERE phase IN ('succeeded','failed','cancelled') AND cleaned=0 ORDER BY attempt_id",
    );
  }
  predecessors(command: MediaCommand): MediaAttempt[] {
    return this.#read(
      "SELECT * FROM media_attempts WHERE json_extract(body,'$.command.jobId')=? AND json_extract(body,'$.command.attempt')<? ORDER BY json_extract(body,'$.command.attempt')",
      [command.jobId, command.attempt],
    );
  }
  pending(id: string): MediaResult | null {
    const row = this.#db
      .prepare(
        'SELECT body FROM media_events WHERE attempt_id = ? AND confirmed = 0 ORDER BY sequence LIMIT 1',
      )
      .get(id);
    if (!row) return null;
    try {
      return JSON.parse(String(row.body)) as MediaResult;
    } catch {
      throw new Error('JOURNAL_MEDIA_CORRUPT');
    }
  }
  confirm(id: string): void {
    if (
      this.#db.prepare('UPDATE media_events SET confirmed = 1 WHERE message_id = ?').run(id)
        .changes !== 1
    )
      throw new Error('JOURNAL_MEDIA_EVENT_MISSING');
  }
}
