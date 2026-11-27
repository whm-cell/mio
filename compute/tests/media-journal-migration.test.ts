import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MEDIA_PROFILE,
  MEDIA_VERSION,
  COMPUTE_PROFILE,
  mediaObjectPrefix,
} from '@mio/compute-contracts';
import type { MediaCommand, MediaResult } from '@mio/compute-contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { Journal } from '../src/adapters/journal.ts';
import { MediaJournal, mediaIdentity } from '../src/adapters/media-journal.ts';
import type {
  MediaAttempt,
  MediaPhase,
  MediaUploadCheckpoint,
} from '../src/adapters/media-journal.ts';
import { migrateMediaUploads } from '../src/adapters/media-journal-schema.ts';
import { mediaJournalV8Schema } from './media-journal-v8-fixture.ts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function historical() {
  const directory = mkdtempSync(join(tmpdir(), 'mio-media-v8-'));
  roots.push(directory);
  const path = join(directory, 'journal.sqlite3');
  writeFileSync(path, '', { mode: 0o600 });
  const db = new DatabaseSync(path);
  db.exec(mediaJournalV8Schema);
  return { directory, path, db };
}
function command(jobId = randomUUID(), attempt: 1 | 2 | 3 = 1): MediaCommand {
  const assetId = randomUUID();
  return {
    version: MEDIA_VERSION,
    type: 'media.request',
    messageId: randomUUID(),
    jobId,
    attemptId: randomUUID(),
    attempt,
    profile: MEDIA_PROFILE,
    operation: 'video.trim',
    inputs: [
      { assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 3, etag: 'historical' },
    ],
    parameters: { startSeconds: 0, endSeconds: 2 },
  };
}
function upload(
  c: MediaCommand,
  name: string,
  state: MediaUploadCheckpoint['state'],
): MediaUploadCheckpoint {
  const file = { name, role: 'segment' as const, contentType: 'video/mp2t' };
  const key = mediaObjectPrefix(c.jobId, c.attemptId) + name;
  const digest = { size: 7, sha256: 'a'.repeat(64) };
  return {
    file,
    key,
    digest,
    state,
    object:
      state === 'confirmed'
        ? { ...file, key, sizeBytes: 7, sha256: digest.sha256, etag: 'historical' }
        : null,
  };
}
function attempt(phase: MediaPhase, c = command()): MediaAttempt {
  const step = { id: 'encode', tool: 'ffmpeg' as const, args: ['-v', 'error'] };
  return {
    command: c,
    phase,
    startedAt: 42,
    steps: {
      encode: {
        identity: mediaIdentity(step),
        step,
        state: 'complete',
        pid: null,
        processIdentity: null,
        exitCode: 0,
        signal: null,
        outputs: { 'z.ts': { size: 7, sha256: 'a'.repeat(64) } },
        result: { stdout: '', diagnostic: 'historical checkpoint' },
        reusedFromAttemptId: randomUUID(),
      },
    },
    inputs: { 'input-0': { size: 3, sha256: 'b'.repeat(64) } },
    uploads: {
      'z.ts': upload(c, 'z.ts', 'intent'),
      'a.ts': upload(c, 'a.ts', 'confirmed'),
      'rejected.ts': upload(c, 'rejected.ts', 'rejected'),
    },
    result: { files: [{ name: 'z.ts', role: 'segment', contentType: 'video/mp2t' }], data: {} },
    ackDispatched: true,
    ...(phase === 'reconciling' ? { unknownCode: 'UPLOAD_UNKNOWN' as const } : {}),
  };
}
function insert(db: DatabaseSync, value: MediaAttempt) {
  db.prepare('INSERT INTO media_attempts(attempt_id,command_id,identity,body) VALUES(?,?,?,?)').run(
    value.command.attemptId,
    value.command.messageId,
    mediaIdentity(value.command),
    JSON.stringify(value),
  );
}
function event(a: MediaAttempt): MediaResult {
  return {
    version: MEDIA_VERSION,
    type: 'media.result',
    messageId: randomUUID(),
    commandId: a.command.messageId,
    jobId: a.command.jobId,
    attemptId: a.command.attemptId,
    attempt: a.command.attempt,
    state: 'failed',
    errorCode: 'WORKER_INTERRUPTED',
  };
}

