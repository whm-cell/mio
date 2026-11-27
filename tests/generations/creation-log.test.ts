import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { GenerationStore } from '../../src/generations/image/store.ts';
import type { VideoGenerationStore } from '../../src/generations/video/store.ts';
import type { GenerationExecution } from '../../src/generations/image/execution.ts';
import type { VideoExecution } from '../../src/generations/video/execution.ts';
import { createCreationLogStore } from '../../src/notifications/creation-store.ts';

let db: Awaited<ReturnType<typeof authDatabase>>,
  pool: Pool,
  images: GenerationStore,
  videos: VideoGenerationStore;
let feed: Awaited<ReturnType<typeof createCreationLogStore>>;
beforeAll(async () => {
  db = await authDatabase();
  pool = new Pool({ connectionString: db.url });
  await pool.query(assetSchemaSQL);
  await pool.query(generationSchemaSQL);
  images = new GenerationStore(new Pool({ connectionString: db.url }));
  videos = images.videoStore();
  feed = await createCreationLogStore(db.url, () => null);
});
afterAll(async () => {
  await feed?.close();
  await images?.close();
  await pool?.end();
  await db?.close();
});
async function image() {
  const id = randomUUID(),
    claim = randomUUID();
  await pool.query(
    `INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state) VALUES($1,'same-owner',$2,'hash',$3::jsonb,'materializing');`,
    [id, randomUUID(), JSON.stringify({ input: { n: 2 } })],
  );
  await pool.query(
    "INSERT INTO mio_image_executions(job_id,phase,claim_id) VALUES($1,'materializing',$2)",
    [id, claim],
  );
  return {
    id,
    owner_id: 'same-owner',
    claim_id: claim,
    command: { input: { n: 2 } },
  } as GenerationExecution;
}
async function video() {
  const id = randomUUID(),
    claim = randomUUID();
  await pool.query(
    `INSERT INTO mio_video_jobs(id,owner_id,request_id,input_hash,command,admitted,route_snapshot,state)
    VALUES($1,'same-owner',$2,'hash','{}','{}','{}','materializing')`,
    [id, randomUUID()],
  );
  await pool.query(
    "INSERT INTO mio_video_executions(job_id,phase,claim_id,snapshot) VALUES($1,'materializing',$2,'{}')",
    [id, claim],
  );
  return {
    id,
    owner_id: 'same-owner',
    claim_id: claim,
    checkpoint: { videos: [{ url: 'https://fixture.invalid/video' }] },
  } as VideoExecution;
}
const ref = { file: 'fixture.json', sha256: 'a'.repeat(64), revision: 1 };
function output(id: string, index: number) {
  return {
    key: `mio/generated/${id}/${index}.png`,
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    etag: 'etag',
    contentType: 'image/png',
  };
}

it('commits image outputs and distinct partial/completed results together, preserves identity/time on repeat and rolls back a message failure', async () => {
  const row = await image();
  // Generated keys follow the existing public output-key convention.
  const { imageOutputKey } = await import('../../src/generations/image/contracts.ts');
  const first = { ...output(row.id, 0), key: imageOutputKey(row.id, 0, randomUUID(), 'png') };
  await pool.query(`CREATE FUNCTION fail_image_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture log failure'; END $$;
    CREATE TRIGGER fail_image_log BEFORE INSERT ON mio_creation_logs FOR EACH ROW EXECUTE FUNCTION fail_image_log()`);
  await expect(images.acceptOutputs(row, [first], 'partial', ref)).rejects.toThrow(
    'fixture log failure',
  );
  expect(
    (await pool.query('SELECT * FROM mio_image_outputs WHERE job_id=$1', [row.id])).rowCount,
  ).toBe(0);
  expect(
    (await pool.query('SELECT state FROM mio_image_jobs WHERE id=$1', [row.id])).rows[0].state,
  ).toBe('materializing');
  await pool.query(
    'DROP TRIGGER fail_image_log ON mio_creation_logs;DROP FUNCTION fail_image_log()',
  );
  expect(await images.acceptOutputs(row, [first], 'partial', ref)).toBe(true);
  const partial = (await pool.query('SELECT * FROM mio_creation_logs WHERE job_id=$1', [row.id]))
    .rows[0];
  await pool.query(
    "UPDATE mio_image_executions SET claim_id=$2,phase='materializing' WHERE job_id=$1",
    [row.id, row.claim_id],
  );
  expect(await images.acceptOutputs(row, [first], 'partial', ref)).toBe(true);
  expect(
    (await pool.query('SELECT * FROM mio_creation_logs WHERE job_id=$1', [row.id])).rows[0],
  ).toEqual(partial);
  await pool.query(
    "UPDATE mio_image_executions SET claim_id=$2,phase='materializing' WHERE job_id=$1",
    [row.id, row.claim_id],
  );
  await images.acceptOutputs(
    row,
    [first, { ...output(row.id, 1), key: imageOutputKey(row.id, 1, randomUUID(), 'png') }],
    'completed',
    ref,
  );
  expect(
    (
      await pool.query(
        'SELECT event_kind FROM mio_creation_logs WHERE job_id=$1 ORDER BY event_kind',
        [row.id],
      )
    ).rows,
  ).toEqual([{ event_kind: 'completed' }, { event_kind: 'partial' }]);
});

