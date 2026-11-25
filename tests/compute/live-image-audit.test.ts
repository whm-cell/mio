import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateModelRouteEntry } from '../../src/providers/onelink/router.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { findFixtureImageRouteConfig } from '../providers/fixtures/onelink-routes-fixture.ts';
import {
  createRoutedImageProtocol,
  defaultRouteAsyncTransport,
} from '../../src/integrations/onelink/router.ts';

const mocks = vi.hoisted(() => ({ validateImage: vi.fn(async () => {}) }));
vi.mock('../../src/generations/image/decode.ts', () => ({
  createImageDecoder: () => mocks.validateImage,
}));
import {
  assetBytes,
  assertFrozenScenario,
  assertLiveArtifacts,
  captureLiveArtifacts,
  createReferenceAsset,
  liveImageParameters,
  liveRouteDeclaration,
  matchCompletedOutputs,
  parseLiveInvocation,
  assertLivePhase,
  selectLiveModel,
  verifyReplayResult,
} from './live-image-loop.ts';

const tempDirectories: string[] = [];
function auditDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  tempDirectories.push(directory);
  return directory;
}
async function installAudit(scenario: string, directory: string, transport: typeof fetch) {
  vi.stubEnv('MIO_LIVE_IMAGE_SCENARIO', scenario);
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  vi.resetModules();
  await import('./live-image-audit.ts');
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe('offline live scenario preparation', () => {
  it('refuses changed runtime artifacts before any mocked request', () => {
    const root = auditDirectory();
    mkdirSync(join(root, 'dist', 'nested'), { recursive: true });
    writeFileSync(join(root, 'dist', 'nested', 'module.js'), 'candidate-a');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lock-a');
    const paths = ['dist', 'pnpm-lock.yaml'];
    const identity = captureLiveArtifacts(root, paths);
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    expect(() => assertLiveArtifacts(identity.sha256, root, paths)).not.toThrow();
    writeFileSync(join(root, 'dist', 'nested', 'module.js'), 'candidate-b');
    expect(() => assertLiveArtifacts(identity.sha256, root, paths)).toThrow(
      'LIVE_ARTIFACT_CHANGED',
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects the real entry without opt-in before creating a run or contacting anything', () => {
    const run = join(auditDirectory(), 'must-not-exist');
    const result = spawnSync(
      process.execPath,
      ['tests/compute/live-image-loop.ts', 'prepare', run, 'unused', 'unused', 'live-task'],
      { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH ?? '' } },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('LIVE_OPT_IN');
    expect(existsSync(run)).toBe(false);
  });

  it('parses valid CLI inputs without running a phase and rejects malformed arguments', () => {
    const valid = [
      '--scenario',
      'kling-omni-async',
      'execute',
      '.runtime/fixture-not-created',
      'a',
      'b',
      'live-task',
    ];
    expect(parseLiveInvocation(valid, 'yes', undefined)).toMatchObject({
      scenario: 'kling-omni-async',
      explicitScenario: true,
      phase: 'execute',
      taskId: 'live-task',
    });
    expect(() => parseLiveInvocation(valid, undefined, undefined)).toThrow('LIVE_OPT_IN');
    expect(() =>
      parseLiveInvocation(['--scenario', 'invalid', ...valid.slice(2)], 'yes', undefined),
    ).toThrow('LIVE_SCENARIO');
    expect(() => parseLiveInvocation(valid, 'yes', 'seedream-sync')).toThrow('LIVE_ARGUMENTS');
    expect(() => parseLiveInvocation(valid.slice(0, -1), 'yes', undefined)).toThrow(
      'LIVE_ARGUMENTS',
    );
    expect(() => parseLiveInvocation([...valid, 'extra'], 'yes', undefined)).toThrow(
      'LIVE_ARGUMENTS',
    );
    expect(() =>
      parseLiveInvocation([...valid.slice(0, -1), '../other'], 'yes', undefined),
    ).toThrow('LIVE_TASK');
    expect(() =>
      parseLiveInvocation([...valid, '--scenario', 'seedream-sync'], 'yes', undefined),
    ).toThrow('LIVE_ARGUMENTS');
    expect(
      parseLiveInvocation(
        [
          '--scenario',
          'seedream-sync',
          'dev',
          '.runtime/fixture-not-created',
          'login.json',
          'live-task',
        ],
        'yes',
        undefined,
      ),
    ).toMatchObject({
      scenario: 'seedream-sync',
      explicitScenario: true,
      phase: 'dev',
      first: 'login.json',
      second: '',
      taskId: 'live-task',
    });
    expect(() =>
      parseLiveInvocation(
        ['dev', '.runtime/fixture-not-created', 'a', 'b', 'live-task'],
        'yes',
        undefined,
      ),
    ).toThrow('LIVE_ARGUMENTS');
    expect(existsSync('.runtime/fixture-not-created')).toBe(false);
  });

  it('retires B execution phases before starting any operation', () => {
    expect(() => assertLivePhase('execute')).toThrow('LIVE_LEGACY_PHASE_RETIRED');
    expect(() => assertLivePhase('prepare')).toThrow('LIVE_LEGACY_PHASE_RETIRED');
    expect(() => assertLivePhase('dev')).not.toThrow();
  });

  const scenarios = [
    ['seedream-45-sync', 'doubao-seedream-4.5'],
    ['seedream-50-lite-sync', 'doubao-seedream-5.0-lite'],
    ['kling-omni-async', 'image-kling-v3-omni'],
  ] as const;
  it.each(scenarios)(
    'selects only a current discovered %s model and validates its fixture route',
    (scenario, modelId) => {
      const item = {
        modelId,
        modelRef: 'ref',
        discovered: true,
        credentialVersion: 3,
        catalogVersion: 4,
      };
      expect(selectLiveModel(scenario, [item], 3, 4)).toEqual(item);
      expect(validateModelRouteEntry(liveRouteDeclaration(scenario, modelId))).toBeDefined();
      const transport = vi.fn();
      vi.stubGlobal('fetch', transport);
      expect(() => selectLiveModel(scenario, [{ ...item, discovered: false }], 3, 4)).toThrow(
        'LIVE_MODEL_NOT_FOUND',
      );
      expect(() => selectLiveModel(scenario, [item], 3, 5)).toThrow('LIVE_MODEL_NOT_FOUND');
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('uses public reference fields, requested count and the exact omni route', () => {
    expect(liveImageParameters('seedream-45-sync', 'owned-ready')).toMatchObject({
      operation: 'generate',
      imageAssetIds: ['owned-ready'],
      size: '2K',
      n: 1,
    });
    expect(liveImageParameters('seedream-50-lite-sync')).toMatchObject({
      prompt:
        'Generate exactly two separate images: first a blue square on a white background; second a blue circle on a white background.',
      size: '2K',
      output_format: 'png',
      n: 2,
    });
    expect(liveImageParameters('kling-omni-async', 'owned-ready')).toMatchObject({
      operation: 'generate',
      imageAssetIds: ['owned-ready'],
      async: true,
      n: 1,
    });
    expect(liveImageParameters('gpt-edit', 'owned-ready')).toMatchObject({
      operation: 'edit',
      imageAssetIds: ['owned-ready'],
      n: 1,
    });
    expect(() => liveImageParameters('kling-omni-async')).toThrow('LIVE_REFERENCE_REQUIRED');
    const route = liveRouteDeclaration('kling-omni-async', 'image-kling-v3-omni');
    expect(route).toMatchObject({
      submitPath: '/kling/v1/images/omni-image',
      queryPathTemplate: '/kling/v1/images/omni-image/{task_id}',
      requestDefaults: { referenceFormat: 'image_list' },
      paramSpec: { allowGenerateReferences: true, maxReferenceImages: 1, async: { maxQueries: 8 } },
    });
  });

  it.each([
    ['seedream-45-sync', 'doubao-seedream-4.5', true],
    ['seedream-50-lite-sync', 'doubao-seedream-5.0-lite', false],
    ['kling-omni-async', 'image-kling-v3-omni', true],
    ['gpt-edit', 'gpt-image-2', true],
  ] as const)(
    'verifies the actual frozen %s command and rejects changed fields',
    (scenario, modelId, hasReference) => {
      const ownerId = randomUUID();
      const jobId = randomUUID();
      const referenceId = hasReference ? randomUUID() : undefined;
      const reference = referenceId
        ? {
            assetId: referenceId,
            key: `mio/raw/${referenceId}/${randomUUID()}`,
            sizeBytes: 13,
            etag: '"raw-etag"',
            contentType: 'image/png' as const,
          }
        : undefined;
      const parameters = liveImageParameters(scenario, referenceId);
      const input: Record<string, unknown> = { ...parameters };
      delete input.imageAssetIds;
      const base = findFixtureImageRouteConfig(modelId);
      const route = {
        ...base,
        paramSpec: {
          ...base.paramSpec,
          ...(scenario === 'kling-omni-async'
            ? { async: { operations: ['generate' as const], maxQueries: 8, maxAgeSeconds: 600 } }
            : {}),
          ...(scenario === 'gpt-edit' ? { maxReferenceImages: 4 } : {}),
        },
      };
      const command = {
        type: 'image.request',
        jobId,
        ownerId,
        credential: { format: 'synthetic' },
        profile: route.driver,
        route,
        input: {
          ...input,
          model: modelId,
          ...(reference ? { images: [reference] } : {}),
        },
      } as unknown as Parameters<typeof assertFrozenScenario>[0];
      const check = (value: typeof command) =>
        assertFrozenScenario(value, scenario, modelId, ownerId, jobId, reference);
      expect(() => check(command)).not.toThrow();
      const mutations: ((value: typeof command) => void)[] = [
        (value) => {
          value.ownerId = randomUUID();
        },
        (value) => {
          value.input.model = 'wrong-model';
        },
        (value) => {
          value.input.operation = value.input.operation === 'edit' ? 'generate' : 'edit';
        },
        (value) => {
          value.input.size = 'wrong-size';
        },
        (value) => {
          value.input.output_format = value.input.output_format === 'png' ? 'jpeg' : 'png';
        },
        (value) => {
          value.input.async = value.input.async !== true;
        },
        (value) => {
          value.input.n = (value.input.n ?? 1) + 1;
        },
        (value) => {
          value.input.images = [
            { assetId: randomUUID() } as NonNullable<typeof value.input.images>[number],
          ];
        },
        (value) => {
          (value.route as { submitPath: string }).submitPath = '/wrong';
        },
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(command);
        mutate(changed);
        expect(() => check(changed)).toThrow('LIVE_FROZEN_MISMATCH');
      }
      if (reference) {
        const singleForm = structuredClone(command);
        delete singleForm.input.images;
        singleForm.input.image = reference;
        expect(() => check(singleForm)).not.toThrow();
        for (const mutation of [
          { key: `mio/raw/${reference.assetId}/${randomUUID()}` },
          { sizeBytes: reference.sizeBytes + 1 },
          { etag: '"staging-etag"' },
          { contentType: 'image/jpeg' as const },
        ]) {
          const changed = structuredClone(command);
          changed.input.images = [{ ...reference, ...mutation }];
          expect(() => check(changed)).toThrow('LIVE_FROZEN_MISMATCH');
        }
        const bothForms = structuredClone(command);
        bothForms.input.image = reference;
        expect(() => check(bothForms)).toThrow('LIVE_FROZEN_MISMATCH');
      }
    },
  );

  it('encodes the two Seedream scenarios through the real protocol with fake transport', async () => {
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const id = randomUUID();
    const reference = {
      assetId: id,
      key: `mio/raw/${id}/${randomUUID()}`,
      sizeBytes: bytes.length,
      etag: 'synthetic-etag',
      contentType: 'image/png' as const,
    };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ b64_json: bytes.toString('base64') }, { b64_json: bytes.toString('base64') }],
      }),
    );
    const route = findFixtureImageRouteConfig('doubao-seedream-5.0-lite');
    const parameters = liveImageParameters('seedream-50-lite-sync');
    const result = await createRoutedImageProtocol(
      route,
      'generate',
      transport as typeof fetch,
    ).submit(
      { ...parameters, model: 'doubao-seedream-5.0-lite' } as Parameters<
        ReturnType<typeof createRoutedImageProtocol>['submit']
      >[0],
      'synthetic-key',
    );
    expect(result.state).toBe('returned');
    expect(String(transport.mock.calls[0]?.[0])).toBe(
      'https://api.onelinkai.cloud/volc/api/v3/images/generations',
    );
    const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      prompt: parameters.prompt,
      size: '2K',
      output_format: 'png',
      sequential_image_generation: 'auto',
      sequential_image_generation_options: { max_images: 2 },
    });
    const refTransport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: bytes.toString('base64') }] }));
    const referenceParameters = liveImageParameters('seedream-45-sync', id);
    const referenceInput: Record<string, unknown> = { ...referenceParameters };
    delete referenceInput.imageAssetIds;
    const refResult = await createRoutedImageProtocol(
      findFixtureImageRouteConfig('doubao-seedream-4.5'),
      'generate',
      refTransport as typeof fetch,
      async () => bytes,
    ).submit(
      { ...referenceInput, model: 'doubao-seedream-4.5', images: [reference] } as Parameters<
        ReturnType<typeof createRoutedImageProtocol>['submit']
      >[0],
      'synthetic-key',
    );
    expect(refResult.state).toBe('returned');
    const refBody = JSON.parse(String(refTransport.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(refBody.size).toBe('2K');
    expect(refBody.image).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
    expect(transport).toHaveBeenCalledOnce();
    expect(refTransport).toHaveBeenCalledOnce();
  });

  it('encodes omni references into image_list using the real async protocol and fake transport', async () => {
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const id = randomUUID();
    const reference = {
      assetId: id,
      key: `mio/raw/${id}/${randomUUID()}`,
      sizeBytes: bytes.length,
      etag: 'synthetic-etag',
      contentType: 'image/png' as const,
    };
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 0, data: { task_id: 'task-1' } }));
    const route = findFixtureImageRouteConfig('image-kling-v3-omni');
    const asyncTransport = defaultRouteAsyncTransport(
      route,
      transport as typeof fetch,
      async () => bytes,
    );
    const parameters = liveImageParameters('kling-omni-async', id);
    const input: Record<string, unknown> = { ...parameters };
    delete input.imageAssetIds;
    const result = await createRoutedImageProtocol(
      route,
      'generate',
      transport as typeof fetch,
      undefined,
      asyncTransport,
    ).submitAsync(
      { ...input, model: 'image-kling-v3-omni', images: [reference] } as Parameters<
        ReturnType<typeof createRoutedImageProtocol>['submitAsync']
      >[0],
      'synthetic-key',
    );
    expect(result.state).toBe('submitted');
    expect(String(transport.mock.calls[0]?.[0])).toBe(
      'https://api.onelinkai.cloud/kling/v1/images/omni-image',
    );
    const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model_name: 'image-kling-v3-omni',
      n: 1,
      image_list: [{ image: bytes.toString('base64') }],
    });
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe('multi-output and owned asset validation', () => {
  const jobId = '54e6573d-113f-47ce-a690-2bf698b9138a';
  const assetIds: string[] = [randomUUID(), randomUUID()];
  const outputs = [0, 1].map((index) => ({
    key: `mio/derived/${jobId}/images/${index}-${randomUUID()}.png`,
    sizeBytes: 4,
    sha256: createHash('sha256').update('test').digest('hex'),
    contentType: 'image/png',
  }));
  const image = {
    jobId,
    status: 'completed',
    requestedCount: 2,
    errorCode: null,
    assetIds,
    outputs: assetIds.map((assetId, index) => ({ index, assetId })),
  };
  it('matches every expected output by original index and rejects partial or mismatched results', () => {
    expect(matchCompletedOutputs(image, outputs, 2, 'seedream-50-lite-sync')).toEqual([
      { assetId: assetIds[0], output: outputs[0] },
      { assetId: assetIds[1], output: outputs[1] },
    ]);
    expect(() =>
      matchCompletedOutputs({ ...image, status: 'partial' }, outputs, 2, 'seedream-50-lite-sync'),
    ).toThrow('LIVE_IMAGE_INCOMPLETE');
    expect(() =>
      matchCompletedOutputs(image, outputs.slice(0, 1), 2, 'seedream-50-lite-sync'),
    ).toThrow('LIVE_IMAGE_INCOMPLETE');
    expect(() =>
      matchCompletedOutputs({ ...image, requestedCount: 1 }, outputs, 2, 'seedream-50-lite-sync'),
    ).toThrow('LIVE_IMAGE_INCOMPLETE');
    expect(() =>
      matchCompletedOutputs(
        image,
        [outputs[0]!, { ...outputs[1]!, contentType: 'image/jpeg' }],
        2,
        'seedream-50-lite-sync',
      ),
    ).toThrow('LIVE_JOURNAL_OBJECT');
    expect(() =>
      matchCompletedOutputs(
        { ...image, assetIds: [assetIds[0]!, assetIds[0]!] },
        outputs,
        2,
        'seedream-50-lite-sync',
      ),
    ).toThrow('LIVE_IMAGE_INCOMPLETE');
  });

  it('uploads one reference and checks ready ownership, every downloaded byte count and hash', async () => {
    const bytes = Buffer.from('fixture-image');
    const owner = 'owner-cookie';
    const other = 'other-cookie';
    const state = {
      origin: 'http://127.0.0.1:4321',
      a: { MIO_COS_BUCKET: 'fixture', MIO_COS_REGION: 'test' },
    };
    const assetId = randomUUID();
    const rawKey = `mio/raw/${assetId}/${randomUUID()}`;
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== '127.0.0.1')
        return init?.method === 'PUT'
          ? new Response(null, { status: 200, headers: { etag: '"staging-etag"' } })
          : new Response(bytes, { headers: { etag: '"raw-etag"' } });
      const cookie = (init?.headers as Record<string, string> | undefined)?.cookie;
      if (url.pathname === '/api/v1/assets/uploads')
        return Response.json(
          { assetId, uploadUrl: 'https://fixture.cos.test.myqcloud.com/staging?sig=synthetic' },
          { status: 201 },
        );
      if (url.pathname.endsWith('/complete')) return Response.json({ status: 'ready' });
      if (!cookie) return new Response(null, { status: 401 });
      if (cookie === other) return new Response(null, { status: 404 });
      const id = url.pathname.split('/').at(-1);
      const index = assetIds.indexOf(id ?? '');
      const key = index < 0 ? rawKey : outputs[index]!.key;
      return Response.json({
        status: 'ready',
        contentType: 'image/png',
        size: bytes.length,
        downloadUrl: `https://fixture.cos.test.myqcloud.com/${key}?sig=synthetic`,
      });
    });
    vi.stubGlobal('fetch', transport);
    expect(await createReferenceAsset(state, owner, other, bytes)).toEqual({
      assetId,
      key: rawKey,
      sizeBytes: bytes.length,
      contentType: 'image/png',
      etag: '"raw-etag"',
    });
    const expected = {
      contentType: 'image/png',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    await assetBytes(state, owner, other, assetIds[0]!, { ...expected, key: outputs[0]!.key });
    await assetBytes(state, owner, other, assetIds[1]!, { ...expected, key: outputs[1]!.key });
    await expect(
      assetBytes(state, owner, other, assetIds[1]!, { ...expected, key: outputs[0]!.key }),
    ).rejects.toThrow('LIVE_ASSET_OBJECT_KEY');
    await expect(
      assetBytes(state, owner, other, assetIds[1]!, {
        ...expected,
        key: outputs[1]!.key,
        sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('LIVE_ASSET_HASH');
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(mocks.validateImage).toHaveBeenCalledTimes(3);
  });

  it.each(['missing-raw-etag', 'staging-key'] as const)(
    'rejects reference input when its verified raw identity is %s',
    async (failure) => {
      const bytes = Buffer.from('fixture-image');
      const assetId = randomUUID();
      const state = {
        origin: 'http://127.0.0.1:4321',
        a: { MIO_COS_BUCKET: 'fixture', MIO_COS_REGION: 'test' },
      };
      const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname !== '127.0.0.1') {
          if (init?.method === 'PUT')
            return new Response(null, { status: 200, headers: { etag: '"staging-etag"' } });
          return new Response(bytes, {
            headers: failure === 'missing-raw-etag' ? {} : { etag: '"raw-etag"' },
          });
        }
        const cookie = (init?.headers as Record<string, string> | undefined)?.cookie;
        if (url.pathname === '/api/v1/assets/uploads')
          return Response.json(
            { assetId, uploadUrl: 'https://fixture.cos.test.myqcloud.com/staging?sig=synthetic' },
            { status: 201 },
          );
        if (url.pathname.endsWith('/complete')) return Response.json({ status: 'ready' });
        if (!cookie) return new Response(null, { status: 401 });
        if (cookie === 'other') return new Response(null, { status: 404 });
        const key =
          failure === 'staging-key'
            ? `mio/staging/${assetId}`
            : `mio/raw/${assetId}/${randomUUID()}`;
        return Response.json({
          status: 'ready',
          contentType: 'image/png',
          size: bytes.length,
          downloadUrl: `https://fixture.cos.test.myqcloud.com/${key}?sig=synthetic`,
        });
      });
      vi.stubGlobal('fetch', transport);
      await expect(createReferenceAsset(state, 'owner', 'other', bytes)).rejects.toThrow(
        'LIVE_REFERENCE_OBJECT',
      );
    },
  );

  it('rechecks all output bytes and access after replay, rejecting a changed second output', async () => {
    const bytes = Buffer.from('test');
    const state = {
      origin: 'http://127.0.0.1:4321',
      a: { MIO_COS_BUCKET: 'fixture', MIO_COS_REGION: 'test' },
    };
    const matched = matchCompletedOutputs(image, outputs, 2, 'seedream-50-lite-sync');
    const downloaded: string[] = [];
    let corruptSecond = false;
    let exposeSecond = false;
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== '127.0.0.1') {
        const key = decodeURIComponent(url.pathname.slice(1));
        downloaded.push(key);
        return new Response(corruptSecond && key === outputs[1]!.key ? Buffer.from('fail') : bytes);
      }
      const cookie = (init?.headers as Record<string, string> | undefined)?.cookie;
      if (!cookie) return new Response(null, { status: 401 });
      const index = assetIds.indexOf(url.pathname.split('/').at(-1) ?? '');
      if (cookie === 'other')
        return new Response(null, { status: exposeSecond && index === 1 ? 200 : 404 });
      return Response.json({
        status: 'ready',
        contentType: 'image/png',
        size: bytes.length,
        downloadUrl: `https://fixture.cos.test.myqcloud.com/${outputs[index]!.key}?sig=synthetic`,
      });
    });
    vi.stubGlobal('fetch', transport);
    const observe = () =>
      verifyReplayResult(state, 'owner', 'other', {
        response: Response.json(image),
        initial: image,
        outputs: matched,
        expectedCount: 2,
        queryAttempts: 0,
        finalQueries: 0,
      });
    await expect(observe()).resolves.toBeUndefined();
    expect(downloaded).toEqual([outputs[0]!.key, outputs[1]!.key]);
    downloaded.length = 0;
    corruptSecond = true;
    await expect(observe()).rejects.toThrow('LIVE_ASSET_HASH');
    expect(downloaded).toEqual([outputs[0]!.key, outputs[1]!.key]);
    expect(
      transport.mock.calls.filter(
        ([, init]) => !init?.headers || !(init.headers as Record<string, string>).cookie,
      ),
    ).toHaveLength(8);
    corruptSecond = false;
    exposeSecond = true;
    await expect(observe()).rejects.toThrow('LIVE_ASSET_OTHER_OWNER');
  });

  it('decodes the object key from a URL signed locally by the configured COS SDK', () => {
    const storage = createCosStorage({
      databaseURL: 'postgresql://example.invalid/fixture',
      bucket: 'mio-test-1234567890',
      region: 'ap-shanghai',
      secretId: 'synthetic-id',
      secretKey: 'synthetic-key',
    });
    const key = outputs[0]!.key;
    const pathname = new URL(storage.downloadUrl(key)).pathname;
    expect(decodeURIComponent(pathname.slice(1))).toBe(key);
  });

  it.each([
    'https://fixture.cos.test.myqcloud.com:444/mio/derived/item',
    'https://user@fixture.cos.test.myqcloud.com/mio/derived/item',
  ])('rejects an unsafe signed download host before network access', async (downloadUrl) => {
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const cookie = (init?.headers as Record<string, string> | undefined)?.cookie;
      if (!cookie) return new Response(null, { status: 401 });
      if (cookie === 'other') return new Response(null, { status: 404 });
      return Response.json({ status: 'ready', contentType: 'image/png', size: 1, downloadUrl });
    });
    vi.stubGlobal('fetch', transport);
    await expect(
      assetBytes(
        {
          origin: 'http://127.0.0.1:4321',
          a: { MIO_COS_BUCKET: 'fixture', MIO_COS_REGION: 'test' },
        },
        'owner',
        'other',
        randomUUID(),
        { contentType: 'image/png', sizeBytes: 1, sha256: '0'.repeat(64), key: 'mio/derived/item' },
      ),
    ).rejects.toThrow('LIVE_ASSET_HOST');
    expect(transport).toHaveBeenCalledTimes(3);
    expect(
      transport.mock.calls.every(([input]) => String(input).startsWith('http://127.0.0.1:4321/')),
    ).toBe(true);
  });
});

