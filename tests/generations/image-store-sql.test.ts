import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { expect, it, vi } from 'vitest';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { GenerationStore } from '../../src/generations/image/store.ts';
import { VideoExecutionStore } from '../../src/generations/video/execution-store.ts';
import { cleanCompletedGeneration } from '../../src/generations/image/materialize.ts';
import { authDatabase } from '../support/auth-database.ts';
import { generationFixture } from './fixture.ts';

async function waitingImage() {
  const f = await generationFixture();
  try {
    const job = await f.admit(undefined, 'query reservation', { async: true }, true);
    const ready = (await f.store.claim())!;
    expect(ready.id).toBe(job.jobId);
    await f.store.submitting(ready);
    await f.store.submitted(ready, 'original-task');
    await f.pool.query('UPDATE mio_image_jobs SET next_query_at=now() WHERE id=$1', [ready.id]);
    const row = (await f.store.claim())!;
    expect(row.id).toBe(ready.id);
    return { f, row };
  } catch (error) {
    await f.close();
    throw error;
  }
}

it('upgrades cleanup and capacity indexes once while retaining historical rows', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(assetSchemaSQL);
    await pool.query(generationSchemaSQL);
    await pool.query(`DROP INDEX mio_image_jobs_unfinished_state;
      CREATE INDEX mio_image_jobs_unfinished ON mio_image_jobs(owner_id)
        WHERE state IN ('accepted','submitted','processing','materializing');
      DROP INDEX mio_video_executions_cleanup;`);
    const id = randomUUID();
    await pool.query(
      `INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state)
      VALUES($1,'history',$2,'original','{"old":"command"}','materialization_failed')`,
      [id, randomUUID()],
    );
    await pool.query(
      `INSERT INTO mio_image_executions(job_id,phase,checkpoint)
      VALUES($1,'done','{"file":"original","revision":3,"sha256":"original"}')`,
      [id],
    );
    const history = () =>
      pool.query(
        'SELECT to_jsonb(j) AS job,to_jsonb(e) AS execution FROM mio_image_jobs j JOIN mio_image_executions e ON e.job_id=j.id',
      );
    const indexes = () =>
      pool.query(`SELECT c.oid::text,c.relname,pg_get_indexdef(c.oid) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
      AND c.relname IN ('mio_image_jobs_unfinished','mio_image_jobs_unfinished_state','mio_video_executions_cleanup') ORDER BY c.relname`);
    const before = (await history()).rows;
    await pool.query(generationSchemaSQL);
    const upgraded = (await indexes()).rows;
    expect(upgraded.map((index) => index.relname)).toEqual([
      'mio_image_jobs_unfinished_state',
      'mio_video_executions_cleanup',
    ]);
    expect(upgraded[0].definition).toContain('(state, owner_id)');
    expect(upgraded[1].definition).toContain('(updated_at, job_id)');
    expect(upgraded[1].definition).toContain("IS DISTINCT FROM 'true'::jsonb");
    await pool.query(generationSchemaSQL);
    expect((await indexes()).rows).toEqual(upgraded);
    expect((await history()).rows).toEqual(before);
  } finally {
    await pool.end();
    await database.close();
  }
});

it('keeps video cleanup eligibility and retry scheduling after the index upgrade', async () => {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(assetSchemaSQL);
    await pool.query(generationSchemaSQL);
    const cases = [
      ['completed', 'done', { videos: [], cleaned: false }],
      ['completed', 'done', { videos: [], cleaned: true }],
      ['partial', 'done', { videos: [] }],
      ['completed', 'done', null],
      ['completed', 'materializing', { videos: [] }],
      [
        'completed',
        'done',
        { videos: [], cleanupRetryAt: new Date(Date.now() + 60_000).toISOString() },
      ],
    ] as const;
    const ids = cases.map(() => randomUUID());
    for (const [index, [state, phase, checkpoint]] of cases.entries()) {
      await pool.query(
        `INSERT INTO mio_video_jobs(id,owner_id,request_id,input_hash,command,state)
        VALUES($1,'history',$2,'original','{"old":"command"}',$3)`,
        [ids[index], randomUUID(), state],
      );
      await pool.query(
        "INSERT INTO mio_video_executions(job_id,phase,snapshot,checkpoint) VALUES($1,$2,'{}',$3)",
        [ids[index], phase, checkpoint],
      );
    }
    const execution = new VideoExecutionStore(pool, async () => {});
    expect((await execution.completedCleanup()).map((row) => row.id)).toEqual([ids[0]]);
    await execution.cleanupResult(ids[0]!, true);
    expect(await execution.completedCleanup()).toEqual([]);
    expect(
      (await pool.query('SELECT checkpoint FROM mio_video_executions WHERE job_id=$1', [ids[2]]))
        .rows[0].checkpoint,
    ).toEqual({ videos: [] });
  } finally {
    await pool.end();
    await database.close();
  }
});

