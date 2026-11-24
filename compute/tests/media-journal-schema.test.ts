import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { COMPUTE_PROFILE, type ComputeCommandV1 } from '@mio/compute-contracts';
import { expect, it } from 'vitest';
import { Journal } from '../src/adapters/journal.ts';

it('opens a prior SQLite journal additively, preserving attempts and retired image records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mio-journal-media-'));
  const assetId = randomUUID();
  const command: ComputeCommandV1 = {
    version: 1,
    type: 'transcode.request',
    messageId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    profile: COMPUTE_PROFILE,
    input: { assetId, key: `mio/raw/${assetId}/${randomUUID()}`, sizeBytes: 1, etag: 'etag' },
  };
  const path = join(directory, 'journal.sqlite3');
  try {
    const fresh = new Journal(directory, 'fixture', true);
    try {
      fresh.accept(command);
      fresh.transition(command.attemptId, 'launching');
    } finally {
      fresh.close();
    }
    const previous = new DatabaseSync(path);
    try {
      // Model the version 6 floor in this fixture only, retaining every legacy table and fact.
      previous.exec(`DROP TABLE media_events; DROP TABLE media_cancellations;
        DROP TABLE media_manual_resolutions; DROP TABLE media_attempts;
        UPDATE metadata SET schema_version = 6;
        INSERT INTO image_attempts VALUES('old-image', 'old-identity', 'unknown', '{}');
        CREATE TABLE media_events (incompatible TEXT);`);
    } finally {
      previous.close();
    }
    expect(() => new Journal(directory, 'fixture')).toThrow();
    const partial = new DatabaseSync(path);
    try {
      expect(partial.prepare('SELECT schema_version FROM metadata').get()?.schema_version).toBe(6);
      expect(
        partial.prepare("SELECT name FROM sqlite_master WHERE name='media_attempts'").get(),
      ).toBeUndefined();
      partial.exec('DROP TABLE media_events');
    } finally {
      partial.close();
    }
    for (let opening = 0; opening < 2; opening++) {
      const journal = new Journal(directory, 'fixture');
      try {
        expect(journal.get(command.attemptId)).toMatchObject({ command, phase: 'launching' });
        expect(journal.hasUnknownProcess()).toBe(true);
      } finally {
        journal.close();
      }
    }
    const upgraded = new DatabaseSync(path, { readOnly: true });
    try {
      expect(upgraded.prepare('SELECT schema_version FROM metadata').get()?.schema_version).toBe(7);
      expect(upgraded.prepare('SELECT phase FROM image_attempts').get()?.phase).toBe('unknown');
      for (const table of [
        'media_attempts',
        'media_events',
        'media_cancellations',
        'media_manual_resolutions',
      ])
        expect(upgraded.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0);
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
