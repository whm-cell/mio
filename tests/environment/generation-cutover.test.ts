import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { afterEach, expect, it } from 'vitest';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { inspectGenerationCutover } from '../../scripts/service/generation-cutover.ts';
import { authDatabase } from '../support/auth-database.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const database = await authDatabase();
  cleanup.push(() => database.close());
  const pool = new Pool({ connectionString: database.url });
  cleanup.push(() => pool.end());
  const directory = await mkdtemp(join(tmpdir(), 'mio-cutover-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await pool.query(assetSchemaSQL);
  await pool.query(generationSchemaSQL);
  await pool.query('CREATE TABLE mio_image_outbox(job_id uuid PRIMARY KEY, sent_at timestamptz)');
  return { pool, directory };
}

it('blocks legacy unknowns and pending outbox without changing historical data', async () => {
  const { pool, directory } = await fixture();
  const job = randomUUID();
  await pool.query(
    "INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state) VALUES($1,'legacy',$2,'hash','{}','unknown')",
    [job, randomUUID()],
  );
  await pool.query('INSERT INTO mio_image_outbox(job_id) VALUES($1)', [job]);
  const result = await inspectGenerationCutover(pool, { dataDirectory: directory, env: {} });
  expect(result.counts.legacyUnfinished).toBe(1);
  expect(result.blockers).toContain('LEGACY_IMAGE_TASKS_UNRECONCILED');
  expect(result.blockers).toContain('LEGACY_IMAGE_OUTBOX_PENDING');
  expect(result.blockers).toContain('LEGACY_IMAGE_RECOVERY_DATA_MISSING');
  expect(result.blockers).toContain('A_COS_ACCESS_UNVERIFIED');
  expect(result.readyForCutover).toBe(false);
  expect((await pool.query('SELECT state FROM mio_image_jobs WHERE id=$1', [job])).rows).toEqual([
    { state: 'unknown' },
  ]);
});

it('refuses a settled journal with an upload identity that has no confirmed output', async () => {
  const { pool, directory } = await fixture();
  const journal = join(directory, 'journal.sqlite3');
  const db = new DatabaseSync(journal);
  const job = randomUUID();
  const fileId = randomUUID();
  db.exec('CREATE TABLE image_attempts(job_id text,phase text,payload text)');
  db.prepare('INSERT INTO image_attempts VALUES(?,?,?)').run(
    job,
    'completed',
    JSON.stringify({ attemptedFileIds: { 0: [fileId] }, outputs: [] }),
  );
  db.close();
  const result = await inspectGenerationCutover(pool, {
    dataDirectory: directory,
    journal,
    env: {},
  });
  expect(result.journal).toBe('unreconciled');
  expect(result.blockers).toContain('LEGACY_IMAGE_UPLOADS_REQUIRE_RECONCILIATION');
  expect(result.readyForCutover).toBe(false);
  const reread = new DatabaseSync(journal, { readOnly: true });
  expect(reread.prepare('SELECT count(*) AS n FROM image_attempts').get()!.n).toBe(1);
  reread.close();
});
