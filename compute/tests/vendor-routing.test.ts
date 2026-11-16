import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  imageCommandCredentialBinding,
  imageOutputIndex,
  imageOutputKey,
  imageQueryCredentialBinding,
  parseImageResult,
  validateImageInputByRoute,
  validateImageRouteConfig,
  type ImageAssetRef,
  type ImageDriver,
  type ImageInput,
  type ImageQueryCommandV1,
  type ImageRouteConfig,
  type ImageRouteParamSpec,
} from '@mio/compute-contracts';
import { Journal } from '../src/adapters/journal.ts';
import { createImageWorker } from '../src/image-worker.ts';
import { createRoutedImageProtocol, defaultRouteAsyncTransport } from '../src/images.ts';
import { sealImageKey } from '../../src/compute/image-credentials.ts';

function encodeSample(codec: 'png' | 'mjpeg'): Uint8Array {
  const encoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=16x16',
      '-frames:v',
      '1',
      '-c:v',
      codec,
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  if (encoded.status !== 0) throw new Error('ffmpeg sample encode failed');
  return Uint8Array.from(encoded.stdout);
}

const PNG_BYTES = encodeSample('png');
const JPEG_BYTES = encodeSample('mjpeg');

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeRoute(
  driver: ImageDriver,
  vendor: string,
  submitPath: string,
  paramOverrides: Partial<ImageRouteParamSpec>,
  options?: {
    editPath?: string | null;
    queryPathTemplate?: string | null;
    effectiveWatermark?: boolean | null;
    watermarkDefault?: boolean | null;
    referenceFormat?: 'image' | 'image_list' | null;
    fixedOutputFormat?: 'png' | 'jpeg' | 'webp' | null;
  },
): ImageRouteConfig {
  const requiresAsync = paramOverrides.requiresAsync ?? false;
  return {
    driver,
    vendor,
    submitPath,
    editPath: options?.editPath ?? null,
    queryPathTemplate: options?.queryPathTemplate ?? null,
    requiresAsync,
    ...(options?.effectiveWatermark !== undefined
      ? { effectiveWatermark: options.effectiveWatermark }
      : {}),
    paramSpec: {
      supportedOperations: ['generate'],
      requiresAsync,
      maxN: 1,
      allowExplicitN: true,
      allowedSizes: null,
      allowCustomDimensions: false,
      maxReferenceImages: 0,
      allowGenerateReferences: false,
      allowMaskPng: false,
      allowOutpaintGeometry: false,
      allowedQualities: [],
      allowedBackgrounds: [],
      allowedModerations: [],
      allowedOutputFormats: [],
      allowOutputCompression: false,
      allowUserField: false,
      allowedAspectRatios: [],
      allowWatermarkOverride: false,
      async: null,
      ...paramOverrides,
    },
    requestDefaults: {
      ...(options?.watermarkDefault !== undefined ? { watermark: options.watermarkDefault } : {}),
      ...(options?.referenceFormat !== undefined
        ? { referenceFormat: options.referenceFormat }
        : {}),
    },
    outputSpec: { fixedOutputFormat: options?.fixedOutputFormat ?? null },
  };
}

function assetRef(contentType: ImageAssetRef['contentType'] = 'image/png'): ImageAssetRef {
  const assetId = randomUUID();
  return {
    assetId,
    key: `mio/raw/${assetId}/${randomUUID()}`,
    sizeBytes: PNG_BYTES.byteLength,
    etag: '"etag-v1"',
    contentType,
  };
}

function mockDownload(bytes: Uint8Array = PNG_BYTES) {
  return async <T>(
    _url: URL,
    _signal: AbortSignal | undefined,
    action: (response: Response) => Promise<T>,
  ): Promise<T> =>
    action(
      new Response(Buffer.from(bytes), {
        status: 200,
        headers: { 'content-type': bytes === JPEG_BYTES ? 'image/jpeg' : 'image/png' },
      }),
    );
}

function routedCommand(
  route: ImageRouteConfig,
  input: ImageInput,
  profile: ImageRouteConfig['driver'] = route.driver,
) {
  const base = {
    version: 1 as const,
    type: 'image.request' as const,
    messageId: randomUUID(),
    jobId: randomUUID(),
    ownerId: randomUUID(),
    expiresAt: Date.now() + 120_000,
    profile,
    route,
    input,
  };
  const binding = imageCommandCredentialBinding(base);
  return { ...base, credential: sealImageKey('secret-onelink-key', binding, 'b1', keys.publicKey) };
}