it('upgrades a complete historical v8 database, preserving all phases, receipts, checkpoints and replay authorities', () => {
  const { directory, path, db } = historical();
  const phases: MediaPhase[] = [
    'received',
    'downloading',
    'executing',
    'output_ready',
    'uploading',
    'reconciling',
    'succeeded',
    'failed',
    'cancelled',
  ];
  const values = phases.map((phase) => attempt(phase));
  values.push(
    { ...attempt('succeeded'), cleaned: true },
    { ...attempt('received'), cleaned: true },
  );
  for (const value of values) insert(db, value);
  const cancelled = values[8]!;
  db.prepare('INSERT INTO media_cancellations VALUES(?,?,?)').run(
    cancelled.command.attemptId,
    cancelled.command.jobId,
    randomUUID(),
  );
  db.prepare('INSERT INTO media_manual_resolutions VALUES(?,?,?)').run(
    cancelled.command.attemptId,
    'old explicit resolution',
    99,
  );
  db.exec("INSERT INTO image_attempts VALUES('retired','identity','unknown','{\"unknown\":true}')");
  db.exec(
    "INSERT INTO worker_observation_outbox(message_id,boot_sequence,sequence,observed_at,type,body) VALUES('old-observation',2,3,42,'worker.telemetry','{}')",
  );
  const transcodeAsset = randomUUID();
  const transcode = {
    version: 1,
    type: 'transcode.request',
    messageId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    profile: COMPUTE_PROFILE,
    input: {
      assetId: transcodeAsset,
      key: `mio/raw/${transcodeAsset}/${randomUUID()}`,
      sizeBytes: 1,
      etag: 'old',
    },
  };
  db.prepare(
    "INSERT INTO attempts(attempt_id,command_id,command_json,phase,started_at) VALUES(?,?,?,'launching',42)",
  ).run(transcode.attemptId, transcode.messageId, JSON.stringify(transcode));
  const target = values[9]!,
    first = event(target),
    second = event(target);
  const writeEvent = db.prepare(
    'INSERT INTO media_events(sequence,message_id,attempt_id,body) VALUES(?,?,?,?)',
  );
  writeEvent.run(20, second.messageId, target.command.attemptId, JSON.stringify(second));
  writeEvent.run(5, first.messageId, target.command.attemptId, JSON.stringify(first));
  db.close();
  for (let opening = 0; opening < 2; opening++) {
    const journal = new Journal(directory, 'fixture');
    try {
      for (const value of values) {
        expect(journal.media.get(value.command.attemptId)).toEqual(value);
        expect(Object.keys(journal.media.get(value.command.attemptId)!.uploads)).toEqual([
          'z.ts',
          'a.ts',
          'rejected.ts',
        ]);
      }
      expect(journal.get(transcode.attemptId)).toMatchObject({
        command: transcode,
        phase: 'launching',
      });
      const sorted = (items: MediaAttempt[]) => items.map((v) => v.command.attemptId).sort();
      const terminal = (v: MediaAttempt) => ['succeeded', 'failed', 'cancelled'].includes(v.phase);
      expect(sorted(journal.media.unfinished())).toEqual(
        sorted(values.filter((v) => !terminal(v))),
      );
      expect(sorted(journal.media.cleanupCandidates())).toEqual(
        sorted(values.filter((v) => terminal(v) && !v.cleaned)),
      );
      expect(sorted(journal.media.recoverable())).toEqual(
        sorted(values.filter((v) => !terminal(v) || !v.cleaned || v === target)),
      );
      expect(journal.media.pending(target.command.attemptId)).toEqual(first);
      expect(journal.media.cancelled(cancelled.command.attemptId)).toBe(true);
    } finally {
      journal.close();
    }
  }
  const journal = new Journal(directory, 'fixture');
  journal.media.confirm(first.messageId);
  expect(journal.media.pending(target.command.attemptId)).toEqual(second);
  journal.media.confirm(second.messageId);
  journal.close();
  const reopened = new Journal(directory, 'fixture');
  expect(reopened.media.pending(target.command.attemptId)).toBeNull();
  reopened.close();
  const check = new DatabaseSync(path);
  try {
    expect(check.prepare('SELECT schema_version FROM metadata').get()?.schema_version).toBe(9);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
    expect(
      check
        .prepare("SELECT json_extract(body,'$.uploads') AS uploads FROM media_attempts LIMIT 1")
        .get()?.uploads,
    ).toBeNull();
    expect(check.prepare('SELECT count(*) AS n FROM media_uploads').get()?.n).toBe(
      values.length * 3,
    );
    expect(check.prepare('SELECT count(*) AS n FROM media_events').get()?.n).toBe(2);
    expect(check.prepare('SELECT evidence FROM media_manual_resolutions').get()?.evidence).toBe(
      'old explicit resolution',
    );
    expect(check.prepare('SELECT phase FROM image_attempts').get()?.phase).toBe('unknown');
    expect(
      check.prepare('SELECT message_id FROM worker_observation_outbox').get()?.message_id,
    ).toBe('old-observation');
  } finally {
    check.close();
  }
});

