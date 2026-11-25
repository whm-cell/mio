import {
  parseWorkerLimits,
  parseWorkerLimitsResult,
  parseWorkerTelemetry,
  WORKER_DEFAULT_LIMITS,
  WORKER_MAX_MESSAGE_BYTES,
} from '@mio/compute-contracts';
import type {
  WorkerLimits,
  WorkerLimitsResult,
  WorkerTelemetry,
  WorkerTelemetryGap,
} from '@mio/compute-contracts';
import type { DatabaseSync } from 'node:sqlite';

const maxPending = 100_000;
const maxPendingBytes = 256 * 1024 * 1024;
const dayMs = 24 * 60 * 60_000;

type Position = { bootSequence: number; sequence: number; at: number };
type Gap = WorkerTelemetryGap;
type ObservationMessage = WorkerTelemetry | WorkerLimitsResult;

function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function migrateWorkerObservabilityJournal(db: DatabaseSync): void {
  transaction(db, () => {
    db.exec(`
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
      CREATE INDEX worker_observation_pending ON worker_observation_outbox(id) WHERE confirmed_at IS NULL;
      CREATE INDEX worker_observation_pending_type ON worker_observation_outbox(type,id)
        WHERE confirmed_at IS NULL;
      CREATE INDEX worker_observation_latest ON worker_observation_outbox(boot_sequence DESC,sequence DESC)
        WHERE snapshot=1 AND confirmed_at IS NULL;
      CREATE INDEX worker_observation_confirmed ON worker_observation_outbox(confirmed_at)
        WHERE confirmed_at IS NOT NULL;
      UPDATE metadata SET schema_version=8;
    `);
    db.prepare('INSERT INTO worker_observation_state(singleton,requested_limits) VALUES(1,?)').run(
      JSON.stringify(WORKER_DEFAULT_LIMITS),
    );
  });
}

export function checkWorkerObservabilityJournal(db: DatabaseSync): void {
  db.prepare(
    `SELECT boot_sequence,applied_revision,applied_command_id,requested_limits,handled_revision,
    handled_command_id,handled_limits,handled_reason,pending_gap FROM worker_observation_state LIMIT 0`,
  ).all();
  db.prepare(
    `SELECT id,message_id,boot_sequence,sequence,observed_at,type,body,gap,snapshot,body_bytes,confirmed_at
    FROM worker_observation_outbox LIMIT 0`,
  ).all();
}

function order(left: Position, right: Position): number {
  return left.bootSequence - right.bootSequence || left.sequence - right.sequence;
}

function merge(left: Gap | null, right: Gap | null): Gap | null {
  if (!left || !right) return left ?? right;
  return {
    first: order(left.first, right.first) < 0 ? left.first : right.first,
    last: order(left.last, right.last) > 0 ? left.last : right.last,
    count: left.count + right.count,
  };
}

interface Decision {
  revision: number;
  id: string;
  limits: WorkerLimits;
  reason: WorkerLimitsResult['reason'];
}

interface WorkerControlState {
  bootSequence: number;
  applied: { revision: number; commandId: string | null; requested: WorkerLimits };
  handled: Decision | null;
}