describe('ImageRouteConfig contracts and 16-output bounds', () => {
  it('accepts indices 0..15 and up to 16 outputs while rejecting index 16', () => {
    const jobId = randomUUID();
    const outputs = Array.from({ length: 16 }, (_, index) => {
      const fileId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const key = imageOutputKey(jobId, index, fileId, 'png');
      expect(imageOutputIndex(jobId, key, 'image/png')).toBe(index);
      return {
        key,
        sizeBytes: 16,
        sha256: 'a'.repeat(64),
        etag: 'etag',
        contentType: 'image/png',
      };
    });
    expect(() => imageOutputKey(jobId, 16, randomUUID(), 'png')).toThrow('IMAGE_OUTPUT_INVALID');
    const overKey = `mio/derived/${jobId}/images/16-${randomUUID()}.png`;
    expect(imageOutputIndex(jobId, overKey, 'image/png')).toBeNull();
    expect(
      parseImageResult({
        version: 1,
        type: 'image.result',
        messageId: randomUUID(),
        commandId: randomUUID(),
        jobId,
        state: 'completed',
        outputs,
      }).outputs,
    ).toHaveLength(16);
    expect(() =>
      parseImageResult({
        version: 1,
        type: 'image.result',
        messageId: randomUUID(),
        commandId: randomUUID(),
        jobId,
        state: 'completed',
        outputs: [...outputs, { ...outputs[0]!, key: overKey }],
      }),
    ).toThrow('IMAGE_MESSAGE_INVALID');
  });

  it('enforces driver path prefixes, traversal bans, {task_id} templates, maxN=15 and maxReferenceImages=1', () => {
    const validSeedream5 = makeRoute(
      'volcengine-ark-images',
      'volcengine',
      '/volc/api/v3/images/generations',
      {
        supportedOperations: ['generate', 'edit'],
        allowedSizes: ['2K', '3K'],
        maxN: 15,
        maxReferenceImages: 14,
        allowGenerateReferences: true,
        allowWatermarkOverride: true,
      },
      { watermarkDefault: true, fixedOutputFormat: 'jpeg' },
    );
    expect(validateImageRouteConfig(validSeedream5)).toBe(true);
    expect(
      validateImageInputByRoute(
        { model: 'doubao-seedream-5.0-lite', prompt: 'poster', n: 15, size: '2K' },
        validSeedream5,
      ),
    ).toBe(true);
    expect(
      validateImageRouteConfig({ ...validSeedream5, submitPath: '/v1/images/generations' }),
    ).toBe(false);
    expect(
      validateImageRouteConfig({
        ...validSeedream5,
        submitPath: '/volc/api/v3/../v1/images/generations',
      }),
    ).toBe(false);
    const validKlingOmni = makeRoute(
      'kling-images',
      'kling',
      '/kling/v1/images/omni-image',
      {
        supportedOperations: ['generate', 'edit'],
        requiresAsync: true,
        maxReferenceImages: 1,
        allowGenerateReferences: true,
        async: { operations: ['generate', 'edit'], maxQueries: 12, maxAgeSeconds: 300 },
      },
      {
        queryPathTemplate: '/kling/v1/images/omni-image/{task_id}',
        referenceFormat: 'image_list',
      },
    );
    expect(validateImageRouteConfig(validKlingOmni)).toBe(true);
    expect(
      validateImageRouteConfig({
        ...validKlingOmni,
        requestDefaults: {},
      }),
    ).toBe(false);
    expect(
      validateImageRouteConfig({
        ...validKlingOmni,
        paramSpec: { ...validKlingOmni.paramSpec, maxReferenceImages: 2 },
        requestDefaults: { referenceFormat: 'image' },
      }),
    ).toBe(false);
    expect(
      validateImageRouteConfig({
        ...validSeedream5,
        requestDefaults: { ...validSeedream5.requestDefaults, referenceFormat: 'image' },
      }),
    ).toBe(false);
    expect(
      validateImageRouteConfig({
        ...validKlingOmni,
        queryPathTemplate: '/kling/v1/images/omni-image/{other}',
      }),
    ).toBe(false);
  });
});

