import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { checkGenerationSchema, generationSchemaSQL } from '../../src/generations/schema.ts';
import { checkComputeSchema, computeSchemaSQL } from '../../src/compute/schema.ts';
import { createGenerationAdmission } from '../../src/generations/admission.ts';
import { imageOutputKey } from '../../src/generations/contracts.ts';
import { GenerationStore } from '../../src/generations/store.ts';
import { generationFixture } from '../generations/fixture.ts';

it('migrates existing media tables incrementally and reads historical B jobs without claiming them', async () => {
  const f = await generationFixture();
  try {
    await f.pool.query(computeSchemaSQL);
    const job = await f.admit();
    const before = await f.store.imageGet(f.actor.userId, job.jobId);
    expect(before).toMatchObject({ requestedCount: 1, assetIds: [], outputs: [] });
    await f.pool.query('DELETE FROM mio_image_executions WHERE job_id=$1', [job.jobId]);
    await f.pool.query(generationSchemaSQL);
    await expect(checkGenerationSchema(f.pool)).resolves.toBeUndefined();
    await expect(checkComputeSchema(f.pool)).resolves.toBeUndefined();
    expect(await f.store.imageGet(f.actor.userId, job.jobId)).toEqual(before);
    expect(await f.store.claim()).toBeUndefined();
    await f.start();
    expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('accepted');
    expect(f.transport).not.toHaveBeenCalled();
    await expect(f.service.recoverImage(f.actor, job.jobId)).rejects.toMatchObject({
      code: 'RESULT_CONFLICT',
    });
  } finally {
    await f.close();
  }
});

it('reads the job state and sparse outputs on the same side of a PostgreSQL commit', async () => {
  const f = await generationFixture();
  const writer = await f.pool.connect();
  const reader = new GenerationStore(f.pool);
  try {
    const { jobId } = await f.admit(undefined, 'sparse outputs', { n: 3 });
    const later = await f.addImageSource();
    const earlier = await f.addImageSource();
    await f.pool.query("UPDATE mio_image_jobs SET state='materializing' WHERE id=$1", [jobId]);
    await f.pool.query(
      'INSERT INTO mio_image_outputs(job_id,output_index,asset_id) VALUES($1,2,$2)',
      [jobId, later.assetId],
    );

    await writer.query('BEGIN');
    await writer.query(
      'INSERT INTO mio_image_outputs(job_id,output_index,asset_id) VALUES($1,1,$2)',
      [jobId, earlier.assetId],
    );
    await writer.query("UPDATE mio_image_jobs SET state='partial' WHERE id=$1", [jobId]);
    const query = f.pool.query.bind(f.pool);
    let columns: string[] = [];
    const read = vi.spyOn(f.pool, 'query').mockImplementationOnce(async (sql, values) => {
      // Commit after PostgreSQL answers the first SELECT and before the reader can issue another.
      const result = await query(sql, values);
      columns = result.fields.map((field) => field.name);
      await writer.query('COMMIT');
      return result;
    });
    try {
      expect(await reader.imageGet(f.actor.userId, jobId)).toEqual({
        jobId,
        requestedCount: 3,
        status: 'materializing',
        errorCode: null,
        assetIds: [later.assetId],
        outputs: [{ index: 2, assetId: later.assetId }],
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(columns).toEqual(['id', 'state', 'error_code', 'requested_count', 'outputs']);
    } finally {
      read.mockRestore();
    }
    expect(await reader.imageGet(f.actor.userId, jobId)).toEqual({
      jobId,
      requestedCount: 3,
      status: 'partial',
      errorCode: null,
      assetIds: [earlier.assetId, later.assetId],
      outputs: [
        { index: 1, assetId: earlier.assetId },
        { index: 2, assetId: later.assetId },
      ],
    });
    await expect(reader.imageGet('other-owner', jobId)).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
      status: 404,
    });
  } finally {
    await writer.query('ROLLBACK').finally(() => writer.release());
    await f.close();
  }
});

