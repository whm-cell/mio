import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { authDatabase } from '../support/auth-database.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { AssetStore } from '../../src/assets/store.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { createAudioJobService } from '../../src/audio/jobs/service.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { submitAudio } from '../../src/integrations/onelink/audio.ts';
import type { downloadAudio } from '../../src/integrations/onelink/audio.ts';
import type { AudioJobRow } from '../../src/audio/jobs/store.ts';
import { AudioError } from '../../src/audio/contracts.ts';
import type { AudioInspectionInput, AudioInspection } from '@mio/compute-contracts';
import { AudioMediaError } from '../../src/audio/media.ts';

const parameters = { speed: 1, volume: 1, pitch: 0, format: 'wav' as const };
const capabilities = {
  speed: { min: 0.5, max: 2, default: 1 },
  volume: { min: 0.01, max: 10, default: 1 },
  pitch: { min: -12, max: 12, default: 0 },
  formats: ['wav', 'mp3'],
  defaultFormat: 'wav',
  textMaxCodePoints: 10000,
  textMaxBytes: 81920,
  sampleMaxBytes: 20971520,
  sampleMinSeconds: 10,
  sampleMaxSeconds: 300,
};
let database: Awaited<ReturnType<typeof authDatabase>>,
  assetDatabase: Awaited<ReturnType<typeof authDatabase>>,
  pool: Pool,
  assetPool: Pool;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  database = await authDatabase();
  assetDatabase = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  assetPool = new Pool({ connectionString: assetDatabase.url });
  await assetPool.query(assetSchemaSQL);
  await pool.query(providerSchemaSQL);
  await pool.query(providerSchemaSQL);
}, 30000);
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
afterAll(async () => {
  await pool?.end();
  await assetPool?.end();
  await database?.close();
  await assetDatabase?.close();
});
async function fixture() {
  const modelId = 'audio-job-' + randomUUID(),
    otherModelId = 'audio-other-' + randomUUID(),
    config = { databaseURL: database.url, masterKey: randomBytes(32), masterKeyId: 'audio-test' };
  const store = await createProviderStore(config),
    actor = { userId: randomUUID(), sessionId: 'synthetic-session' };
  const providers = createProviderService(store, config, async () =>
    Response.json({ data: [{ id: modelId }, { id: otherModelId }] }),
  );
  await providers.save(actor, 0, 'synthetic-audio-key');
  await providers.discover(actor);
  const common = {
    rawModelId: modelId,
    vendor: 'minimax',
    classification: 'voice',
    sourceKind: 'protocol-reference',
    source: 'deterministic gateway fixture',
    sourceVersion: '2026-11-19',
  };
  await store.importRoutes([
    {
      ...common,
      operation: 'audio.voices.list',
      driver: 'minimax-voices',
      submitPath: '/minimax/v1/get_voice',
    },
    {
      ...common,
      operation: 'audio.tts',
      driver: 'minimax-tts',
      submitPath: '/minimax/v1/t2a_v2',
      paramSpec: capabilities,
    },
    {
      ...common,
      rawModelId: otherModelId,
      operation: 'audio.tts',
      driver: 'minimax-tts',
      submitPath: '/minimax/v1/t2a_v2',
      paramSpec: capabilities,
    },
    {
      ...common,
      operation: 'audio.clone',
      driver: 'minimax-clone',
      submitPath: '/minimax/v1/t2a_pro/voice_clone',
      paramSpec: capabilities,
    },
  ]);
  const models = await providers.listAudioModels(actor, 'tts');
  const modelRef = models.find((model) => model.modelId === modelId)!.modelRef;
  const otherModelRef = models.find((model) => model.modelId === otherModelId)!.modelRef;
  await pool.query(
    `INSERT INTO mio_provider_voices(provider_id,source,upstream_id,name,descriptions,seen_seq,registration_model_key,registration_evidence)
     SELECT c.id,'system','fixture-voice','测试音色','[]'::jsonb,1,m.model_key,'test fixture'
     FROM mio_provider_configs c JOIN mio_provider_models m ON m.provider_id=c.id
     WHERE c.owner_id=$1 AND m.raw_model_id=$2`,
    [actor.userId, modelId],
  );
  const voiceRef = (await providers.voices.list(actor.userId, new URLSearchParams())).items[0]!
    .voiceRef;
  const output = Buffer.from('checkpoint-audio-fixture');
  const objects = new Map<string, { bytes: Buffer; etag: string; sha256: string }>();
  let failUpload = false,
    failPublish = false,
    failInspection = false;
  const headObject = async (key: string) => {
    const item = objects.get(key);
    if (!item) throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
    return { size: item.bytes.length, etag: item.etag, sha256: item.sha256 };
  };
  const head = vi.fn(headObject);
  const ensureAudioPrivate = vi.fn<NonNullable<AssetObjectStore['ensureAudioPrivate']>>(
    async (key, expected) => {
      const checked = await headObject(key);
      expect(checked).toMatchObject({
        size: expected.sizeBytes,
        etag: expected.etag,
        ...(expected.sha256 === undefined ? {} : { sha256: expected.sha256 }),
      });
    },
  );
  const storage: AssetObjectStore = {
    uploadUrl: () => '',
    downloadUrl: () => '',
    copy: async () => {},
    delete: async () => {},
    head,
    ensureAudioPrivate,
    readAudio: async (key, etag, size) => {
      const item = objects.get(key)!;
      if (item.etag !== etag) throw Object.assign(new Error('ETAG_CHANGED'), { statusCode: 412 });
      expect(item.bytes.length).toBe(size);
      return item.bytes;
    },
    putAudio: async (key, bytes, format, sha256) => {
      if (failUpload) throw new Error('COS_OFFLINE');
      const item = { bytes: Buffer.from(bytes), etag: 'etag-' + randomUUID(), sha256 };
      objects.set(key, item);
      return {
        key,
        sizeBytes: bytes.length,
        sha256,
        etag: item.etag,
        contentType: 'audio/' + format,
      };
    },
  };
  const submit = vi.fn<typeof submitAudio>(async () => ({ bytes: output }));
  const download = vi.fn<typeof downloadAudio>(async () => output);
  const inspectObject = async (input: AudioInspectionInput): Promise<AudioInspection> => {
    if (failInspection) throw new Error('B_OFFLINE');
    const bytes = objects.get(input.key)!.bytes;
    return {
      durationMs: input.purpose === 'sample' ? 20000 : 1500,
      format: 'wav',
      mimeType: 'audio/wav',
      codec: 'pcm_s16le',
      sampleRate: 32000,
      channels: 1,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  };
  const inspect =
    vi.fn<(input: AudioInspectionInput, signal?: AbortSignal) => Promise<AudioInspection>>(
      inspectObject,
    );
  const baseStore = providers.audioStore;
  const assets = new AssetStore(assetPool);
  const publishAudio = vi.fn((input: Parameters<AssetStore['publishAudio']>[0]) =>
    assets.publishAudio(input),
  );
  const startJobs = () =>
    createAudioJobService(
      {
        ...baseStore,
        publish: async (...args) => {
          if (failPublish) throw new Error('PG_PUBLISH_FAILED');
          return baseStore.publish(...args);
        },
      },
      providers,
      storage,
      { inspect, close: async () => {} },
      {
        owned: (id, owner) => assets.owned(id, owner),
        checkAudioPublicationIdentity: (input) => assets.checkAudioPublicationIdentity(input),
        publishAudio,
      },
      { submit, download, pollMs: 5 },
    );
  const jobs = startJobs();
  let replacement: ReturnType<typeof startJobs> | undefined;
  cleanup.push(async () => {
    await jobs.close();
    await replacement?.close();
    await providers.close();
  });
  const body = {
    requestId: randomUUID(),
    modelRef,
    voiceRef,
    text: '你好，世界。',
    mode: 'standard',
    parameters,
  };
  const settled = async (jobId: string, status: string) => {
    await vi.waitFor(async () => expect((await jobs.get(actor, jobId)).status).toBe(status), {
      timeout: 4000,
      interval: 10,
    });
    return jobs.get(actor, jobId);
  };
  const sample = async () => {
    const id = randomUUID(),
      key = `mio/raw/${id}/${randomUUID()}`,
      sha256 = createHash('sha256').update(output).digest('hex');
    objects.set(key, { bytes: output, etag: 'sample-etag', sha256 });
    await assetPool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,source_etag,expires_at) VALUES($1,$2,'sample.wav','audio/wav',$3,$4,$4,'ready','sample-etag',now())`,
      [id, actor.userId, output.length, key],
    );
    return id;
  };
  return {
    actor,
    providers,
    jobs,
    modelId,
    head,
    headObject,
    ensureAudioPrivate,
    submit,
    download,
    output,
    baseStore,
    inspect,
    inspectObject,
    assets,
    publishAudio,
    modelRef,
    otherModelRef,
    voiceRef,
    body,
    settled,
    sample,
    async restart() {
      await jobs.close();
      return (replacement = startJobs());
    },
    replaceSample(id: string) {
      const key = [...objects.keys()].find((key) => key.startsWith(`mio/raw/${id}/`))!;
      const existing = objects.get(key)!;
      objects.set(key, {
        ...existing,
        bytes: Buffer.from(existing.bytes).fill(0),
        etag: 'sample-changed',
      });
    },
    failUpload: (v: boolean) => {
      failUpload = v;
    },
    failPublish: (v: boolean) => {
      failPublish = v;
    },
    failInspection: (v: boolean) => {
      failInspection = v;
    },
  };
}
function cloneWithAudition(f: Awaited<ReturnType<typeof fixture>>, sampleAssetId: string) {
  f.submit.mockImplementationOnce(async (_admission, _key, input) => ({
    bytes: Buffer.from('checkpoint-audio-fixture'),
    voiceId: input.voiceId!,
  }));
  return f.jobs.clone(f.actor, {
    requestId: randomUUID(),
    modelRef: f.modelRef,
    sampleAssetId,
    name: '我的音色',
    auditionText: '这是试听。',
    sampleAuthorization: true,
  });
}

it('accepts short and 10000-codepoint text, freezes parameters, publishes separate job/record/asset IDs', async () => {
  const f = await fixture();
  const { job } = await f.jobs.create(f.actor, { ...f.body, text: '字'.repeat(10000) });
  const ready = await f.settled(job.jobId, 'ready');
  expect(ready.parameters).toEqual(parameters);
  expect(ready.outputs[0]?.durationMs).toBe(1500);
  expect(new Set([ready.jobId, ready.recordId, ready.assetIds[0]]).size).toBe(3);
  const record = await f.jobs.record(f.actor, ready.recordId!);
  expect(record.text).toBe('字'.repeat(10000));
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.submit.mock.calls[0]?.[2]).toMatchObject({ parameters, text: '字'.repeat(10000) });
  expect(
    (await pool.query("SELECT to_regclass('mio_assets') AS assets")).rows[0].assets,
  ).toBeNull();
  expect(
    (await assetPool.query("SELECT to_regclass('mio_audio_jobs') AS jobs")).rows[0].jobs,
  ).toBeNull();
  expect(await f.assets.owned(ready.assetIds[0]!, f.actor.userId)).toMatchObject({
    state: 'ready',
    content_type: 'audio/wav',
    filename: `audio-${job.jobId}.wav`,
  });
});
it('replays identical request before mutable lookups; changed input conflicts without another POST', async () => {
  const f = await fixture();
  const first = await f.jobs.create(f.actor, f.body);
  await f.settled(first.job.jobId, 'ready');
  const replay = await f.jobs.create(f.actor, f.body);
  expect(replay.created).toBe(false);
  expect(replay.job.jobId).toBe(first.job.jobId);
  await expect(f.jobs.create(f.actor, { ...f.body, text: 'different' })).rejects.toMatchObject({
    code: 'REQUEST_CONFLICT',
  });
  expect(f.submit).toHaveBeenCalledTimes(1);
});
it('submits the chosen voice upstream ID and keeps the record snapshot immutable', async () => {
  const f = await fixture();
  const voiceRef = randomUUID();
  await pool.query(
    `INSERT INTO mio_provider_voices(id,provider_id,source,upstream_id,name,descriptions,seen_seq,registration_model_key,registration_evidence)
     SELECT $2,provider_id,'system','fixture-voice-b','音色 B','[]'::jsonb,1,registration_model_key,'test fixture'
     FROM mio_provider_voices WHERE id=$1`,
    [f.voiceRef, voiceRef],
  );
  const { job } = await f.jobs.create(f.actor, { ...f.body, voiceRef });
  const ready = await f.settled(job.jobId, 'ready');
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.submit.mock.calls[0]?.[2]).toMatchObject({ upstreamVoiceId: 'fixture-voice-b' });
  await pool.query('UPDATE mio_provider_voices SET name=$2 WHERE id=$1', [voiceRef, '改名']);
  expect(await f.jobs.record(f.actor, ready.recordId!)).toMatchObject({
    voiceRef,
    voiceSnapshot: { name: '音色 B' },
  });
});
it('recovers upload and publication failure using the saved output without another supplier call', async () => {
  const f = await fixture();
  f.failUpload(true);
  const { job } = await f.jobs.create(f.actor, f.body);
  await vi.waitFor(async () =>
    expect((await f.jobs.get(f.actor, job.jobId)).recoverable).toBe(true),
  );
  f.failUpload(false);
  f.failPublish(true);
  await f.jobs.recover(f.actor, job.jobId);
  await vi.waitFor(async () =>
    expect((await f.jobs.get(f.actor, job.jobId)).recoverable).toBe(true),
  );
  const registered = f.publishAudio.mock.calls[0]![0];
  expect(await f.assets.owned(registered.assetId, f.actor.userId)).toMatchObject({
    state: 'ready',
  });
  expect((await f.jobs.get(f.actor, job.jobId)).outputs).toEqual([]);
  f.failPublish(false);
  await f.jobs.recover(f.actor, job.jobId);
  await f.settled(job.jobId, 'ready');
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.ensureAudioPrivate).toHaveBeenCalledWith(
    registered.key,
    expect.objectContaining({
      sizeBytes: registered.sizeBytes,
      etag: registered.etag,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
    expect.any(AbortSignal),
  );
  expect(
    (await assetPool.query('SELECT id FROM mio_assets WHERE id=$1', [registered.assetId])).rowCount,
  ).toBe(1);
});
it('retains the supplier checkpoint when asset registration fails and resumes into the asset database', async () => {
  const f = await fixture();
  f.publishAudio.mockRejectedValueOnce(new Error('ASSET_DATABASE_OFFLINE'));
  const { job } = await f.jobs.create(f.actor, f.body);
  await vi.waitFor(async () =>
    expect(await f.jobs.get(f.actor, job.jobId)).toMatchObject({
      errorCode: 'AUDIO_STORAGE_UNAVAILABLE',
      recoverable: true,
      outputs: [],
    }),
  );
  expect(
    (await pool.query('SELECT output_bytes FROM mio_audio_jobs WHERE id=$1', [job.jobId])).rows[0]
      .output_bytes,
  ).toBeTruthy();
  await f.jobs.recover(f.actor, job.jobId);
  const ready = await f.settled(job.jobId, 'ready');
  expect(await f.assets.owned(ready.assetIds[0]!, f.actor.userId)).toMatchObject({
    state: 'ready',
  });
  expect(f.submit).toHaveBeenCalledOnce();
});
it('rejects a conflicting ready asset instead of replacing its identity or file', async () => {
  const f = await fixture();
  const { job } = await f.jobs.create(f.actor, f.body);
  await f.settled(job.jobId, 'ready');
  const original = f.publishAudio.mock.calls[0]![0];
  for (const change of [
    { ownerId: randomUUID() },
    { key: `mio/raw/${randomUUID()}/${randomUUID()}` },
    { etag: 'different-etag' },
    { sizeBytes: original.sizeBytes + 1 },
    { contentType: 'audio/mpeg' },
    { filename: 'different.wav' },
  ])
    await expect(f.assets.publishAudio({ ...original, ...change })).rejects.toMatchObject({
      code: 'ASSET_SOURCE_CHANGED',
    });
  expect(await f.assets.owned(original.assetId, original.ownerId)).toMatchObject({
    raw_key: original.key,
    source_etag: original.etag,
    filename: original.filename,
  });
});
it('preserves inspection errors and recovers saved audio without another supplier call', async () => {
  const f = await fixture();
  f.inspect.mockRejectedValueOnce(new AudioMediaError('AUDIO_STORAGE_UNAVAILABLE'));
  const { job } = await f.jobs.create(f.actor, f.body);
  await vi.waitFor(async () =>
    expect(await f.jobs.get(f.actor, job.jobId)).toMatchObject({
      status: 'materializing',
      errorCode: 'AUDIO_STORAGE_UNAVAILABLE',
      recoverable: true,
    }),
  );
  await f.jobs.recover(f.actor, job.jobId);
  await f.settled(job.jobId, 'ready');
  expect(f.submit).toHaveBeenCalledTimes(1);
});
it.each(['inspection', 'download', 'object identity'])(
  'terminates deterministic %s output failures and replays the same request without another POST',
  async (failure) => {
    const f = await fixture();
    if (failure === 'inspection')
      f.inspect.mockImplementationOnce(async (input) => ({
        ...(await f.inspectObject(input)),
        sha256: '0'.repeat(64),
      }));
    else if (failure === 'download') {
      f.submit.mockResolvedValueOnce({ url: 'https://audio-fixture.invalid/output.wav' });
      f.download.mockResolvedValueOnce(new Uint8Array());
    } else
      f.head.mockResolvedValueOnce({
        size: f.output.length,
        etag: 'other-etag',
        sha256: '0'.repeat(64),
      });
    const { job } = await f.jobs.create(f.actor, f.body);
    const failed = await f.settled(job.jobId, 'failed');
    expect(failed).toMatchObject({
      errorCode: failure === 'object identity' ? 'AUDIO_OUTPUT_MISMATCH' : 'AUDIO_OUTPUT_INVALID',
      recoverable: false,
      recordId: null,
      outputs: [],
    });
    expect(
      (
        await pool.query(
          'SELECT output_bytes,output_url,lease_id,lease_until FROM mio_audio_jobs WHERE id=$1',
          [job.jobId],
        )
      ).rows[0],
    ).toEqual({ output_bytes: null, output_url: null, lease_id: null, lease_until: null });
    expect(await f.jobs.recover(f.actor, job.jobId)).toEqual(failed);
    expect(await f.jobs.recover(f.actor, job.jobId)).toEqual(failed);
    expect(await f.jobs.cancel(f.actor, job.jobId)).toEqual(failed);
    expect(await f.jobs.create(f.actor, f.body)).toEqual({ created: false, job: failed });
    await expect(
      f.jobs.create(f.actor, { ...f.body, text: 'changed input' }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(f.publishAudio).not.toHaveBeenCalled();
    expect(
      (await assetPool.query('SELECT id FROM mio_assets WHERE owner_id=$1', [f.actor.userId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await pool.query('SELECT id FROM mio_audio_records WHERE job_id=$1', [job.jobId])).rowCount,
    ).toBe(0);
    expect(f.submit).toHaveBeenCalledOnce();
  },
);

it('keeps a failed clone voice conflict terminal after clearing its audition checkpoint', async () => {
  const f = await fixture(),
    sampleAssetId = await f.sample();
  const upstreamVoiceId = 'conflicting-clone-' + randomUUID();
  await pool.query(
    `INSERT INTO mio_provider_voices(provider_id,source,upstream_id,name,descriptions,seen_seq,local_clone_job_id)
    SELECT provider_id,'voice_cloning',$2,'Prior clone','[]',1,$3 FROM mio_provider_voices WHERE id=$1`,
    [f.voiceRef, upstreamVoiceId, randomUUID()],
  );
  f.submit.mockResolvedValueOnce({ voiceId: upstreamVoiceId, bytes: f.output });
  const body = {
    requestId: randomUUID(),
    modelRef: f.modelRef,
    sampleAssetId,
    name: 'My clone',
    auditionText: 'Synthetic audition',
    sampleAuthorization: true,
  };
  const { job } = await f.jobs.clone(f.actor, body);
  const failed = await f.settled(job.jobId, 'failed');
  expect(failed).toMatchObject({
    errorCode: 'AUDIO_VOICE_CONFLICT',
    upstreamConfirmed: true,
    recoverable: false,
    recordId: null,
  });
  expect(
    (
      await pool.query(
        'SELECT output_bytes,output_url,upstream_voice_id FROM mio_audio_jobs WHERE id=$1',
        [job.jobId],
      )
    ).rows[0],
  ).toEqual({ output_bytes: null, output_url: null, upstream_voice_id: upstreamVoiceId });
  expect(await f.jobs.recover(f.actor, job.jobId)).toEqual(failed);
  expect(await f.jobs.recover(f.actor, job.jobId)).toEqual(failed);
  expect(await f.jobs.cancel(f.actor, job.jobId)).toEqual(failed);
  expect(await f.jobs.clone(f.actor, body)).toEqual({ created: false, job: failed });
  expect(f.submit).toHaveBeenCalledOnce();
  expect(f.publishAudio).toHaveBeenCalledOnce();
  expect(
    (await pool.query('SELECT id FROM mio_audio_records WHERE job_id=$1', [job.jobId])).rowCount,
  ).toBe(0);
});

it.each([
  [409, 'AUDIO_LEASE_LOST'],
  [409, 'AUDIO_CHECKPOINT_CHANGED'],
  [503, 'AUDIO_OUTPUT_INVALID'],
])(
  'preserves recovery for %i %s instead of treating every output error as terminal',
  async (status, code) => {
    const f = await fixture();
    f.inspect.mockRejectedValueOnce(new AudioError(status, code));
    const { job } = await f.jobs.create(f.actor, f.body);
    await vi.waitFor(async () =>
      expect(await f.jobs.get(f.actor, job.jobId)).toMatchObject({
        status: 'materializing',
        errorCode: code,
        recoverable: true,
      }),
    );
    expect(
      (await pool.query('SELECT output_bytes FROM mio_audio_jobs WHERE id=$1', [job.jobId])).rows[0]
        .output_bytes,
    ).toEqual(f.output);
    await f.jobs.recover(f.actor, job.jobId);
    await f.settled(job.jobId, 'ready');
    expect(f.submit).toHaveBeenCalledOnce();
  },
);

it('releases both owner slots after deterministic output failures', async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++) {
    f.inspect.mockImplementationOnce(async (input) => ({
      ...(await f.inspectObject(input)),
      sha256: '0'.repeat(64),
    }));
    const { job } = await f.jobs.create(f.actor, { ...f.body, requestId: randomUUID() });
    await f.settled(job.jobId, 'failed');
  }
  const { job } = await f.jobs.create(f.actor, { ...f.body, requestId: randomUUID() });
  await f.settled(job.jobId, 'ready');
  expect(f.submit).toHaveBeenCalledTimes(3);
});

it('retains a deterministic failure code when shutdown begins during output inspection', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.inspect.mockImplementationOnce(async (input) => {
    entered.resolve();
    await release.promise;
    return { ...(await f.inspectObject(input)), sha256: '0'.repeat(64) };
  });
  const { job } = await f.jobs.create(f.actor, f.body);
  await entered.promise;
  const closing = f.jobs.close();
  release.resolve();
  await closing;
  expect(await f.baseStore.owned(f.actor.userId, job.jobId)).toMatchObject({
    status: 'failed',
    error_code: 'AUDIO_OUTPUT_INVALID',
    has_output: false,
    lease_id: null,
  });
  expect(f.submit).toHaveBeenCalledOnce();
});

async function stalledFixture() {
  const f = await fixture();
  f.failUpload(true);
  const { job } = await f.jobs.create(f.actor, f.body);
  await vi.waitFor(async () =>
    expect((await f.jobs.get(f.actor, job.jobId)).recoverable).toBe(true),
  );
  await f.jobs.close();
  cleanup.push(async () => {
    await pool.query(
      "UPDATE mio_audio_jobs SET status='failed',lease_id=NULL,lease_until=NULL WHERE id=$1 AND status IN ('queued','submitted','materializing')",
      [job.jobId],
    );
  });
  return { ...f, job };
}

it.each([
  ['stalled bytes', 'materializing', null, 'AUDIO_STORAGE_UNAVAILABLE', false, false, 'cancelled'],
  [
    'stalled URL with prior intent',
    'materializing',
    null,
    'AUDIO_STORAGE_UNAVAILABLE',
    true,
    true,
    'cancelled',
  ],
  [
    'active lease',
    'materializing',
    'active',
    'AUDIO_STORAGE_UNAVAILABLE',
    false,
    false,
    'materializing',
  ],
  [
    'expired lease',
    'materializing',
    'expired',
    'AUDIO_STORAGE_UNAVAILABLE',
    false,
    false,
    'materializing',
  ],
  ['unleased no error', 'materializing', null, null, false, false, 'materializing'],
  ['submitted', 'submitted', 'active', null, false, false, 'submitted'],
  ['unknown', 'unknown', null, 'AUDIO_SUBMIT_UNKNOWN', false, false, 'unknown'],
  ['queued', 'queued', 'active', null, false, false, 'cancelled'],
  ['ready', 'ready', null, null, false, false, 'ready'],
  ['failed', 'failed', null, 'AUDIO_OUTPUT_INVALID', false, false, 'failed'],
  ['cancelled', 'cancelled', null, 'AUDIO_STORAGE_UNAVAILABLE', true, false, 'cancelled'],
])(
  'cancels %s with its original lease and terminal boundaries',
  async (_name, status, lease, error, prior, url, expected) => {
    const f = await stalledFixture();
    const leaseId = lease ? randomUUID() : null,
      until = lease ? new Date(Date.now() + (lease === 'expired' ? -60000 : 60000)) : null;
    await pool.query(
      'UPDATE mio_audio_jobs SET status=$2,lease_id=$3,lease_until=$4,error_code=$5,cancel_requested=$6,output_bytes=$7,output_url=$8 WHERE id=$1',
      [
        f.job.jobId,
        status,
        leaseId,
        until,
        error,
        prior,
        url ? null : f.output,
        url ? 'https://audio-fixture.invalid/output.wav' : null,
      ],
    );
    const before = await f.baseStore.owned(f.actor.userId, f.job.jobId);
    const result = await f.baseStore.cancel(f.actor.userId, f.job.jobId);
    expect(result.status).toBe(expected);
    const terminal = ['ready', 'failed', 'cancelled'].includes(status as string);
    const ended = expected === 'cancelled' && !terminal;
    expect(result).toMatchObject({
      lease_id: ended ? null : leaseId,
      has_output: !ended,
      cancel_requested: terminal ? prior : true,
      error_code: error,
    });
    if (terminal) expect(result).toEqual(before);
    expect(await f.baseStore.cancel(f.actor.userId, f.job.jobId)).toEqual(result);
    const row = (
      await pool.query(
        'SELECT output_bytes,output_url,lease_until FROM mio_audio_jobs WHERE id=$1',
        [f.job.jobId],
      )
    ).rows[0];
    expect(row).toEqual({
      output_bytes: ended || url ? null : f.output,
      output_url: !ended && url ? 'https://audio-fixture.invalid/output.wav' : null,
      lease_until: ended ? null : until,
    });
    if (ended) expect(await f.baseStore.recover(f.actor.userId, f.job.jobId)).toEqual(result);
    expect(f.submit).toHaveBeenCalledOnce();
  },
);

it('keeps recovery idempotent and guards ownership, leased rows, and terminal state', async () => {
  const f = await stalledFixture();
  for (const operation of ['recover', 'cancel'] as const) {
    await expect(f.baseStore[operation](randomUUID(), f.job.jobId)).rejects.toMatchObject({
      status: 404,
      code: 'AUDIO_JOB_NOT_FOUND',
    });
    await expect(f.baseStore[operation](f.actor.userId, randomUUID())).rejects.toMatchObject({
      status: 404,
      code: 'AUDIO_JOB_NOT_FOUND',
    });
  }
  for (const offset of [60000, -60000]) {
    const lease = randomUUID();
    await pool.query('UPDATE mio_audio_jobs SET lease_id=$2,lease_until=$3 WHERE id=$1', [
      f.job.jobId,
      lease,
      new Date(Date.now() + offset),
    ]);
    const before = await f.baseStore.owned(f.actor.userId, f.job.jobId);
    expect(await f.baseStore.recover(f.actor.userId, f.job.jobId)).toEqual(before);
  }
  await pool.query('UPDATE mio_audio_jobs SET lease_id=NULL,lease_until=NULL WHERE id=$1', [
    f.job.jobId,
  ]);
  const recovered = await f.baseStore.recover(f.actor.userId, f.job.jobId);
  expect(recovered).toMatchObject({ status: 'materializing', error_code: null, has_output: true });
  expect(await f.baseStore.recover(f.actor.userId, f.job.jobId)).toEqual(recovered);
  await pool.query(
    "UPDATE mio_audio_jobs SET status='unknown',error_code='AUDIO_SUBMIT_UNKNOWN' WHERE id=$1",
    [f.job.jobId],
  );
  await expect(f.baseStore.recover(f.actor.userId, f.job.jobId)).rejects.toMatchObject({
    code: 'AUDIO_SUBMIT_UNKNOWN',
  });
  expect(f.submit).toHaveBeenCalledOnce();
});

it('keeps committed output on lost checkpoint acknowledgement and rejects a stale worker cleanup', async () => {
  const f = await stalledFixture(),
    lease = randomUUID();
  await pool.query(
    "UPDATE mio_audio_jobs SET status='submitted',error_code=NULL,lease_id=$2,lease_until=now()+interval '30 minutes',output_bytes=NULL WHERE id=$1",
    [f.job.jobId, lease],
  );
  const job = (
    await pool.query<AudioJobRow>('SELECT * FROM mio_audio_jobs WHERE id=$1', [f.job.jobId])
  ).rows[0]!;
  await f.baseStore.checkpoint(job, { bytes: f.output });
  await f.baseStore.defer(job, 'unknown', 'AUDIO_SUBMIT_UNKNOWN');
  expect(await f.baseStore.owned(f.actor.userId, job.id)).toMatchObject({
    status: 'materializing',
    error_code: 'AUDIO_CHECKPOINT_UNAVAILABLE',
    has_output: true,
    lease_id: null,
  });
  await pool.query(
    "UPDATE mio_audio_jobs SET lease_id=$2,lease_until=now()+interval '30 minutes' WHERE id=$1",
    [job.id, randomUUID()],
  );
  const before = (await pool.query('SELECT * FROM mio_audio_jobs WHERE id=$1', [job.id])).rows[0];
  await f.baseStore.defer(job, 'failed', 'AUDIO_OUTPUT_INVALID');
  expect((await pool.query('SELECT * FROM mio_audio_jobs WHERE id=$1', [job.id])).rows[0]).toEqual(
    before,
  );
  expect(f.submit).toHaveBeenCalledOnce();
});
it("rejects another owner's sample in the separate asset database before supplier submission", async () => {
  const f = await fixture(),
    sampleAssetId = await f.sample();
  await assetPool.query('UPDATE mio_assets SET owner_id=$2 WHERE id=$1', [
    sampleAssetId,
    randomUUID(),
  ]);
  const sample = { assetId: sampleAssetId, authorized: true, name: '声音', auditionText: '试听' };
  await expect(
    f.jobs.freezeContext(f.actor, { modelRef: f.modelRef, sample }),
  ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND', status: 404 });
  await expect(
    f.jobs.clone(f.actor, {
      requestId: randomUUID(),
      modelRef: f.modelRef,
      sampleAssetId,
      name: '声音',
      auditionText: '试听',
      sampleAuthorization: true,
    }),
  ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND', status: 404 });
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.ensureAudioPrivate).not.toHaveBeenCalled();
});
it('preserves unknown upstream result and never re-POSTs it', async () => {
  const f = await fixture();
  f.submit.mockRejectedValueOnce(new Error('CONNECTION_LOST'));
  const { job } = await f.jobs.create(f.actor, f.body);
  await f.settled(job.jobId, 'unknown');
  await expect(f.jobs.recover(f.actor, job.jobId)).rejects.toMatchObject({
    code: 'AUDIO_SUBMIT_UNKNOWN',
  });
  await f.jobs.create(f.actor, f.body);
  expect(f.submit).toHaveBeenCalledTimes(1);
});
it('checks ownership and rejects undeclared parameters, oversized text and missing sample authorization', async () => {
  const f = await fixture();
  await expect(
    f.jobs.create(f.actor, { ...f.body, parameters: { ...parameters, emotion: 'happy' } }),
  ).rejects.toBeInstanceOf(AudioError);
  await expect(
    f.jobs.create(f.actor, { ...f.body, text: '字'.repeat(10001) }),
  ).rejects.toMatchObject({ code: 'AUDIO_TEXT_INVALID' });
  await expect(
    f.jobs.clone(f.actor, {
      requestId: randomUUID(),
      modelRef: f.modelRef,
      sampleAssetId: randomUUID(),
      name: '我的声音',
      auditionText: '试听',
    }),
  ).rejects.toMatchObject({ code: 'AUDIO_SAMPLE_AUTHORIZATION_REQUIRED' });
  const { job } = await f.jobs.create(f.actor, f.body);
  await expect(f.jobs.get({ userId: randomUUID() }, job.jobId)).rejects.toMatchObject({
    code: 'AUDIO_JOB_NOT_FOUND',
  });
});
it('clones an authorized ready sample then reuses its stable voice reference for TTS', async () => {
  const f = await fixture(),
    sampleAssetId = await f.sample();
  const { job } = await cloneWithAudition(f, sampleAssetId);
  const ready = await f.settled(job.jobId, 'ready');
  expect(ready.voiceRef).toBeTruthy();
  expect(f.inspect).toHaveBeenCalledWith(
    expect.objectContaining({ purpose: 'sample', assetId: sampleAssetId }),
    expect.any(AbortSignal),
  );
  expect(f.ensureAudioPrivate).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(new RegExp(`^mio/raw/${sampleAssetId}/[a-f0-9-]{36}$`)),
    { sizeBytes: Buffer.byteLength('checkpoint-audio-fixture'), etag: 'sample-etag' },
    expect.any(AbortSignal),
  );
  const tts = await f.jobs.create(f.actor, { ...f.body, voiceRef: ready.voiceRef });
  await f.settled(tts.job.jobId, 'ready');
  expect(f.submit).toHaveBeenCalledTimes(2);
});

it('replays same UUID, defaults and text concurrently, and checks the exact model for a new request', async () => {
  const f = await fixture();
  const { requestId, modelRef, voiceRef, text, mode } = f.body;
  const withDefaults = { requestId, modelRef, voiceRef, text, mode };
  const receipts = await Promise.all([
    f.jobs.create(f.actor, f.body),
    f.jobs.create(f.actor, withDefaults),
  ]);
  expect(receipts.map(({ created }) => created).sort()).toEqual([false, true]);
  expect(receipts[0]!.job.jobId).toBe(receipts[1]!.job.jobId);
  await f.settled(receipts[0]!.job.jobId, 'ready');
  await expect(
    f.jobs.create(f.actor, {
      ...f.body,
      requestId: randomUUID(),
      modelRef: f.otherModelRef,
    }),
  ).rejects.toMatchObject({ code: 'VOICE_NOT_FOUND' });
  expect(f.submit).toHaveBeenCalledOnce();
});

it('cancels a clone during sample inspection before any supplier POST', async () => {
  const f = await fixture();
  const sampleAssetId = await f.sample();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  f.inspect.mockImplementationOnce(async (input) => {
    entered.resolve();
    await resume.promise;
    return f.inspectObject(input);
  });
  const { job } = await f.jobs.clone(f.actor, {
    requestId: randomUUID(),
    modelRef: f.modelRef,
    sampleAssetId,
    name: '我的音色',
    auditionText: '这是试听。',
    sampleAuthorization: true,
  });
  await entered.promise;
  try {
    expect(await f.jobs.cancel(f.actor, job.jobId)).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
    });
  } finally {
    resume.resolve();
  }
  const replacement = await f.restart();
  expect((await replacement.get(f.actor, job.jobId)).status).toBe('cancelled');
  expect(f.submit).not.toHaveBeenCalled();
});

it('recovers a pre-submit clone after shutdown without repeating its supplier POST', async () => {
  const f = await fixture();
  const sampleAssetId = await f.sample();
  const entered = Promise.withResolvers<void>();
  f.inspect.mockImplementationOnce(async (_, signal) => {
    entered.resolve();
    return new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
  });
  const { job } = await cloneWithAudition(f, sampleAssetId);
  await entered.promise;
  expect((await f.jobs.get(f.actor, job.jobId)).status).toBe('queued');
  expect(f.submit).not.toHaveBeenCalled();
  const replacement = await f.restart();
  await vi.waitFor(async () => {
    expect((await replacement.get(f.actor, job.jobId)).status).toBe('ready');
  });
  expect(f.submit).toHaveBeenCalledOnce();
});

it('rejects a changed sample after a completed inspection and keeps the supplier boundary closed', async () => {
  const f = await fixture();
  const sampleAssetId = await f.sample();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  f.inspect.mockImplementationOnce(async (input) => {
    const inspected = await f.inspectObject(input);
    entered.resolve();
    await resume.promise;
    return inspected;
  });
  const { job } = await f.jobs.clone(f.actor, {
    requestId: randomUUID(),
    modelRef: f.modelRef,
    sampleAssetId,
    name: '我的音色',
    auditionText: '这是试听。',
    sampleAuthorization: true,
  });
  await entered.promise;
  f.replaceSample(sampleAssetId);
  resume.resolve();
  expect(await f.settled(job.jobId, 'failed')).toMatchObject({
    errorCode: 'AUDIO_SAMPLE_CHANGED',
    recordId: null,
  });
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.ensureAudioPrivate).not.toHaveBeenCalled();
});

it('preserves a confirmed clone without an audition as terminal, without publishing or retrying', async () => {
  const f = await fixture();
  const sampleAssetId = await f.sample();
  f.submit.mockImplementationOnce((admission, key, input, signal) =>
    submitAudio(admission, key, input, signal, async () =>
      Response.json({ base_resp: { status_code: 0 } }),
    ),
  );
  const { job } = await f.jobs.clone(f.actor, {
    requestId: randomUUID(),
    modelRef: f.modelRef,
    sampleAssetId,
    name: '我的音色',
    auditionText: '这是试听。',
    sampleAuthorization: true,
  });
  expect(await f.settled(job.jobId, 'failed')).toMatchObject({
    upstreamConfirmed: true,
    errorCode: 'AUDIO_AUDITION_MISSING',
    recordId: null,
    voiceRef: null,
    recoverable: false,
  });
  await expect(f.jobs.recover(f.actor, job.jobId)).rejects.toMatchObject({
    code: 'AUDIO_AUDITION_MISSING',
  });
  expect(f.publishAudio).not.toHaveBeenCalled();
  expect(f.submit).toHaveBeenCalledOnce();
});

it('classifies a business error in HTTP 200 as a known supplier rejection', async () => {
  const f = await fixture();
  const once = vi.fn(async () => Response.json({ base_resp: { status_code: 1001 } }));
  f.submit.mockImplementationOnce((admission, key, input, signal) =>
    submitAudio(admission, key, input, signal, once),
  );
  const { job } = await f.jobs.create(f.actor, f.body);
  expect(await f.settled(job.jobId, 'failed')).toMatchObject({
    errorCode: 'AUDIO_UPSTREAM_REJECTED',
    recordId: null,
    recoverable: false,
  });
  expect(once).toHaveBeenCalledOnce();
  expect(f.publishAudio).not.toHaveBeenCalled();
});

it('closes fresh clone admission when the exact route is disabled during asset HEAD', async () => {
  const f = await fixture();
  const sampleAssetId = await f.sample();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  f.head.mockImplementationOnce(async (key) => {
    entered.resolve();
    await resume.promise;
    return f.headObject(key);
  });
  const pending = f.jobs.clone(f.actor, {
    requestId: randomUUID(),
    modelRef: f.modelRef,
    sampleAssetId,
    name: '我的音色',
    auditionText: '这是试听。',
    sampleAuthorization: true,
  });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'AUDIO_OPERATION_UNAVAILABLE' });
  await entered.promise;
  try {
    await pool.query(
      `UPDATE mio_provider_model_routes SET enabled=false,declaration_version=declaration_version+1
       WHERE raw_model_id=$1 AND operation='audio.clone'`,
      [f.modelId],
    );
  } finally {
    resume.resolve();
  }
  await rejected;
  expect(
    (await pool.query('SELECT id FROM mio_audio_jobs WHERE owner_id=$1', [f.actor.userId]))
      .rowCount,
  ).toBe(0);
  expect(f.submit).not.toHaveBeenCalled();
});

it('keeps an accepted clone on the frozen route after the route closes', async () => {
  const f = await fixture();
  const sampleAssetId = await f.sample();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  f.inspect.mockImplementationOnce(async (input) => {
    entered.resolve();
    await resume.promise;
    return f.inspectObject(input);
  });
  f.submit.mockImplementationOnce(async (_admission, _key, input) => ({
    bytes: Buffer.from('checkpoint-audio-fixture'),
    voiceId: input.voiceId!,
  }));
  const body = {
    requestId: randomUUID(),
    modelRef: f.modelRef,
    sampleAssetId,
    name: '我的音色',
    auditionText: '这是试听。',
    sampleAuthorization: true,
  };
  const { job } = await f.jobs.clone(f.actor, body);
  await entered.promise;
  try {
    await pool.query(
      `UPDATE mio_provider_model_routes SET enabled=false,declaration_version=declaration_version+1
       WHERE raw_model_id=$1 AND operation='audio.clone'`,
      [f.modelId],
    );
    expect(await f.jobs.clone(f.actor, body)).toMatchObject({
      created: false,
      job: { jobId: job.jobId },
    });
  } finally {
    resume.resolve();
  }
  expect(await f.settled(job.jobId, 'ready')).toMatchObject({ upstreamConfirmed: true });
  expect(f.submit).toHaveBeenCalledOnce();
});

it('never changes the ACL of an already stored output if the asset identity belongs to a different owner', async () => {
  const f = await fixture();
  f.failPublish(true);
  const { job } = await f.jobs.create(f.actor, f.body);
  await vi.waitFor(async () =>
    expect((await f.jobs.get(f.actor, job.jobId)).recoverable).toBe(true),
  );
  const original = f.publishAudio.mock.calls[0]![0];
  const otherOwner = randomUUID();
  await assetPool.query('UPDATE mio_assets SET owner_id=$2 WHERE id=$1', [
    original.assetId,
    otherOwner,
  ]);
  f.failPublish(false);
  await f.jobs.recover(f.actor, job.jobId);
  await vi.waitFor(async () =>
    expect(await f.jobs.get(f.actor, job.jobId)).toMatchObject({
      status: 'materializing',
      errorCode: 'AUDIO_STORAGE_UNAVAILABLE',
      recoverable: true,
    }),
  );
  expect(f.ensureAudioPrivate).not.toHaveBeenCalled();
  expect(f.submit).toHaveBeenCalledOnce();
  expect(await f.assets.owned(original.assetId, otherOwner)).toMatchObject({
    raw_key: original.key,
  });
});

it.each([
  [403, 'AUDIO_STORAGE_UNAVAILABLE'],
  [412, 'AUDIO_SAMPLE_CHANGED'],
])(
  'stops before the first clone POST when the verified sample private ACL fails with HTTP %s',
  async (statusCode, code) => {
    const f = await fixture();
    const sampleAssetId = await f.sample();
    f.ensureAudioPrivate.mockRejectedValueOnce(
      Object.assign(new Error('ACL_FIXTURE_FAILURE'), { statusCode }),
    );
    const { job } = await f.jobs.clone(f.actor, {
      requestId: randomUUID(),
      modelRef: f.modelRef,
      sampleAssetId,
      name: '授权样本',
      auditionText: '请试听这段文字。',
      sampleAuthorization: true,
    });
    expect(await f.settled(job.jobId, 'failed')).toMatchObject({
      errorCode: code,
      upstreamConfirmed: false,
      recordId: null,
    });
    expect(f.inspect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ purpose: 'sample', assetId: sampleAssetId }),
      expect.any(AbortSignal),
    );
    expect(f.ensureAudioPrivate).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.publishAudio).not.toHaveBeenCalled();
  },
);