describe('four OneLink vendor image drivers', () => {
  it('encodes openai-images JSON generate and multipart edit with PNG mask without leaking COS metadata', async () => {
    const genRoute = makeRoute('openai-images', 'openai', '/v1/images/generations', {
      supportedOperations: ['generate'],
      allowedSizes: ['1024x1024'],
      allowedQualities: ['high'],
      allowedBackgrounds: ['transparent'],
      allowedOutputFormats: ['png'],
      maxN: 2,
    });
    const editRoute = makeRoute(
      'openai-images',
      'openai',
      '/v1/images/generations',
      {
        supportedOperations: ['generate', 'edit'],
        maxReferenceImages: 2,
        allowMaskPng: true,
      },
      { editPath: '/v1/images/edits' },
    );
    const calls: { url: string; body: unknown }[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const body =
        init?.body instanceof FormData
          ? Array.from(init.body.entries()).map(([k, v]) => [k, v instanceof File ? v.name : v])
          : JSON.parse(String(init?.body));
      calls.push({ url: String(input), body });
      return Response.json({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString('base64') }] });
    });
    const genProto = createRoutedImageProtocol(
      genRoute,
      'generate',
      transport,
      undefined,
      undefined,
      mockDownload(),
    );
    const genRes = await genProto.submit(
      {
        model: 'gpt-image-1',
        prompt: 'icon',
        size: '1024x1024',
        quality: 'high',
        background: 'transparent',
        output_format: 'png',
      },
      'sk-test',
    );
    expect(genRes.state).toBe('returned');

    const ref = assetRef('image/png');
    const mask = assetRef('image/png');
    const editProto = createRoutedImageProtocol(
      editRoute,
      'edit',
      transport,
      async () => PNG_BYTES,
      undefined,
      mockDownload(),
    );
    const editRes = await editProto.submit(
      { model: 'gpt-image-1', operation: 'edit', prompt: 'replace sky', image: ref, mask },
      'sk-test',
    );
    expect(editRes.state).toBe('returned');
    expect(calls[0]?.url).toBe('https://api.onelinkai.cloud/v1/images/generations');
    expect(calls[1]?.url).toBe('https://api.onelinkai.cloud/v1/images/edits');
    const serialized = JSON.stringify(calls[1]?.body);
    expect(serialized).not.toContain(ref.assetId);
    expect(serialized).not.toContain(ref.key);
    expect(serialized).not.toContain(ref.etag);
  });

  it('runs volcengine-ark-images sequential n=15, reference data URI, effectiveWatermark=false and URL download', async () => {
    const route = makeRoute(
      'volcengine-ark-images',
      'volcengine',
      '/volc/api/v3/images/generations',
      {
        supportedOperations: ['generate', 'edit'],
        allowedSizes: ['2K', '3K'],
        maxN: 15,
        maxReferenceImages: 14,
        allowGenerateReferences: true,
        allowWatermarkOverride: true,
      },
      { effectiveWatermark: false, watermarkDefault: true, fixedOutputFormat: 'jpeg' },
    );
    const directory = mkdtempSync(join(tmpdir(), 'mio-volc-route-'));
    const journal = new Journal(directory, randomUUID(), true);
    const ref = assetRef('image/png');
    const outboundBodies: Record<string, unknown>[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      outboundBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        data: Array.from({ length: 15 }, (_, index) =>
          index % 2 === 0
            ? { b64_json: Buffer.from(JPEG_BYTES).toString('base64') }
            : { url: `https://cdn.example.com/out-${index}.jpg` },
        ),
      });
    });
    const materialize = vi.fn(
      async (job: string, index: number, base64: string, format: string, fileId: string) => {
        const bytes = Buffer.from(base64, 'base64');
        return {
          key: imageOutputKey(job, index, fileId, format as 'jpeg'),
          sizeBytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          etag: 'etag',
          contentType: `image/${format}`,
        };
      },
    );
    try {
      const worker = createImageWorker(
        journal,
        'b1',
        keys.privateKey,
        materialize,
        transport,
        async () => PNG_BYTES,
        undefined,
        mockDownload(JPEG_BYTES),
      );
      const cmd = routedCommand(route, {
        model: 'doubao-seedream-5.0-lite',
        operation: 'edit',
        prompt: '15 storyboard frames',
        n: 15,
        size: '2K',
        image: ref,
      });
      const outcome = await worker(cmd);
      expect(outcome.state).toBe('completed');
      if (outcome.state === 'completed') expect(outcome.outputs).toHaveLength(15);
      expect(outboundBodies[0]).toMatchObject({
        model: 'doubao-seedream-5.0-lite',
        size: '2K',
        watermark: false,
        sequential_image_generation: 'auto',
        sequential_image_generation_options: { max_images: 15 },
      });
      expect(String(outboundBodies[0]?.image)).toMatch(/^data:image\/png;base64,/);
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('runs vidu-images custom route submit and {task_id} query template substitution', async () => {
    const route = makeRoute(
      'vidu-images',
      'vidu',
      '/vidu/ent/v2/reference2image',
      {
        supportedOperations: ['generate'],
        requiresAsync: true,
        allowedSizes: ['1080p', '2K'],
        allowedAspectRatios: ['16:9'],
        maxReferenceImages: 7,
        allowGenerateReferences: true,
        async: { operations: ['generate'], maxQueries: 12, maxAgeSeconds: 600 },
      },
      { queryPathTemplate: '/vidu/ent/v2/tasks/{task_id}/creations' },
    );
    const seenUrls: string[] = [];
    const seenBodies: Record<string, unknown>[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      seenUrls.push(String(url));
      if (init?.method === 'POST') {
        seenBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ task_id: 'vidu_task_99', state: 'created' });
      }
      return Response.json({
        state: 'success',
        creations: [{ url: 'https://cdn.example.com/vidu.png' }],
      });
    });
    const asyncDriver = defaultRouteAsyncTransport(
      route,
      transport,
      async () => PNG_BYTES,
      mockDownload(PNG_BYTES),
    );
    const proto = createRoutedImageProtocol(
      route,
      'generate',
      transport,
      async () => PNG_BYTES,
      asyncDriver,
    );
    const submitted = await proto.submitAsync(
      {
        model: 'image-vidu-q2-pro',
        prompt: 'cinematic landscape',
        async: true,
        size: '2K',
        aspect_ratio: '16:9',
        images: [assetRef('image/png')],
      },
      'sk-vidu',
    );
    expect(submitted).toMatchObject({ state: 'submitted', upstreamTaskId: 'vidu_task_99' });
    expect(seenUrls[0]).toBe('https://api.onelinkai.cloud/vidu/ent/v2/reference2image');
    expect(seenBodies[0]).toMatchObject({
      model: 'image-vidu-q2-pro',
      resolution: '2K',
      aspect_ratio: '16:9',
    });
    const queried = await proto.queryAsync(
      { model: 'image-vidu-q2-pro', prompt: 'cinematic landscape', async: true },
      'sk-vidu',
      'vidu_task_99',
      1,
    );
    expect(seenUrls[1]).toBe(
      'https://api.onelinkai.cloud/vidu/ent/v2/tasks/vidu_task_99/creations',
    );
    expect(queried.state).toBe('returned');
  });

  it('runs kling-images standard generations and omni-image raw base64 image_list while ignoring billing wrappers', async () => {
    const genRoute = makeRoute(
      'kling-images',
      'kling',
      '/kling/v1/images/generations',
      {
        supportedOperations: ['generate'],
        requiresAsync: true,
        allowedAspectRatios: ['16:9', '1:1'],
        maxN: 9,
        async: { operations: ['generate'], maxQueries: 12, maxAgeSeconds: 600 },
      },
      { queryPathTemplate: '/kling/v1/images/generations/{task_id}' },
    );
    const singleRefGenRoute = makeRoute(
      'kling-images',
      'kling',
      '/kling/v1/images/generations',
      {
        supportedOperations: ['generate'],
        requiresAsync: true,
        allowedAspectRatios: ['16:9', '1:1'],
        maxN: 4,
        maxReferenceImages: 1,
        allowGenerateReferences: true,
        async: { operations: ['generate'], maxQueries: 12, maxAgeSeconds: 600 },
      },
      {
        queryPathTemplate: '/kling/v1/images/generations/{task_id}',
        referenceFormat: 'image',
      },
    );
    const omniRoute = makeRoute(
      'kling-images',
      'kling',
      '/kling/v1/images/custom-multi-endpoint',
      {
        supportedOperations: ['generate', 'edit'],
        requiresAsync: true,
        allowedAspectRatios: ['16:9', 'auto'],
        maxN: 9,
        maxReferenceImages: 2,
        allowGenerateReferences: true,
        async: { operations: ['generate', 'edit'], maxQueries: 12, maxAgeSeconds: 600 },
      },
      {
        queryPathTemplate: '/kling/v1/images/custom-multi-endpoint/{task_id}',
        referenceFormat: 'image_list',
      },
    );
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        posts.push({
          url: String(url),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return Response.json({
          code: 0,
          data: { task_id: 'kling_omni_1', task_status: 'submitted' },
        });
      }
      return Response.json({
        code: 0,
        usage: { credits: 12, cost_usd: '0.05' },
        data: {
          task_id: 'kling_omni_1',
          task_status: 'succeed',
          task_result: { images: [{ index: 0, url: 'https://cdn.example.com/kling.png' }] },
        },
      });
    });
    const genDriver = defaultRouteAsyncTransport(
      genRoute,
      transport,
      undefined,
      mockDownload(PNG_BYTES),
    );
    const genProto = createRoutedImageProtocol(
      genRoute,
      'generate',
      transport,
      undefined,
      genDriver,
    );
    await genProto.submitAsync(
      { model: 'image-kling-v3', prompt: 'mountain', async: true, n: 4, aspect_ratio: '16:9' },
      'sk-kling',
    );
    expect(posts[0]).toEqual({
      url: 'https://api.onelinkai.cloud/kling/v1/images/generations',
      body: { model_name: 'image-kling-v3', prompt: 'mountain', n: 4, aspect_ratio: '16:9' },
    });

    const singleRefRead = vi.fn(async () => PNG_BYTES);
    const singleRefDriver = defaultRouteAsyncTransport(
      singleRefGenRoute,
      transport,
      singleRefRead,
      mockDownload(PNG_BYTES),
    )!;
    const singleRefSubmitted = await singleRefDriver.submit(
      {
        model: 'image-kling-v3',
        prompt: 'reference mountain',
        async: true,
        images: [assetRef('image/png')],
      },
      'sk-kling',
      new AbortController().signal,
    );
    expect(singleRefSubmitted.state).toBe('submitted');
    expect(posts[1]).toEqual({
      url: 'https://api.onelinkai.cloud/kling/v1/images/generations',
      body: {
        model_name: 'image-kling-v3',
        prompt: 'reference mountain',
        n: 1,
        image: Buffer.from(PNG_BYTES).toString('base64'),
      },
    });

    // Fail closed if > 1 reference image ever reaches single-`image` Kling transport
    singleRefRead.mockClear();
    const multiOnSingle = await singleRefDriver.submit(
      {
        model: 'image-kling-v3',
        prompt: 'should fail closed',
        async: true,
        images: [assetRef('image/png'), assetRef('image/png')],
      },
      'sk-kling',
      new AbortController().signal,
    );
    expect(multiOnSingle).toEqual({ state: 'rejected', code: 'IMAGE_INPUT_INVALID' });
    expect(singleRefRead).not.toHaveBeenCalled();
    expect(posts).toHaveLength(2);

    const omniDriver = defaultRouteAsyncTransport(
      omniRoute,
      transport,
      async () => PNG_BYTES,
      mockDownload(PNG_BYTES),
    );
    const omniProto = createRoutedImageProtocol(
      omniRoute,
      'edit',
      transport,
      async () => PNG_BYTES,
      omniDriver,
    );
    const editInput: ImageInput = {
      model: 'image-kling-v3-omni',
      operation: 'edit',
      prompt: 'make winter',
      async: true,
      aspect_ratio: '16:9',
      images: [assetRef('image/png'), assetRef('image/png')],
    };
    const submitted = await omniProto.submitAsync(editInput, 'sk-kling');
    expect(submitted.state).toBe('submitted');
    const imageList = posts[2]?.body.image_list as { image: string }[];
    expect(posts[2]?.url).toBe('https://api.onelinkai.cloud/kling/v1/images/custom-multi-endpoint');
    expect(imageList).toHaveLength(2);
    expect(imageList[0]?.image.startsWith('data:')).toBe(false);
    expect(imageList[0]?.image).toBe(Buffer.from(PNG_BYTES).toString('base64'));
    expect(imageList[1]?.image).toBe(Buffer.from(PNG_BYTES).toString('base64'));

    const queried = await omniProto.queryAsync(editInput, 'sk-kling', 'kling_omni_1', 1);
    expect(queried.state).toBe('returned');
  });

  it('fails closed on route AAD tampering and pre-journal COS If-Match failure with 0 upstream POSTs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-tamper-cos-'));
    const journal = new Journal(directory, randomUUID(), true);
    const transport = vi.fn<typeof fetch>();
    const omniRoute = makeRoute(
      'kling-images',
      'kling',
      '/kling/v1/images/omni-image',
      {
        supportedOperations: ['generate', 'edit'],
        requiresAsync: true,
        maxReferenceImages: 1,
        allowGenerateReferences: true,
        async: { operations: ['generate', 'edit'], maxQueries: 10, maxAgeSeconds: 300 },
      },
      {
        queryPathTemplate: '/kling/v1/images/omni-image/{task_id}',
        referenceFormat: 'image_list',
      },
    );
    try {
      const cosFailWorker = createImageWorker(
        journal,
        'b1',
        keys.privateKey,
        vi.fn(),
        transport,
        async () => {
          throw new Error('COS PreconditionFailed 412');
        },
        undefined,
        mockDownload(),
      );
      const validCmd = routedCommand(
        omniRoute,
        {
          model: 'image-kling-v3-omni',
          operation: 'edit',
          prompt: 'edit ref',
          async: true,
          image: assetRef('image/png'),
        },
        'kling-images',
      );
      await expect(cosFailWorker(validCmd)).rejects.toThrow('IMAGE_INPUT_UNAVAILABLE');
      expect(journal.image(validCmd.jobId)).toBeNull();
      expect(transport).not.toHaveBeenCalled();

      const okCosWorker = createImageWorker(
        journal,
        'b1',
        keys.privateKey,
        vi.fn(),
        transport,
        async () => PNG_BYTES,
        undefined,
        mockDownload(),
      );
      const tampered = structuredClone(validCmd);
      tampered.jobId = randomUUID();
      tampered.route = { ...omniRoute, submitPath: '/kling/v1/images/generations' };
      expect(await okCosWorker(tampered)).toEqual({
        state: 'rejected',
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
      });
      expect(transport).not.toHaveBeenCalled();

      const submitTransport = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ code: 0, data: { task_id: 'task_123', task_status: 'submitted' } }),
        );
      const asyncWorker = createImageWorker(
        journal,
        'b1',
        keys.privateKey,
        vi.fn(),
        submitTransport,
        async () => PNG_BYTES,
        undefined,
        mockDownload(),
      );
      expect(await asyncWorker(validCmd)).toEqual({
        state: 'submitted',
        upstreamTaskId: 'task_123',
        queryAttempt: 0,
      });
      expect(submitTransport).toHaveBeenCalledTimes(1);

      const queryBase = {
        version: 1 as const,
        type: 'image.query' as const,
        messageId: randomUUID(),
        commandId: validCmd.messageId,
        jobId: validCmd.jobId,
        ownerId: validCmd.ownerId,
        expiresAt: validCmd.expiresAt,
        queryDeadline: Date.now() + 60_000,
        profile: validCmd.profile,
        operation: 'edit' as const,
        route: omniRoute,
        input: validCmd.input,
        credential: validCmd.credential,
        upstreamTaskId: 'task_123',
        queryAttempt: 1,
      };
      const wrongRouteBinding = {
        ...queryBase,
        route: { ...omniRoute, queryPathTemplate: '/kling/v1/images/generations/{task_id}' },
      };
      const tamperedQuery: ImageQueryCommandV1 = {
        ...queryBase,
        queryCredential: sealImageKey(
          'secret-onelink-key',
          imageQueryCredentialBinding(wrongRouteBinding),
          'b1',
          keys.publicKey,
        ),
      };
      expect(await asyncWorker(tamperedQuery)).toEqual({
        state: 'failed',
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
        upstreamTaskId: 'task_123',
        queryAttempt: 1,
      });
      const routeConflictQuery: ImageQueryCommandV1 = {
        ...tamperedQuery,
        route: wrongRouteBinding.route,
      };
      await expect(asyncWorker(routeConflictQuery)).rejects.toThrow('IMAGE_COMMAND_CONFLICT');
      expect(submitTransport).toHaveBeenCalledTimes(1);
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });
});
