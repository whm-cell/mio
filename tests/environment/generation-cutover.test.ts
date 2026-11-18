import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { inspectGenerationCutover } from '../../scripts/service/generation-cutover.ts';
import { authDatabase } from '../support/auth-database.ts';

const probeUrl = 'https://cos.invalid/preflight';
const probeEtag = 'test-etag';
let probeBytes: Buffer | undefined;
vi.mock('../../src/integrations/cos.ts', () => ({
  createCosStorage: () => ({
    uploadUrl: () => probeUrl,
    async head() {
      const bytes = probeBytes!;
      return {
        size: bytes.length,
        etag: probeEtag,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    async readImage() {
      return probeBytes!;
    },
  }),
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  probeBytes = undefined;
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

function healthyPreflight(dataDirectory: string) {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (input === probeUrl && init?.method === 'PUT' && Buffer.isBuffer(init.body)) {
      probeBytes = Buffer.from(init.body);
      return new Response(null, { headers: { etag: probeEtag } });
    }
    if (input.startsWith('http://127.0.0.1:15672/api/queues/mio-test/'))
      return Response.json({ messages: 0, consumers: 0 });
    throw new Error('Unexpected preflight request');
  });
  return {
    dataDirectory,
    probeCos: true,
    env: {
      MIO_ASSETS_DATABASE_URL: 'postgresql://fixture/fixture',
      MIO_COS_BUCKET: 'fixture-1234',
      MIO_COS_REGION: 'ap-beijing',
      MIO_COS_SECRET_ID: 'fixture-id',
      MIO_COS_SECRET_KEY: 'fixture-key',
      MIO_ENVIRONMENT: 'test',
      MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT: '15672',
      MIO_LOCAL_RABBITMQ_PASSWORD: 'fixture-broker',
    },
  };
}

function writeJournal(
  path: string,
  rows: { jobId: string; payload: unknown; phase?: 'completed' | 'rejected' }[],
) {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      'CREATE TABLE image_attempts(job_id TEXT PRIMARY KEY,identity TEXT NOT NULL,phase TEXT NOT NULL,payload TEXT)',
    );
    const insert = database.prepare('INSERT INTO image_attempts VALUES(?,?,?,?)');
    for (const { jobId, phase, payload } of rows) {
      insert.run(
        jobId,
        'fixture',
        phase ?? 'completed',
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      );
    }
  } finally {
    database.close();
  }
  return path;
}

async function addSettledJob(pool: Pool, state: 'partial' | 'completed' | 'rejected', n?: number) {
  const jobId = randomUUID();
  const commandId = randomUUID();
  await pool.query(
    "INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state) VALUES($1,'legacy',$2,'hash',$3,$4)",
    [jobId, randomUUID(), { messageId: commandId, input: { n } }, state],
  );
  return { jobId, commandId };
}

async function addLegacyOutput(pool: Pool, jobId: string, index: number) {
  const fileId = randomUUID();
  const key = `mio/derived/${jobId}/images/${index}-${fileId}.png`;
  const output = { key, sizeBytes: 68, contentType: 'image/png' };
  const assetId = randomUUID();
  await pool.query(
    `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at,asset_kind)
     VALUES($1,'legacy','image',$2,$3,$4,'ready',now(),'derived')`,
    [assetId, output.contentType, output.sizeBytes, key],
  );
  await pool.query('INSERT INTO mio_image_outputs VALUES($1,$2,$3)', [jobId, index, assetId]);
  return { fileId, output };
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
  const job = randomUUID();
  const fileId = randomUUID();
  const journal = writeJournal(join(directory, 'journal.sqlite3'), [
    { jobId: job, payload: { attemptedFileIds: { 0: [fileId] }, outputs: [] } },
  ]);
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

it('blocks an old terminal partial when its journal is absent, empty, or belongs to another job', async () => {
  const { pool, directory } = await fixture();
  const { jobId, commandId } = await addSettledJob(pool, 'partial');
  const options = healthyPreflight(directory);
  const unrelated = writeJournal(join(directory, 'unrelated.sqlite3'), [
    { jobId: randomUUID(), payload: { commandId, expectedCount: 1, outputs: [] } },
  ]);
  const empty = writeJournal(join(directory, 'empty.sqlite3'), []);
  const wrongCommand = writeJournal(join(directory, 'wrong-command.sqlite3'), [
    { jobId, payload: { commandId: randomUUID(), expectedCount: 1, outputs: [] } },
  ]);
  const unboundEmptyArray = writeJournal(join(directory, 'old-empty-array.sqlite3'), [
    { jobId, payload: [] },
  ]);
  const otherDatabase = join(directory, 'no-image-table.sqlite3');
  new DatabaseSync(otherDatabase).close();
  for (const [name, journal] of Object.entries({
    omitted: undefined,
    missing: join(directory, 'missing.sqlite3'),
    unrelated,
    empty,
    wrongCommand,
    unboundEmptyArray,
    otherDatabase,
  })) {
    const result = await inspectGenerationCutover(pool, {
      ...options,
      ...(journal ? { journal } : {}),
    });
    expect.soft(result, name).toMatchObject({
      counts: { legacy: 1, legacyUnfinished: 0 },
      directory: 'writable',
      cos: { status: 'verified' },
      blockers: ['LEGACY_IMAGE_PARTIALS_UNRECONCILED'],
      readyForCutover: false,
    });
  }
  expect((await pool.query('SELECT state FROM mio_image_jobs WHERE id=$1', [jobId])).rows).toEqual([
    { state: 'partial' },
  ]);
});

it('reconciles a historical partial against the exact surviving original output index and asset', async () => {
  const { pool, directory } = await fixture();
  const { jobId, commandId } = await addSettledJob(pool, 'partial', 3);
  const last = await addLegacyOutput(pool, jobId, 2);
  const first = await addLegacyOutput(pool, jobId, 0);
  const options = healthyPreflight(directory);
  const payload = {
    commandId,
    expectedCount: 3,
    outputs: [first.output, last.output],
    attemptedFileIds: { 0: [first.fileId], 2: [last.fileId] },
  };
  for (const [name, saved] of Object.entries({ current: payload, olderArray: payload.outputs })) {
    const journal = writeJournal(join(directory, `${name}.sqlite3`), [{ jobId, payload: saved }]);
    const result = await inspectGenerationCutover(pool, { ...options, journal });
    expect(result, name).toMatchObject({ journal: 'idle', blockers: [], readyForCutover: true });
  }
  for (const [name, saved] of Object.entries({
    wrongCount: { ...payload, expectedCount: 4 },
    wrongKey: {
      ...payload,
      outputs: [first.output, { ...last.output, key: last.output.key.replace('/2-', '/1-') }],
      attemptedFileIds: { 0: [first.fileId], 1: [last.fileId] },
    },
    wrongSize: { ...payload, outputs: [first.output, { ...last.output, sizeBytes: 67 }] },
    wrongOrder: { ...payload, outputs: [last.output, first.output] },
  })) {
    const journal = writeJournal(join(directory, `${name}.sqlite3`), [{ jobId, payload: saved }]);
    const result = await inspectGenerationCutover(pool, { ...options, journal });
    expect(result, name).toMatchObject({
      blockers: ['LEGACY_IMAGE_PARTIALS_UNRECONCILED'],
      readyForCutover: false,
    });
  }
  expect(
    (
      await pool.query(
        'SELECT output_index FROM mio_image_outputs WHERE job_id=$1 ORDER BY output_index',
        [jobId],
      )
    ).rows,
  ).toEqual([{ output_index: 0 }, { output_index: 2 }]);
});

it('distinguishes a proven empty terminal result from one with an unconfirmed upload', async () => {
  const { pool, directory } = await fixture();
  const { jobId, commandId } = await addSettledJob(pool, 'partial');
  const options = healthyPreflight(directory);
  const payload = { commandId, expectedCount: 1, outputs: [] };
  const emptyResult = writeJournal(join(directory, 'empty-result.sqlite3'), [{ jobId, payload }]);
  expect(await inspectGenerationCutover(pool, { ...options, journal: emptyResult })).toMatchObject({
    journal: 'idle',
    blockers: [],
    readyForCutover: true,
  });

  const upload = writeJournal(join(directory, 'upload-unconfirmed.sqlite3'), [
    { jobId, payload: { ...payload, attemptedFileIds: { 0: [randomUUID()] } } },
  ]);
  expect(await inspectGenerationCutover(pool, { ...options, journal: upload })).toMatchObject({
    journal: 'unreconciled',
    blockers: ['LEGACY_IMAGE_UPLOADS_REQUIRE_RECONCILIATION'],
    readyForCutover: false,
  });
});

it('reads legacy plain-text rejections in the same journal as a proven partial', async () => {
  const { pool, directory } = await fixture();
  const partial = await addSettledJob(pool, 'partial');
  const rejected = await addSettledJob(pool, 'rejected');
  const options = healthyPreflight(directory);
  const partialRecord = {
    jobId: partial.jobId,
    payload: { commandId: partial.commandId, expectedCount: 1, outputs: [] },
  };
  const legacyRejection = writeJournal(join(directory, 'plain-rejection.sqlite3'), [
    { jobId: rejected.jobId, phase: 'rejected', payload: 'IMAGE_CREDENTIAL_UNAVAILABLE' },
    partialRecord,
  ]);
  expect(
    await inspectGenerationCutover(pool, { ...options, journal: legacyRejection }),
  ).toMatchObject({
    journal: 'idle',
    blockers: [],
    readyForCutover: true,
  });

  const damaged = writeJournal(join(directory, 'damaged-rejection.sqlite3'), [
    partialRecord,
    { jobId: rejected.jobId, phase: 'rejected', payload: 'IMAGE_BAD_PAYLOAD' },
  ]);
  expect(await inspectGenerationCutover(pool, { ...options, journal: damaged })).toMatchObject({
    journal: 'unreadable',
    blockers: ['LEGACY_IMAGE_JOURNAL_UNREADABLE'],
    readyForCutover: false,
  });
});

it('does not require a legacy journal for a fresh A site, complete history, or A-owned partials', async () => {
  const { pool, directory } = await fixture();
  const options = healthyPreflight(directory);
  expect(await inspectGenerationCutover(pool, options)).toMatchObject({
    counts: { legacy: 0, aTasks: 0 },
    journal: 'absent',
    blockers: [],
    readyForCutover: true,
  });

  const complete = await addSettledJob(pool, 'completed');
  await addLegacyOutput(pool, complete.jobId, 0);
  const aJob = await addSettledJob(pool, 'partial');
  await pool.query("INSERT INTO mio_image_executions(job_id,phase) VALUES($1,'done')", [
    aJob.jobId,
  ]);
  expect(await inspectGenerationCutover(pool, options)).toMatchObject({
    counts: { legacy: 1, aTasks: 1 },
    journal: 'absent',
    blockers: [],
    readyForCutover: true,
    rollbackRequiresAReconciliation: true,
  });
});