export class WorkerObservabilityJournal {
  readonly #db: DatabaseSync;
  #pendingCount = 0;
  #pendingBytes = 0;
  #inFlight: number | null = null;
  #unrecorded: Gap | null = null;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  boot(): WorkerControlState {
    const pending = this.#db
      .prepare(
        `
      SELECT count(*) AS n,coalesce(sum(body_bytes),0) AS bytes
      FROM worker_observation_outbox WHERE confirmed_at IS NULL
    `,
      )
      .get();
    this.#pendingCount = Number(pending?.n);
    this.#pendingBytes = Number(pending?.bytes);
    return transaction(this.#db, () => {
      this.#db
        .prepare(
          'UPDATE worker_observation_state SET boot_sequence=boot_sequence+1 WHERE singleton=1',
        )
        .run();
      return this.control();
    });
  }

  control(): WorkerControlState {
    const row = this.#db.prepare('SELECT * FROM worker_observation_state WHERE singleton=1').get();
    if (!row) throw new Error('WORKER_OBSERVATION_STATE_MISSING');
    const bootSequence = Number(row.boot_sequence);
    const revision = Number(row.applied_revision);
    const handledRevision = Number(row.handled_revision);
    if (
      !Number.isSafeInteger(bootSequence) ||
      bootSequence < 1 ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      !Number.isSafeInteger(handledRevision) ||
      handledRevision < revision ||
      (revision > 0 && typeof row.applied_command_id !== 'string') ||
      (handledRevision > 0 && typeof row.handled_command_id !== 'string')
    )
      throw new Error('WORKER_OBSERVATION_STATE_CORRUPT');
    return {
      bootSequence,
      applied: {
        revision,
        commandId: row.applied_command_id === null ? null : String(row.applied_command_id),
        requested: parseWorkerLimits(JSON.parse(String(row.requested_limits))),
      },
      handled:
        handledRevision === 0
          ? null
          : {
              revision: handledRevision,
              id: String(row.handled_command_id),
              limits: parseWorkerLimits(JSON.parse(String(row.handled_limits))),
              reason: row.handled_reason as WorkerLimitsResult['reason'],
            },
    };
  }

  telemetry(message: WorkerTelemetry): void {
    try {
      const room = transaction(this.#db, () => {
        const room = this.#makeRoom();
        const { gap } = room;
        const lost = merge(gap, this.#unrecorded);
        const inserted = this.#insert(
          parseWorkerTelemetry(lost ? { ...message, gap: lost } : message),
          lost,
        );
        if (gap)
          this.#db
            .prepare('UPDATE worker_observation_state SET pending_gap=NULL WHERE singleton=1')
            .run();
        return { ...room, inserted };
      });
      this.#pendingCount += 1 - room.removed;
      this.#pendingBytes += room.inserted - room.bytes;
      this.#unrecorded = null;
    } catch (error) {
      const position = {
        bootSequence: message.bootSequence,
        sequence: message.sequence,
        at: message.observedAt,
      };
      this.#unrecorded = merge(this.#unrecorded, { first: position, last: position, count: 1 });
      throw error;
    }
  }

  result(message: WorkerLimitsResult, decision: Decision | null): void {
    const room = transaction(this.#db, () => {
      const room = this.#makeRoom();
      const inserted = this.#insert(parseWorkerLimitsResult(message), null);
      if (room.removed) {
        this.#db
          .prepare('UPDATE worker_observation_state SET pending_gap=? WHERE singleton=1')
          .run(JSON.stringify(room.gap));
      }
      if (decision) {
        this.#db
          .prepare(
            `
          UPDATE worker_observation_state
          SET handled_revision=?,handled_command_id=?,handled_limits=?,handled_reason=?
          WHERE singleton=1
        `,
          )
          .run(decision.revision, decision.id, JSON.stringify(decision.limits), decision.reason);
        if (!decision.reason) {
          this.#db
            .prepare(
              `
            UPDATE worker_observation_state SET applied_revision=?,applied_command_id=?,requested_limits=?
            WHERE singleton=1
          `,
            )
            .run(decision.revision, decision.id, JSON.stringify(decision.limits));
        }
      }
      return { ...room, inserted };
    });
    this.#pendingCount += 1 - room.removed;
    this.#pendingBytes += room.inserted - room.bytes;
  }

  #makeRoom(): { removed: number; bytes: number; gap: Gap | null } {
    const cached = this.#db
      .prepare('SELECT pending_gap FROM worker_observation_state WHERE singleton=1')
      .get()?.pending_gap;
    let gap = cached ? (JSON.parse(String(cached)) as Gap) : null;
    let removed = 0,
      bytes = 0;
    if (
      this.#pendingCount < maxPending &&
      this.#pendingBytes + WORKER_MAX_MESSAGE_BYTES <= maxPendingBytes
    )
      return { removed, bytes, gap };
    const oldestTelemetry = this.#db.prepare(`
      DELETE FROM worker_observation_outbox WHERE id=(
        SELECT id FROM worker_observation_outbox WHERE confirmed_at IS NULL
          AND type='worker.telemetry' AND id<>? ORDER BY id LIMIT 1
      ) RETURNING boot_sequence,sequence,observed_at,gap,body_bytes
    `);
    // A future gap carrier can increase this frame's size. Reserve one bounded frame up front.
    while (
      this.#pendingCount - removed >= maxPending ||
      this.#pendingBytes - bytes + WORKER_MAX_MESSAGE_BYTES > maxPendingBytes
    ) {
      const dropped = oldestTelemetry.get(this.#inFlight ?? 0);
      if (!dropped) throw new Error('WORKER_OBSERVATION_OUTBOX_FULL');
      const position = {
        bootSequence: Number(dropped.boot_sequence),
        sequence: Number(dropped.sequence),
        at: Number(dropped.observed_at),
      };
      const carrier = dropped.gap ? (JSON.parse(String(dropped.gap)) as Gap) : null;
      gap = merge(gap, merge(carrier, { first: position, last: position, count: 1 }));
      removed++;
      bytes += Number(dropped.body_bytes);
    }
    return { removed, bytes, gap };
  }

  #insert(message: ObservationMessage, gap: Gap | null): number {
    const body = JSON.stringify(message);
    const bytes = Buffer.byteLength(body);
    if (bytes > WORKER_MAX_MESSAGE_BYTES) throw new Error('WORKER_OBSERVATION_MESSAGE_TOO_LARGE');
    this.#db
      .prepare(
        `
      INSERT INTO worker_observation_outbox(message_id,boot_sequence,sequence,observed_at,type,body,gap,snapshot,body_bytes)
      VALUES(?,?,?,?,?,?,?,?,?)
    `,
      )
      .run(
        message.messageId,
        message.bootSequence,
        message.sequence,
        message.observedAt,
        message.type,
        body,
        gap ? JSON.stringify(gap) : null,
        message.type === 'worker.telemetry' && !message.event ? 1 : 0,
        bytes,
      );
    return bytes;
  }

  peek(fresh = false): { id: number; message: ObservationMessage } | null {
    const latest = fresh
      ? this.#db
          .prepare(
            `
      SELECT id,body FROM worker_observation_outbox WHERE confirmed_at IS NULL AND snapshot=1
      ORDER BY boot_sequence DESC,sequence DESC LIMIT 1
    `,
          )
          .get()
      : undefined;
    const row =
      latest ??
      this.#db
        .prepare(
          `
      SELECT id,body FROM worker_observation_outbox WHERE confirmed_at IS NULL AND type='worker.limits.result'
      ORDER BY id LIMIT 1
    `,
        )
        .get() ??
      this.#db
        .prepare(
          `
      SELECT id,body FROM worker_observation_outbox WHERE confirmed_at IS NULL ORDER BY id LIMIT 1
    `,
        )
        .get();
    if (!row) return null;
    const id = Number(row.id);
    const message = JSON.parse(String(row.body)) as ObservationMessage;
    this.#inFlight = id;
    return { id, message };
  }

  settled(id: number, at: number | null): void {
    this.#inFlight = null;
    if (at === null) return;
    const pending = this.#db
      .prepare(
        'SELECT body_bytes FROM worker_observation_outbox WHERE id=? AND confirmed_at IS NULL',
      )
      .get(id);
    if (!pending) return;
    // The broker owns delivery after confirmation. Keep only receipt identity for 24 hours.
    this.#db
      .prepare(
        "UPDATE worker_observation_outbox SET confirmed_at=?,body='{}',body_bytes=0,gap=NULL WHERE id=?",
      )
      .run(at, id);
    this.#pendingCount--;
    this.#pendingBytes -= Number(pending.body_bytes);
  }

  prune(now: number): void {
    this.#db
      .prepare(
        `
      DELETE FROM worker_observation_outbox WHERE id IN (
        SELECT id FROM worker_observation_outbox WHERE confirmed_at < ? ORDER BY confirmed_at LIMIT 2048
      )
    `,
      )
      .run(now - dayMs);
  }
}