it('upgrades a retained legacy state constraint before running async tasks without resubmitting history', async () => {
  const f = await generationFixture();
  try {
    const historical = await f.admit();
    await f.pool.query('DELETE FROM mio_image_executions WHERE job_id=$1', [historical.jobId]);
    const before = (
      await f.pool.query('SELECT * FROM mio_image_jobs WHERE id=$1', [historical.jobId])
    ).rows[0];
    await f.pool.query(`ALTER TABLE mio_image_jobs DROP CONSTRAINT mio_image_jobs_state_check;
      ALTER TABLE mio_image_jobs ADD CONSTRAINT mio_image_jobs_state_check
      CHECK(state IN ('accepted','materializing','completed','partial','materialization_failed','unknown','rejected'))`);
    await expect(checkGenerationSchema(f.pool)).rejects.toThrow('GENERATION_IMAGE_SCHEMA_OUTDATED');
    await f.pool.query(generationSchemaSQL);
    await f.pool.query(generationSchemaSQL);
    await expect(checkGenerationSchema(f.pool)).resolves.toBeUndefined();
    expect(
      (await f.pool.query('SELECT * FROM mio_image_jobs WHERE id=$1', [historical.jobId])).rows[0],
    ).toEqual(before);
    f.asyncTransport.query.mockResolvedValueOnce({
      state: 'processing',
      upstreamTaskId: 'original-upstream-task',
    });
    await f.start();
    const job = await f.service.createImage(f.actor, randomUUID(), f.asyncModelRef, {
      prompt: 'after legacy state upgrade',
      async: true,
    });
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('processing'),
      { timeout: 6000 },
    );
    expect(
      (
        await f.pool.query(
          'SELECT upstream_task_id,query_attempt FROM mio_image_jobs WHERE id=$1',
          [job.jobId],
        )
      ).rows[0],
    ).toEqual({
      upstream_task_id: 'original-upstream-task',
      query_attempt: 1,
    });
    await f.pool.query('UPDATE mio_image_jobs SET next_query_at=now() WHERE id=$1', [job.jobId]);
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('completed'),
      { timeout: 6000 },
    );
    expect(f.asyncTransport.submit).toHaveBeenCalledTimes(1);
    expect(f.asyncTransport.query).toHaveBeenCalledTimes(2);
    expect(f.transport).not.toHaveBeenCalled();
    expect(
      (await f.pool.query('SELECT * FROM mio_image_jobs WHERE id=$1', [historical.jobId])).rows[0],
    ).toEqual(before);
  } finally {
    await f.close();
  }
});