it('reserves image queries in four statements and returns only changed database fields', async () => {
  const { f, row } = await waitingImage();
  const statements: string[] = [];
  const returnedColumns: string[][] = [];
  const pool = new Pool({ connectionString: f.database.url });
  pool.on('connect', (client) => {
    const query = client.query;
    vi.spyOn(client, 'query').mockImplementation(function (this: PoolClient, ...args: unknown[]) {
      statements.push(typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text);
      return Reflect.apply(query, this, args).then((result: QueryResult) => {
        returnedColumns.push(result.fields.map((field) => field.name));
        return result;
      });
    });
  });
  const store = new GenerationStore(pool);
  try {
    await f.pool.query('UPDATE mio_image_jobs SET query_attempt=1 WHERE id=$1', [row.id]);
    const reserved = await store.beginQuery(row);
    expect(reserved).toEqual({ ...row, phase: 'querying', query_attempt: 2 });
    expect(reserved?.command).toBe(row.command);
    expect(row.phase).toBe('waiting');
    expect(row.query_attempt).toBe(0);
    expect(statements).toHaveLength(4);
    expect(returnedColumns[2]).toEqual(['phase', 'query_attempt']);
    expect(await store.beginQuery(row)).toBeUndefined();
    expect(
      (await f.pool.query('SELECT query_attempt FROM mio_image_jobs WHERE id=$1', [row.id])).rows[0]
        .query_attempt,
    ).toBe(2);
    statements.length = 0;
    returnedColumns.length = 0;
    await store.imageRecover(f.actor.userId, row.id);
    expect(statements).toHaveLength(5);
    expect(returnedColumns[3]).toEqual(['state', 'upstream_task_id', 'active_recovery_seq']);
  } finally {
    await store.close();
    await f.close();
  }
});