it.each([3, 4, 5, 6, 7, 8])(
  'retains the historical v%s admission/migration path and reopens at v9',
  (version) => {
    const { directory, path, db } = historical();
    // Remove only tables introduced after the selected historical floor, using the baseline migration history.
    if (version < 8)
      db.exec('DROP TABLE worker_observation_outbox; DROP TABLE worker_observation_state');
    if (version < 7)
      db.exec(
        'DROP TABLE media_events; DROP TABLE media_cancellations; DROP TABLE media_manual_resolutions; DROP TABLE media_attempts',
      );
    if (version < 5) db.exec('DROP TABLE image_attempts');
    if (version === 3) db.exec('ALTER TABLE attempts RENAME COLUMN ack_dispatched TO acknowledged');
    db.prepare('UPDATE metadata SET schema_version=?').run(version);
    db.close();
    for (let i = 0; i < 2; i++) new Journal(directory, 'fixture').close();
    const current = new DatabaseSync(path);
    try {
      expect(current.prepare('SELECT schema_version FROM metadata').get()?.schema_version).toBe(9);
    } finally {
      current.close();
    }
  },
);

it('rolls back the entire v8 migration when a historical receipt cannot be represented', () => {
  const { directory, path, db } = historical();
  const value = attempt('reconciling');
  value.uploads['z.ts']!.state = 'invalid' as MediaUploadCheckpoint['state'];
  insert(db, value);
  db.close();
  expect(() => new Journal(directory, 'fixture')).toThrow();
  const prior = new DatabaseSync(path);
  try {
    expect(prior.prepare('SELECT schema_version FROM metadata').get()?.schema_version).toBe(8);
    expect(
      prior.prepare("SELECT name FROM sqlite_master WHERE name='media_uploads'").get(),
    ).toBeUndefined();
    expect(
      prior
        .prepare('PRAGMA table_info(media_attempts)')
        .all()
        .map((c) => c.name),
    ).toEqual(['attempt_id', 'command_id', 'identity', 'body']);
    expect(
      JSON.parse(String(prior.prepare('SELECT body FROM media_attempts').get()?.body)),
    ).toEqual(value);
  } finally {
    prior.close();
  }
});