it('deduplicates concurrent requests before provider availability and rolls back execution insertion failures', async () => {
  const f = await generationFixture();
  try {
    const requestId = randomUUID();
    const jobs = await Promise.all(Array.from({ length: 12 }, () => f.admit(requestId)));
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(1);
    const withoutProvider = createGenerationAdmission(
      f.store,
      f.files,
      f.objects.head,
      () => undefined,
    );
    expect(
      (await withoutProvider(f.actor, requestId, f.modelRef, { prompt: 'fixture' })).jobId,
    ).toBe(jobs[0]!.jobId);
    await expect(
      withoutProvider(f.actor, requestId, f.modelRef, { prompt: 'different' }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await f.pool.query(
      "CREATE FUNCTION reject_execution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture write failure'; END $$",
    );
    await f.pool.query(
      'CREATE TRIGGER reject_execution BEFORE INSERT ON mio_image_executions FOR EACH ROW EXECUTE FUNCTION reject_execution()',
    );
    const failed = randomUUID();
    await expect(f.admit(failed)).rejects.toThrow('fixture write failure');
    expect(await f.store.imageRequest(f.actor.userId, failed)).toBeUndefined();
    expect((await f.pool.query('SELECT count(*) FROM mio_image_jobs')).rows[0].count).toBe('1');
  } finally {
    await f.close();
  }
});

it('enforces 32 active jobs per owner and 1000 globally while preserving historical idempotency', async () => {
  const f = await generationFixture();
  try {
    const results = await Promise.allSettled(Array.from({ length: 36 }, () => f.admit()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(32);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => r.status === 'rejected' && r.reason.code === 'COMPUTE_QUOTA_EXCEEDED'),
    ).toBe(true);
    const row = (await f.pool.query('SELECT * FROM mio_image_jobs LIMIT 1')).rows[0];
    await f.pool.query(
      `INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state)
      SELECT gen_random_uuid(),'other-'||i,gen_random_uuid(),'fixture',$1,'accepted' FROM generate_series(1,968) i`,
      [row.command],
    );
    const admission = createGenerationAdmission(f.store, f.files, f.objects.head, () => f.provider);
    const snapshot = await f.provider.snapshotImage(f.actor, f.modelRef);
    const next = {
      ...row.command,
      jobId: randomUUID(),
      messageId: randomUUID(),
      ownerId: 'new-owner',
    };
    await expect(
      f.store.imageCreate('new-owner', randomUUID(), 'other', next, row.admitted, snapshot),
    ).rejects.toMatchObject({ code: 'COMPUTE_QUOTA_EXCEEDED' });
    expect(
      (await admission(f.actor, row.request_id, f.modelRef, { prompt: 'fixture' })).jobId,
    ).toBe(row.id);
  } finally {
    await f.close();
  }
});

it('claims one execution atomically and ignores stale output commits without duplicating assets', async () => {
  const f = await generationFixture();
  try {
    const job = await f.admit();
    const claims = await Promise.all(Array.from({ length: 8 }, () => f.store.claim()));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const row = claims.find(Boolean)!;
    const receipt = await f.files.receive(
      row.id,
      row.command.messageId,
      1,
      [{ base64: f.bytes.toString('base64') }],
      'png',
    );
    const output = {
      key: imageOutputKey(row.id, 0, randomUUID(), 'png'),
      sizeBytes: f.bytes.length,
      sha256: createHash('sha256').update(f.bytes).digest('hex'),
      etag: 'etag',
      contentType: 'image/png',
    };
    expect(
      await f.store.acceptOutputs(
        { ...row, claim_id: randomUUID() },
        [output],
        'completed',
        receipt.ref,
      ),
    ).toBe(false);
    expect(await f.store.acceptOutputs(row, [output], 'completed', receipt.ref)).toBe(true);
    expect(await f.store.acceptOutputs(row, [output], 'completed', receipt.ref)).toBe(false);
    expect((await f.store.imageGet(f.actor.userId, job.jobId)).assetIds).toHaveLength(1);
    expect(
      (await f.pool.query('SELECT snapshot FROM mio_image_executions WHERE job_id=$1', [job.jobId]))
        .rows[0].snapshot,
    ).toBeNull();
    await expect(f.store.imageGet('other-owner', job.jobId)).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
  } finally {
    await f.close();
  }
});

it('keeps saved indices and rolls back the output batch on identity or database conflicts', async () => {
  const f = await generationFixture();
  try {
    const { jobId } = await f.admit(undefined, 'three outputs', { n: 3 });
    const initial = (await f.store.claim())!;
    const { ref } = await f.files.receive(
      jobId,
      initial.command.messageId,
      3,
      [{ base64: f.bytes.toString('base64') }],
      'png',
    );
    const output = (index: number) => ({
      key: imageOutputKey(jobId, index, randomUUID(), 'png'),
      sizeBytes: f.bytes.length,
      sha256: createHash('sha256').update(f.bytes).digest('hex'),
      etag: 'etag',
      contentType: 'image/png',
    });
    const first = output(0);
    const second = output(1);
    const saved = output(2);
    expect(await f.store.acceptOutputs(initial, [saved], 'materializing', ref)).toBe(true);
    const before = await f.store.imageGet(f.actor.userId, jobId);
    const row = (await f.store.claim())!;
    for (const changed of [
      [first, output(0)],
      [first, { ...saved, contentType: 'image/jpeg' }],
      [first, output(2)],
      [first, { ...saved, sizeBytes: saved.sizeBytes + 1 }],
    ]) {
      await expect(f.store.acceptOutputs(row, changed, 'materializing', ref)).rejects.toMatchObject(
        { code: 'RESULT_CONFLICT' },
      );
    }
    await f.pool.query(
      'ALTER TABLE mio_image_outputs ADD CONSTRAINT fixture_reject_index CHECK (output_index<>1)',
    );
    await expect(
      f.store.acceptOutputs(row, [first, second, saved], 'completed', ref),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await f.store.imageGet(f.actor.userId, jobId)).toEqual(before);
    expect((await f.pool.query('SELECT raw_key FROM mio_assets')).rows).toEqual([
      { raw_key: saved.key },
    ]);
    await f.pool.query('ALTER TABLE mio_image_outputs DROP CONSTRAINT fixture_reject_index');
    const commits = await Promise.all(
      [1, 2].map(() => f.store.acceptOutputs(row, [first, second, saved], 'completed', ref)),
    );
    expect(commits.sort()).toEqual([false, true]);

    const final = await f.store.imageGet(f.actor.userId, jobId);
    expect(final.status).toBe('completed');
    expect(final.outputs.map(({ index }) => index)).toEqual([0, 1, 2]);
    expect(final.outputs[2]).toEqual(before.outputs[0]);
    const assets = await f.pool.query(
      'SELECT id,owner_id,raw_key,content_type,size_bytes,state,asset_kind FROM mio_assets ORDER BY filename',
    );
    expect(assets.rows).toEqual(
      [first, second, saved].map((item, index) => ({
        id: final.outputs[index]!.assetId,
        owner_id: f.actor.userId,
        raw_key: item.key,
        content_type: item.contentType,
        size_bytes: String(item.sizeBytes),
        state: 'ready',
        asset_kind: 'derived',
      })),
    );
  } finally {
    await f.close();
  }
});

it('keeps a later valid output at its original index and never labels partial results complete', async () => {
  const f = await generationFixture();
  try {
    f.transport.mockResolvedValue(
      Response.json({ data: [{ b64_json: 'YmFk' }, { b64_json: f.bytes.toString('base64') }] }),
    );
    await f.start();
    const job = await f.service.createImage(f.actor, randomUUID(), f.modelRef, {
      prompt: 'partial',
      n: 2,
    });
    await vi.waitFor(
      async () => expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('partial'),
      { timeout: 6000 },
    );
    const result = await f.service.getImage(f.actor, job.jobId);
    expect(result.outputs.map((output) => output.index)).toEqual([1]);
    expect(result.assetIds).toHaveLength(1);
    await expect(f.service.recoverImage(f.actor, job.jobId)).rejects.toMatchObject({
      code: 'RESULT_CONFLICT',
    });
    await f.stop();
    await f.start();
    expect((await f.service.getImage(f.actor, job.jobId)).status).toBe('partial');
    expect(f.transport).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