it('spends exactly one attempt for concurrent image query reservations', async () => {
  const { f, row } = await waitingImage();
  try {
    const results = await Promise.all([f.store.beginQuery(row), f.store.beginQuery(row)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      (await f.pool.query('SELECT query_attempt FROM mio_image_jobs WHERE id=$1', [row.id])).rows[0]
        .query_attempt,
    ).toBe(1);
  } finally {
    await f.close();
  }
});

it.each([
  'UPDATE mio_image_executions SET claim_id=gen_random_uuid() WHERE job_id=$1',
  "UPDATE mio_image_executions SET phase='done' WHERE job_id=$1",
  'UPDATE mio_image_jobs SET upstream_task_id=NULL WHERE id=$1',
  'UPDATE mio_image_jobs SET query_attempt=async_max_queries WHERE id=$1',
  "UPDATE mio_image_jobs SET async_deadline=now()-interval '1 second' WHERE id=$1",
  "UPDATE mio_image_jobs SET command=jsonb_set(command,'{expiresAt}','0') WHERE id=$1",
])('does not reserve a stale or ineligible image query: %s', async (sql) => {
  const { f, row } = await waitingImage();
  try {
    await f.pool.query(sql, [row.id]);
    const state = () =>
      f.pool.query(
        'SELECT j.query_attempt,e.phase,e.claim_id FROM mio_image_jobs j JOIN mio_image_executions e ON e.job_id=j.id WHERE j.id=$1',
        [row.id],
      );
    const before = (await state()).rows;
    expect(await f.store.beginQuery(row)).toBeUndefined();
    expect((await state()).rows).toEqual(before);
    expect(row.phase).toBe('waiting');
    expect(row.query_attempt).toBe(0);
  } finally {
    await f.close();
  }
});

it('rolls back the reserved attempt if the image execution update fails', async () => {
  const { f, row } = await waitingImage();
  try {
    await f.pool.query(`CREATE FUNCTION reject_query_phase() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture phase write failed'; END $$;
      CREATE TRIGGER reject_query_phase BEFORE UPDATE ON mio_image_executions FOR EACH ROW
      WHEN (NEW.phase='querying') EXECUTE FUNCTION reject_query_phase();`);
    await expect(f.store.beginQuery(row)).rejects.toThrow('fixture phase write failed');
    expect(
      (
        await f.pool.query(
          'SELECT j.query_attempt,e.phase FROM mio_image_jobs j JOIN mio_image_executions e ON e.job_id=j.id WHERE j.id=$1',
          [row.id],
        )
      ).rows,
    ).toEqual([{ query_attempt: 0, phase: 'waiting' }]);
  } finally {
    await f.close();
  }
});

it('rechecks the image deadline after waiting for the execution lock', async () => {
  const { f, row } = await waitingImage();
  const blocker = await f.pool.connect();
  const targetUrl = new URL(f.database.url);
  const application = f.database.applicationName + '_reservation';
  targetUrl.searchParams.set('application_name', application);
  const target = new GenerationStore(new Pool({ connectionString: targetUrl.toString() }));
  let reservation: ReturnType<typeof target.beginQuery> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT job_id FROM mio_image_executions WHERE job_id=$1 FOR UPDATE', [
      row.id,
    ]);
    reservation = target.beginQuery(row);
    await vi.waitFor(async () =>
      expect(
        (
          await f.pool.query(
            'SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1',
            [application],
          )
        ).rows[0]?.wait_event_type,
      ).toBe('Lock'),
    );
    await blocker.query(
      "UPDATE mio_image_jobs SET async_deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
      [row.id],
    );
    await blocker.query('COMMIT');
    expect(await reservation).toBeUndefined();
    expect(
      (
        await f.pool.query(
          'SELECT j.query_attempt,e.phase FROM mio_image_jobs j JOIN mio_image_executions e ON e.job_id=j.id WHERE j.id=$1',
          [row.id],
        )
      ).rows,
    ).toEqual([{ query_attempt: 0, phase: 'waiting' }]);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await reservation;
    await target.close();
    await f.close();
  }
});

it('retains completed image recovery files after a retry used two physical keys', async () => {
  const f = await generationFixture();
  const put = f.objects.putImage!;
  let puts = 0;
  f.objects.putImage = vi.fn<typeof put>(async (...args) => {
    if (++puts === 1) throw new Error('fixture unknown first PUT');
    return put(...args);
  });
  const clean = vi.spyOn(f.files, 'clean');
  try {
    const service = await f.start();
    const job = await service.createImage(f.actor, randomUUID(), f.modelRef, {
      prompt: 'completed retry retention',
    });
    await vi.waitFor(
      async () => expect((await service.getImage(f.actor, job.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    await f.stop();
    const row = (await f.store.completedCleanup()).find((candidate) => candidate.id === job.jobId)!;
    const saved = (await f.files.load(row.id, row.command.messageId, 1, row.checkpoint!))!;
    expect(saved.checkpoint.attemptedKeys[0]).toHaveLength(2);
    vi.mocked(f.objects.head).mockClear();
    await cleanCompletedGeneration(
      row,
      f.store,
      f.files,
      f.objects.head,
      new AbortController().signal,
    );
    expect(f.objects.head).not.toHaveBeenCalled();
    expect(clean).not.toHaveBeenCalled();
    expect(await f.files.read(row.id, saved.checkpoint.images[0]!)).toEqual(f.bytes);
    expect((await f.store.completedCleanup()).map((candidate) => candidate.id)).toContain(row.id);
    expect(f.transport).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