it('keeps indexed selection at two reads regardless of candidate count and preserves retry checkpoint rules', () => {
  const { db } = historical();
  const failed = attempt('failed');
  for (let i = 0; i < 24; i++) insert(db, attempt(i % 2 ? 'failed' : 'executing'));
  insert(db, failed);
  migrateMediaUploads(db);
  const journal = new MediaJournal(db);
  try {
    const prepared = vi.spyOn(db, 'prepare');
    expect(journal.cleanupCandidates()).toHaveLength(13);
    expect(prepared).toHaveBeenCalledTimes(2);
    prepared.mockRestore();
    const cleanupPlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM media_attempts WHERE phase IN ('succeeded','failed','cancelled') AND cleaned=0 ORDER BY attempt_id",
      )
      .all();
    const unfinishedPlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM media_attempts WHERE phase NOT IN ('succeeded','failed','cancelled') ORDER BY attempt_id",
      )
      .all();
    const uploadPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT attempt_id,name,state,body FROM media_uploads
      WHERE attempt_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
      )
      .all(JSON.stringify([failed.command.attemptId]));
    process.stdout.write(
      'B07 SQLite index plans ' +
        JSON.stringify({ cleanupPlan, unfinishedPlan, uploadPlan }) +
        '\n',
    );
    expect(cleanupPlan.some((row) => String(row.detail).includes('media_attempts_cleanup'))).toBe(
      true,
    );
    expect(
      unfinishedPlan.some((row) => String(row.detail).includes('media_attempts_unfinished')),
    ).toBe(true);
    const retry = {
      ...failed.command,
      attempt: 2 as const,
      attemptId: randomUUID(),
      messageId: randomUUID(),
    };
    expect(journal.checkpointSource(retry)).toEqual(failed);
    journal.accept(retry);
    expect(journal.predecessors(retry)).toEqual([failed]);
    failed.cleaned = true;
    journal.save(failed);
    expect(journal.checkpointSource(retry)).toBeNull();
    expect(journal.accept(retry).command).toEqual(retry);
    expect(() => journal.accept({ ...retry, messageId: randomUUID() })).toThrow('ATTEMPT_CONFLICT');
  } finally {
    db.close();
  }
});

it('keeps upload order and phase/event atomicity across receipt writes, failed snapshots and process exit', () => {
  const { directory, path, db } = historical();
  const value = attempt('reconciling');
  insert(db, value);
  db.close();
  const journal = new Journal(directory, 'fixture');
  try {
    const updated = journal.media.get(value.command.attemptId)!;
    updated.uploads['z.ts']!.state = 'confirmed';
    journal.media.saveUpload(updated, 'z.ts');
    expect(Object.keys(journal.media.get(value.command.attemptId)!.uploads)).toEqual(
      Object.keys(value.uploads),
    );
    const conflict = { ...updated, command: { ...updated.command, messageId: randomUUID() } };
    expect(() => journal.media.saveUpload(conflict, 'z.ts')).toThrow('JOURNAL_MEDIA_WRITE_FAILED');
    const committed = journal.media.get(value.command.attemptId)!;
    const result = event(updated);
    journal.media.transition(updated, 'failed', result);
    const before = journal.media.get(value.command.attemptId)!;
    expect(() => journal.media.transition(updated, 'cancelled', result)).toThrow();
    expect(journal.media.get(value.command.attemptId)).toEqual(before);
    const bad = {
      ...committed,
      uploads: {
        ...committed.uploads,
        invalid: {
          ...committed.uploads['a.ts']!,
          state: 'invalid' as MediaUploadCheckpoint['state'],
        },
      },
    };
    expect(() => journal.media.save(bad)).toThrow();
    expect(journal.media.get(value.command.attemptId)).toEqual(before);
  } finally {
    journal.close();
  }
  const before = new Journal(directory, 'fixture');
  const snapshot = before.media.get(value.command.attemptId)!;
  before.close();
  // Real process exit with an uncommitted phase, receipt and event on the same WAL file.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    db.prepare("UPDATE media_attempts SET phase='cancelled',body=json_set(body,'$.phase','cancelled') WHERE attempt_id=?").run(process.argv[2]);
    db.prepare("UPDATE media_uploads SET state='intent',body=json_set(body,'$.state','intent') WHERE attempt_id=?").run(process.argv[2]);
    db.prepare("INSERT INTO media_events(message_id,attempt_id,body) VALUES('uncommitted',?,'{}')").run(process.argv[2]);
    process.exit(0);
  `,
      path,
      value.command.attemptId,
    ],
    { stdio: 'pipe' },
  );
  const recovered = new Journal(directory, 'fixture');
  try {
    expect(recovered.media.get(value.command.attemptId)).toEqual(snapshot);
  } finally {
    recovered.close();
  }
  const check = new DatabaseSync(path);
  try {
    expect(
      check.prepare("SELECT 1 FROM media_events WHERE message_id='uncommitted'").get(),
    ).toBeUndefined();
  } finally {
    check.close();
  }
});