it('omits unknown and recoverable image states and records only definitive failure', async () => {
  for (const [state, code, expected] of [
    ['unknown', 'IMAGE_SUBMISSION_UNKNOWN', 0],
    ['materialization_failed', null, 0],
    ['failed', 'IMAGE_QUERY_LIMIT', 0],
    ['failed', 'IMAGE_UPSTREAM_REJECTED', 1],
  ] as const) {
    const row = await image();
    await images.terminal(row, state, code);
    expect(
      (await pool.query('SELECT * FROM mio_creation_logs WHERE job_id=$1', [row.id])).rowCount,
    ).toBe(expected);
  }
});

it('uses registered video output facts for partial then completed and atomically rolls back final result on log failure', async () => {
  const row = await video();
  const asset = randomUUID();
  await pool.query(
    `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,raw_key,state,expires_at) VALUES($1,'same-owner','v.mp4','video/mp4',10,'private-video','ready',now())`,
    [asset],
  );
  await pool.query(
    "INSERT INTO mio_video_outputs(job_id,output_index,asset_id,phase) VALUES($1,0,$2,'registered')",
    [row.id, asset],
  );
  await pool.query(`CREATE FUNCTION fail_video_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture log failure'; END $$;
    CREATE TRIGGER fail_video_log BEFORE INSERT ON mio_creation_logs FOR EACH ROW EXECUTE FUNCTION fail_video_log()`);
  await expect(videos.executorStore().terminal(row, 'partial', null)).rejects.toThrow(
    'fixture log failure',
  );
  expect(
    (await pool.query('SELECT state FROM mio_video_jobs WHERE id=$1', [row.id])).rows[0].state,
  ).toBe('materializing');
  await pool.query(
    'DROP TRIGGER fail_video_log ON mio_creation_logs;DROP FUNCTION fail_video_log()',
  );
  expect(await videos.executorStore().terminal(row, 'partial', null)).toBe(true);
  await pool.query(
    "UPDATE mio_video_executions SET claim_id=$2,phase='materializing' WHERE job_id=$1",
    [row.id, row.claim_id],
  );
  expect(await videos.executorStore().terminal(row, 'completed', null)).toBe(true);
  expect(
    (
      await pool.query(
        'SELECT event_kind FROM mio_creation_logs WHERE job_id=$1 ORDER BY event_kind',
        [row.id],
      )
    ).rows,
  ).toEqual([{ event_kind: 'completed' }, { event_kind: 'partial' }]);
  await feed.receiveAudio(randomUUID(), {
    ownerId: 'same-owner',
    jobId: randomUUID(),
    mediaType: 'audio',
    eventKind: 'completed',
    title: '音频完成',
    summary: '作品已发布',
    occurredAt: new Date().toISOString(),
  });
  expect(new Set((await feed.list('same-owner', 1, 100)).items.map((x) => x.mediaType))).toEqual(
    new Set(['image', 'video', 'audio']),
  );
});

it('does not publish video unknown/recoverable/query-limit failures; invalid routes create one definitive result', async () => {
  for (const [state, code, expected] of [
    ['unknown', 'VIDEO_SUBMISSION_UNKNOWN', 0],
    ['materialization_failed', 'VIDEO_MATERIALIZATION_FAILED', 0],
    ['failed', 'VIDEO_QUERY_LIMIT', 0],
    ['failed', 'VIDEO_UPSTREAM_REJECTED', 1],
  ] as const) {
    const row = await video();
    await videos.executorStore().terminal(row, state, code);
    expect(
      (await pool.query('SELECT * FROM mio_creation_logs WHERE job_id=$1', [row.id])).rowCount,
    ).toBe(expected);
  }
  const row = await video();
  await videos.executorStore().settleInvalidRoute(row, 'rejected', 'VIDEO_INPUT_INVALID');
  await videos.executorStore().settleInvalidRoute(row, 'rejected', 'VIDEO_INPUT_INVALID');
  expect(
    (await pool.query('SELECT * FROM mio_creation_logs WHERE job_id=$1', [row.id])).rowCount,
  ).toBe(1);
});