describe('offline network audit interlock', () => {
  it('does not consume the generation POST budget for A model discovery or local service calls', async () => {
    const directory = auditDirectory();
    const transport = vi.fn(async () => Response.json({ data: [] }));
    await installAudit('gpt-sync', directory, transport as typeof fetch);
    await fetch('https://api.onelinkai.cloud/v1/models');
    await fetch('http://127.0.0.1:4310/readyz');
    expect(existsSync(join(directory, 'supplier-post-started.json'))).toBe(false);
    await fetch('https://api.onelinkai.cloud/v1/images/generations', { method: 'POST' });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(existsSync(join(directory, 'supplier-post-started.json'))).toBe(true);
  });

  const endpoints = [
    ['vidu-async', '/vidu/ent/v2/reference2image'],
    ['kling-async', '/kling/v1/images/generations'],
    ['seedream-sync', '/volc/api/v3/images/generations'],
    ['gpt-sync', '/v1/images/generations'],
    ['gpt-edit', '/v1/images/edits'],
    ['seedream-45-sync', '/volc/api/v3/images/generations'],
    ['seedream-50-lite-sync', '/volc/api/v3/images/generations'],
    ['kling-omni-async', '/kling/v1/images/omni-image'],
  ] as const;
  it.each(endpoints)(
    'allows one exact %s POST then blocks a repeat, including after restart',
    async (scenario, path) => {
      const directory = auditDirectory();
      const transport = vi.fn(async () => new Response(null, { status: 200 }));
      await installAudit(scenario, directory, transport as typeof fetch);
      const url = `https://api.onelinkai.cloud${path}`;
      await fetch(url, { method: 'POST' });
      expect(() => fetch(url, { method: 'POST' })).toThrow('LIVE_IMAGE_REPEAT_POST_BLOCKED');
      await installAudit(scenario, directory, transport as typeof fetch);
      expect(() => fetch(url, { method: 'POST' })).toThrow('LIVE_IMAGE_REPEAT_POST_BLOCKED');
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it('blocks wrong and unknown endpoints before forwarding and never retries unknown outcomes', async () => {
    const blocked = auditDirectory();
    const transport = vi.fn(async () => new Response(null, { status: 200 }));
    await installAudit('kling-omni-async', blocked, transport as typeof fetch);
    expect(() =>
      fetch('https://api.onelinkai.cloud/kling/v1/images/generations', { method: 'POST' }),
    ).toThrow('LIVE_IMAGE_UNEXPECTED_PROVIDER_POST');
    expect(transport).not.toHaveBeenCalled();
    const unknown = auditDirectory();
    const failing = vi.fn(async () => {
      throw new Error('synthetic transport failure');
    });
    await installAudit('gpt-edit', unknown, failing as typeof fetch);
    await expect(
      fetch('https://api.onelinkai.cloud/v1/images/edits', { method: 'POST' }),
    ).rejects.toThrow();
    await installAudit('gpt-edit', unknown, failing as typeof fetch);
    expect(() => fetch('https://api.onelinkai.cloud/v1/images/edits', { method: 'POST' })).toThrow(
      'LIVE_IMAGE_REPEAT_POST_BLOCKED',
    );
    expect(failing).toHaveBeenCalledOnce();
  });

  it('rejects vidu img2img because the selected route is reference2image', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 200 }));
    await installAudit('vidu-async', auditDirectory(), transport as typeof fetch);
    expect(() =>
      fetch('https://api.onelinkai.cloud/vidu/ent/v2/img2img', { method: 'POST' }),
    ).toThrow('LIVE_IMAGE_UNEXPECTED_PROVIDER_POST');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([307, 308])(
    'does not follow HTTP %i redirects to an unapproved endpoint',
    async (status) => {
      const requests: {
        path: string | undefined;
        method: string | undefined;
        body: string;
        header: string | undefined;
      }[] = [];
      const server = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          requests.push({
            path: request.url,
            method: request.method,
            body,
            header: request.headers['x-fixture'] as string | undefined,
          });
          response.writeHead(status, { location: '/unapproved' });
          response.end();
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('fixture server unavailable');
        const nativeFetch = globalThis.fetch;
        const transport = vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const original = input instanceof Request ? input : new Request(input, init);
          const local = new Request(`http://127.0.0.1:${address.port}/approved`, original);
          return nativeFetch(local, init);
        });
        await installAudit('kling-omni-async', auditDirectory(), transport as typeof fetch);
        const request = new Request('https://api.onelinkai.cloud/kling/v1/images/omni-image', {
          method: 'POST',
          body: 'fixture-body',
          headers: { 'x-fixture': 'preserved' },
          redirect: 'follow',
        });
        await expect(fetch(request, { redirect: 'follow' })).rejects.toThrow();
        expect(transport).toHaveBeenCalledOnce();
        expect(transport.mock.calls[0]?.[1]?.redirect).toBe('error');
        expect(requests).toEqual([
          { path: '/approved', method: 'POST', body: 'fixture-body', header: 'preserved' },
        ]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done, fail) =>
          server.close((error) => (error ? fail(error) : done())),
        );
      }
    },
  );

  it('holds omni before the first query, enforces task identity and caps forwarding at eight', async () => {
    const directory = auditDirectory();
    writeFileSync(
      join(directory, 'allowed-task.json'),
      JSON.stringify({ upstreamTaskId: 'task-1', deadline: Date.now() + 600_000 }),
    );
    const transport = vi.fn(async () =>
      Response.json({ code: 0, data: { task_status: 'processing' } }),
    );
    vi.stubEnv('MIO_LIVE_IMAGE_HOLD_FIRST_QUERY', 'yes');
    await installAudit('kling-omni-async', directory, transport as typeof fetch);
    void fetch('https://api.onelinkai.cloud/kling/v1/images/omni-image/task-1');
    expect(transport).not.toHaveBeenCalled();
    vi.stubEnv('MIO_LIVE_IMAGE_HOLD_FIRST_QUERY', 'no');
    await installAudit('kling-omni-async', directory, transport as typeof fetch);
    expect(() => fetch('https://api.onelinkai.cloud/kling/v1/images/omni-image/wrong')).toThrow(
      'LIVE_QUERY_TASK_MISMATCH',
    );
    for (let i = 0; i < 8; i++)
      await fetch('https://api.onelinkai.cloud/kling/v1/images/omni-image/task-1');
    expect(() => fetch('https://api.onelinkai.cloud/kling/v1/images/omni-image/task-1')).toThrow(
      'LIVE_QUERY_LIMIT_BLOCKED',
    );
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(8));
    await vi.waitFor(async () => {
      const { existsSync } = await import('node:fs');
      expect(existsSync(join(directory, 'supplier-query-8-trace.json'))).toBe(true);
    });
  });

  it('waits for the persisted task before forwarding and rejects an unrelated held query', async () => {
    const directory = auditDirectory();
    const transport = vi.fn(async () =>
      Response.json({ code: 0, data: { task_status: 'processing' } }),
    );
    vi.stubEnv('MIO_LIVE_IMAGE_AWAIT_TASK', 'yes');
    await installAudit('kling-async', directory, transport as typeof fetch);
    const wrong = fetch('https://api.onelinkai.cloud/kling/v1/images/generations/wrong', {
      headers: { authorization: 'synthetic-secret' },
    });
    expect(existsSync(join(directory, 'supplier-query-held.json'))).toBe(true);
    expect(transport).not.toHaveBeenCalled();
    writeFileSync(
      join(directory, 'allowed-task.json'),
      JSON.stringify({ upstreamTaskId: 'actual-task', deadline: Date.now() + 600_000 }),
    );
    await expect(wrong).rejects.toThrow('LIVE_QUERY_TASK_MISMATCH');
    expect(transport).not.toHaveBeenCalled();
    for (let i = 0; i < 8; i++)
      await fetch('https://api.onelinkai.cloud/kling/v1/images/generations/actual-task', {
        headers: { authorization: 'synthetic-secret' },
      });
    expect(() =>
      fetch('https://api.onelinkai.cloud/kling/v1/images/generations/actual-task'),
    ).toThrow('LIVE_QUERY_LIMIT_BLOCKED');
    expect(transport).toHaveBeenCalledTimes(8);
    expect(readFileSync(join(directory, 'supplier-http-events.jsonl'), 'utf8')).not.toContain(
      'synthetic-secret',
    );
  });

  it('does not forward a held query after its caller aborts', async () => {
    const directory = auditDirectory();
    const transport = vi.fn(async () => new Response('ok'));
    vi.stubEnv('MIO_LIVE_IMAGE_AWAIT_TASK', 'yes');
    await installAudit('kling-async', directory, transport as typeof fetch);
    const controller = new AbortController();
    const held = fetch('https://api.onelinkai.cloud/kling/v1/images/generations/actual-task', {
      signal: controller.signal,
    });
    controller.abort();
    writeFileSync(
      join(directory, 'allowed-task.json'),
      JSON.stringify({ upstreamTaskId: 'actual-task', deadline: Date.now() + 600_000 }),
    );
    await expect(held).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a query whose persisted deadline expired while waiting for the task', async () => {
    const directory = auditDirectory();
    const transport = vi.fn(async () => new Response('ok'));
    vi.stubEnv('MIO_LIVE_IMAGE_AWAIT_TASK', 'yes');
    await installAudit('kling-async', directory, transport as typeof fetch);
    const held = fetch('https://api.onelinkai.cloud/kling/v1/images/generations/actual-task');
    writeFileSync(
      join(directory, 'allowed-task.json'),
      JSON.stringify({ upstreamTaskId: 'actual-task', deadline: Date.now() - 1 }),
    );
    await expect(held).rejects.toThrow('LIVE_QUERY_DEADLINE_EXCEEDED');
    expect(transport).not.toHaveBeenCalled();
    expect(existsSync(join(directory, 'supplier-query-deadline-blocked.json'))).toBe(true);
  });

  it('does not forward when recording the query budget crosses its deadline', async () => {
    const directory = auditDirectory();
    const transport = vi.fn(async () => new Response('ok'));
    writeFileSync(
      join(directory, 'allowed-task.json'),
      JSON.stringify({ upstreamTaskId: 'actual-task', deadline: 1000 }),
    );
    await installAudit('kling-async', directory, transport as typeof fetch);
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(999).mockReturnValueOnce(1000);
    try {
      expect(() =>
        fetch('https://api.onelinkai.cloud/kling/v1/images/generations/actual-task'),
      ).toThrow('LIVE_QUERY_DEADLINE_EXCEEDED');
      expect(existsSync(join(directory, 'supplier-query-1.json'))).toBe(true);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});
