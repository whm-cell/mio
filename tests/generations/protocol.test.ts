import { spawnSync } from 'node:child_process';
import { createImageDecoder } from '../../src/generations/decode.ts';
import { registerVendorRoutingCases } from './protocol-fixture.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_DRIVERS,
  isValidImageAssetObjectKey,
  validateImageInputByRoute,
  validateImageRouteConfig,
  type ImageDriver,
  type ImageRouteConfig,
} from '../../src/generations/contracts.ts';
import {
  createRoutedImageProtocol,
  type ReadImage,
} from '../../src/integrations/onelink/router.ts';
import { createRoutedKlingImageProtocol } from '../../src/integrations/onelink/kling/index.ts';
import { createRoutedViduImageProtocol } from '../../src/integrations/onelink/vidu/index.ts';
import { validateModelRouteEntry } from '../../src/providers/onelink/router.ts';
import { findFixtureRoute } from '../providers/fixtures/onelink-routes-fixture.ts';

type ImageDownload = typeof withPublicHttps;

const input = { model: 'gpt-image-2', prompt: 'a blue square' };
const key = 'private-test-credential';

const GPT_ROUTE: ImageRouteConfig = {
  driver: 'openai-images',
  vendor: 'openai',
  submitPath: '/v1/images/generations',
  editPath: '/v1/images/edits',
  queryPathTemplate: null,
  requiresAsync: false,
  effectiveWatermark: null,
  paramSpec: {
    supportedOperations: ['generate', 'edit', 'outpaint'],
    requiresAsync: false,
    maxN: 10,
    allowExplicitN: true,
    allowedSizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
    allowCustomDimensions: true,
    maxReferenceImages: 16,
    allowGenerateReferences: false,
    allowMaskPng: true,
    allowOutpaintGeometry: true,
    allowedQualities: ['high', 'medium', 'low', 'auto'],
    allowedBackgrounds: ['transparent', 'opaque', 'auto'],
    allowedModerations: ['low', 'auto'],
    allowedOutputFormats: ['png', 'jpeg', 'webp'],
    allowOutputCompression: true,
    allowUserField: true,
    allowedAspectRatios: [],
    allowWatermarkOverride: false,
    async: { operations: ['generate'], maxQueries: 8, maxAgeSeconds: 600 },
  },
  requestDefaults: { responseFormat: 'b64_json' },
  outputSpec: { fixedOutputFormat: null },
};

const SEEDREAM_ROUTE: ImageRouteConfig = {
  driver: 'volcengine-ark-images',
  vendor: 'volcengine',
  submitPath: '/volc/api/v3/images/generations',
  editPath: null,
  queryPathTemplate: null,
  requiresAsync: false,
  effectiveWatermark: true,
  paramSpec: {
    supportedOperations: ['generate'],
    requiresAsync: false,
    maxN: 1,
    allowExplicitN: true,
    allowedSizes: ['1024x1024'],
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
  },
  requestDefaults: {
    watermark: true,
    sequentialImageGeneration: 'disabled',
    responseFormat: 'b64_json',
    stream: false,
    defaultSize: '1024x1024',
  },
  outputSpec: { fixedOutputFormat: 'jpeg' },
};

const VIDU_ROUTE: ImageRouteConfig = {
  driver: 'vidu-images',
  vendor: 'vidu',
  submitPath: '/vidu/ent/v2/reference2image',
  editPath: null,
  queryPathTemplate: '/vidu/ent/v2/tasks/{task_id}/creations',
  requiresAsync: true,
  effectiveWatermark: null,
  paramSpec: {
    supportedOperations: ['generate'],
    requiresAsync: true,
    maxN: 1,
    allowExplicitN: false,
    allowedSizes: ['1080p', '2K', '4K'],
    allowCustomDimensions: false,
    maxReferenceImages: 7,
    allowGenerateReferences: true,
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
    async: { operations: ['generate'], maxQueries: 16, maxAgeSeconds: 3600 },
  },
  requestDefaults: {},
  outputSpec: { fixedOutputFormat: null },
};

const KLING_MINIMAL_ROUTE: ImageRouteConfig = {
  driver: 'kling-images',
  vendor: 'kling',
  submitPath: '/kling/v1/images/generations',
  editPath: null,
  queryPathTemplate: '/kling/v1/images/generations/{task_id}',
  requiresAsync: true,
  effectiveWatermark: null,
  paramSpec: {
    supportedOperations: ['generate'],
    requiresAsync: true,
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
    async: { operations: ['generate'], maxQueries: 16, maxAgeSeconds: 3600 },
  },
  requestDefaults: {},
  outputSpec: { fixedOutputFormat: null },
};

function testVidu(transport: typeof fetch, read: ReadImage, customDownload?: ImageDownload) {
  return createRoutedViduImageProtocol(
    VIDU_ROUTE,
    transport,
    read,
    customDownload ??
      (async (url, signal, consume) =>
        consume(await transport(url, { method: 'GET', redirect: 'error', signal }))),
  );
}

function testKling(transport: typeof fetch) {
  return createRoutedKlingImageProtocol(
    KLING_MINIMAL_ROUTE,
    transport,
    undefined,
    async (url, signal, consume) =>
      consume(await transport(url, { method: 'GET', redirect: 'error', signal })),
  );
}

describe('Routed vendor image protocols', () => {
  it.each(['processing', 'failed', 'success'])(
    'rejects explicit invalid Vidu task identities before interpreting %s or downloading',
    async (state) => {
      const download = vi.fn();
      const imageDownload: ImageDownload = async () => {
        download();
        throw new Error('Unexpected image download');
      };
      for (const id of ['', null, 1, {}, 'other-task', 'bad task id']) {
        const transport = vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            id,
            state,
            creations: [{ id: 'creation-id', url: 'https://image01.vidu.zone/result.jpg' }],
          }),
        );
        const driver = createRoutedViduImageProtocol(
          VIDU_ROUTE,
          transport,
          undefined,
          imageDownload,
        );
        const protocol = createRoutedImageProtocol(
          VIDU_ROUTE,
          'generate',
          transport,
          undefined,
          driver,
        );
        expect(
          await protocol.queryAsync(
            { model: 'image-vidu-q2', prompt: 'identity', async: true },
            key,
            'original-task',
            1,
          ),
        ).toEqual({ state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' });
        expect(transport).toHaveBeenCalledOnce();
        expect(transport.mock.calls[0]![1]?.method).toBe('GET');
      }
      expect(download).not.toHaveBeenCalled();
    },
  );

  it.each(['processing', 'failed', 'succeed'])(
    'requires the Kling task identity before interpreting %s or downloading',
    async (taskStatus) => {
      const download = vi.fn();
      const imageDownload: ImageDownload = async () => {
        download();
        throw new Error('Unexpected image download');
      };
      for (const taskId of [undefined, '', null, 1, {}, 'other-task', 'bad task id']) {
        const transport = vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            code: 0,
            data: {
              task_id: taskId,
              task_status: taskStatus,
              task_result: { images: [{ url: 'https://cdn.kling.example/result.jpg' }] },
            },
          }),
        );
        const driver = createRoutedKlingImageProtocol(
          KLING_MINIMAL_ROUTE,
          transport,
          undefined,
          imageDownload,
        );
        const protocol = createRoutedImageProtocol(
          KLING_MINIMAL_ROUTE,
          'generate',
          transport,
          undefined,
          driver,
        );
        expect(
          await protocol.queryAsync(
            { model: 'image-kling-v3', prompt: 'identity', async: true },
            key,
            'original-task',
            1,
          ),
        ).toEqual({ state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' });
        expect(transport).toHaveBeenCalledOnce();
        expect(transport.mock.calls[0]![1]?.method).toBe('GET');
      }
      expect(download).not.toHaveBeenCalled();
    },
  );

  it('rejects excess Vidu creations before downloading and preserves all requested results and task identity', async () => {
    const route = {
      ...VIDU_ROUTE,
      paramSpec: { ...VIDU_ROUTE.paramSpec, maxN: 2, allowExplicitN: true },
    };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 'original-task',
        state: 'success',
        creations: [
          { url: 'https://image01.vidu.zone/first.jpg' },
          { url: 'https://image01.vidu.zone/second.jpg' },
        ],
      }),
    );
    const downloads: string[] = [];
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const download: ImageDownload = async (url, _signal, consume) => {
      downloads.push(String(url));
      return consume(new Response(bytes));
    };
    const driver = createRoutedViduImageProtocol(route, transport, undefined, download);
    const protocol = createRoutedImageProtocol(route, 'generate', transport, undefined, driver);
    const request = { model: 'image-vidu-q2', prompt: 'two images', async: true, n: 1 };
    expect(await protocol.queryAsync(request, key, 'original-task', 1)).toEqual({
      state: 'unknown',
      code: 'IMAGE_QUERY_UNKNOWN',
    });
    expect(downloads).toEqual([]);
    transport.mockResolvedValueOnce(
      Response.json({
        id: 'original-task',
        state: 'success',
        creations: [
          { url: 'https://image01.vidu.zone/first.jpg' },
          { url: 'https://image01.vidu.zone/second.jpg' },
        ],
      }),
    );
    expect(await protocol.queryAsync({ ...request, n: 2 }, key, 'original-task', 2)).toEqual({
      state: 'returned',
      upstreamTaskId: 'original-task',
      images: Array.from({ length: 2 }, () => ({
        base64: Buffer.from(bytes).toString('base64'),
        format: 'jpeg',
      })),
    });
    expect(downloads).toEqual([
      'https://image01.vidu.zone/first.jpg',
      'https://image01.vidu.zone/second.jpg',
    ]);
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual(
      Array(2).fill('https://api.onelinkai.cloud/vidu/ent/v2/tasks/original-task/creations'),
    );
  });

  it.each([
    [VIDU_ROUTE, 'image-vidu-q2'],
    [KLING_MINIMAL_ROUTE, 'image-kling-v3'],
  ] as const)('rejects unusable %s task templates before import or submission', (route, model) => {
    const transport = vi.fn<typeof fetch>();
    const queryPathTemplate = route.queryPathTemplate + '/{task_id}';
    const invalid = { ...route, queryPathTemplate };
    expect(validateImageRouteConfig(invalid)).toBe(false);
    expect(() =>
      validateModelRouteEntry({
        ...findFixtureRoute(model, 'image.generate'),
        queryPathTemplate,
      }),
    ).toThrow();
    expect(() => createRoutedImageProtocol(invalid, 'generate', transport)).toThrow(
      'IMAGE_PROTOCOL_UNSUPPORTED',
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('builds the documented Vidu async request and preserves downloaded output format', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const ref = {
      assetId: '00000000-0000-4000-8000-000000000001',
      key: 'mio/raw/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002',
      sizeBytes: bytes.length,
      etag: 'private-etag',
      contentType: 'image/jpeg' as const,
    };
    const transport = vi.fn<typeof fetch>();
    transport.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/reference2image'))
        return Response.json({ task_id: 'vidu-task-1', state: 'created' });
      if (String(url).endsWith('/creations'))
        return Response.json({
          id: 'vidu-task-1',
          state: 'success',
          creations: [{ id: 'creation-1', url: 'https://image01.vidu.zone/result.jpg' }],
        });
      expect(init?.method).toBe('GET');
      return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
    });
    const protocol = testVidu(transport, async () => bytes);
    const request = {
      model: 'image-vidu-q2',
      prompt: 'a blue square',
      async: true,
      size: '1080p',
      images: [ref],
    };
    await expect(protocol.submit(request, key, AbortSignal.timeout(1000))).resolves.toEqual({
      state: 'submitted',
      upstreamTaskId: 'vidu-task-1',
      observation: {
        statusCode: 200,
        requestIdPresent: false,
        responsePaths: ['task_id', 'state'],
        taskIdPresent: true,
        errorCategory: 'none',
      },
    });
    const returned = await protocol.query(
      request,
      key,
      'vidu-task-1',
      1,
      AbortSignal.timeout(1000),
    );
    expect(returned).toEqual({
      state: 'returned',
      upstreamTaskId: 'vidu-task-1',
      images: [{ base64: Buffer.from(bytes).toString('base64'), format: 'jpeg' }],
    });
    const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      model: 'image-vidu-q2',
      prompt: 'a blue square',
      resolution: '1080p',
      images: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`,
    });
    expect(JSON.stringify(body)).not.toContain(ref.key);
    expect(JSON.stringify(body)).not.toContain(ref.etag);
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it('accepts newly discovered HTTPS result domains and rejects unsafe URL syntax', async () => {
    const host = 'new-provider.example';
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const request = { model: 'image-vidu-q2', prompt: 'result host', async: true };
    for (const [url, allowed] of [
      [`https://${host}/image.jpg`, true],
      ['https://media.future-provider.example/image.jpg', true],
      [`https://sub.${host}/image.jpg`, true],
      [`https://user@${host}/image.jpg`, false],
      [`https://user:pass@${host}/image.jpg`, false],
      [`https://${host}:8443/image.jpg`, false],
      [`http://${host}/image.jpg`, false],
    ] as const) {
      const transport = vi.fn<typeof fetch>().mockImplementation(async (_target, options) => {
        if (transport.mock.calls.length === 1)
          return Response.json({ state: 'success', creations: [{ url }] });
        expect(options?.redirect).toBe('error');
        expect(options?.headers).toBeUndefined();
        return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
      });
      const result = await testVidu(transport, async () => bytes).query(
        request,
        key,
        'task-host',
        1,
        AbortSignal.timeout(2000),
      );
      expect(result.state).toBe(allowed ? 'returned' : 'unknown');
      expect(transport).toHaveBeenCalledTimes(allowed ? 2 : 1);
    }
  });

  it('identifies downloaded Vidu images by bytes when response headers or paths disagree', async () => {
    const cases = [
      {
        bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        type: 'image/jpeg',
        format: 'png',
      },
      { bytes: [0xff, 0xd8, 0xff, 0xd9], type: 'image/png', format: 'jpeg' },
      {
        bytes: [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')],
        type: 'text/plain',
        format: 'webp',
      },
      { bytes: [0x00, 0x01, 0x02], type: 'image/png', format: null },
    ] as const;
    for (const example of cases) {
      const transport = vi.fn<typeof fetch>().mockImplementation(async (url) =>
        String(url).endsWith('/creations')
          ? Response.json({
              state: 'success',
              creations: [{ url: 'https://example.com/result.jpg' }],
            })
          : new Response(Uint8Array.from(example.bytes), {
              headers: { 'content-type': example.type },
            }),
      );
      const result = await testVidu(transport, async () => new Uint8Array()).query(
        { model: 'image-vidu-q2', prompt: 'result format', async: true },
        key,
        'task-format',
        1,
        AbortSignal.timeout(1000),
      );
      if (example.format) {
        expect(result).toMatchObject({ state: 'returned', images: [{ format: example.format }] });
      } else {
        expect(result).toEqual({ state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' });
      }
    }
  });

  it('does not reject a Vidu result because its declared or streamed size exceeds 64 MiB', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const largeChunk = new Uint8Array(1024 * 1024);
    largeChunk.set(bytes);
    const transport = vi.fn<typeof fetch>();
    let large = false;
    transport.mockImplementation(async (url) => {
      if (String(url).endsWith('/creations'))
        return Response.json({
          state: 'success',
          creations: [{ url: 'https://image01.vidu.zone/result.jpg' }],
        });
      if (!large)
        return new Response(bytes, {
          headers: { 'content-type': 'image/jpeg', 'content-length': String(65 * 1024 * 1024) },
        });
      let emitted = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (emitted++ < 65) controller.enqueue(largeChunk);
            else controller.close();
          },
        }),
        { headers: { 'content-type': 'image/jpeg' } },
      );
    });
    const protocol = createRoutedImageProtocol(
      VIDU_ROUTE,
      'generate',
      transport,
      undefined,
      testVidu(transport, async () => bytes),
    );
    const request = { model: 'image-vidu-q2', prompt: 'size', async: true };
    const first = await protocol.queryAsync(
      request,
      key,
      'task-size',
      1,
      AbortSignal.timeout(20_000),
    );
    expect(first).toMatchObject({ state: 'returned', images: [{ base64: '/9j/2Q==' }] });
    large = true;
    const streamed = await protocol.queryAsync(
      request,
      key,
      'task-size',
      2,
      AbortSignal.timeout(20_000),
    );
    expect(streamed.state).toBe('returned');
    if (streamed.state !== 'returned') throw new Error('expected returned');
    expect(streamed.images[0]?.base64.length).toBe(Math.ceil((65 * 1024 * 1024) / 3) * 4);
  }, 30000);

  it('uses strict base64 validation for both paths without a large synchronous result failing', async () => {
    let base64 = '';
    const synchronous = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ data: [{ b64_json: base64 }] }));
    const asynchronous = {
      submit: vi.fn(async () => ({ state: 'submitted' as const, upstreamTaskId: 'task-base64' })),
      query: vi.fn(async () => ({
        state: 'returned' as const,
        upstreamTaskId: 'task-base64',
        images: [{ base64 }],
      })),
    };
    const protocol = createRoutedImageProtocol(
      GPT_ROUTE,
      'generate',
      synchronous,
      undefined,
      asynchronous,
    );
    const request = { ...input, async: true };
    for (const value of ['AAAA', 'AA==', 'AAA=', 'AB==', 'ABC=']) {
      base64 = value;
      expect(await protocol.submit(input, key)).toEqual({
        state: 'returned',
        images: [{ base64 }],
      });
      expect(await protocol.queryAsync(request, key, 'task-base64', 1)).toEqual({
        state: 'returned',
        upstreamTaskId: 'task-base64',
        images: [{ base64 }],
      });
    }
    for (const value of ['', 'A', 'AAA', 'AA=A', 'A===', '====', 'AA==AAAA', 'AA-_', 'AAA\n']) {
      base64 = value;
      expect(await protocol.submit(input, key)).toEqual({ state: 'returned', images: [null] });
      expect(await protocol.queryAsync(request, key, 'task-base64', 1)).toEqual({
        state: 'unknown',
        code: 'IMAGE_QUERY_UNKNOWN',
      });
    }
    base64 = 'QUJD';
    expect(await protocol.submit(input, 'QUJD')).toEqual({ state: 'returned', images: [null] });
    base64 = 'A'.repeat(8 * 1024 * 1024);
    const large = await protocol.submit(input, key);
    expect(large.state).toBe('returned');
    if (large.state !== 'returned') throw new Error('expected returned');
    expect(large.images[0]?.base64.length).toBe(base64.length);
  }, 30000);

  it('sends an explicitly admitted Vidu model unchanged and never falls back to a synchronous endpoint', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ task_id: 'task-alt' }));
    const read = async () => new Uint8Array();
    const asyncTransport = testVidu(transport, read);
    const reqInput = { model: 'fixture-vidu-alt', prompt: 'model fixture', async: true };
    const protocol = createRoutedImageProtocol(
      VIDU_ROUTE,
      'generate',
      transport,
      read,
      asyncTransport,
    );
    await expect(protocol.submit(reqInput, key)).resolves.toEqual({
      state: 'rejected',
      code: 'IMAGE_INPUT_INVALID',
    });
    expect(transport).not.toHaveBeenCalled();
    await expect(protocol.submitAsync(reqInput, key)).resolves.toMatchObject({
      state: 'submitted',
      upstreamTaskId: 'task-alt',
    });
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'fixture-vidu-alt',
      prompt: 'model fixture',
    });
    expect(String(transport.mock.calls[0]?.[0])).toBe(
      'https://api.onelinkai.cloud/vidu/ent/v2/reference2image',
    );
  });

  it('records only bounded response classes when Vidu omits the documented task_id', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const ref = {
      assetId: '00000000-0000-4000-8000-000000000001',
      key: 'mio/raw/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002',
      sizeBytes: bytes.length,
      etag: 'private-etag',
      contentType: 'image/jpeg' as const,
    };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          state: 'created',
          provider_error: 'private-provider-detail',
          api_key: key,
        },
        { status: 202, headers: { 'x-request-id': 'private-request-id' } },
      ),
    );
    const protocol = testVidu(transport, async () => bytes);
    const result = await protocol.submit(
      { model: 'image-vidu-q2', prompt: 'a blue square', async: true, images: [ref] },
      key,
      AbortSignal.timeout(1000),
    );
    expect(result).toEqual({
      state: 'unknown',
      code: 'IMAGE_SUBMISSION_UNKNOWN',
      observation: {
        statusCode: 202,
        requestIdPresent: true,
        responsePaths: ['state', 'other'],
        taskIdPresent: false,
        errorCategory: 'missing_task_id',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-provider-detail');
    expect(JSON.stringify(result)).not.toContain('private-request-id');
    expect(JSON.stringify(result)).not.toContain('api_key');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('keeps Vidu error responses unknown without exposing body fields or retrying', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const ref = {
      assetId: '00000000-0000-4000-8000-000000000001',
      key: 'mio/raw/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002',
      sizeBytes: bytes.length,
      etag: 'private-etag',
      contentType: 'image/jpeg' as const,
    };
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { task_id: 'should-not-be-used', error: { detail: 'private-error' } },
          { status: 503, headers: { 'x-request-id': 'private-request-id' } },
        ),
      );
    const protocol = testVidu(transport, async () => bytes);
    const result = await protocol.submit(
      { model: 'image-vidu-q2', prompt: 'a blue square', async: true, images: [ref] },
      key,
      AbortSignal.timeout(1000),
    );
    expect(result).toEqual({
      state: 'unknown',
      code: 'IMAGE_SUBMISSION_UNKNOWN',
      observation: {
        statusCode: 503,
        requestIdPresent: true,
        responsePaths: ['task_id', 'error'],
        taskIdPresent: false,
        errorCategory: 'upstream',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-error');
    expect(JSON.stringify(result)).not.toContain('private-request-id');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects an invalid Vidu task_id without allowing a query or a second submit', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const ref = {
      assetId: '00000000-0000-4000-8000-000000000001',
      key: 'mio/raw/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002',
      sizeBytes: bytes.length,
      etag: 'private-etag',
      contentType: 'image/jpeg' as const,
    };
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ task_id: 'invalid task id' }));
    const protocol = testVidu(transport, async () => bytes);
    const result = await protocol.submit(
      { model: 'image-vidu-q2', prompt: 'a blue square', async: true, images: [ref] },
      key,
      AbortSignal.timeout(1000),
    );
    expect(result).toEqual({
      state: 'unknown',
      code: 'IMAGE_SUBMISSION_UNKNOWN',
      observation: {
        statusCode: 200,
        requestIdPresent: false,
        responsePaths: ['task_id'],
        taskIdPresent: false,
        errorCategory: 'invalid_task_id',
      },
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('retains status and request-id presence when the Vidu response stream fails', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const ref = {
      assetId: '00000000-0000-4000-8000-000000000001',
      key: 'mio/raw/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002',
      sizeBytes: bytes.length,
      etag: 'private-etag',
      contentType: 'image/jpeg' as const,
    };
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(key));
      },
    });
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(broken, { status: 200, headers: { 'x-request-id': 'private-request-id' } }),
      );
    const protocol = testVidu(transport, async () => bytes);
    await expect(
      protocol.submit(
        { model: 'image-vidu-q2', prompt: 'a blue square', async: true, images: [ref] },
        key,
        AbortSignal.timeout(1000),
      ),
    ).resolves.toEqual({
      state: 'unknown',
      code: 'IMAGE_SUBMISSION_UNKNOWN',
      observation: {
        statusCode: 200,
        requestIdPresent: true,
        responsePaths: [],
        taskIdPresent: false,
        errorCategory: 'malformed_response',
      },
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects non-HTTPS Vidu results without downloading them', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 'vidu-task-2',
        state: 'success',
        creations: [{ id: 'creation-2', url: 'http://new-provider.example/result.jpg' }],
      }),
    );
    const protocol = testVidu(transport, async () => new Uint8Array());
    await expect(
      protocol.query(
        { model: 'image-vidu-q2', prompt: 'x', async: true },
        key,
        'vidu-task-2',
        1,
        AbortSignal.timeout(1000),
      ),
    ).resolves.toEqual({ state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('cancels an unread result body on a non-success response', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        state: 'success',
        creations: [{ url: 'https://new-provider.example/result' }],
      }),
    );
    const protocol = testVidu(
      transport,
      async () => new Uint8Array(),
      async (_url, _signal, consume) =>
        consume(new Response(body, { status: 500, headers: { 'content-type': 'text/plain' } })),
    );
    await expect(
      protocol.query(
        { model: 'image-vidu-q2', prompt: 'x', async: true },
        key,
        'task-release',
        1,
        AbortSignal.timeout(1000),
      ),
    ).resolves.toEqual({ state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('dispatches only explicit implemented routes and operations', () => {
    expect(() =>
      createRoutedImageProtocol(
        { ...GPT_ROUTE, driver: 'guess-from-model' as ImageDriver },
        'generate',
      ),
    ).toThrow('IMAGE_PROTOCOL_UNSUPPORTED');
    expect(() => createRoutedImageProtocol(GPT_ROUTE, 'edit')).not.toThrow();
    expect(() => createRoutedImageProtocol(GPT_ROUTE, 'outpaint')).not.toThrow();
  });

  it('posts GPT edit as multipart without leaking COS identity fields', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }] }));
    const bytes = Uint8Array.from(Buffer.from('89504e470d0a1a0a', 'hex'));
    const image = {
      assetId: '00000000-0000-4000-8000-000000000001',
      key: 'mio/raw/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002',
      sizeBytes: bytes.length,
      etag: 'etag-image',
      contentType: 'image/png' as const,
    };
    const mask = {
      assetId: '00000000-0000-4000-8000-000000000003',
      key: 'mio/raw/00000000-0000-4000-8000-000000000003/00000000-0000-4000-8000-000000000004',
      sizeBytes: bytes.length,
      etag: 'etag-mask',
      contentType: 'image/png' as const,
    };
    const read = vi.fn(async () => bytes);
    const result = await createRoutedImageProtocol(GPT_ROUTE, 'edit', transport, read).submit(
      { ...input, operation: 'edit', image, mask, n: 1, quality: 'high' },
      key,
    );
    expect(result).toEqual({ state: 'returned', images: [{ base64: 'YWJj' }] });
    expect(read).toHaveBeenCalledTimes(2);
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.onelinkai.cloud/v1/images/edits');
    expect(options?.headers).toEqual({ Authorization: `Bearer ${key}` });
    const form = await new Response(options?.body).formData();
    expect(form.get('model')).toBe(input.model);
    expect(form.get('prompt')).toBe(input.prompt);
    expect(form.get('response_format')).toBe('b64_json');
    expect(form.get('quality')).toBe('high');
    expect(form.get('image')).toBeInstanceOf(File);
    expect(form.get('mask')).toBeInstanceOf(File);
    expect(JSON.stringify(options?.body)).not.toContain(image.key);
    expect(JSON.stringify(options?.body)).not.toContain(image.etag);
  });

  it('posts ordered GPT reference arrays and explicit outpaint geometry in one multipart request', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }] }));
    const bytes = Uint8Array.from(Buffer.from('89504e470d0a1a0a', 'hex'));
    const image = (assetId: string, rawId: string) => ({
      assetId,
      key: `mio/raw/${assetId}/${rawId}`,
      sizeBytes: bytes.length,
      etag: `etag-${assetId.slice(-1)}`,
      contentType: 'image/png' as const,
    });
    const first = image(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    );
    const second = image(
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    );
    const read = vi.fn(async () => bytes);
    const result = await createRoutedImageProtocol(GPT_ROUTE, 'outpaint', transport, read).submit(
      {
        ...input,
        operation: 'outpaint',
        images: [first, second],
        geometry: { left: 16, top: 0, right: 32, bottom: 0 },
      },
      key,
    );
    expect(result).toEqual({ state: 'returned', images: [{ base64: 'YWJj' }] });
    expect(read).toHaveBeenCalledTimes(2);
    const [, options] = transport.mock.calls[0]!;
    const form = await new Response(options?.body).formData();
    const files = form.getAll('image');
    expect(files).toHaveLength(2);
    expect(files.map((value) => (value as File).name)).toEqual(['image.png', 'image.png']);
    expect(form.get('geometry')).toBe(JSON.stringify({ left: 16, top: 0, right: 32, bottom: 0 }));
    expect(JSON.stringify(options?.body)).not.toContain(first.key);
    expect(JSON.stringify(options?.body)).not.toContain(first.etag);
  });

  it('uses one fixed POST, preserves optional defaults, and strips unrelated response fields', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: [{ b64_json: 'YWJj', revised_prompt: key }], secret: key }),
      );
    const options = {
      n: 1,
      background: 'opaque',
      moderation: 'low',
      quality: 'high',
      size: '1024x1024',
      aspect_ratio: '16:9',
      output_format: 'jpeg',
      output_compression: 0,
      user: 'fixture-user',
    } as const;
    const protocol = createRoutedImageProtocol(
      {
        ...GPT_ROUTE,
        paramSpec: { ...GPT_ROUTE.paramSpec, allowedAspectRatios: ['16:9'] },
        requestDefaults: {},
      },
      'generate',
      transport,
    );
    expect(
      await protocol.submit({ ...input, ...options, operation: 'generate', async: false }, key),
    ).toEqual({ state: 'returned', images: [{ base64: 'YWJj' }] });
    await expect(protocol.submit({ ...input, aspect_ratio: '9:16' }, key)).resolves.toEqual({
      state: 'rejected',
      code: 'IMAGE_INPUT_INVALID',
    });
    expect(transport).toHaveBeenCalledOnce();
    const [url, request] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.onelinkai.cloud/v1/images/generations');
    expect(request?.redirect).toBe('error');
    expect(JSON.parse(request?.body as string)).toEqual({ ...input, ...options });
    expect(request?.headers).toEqual({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    });
  });

  it('uses the explicit Volcengine route for one watermarked JPEG and retains only safe usage', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          data: [{ b64_json: 'YWJj' }],
          usage: {
            generated_images: 1,
            input_tokens: 99,
            output_tokens: 120,
            total_tokens: 150,
            secret: key,
          },
        },
        { headers: { 'x-request-id': 'req-123' } },
      ),
    );
    const request = {
      model: 'doubao-seedream-4.0',
      prompt: 'a blue square',
      n: 1,
      size: '1024x1024',
    };
    expect(
      await createRoutedImageProtocol(SEEDREAM_ROUTE, 'generate', transport).submit(request, key),
    ).toEqual({
      state: 'returned',
      images: [{ base64: 'YWJj' }],
      observation: {
        requestId: 'req-123',
        generatedImages: 1,
        outputTokens: 120,
        totalTokens: 150,
      },
    });
    expect(transport).toHaveBeenCalledOnce();
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.onelinkai.cloud/volc/api/v3/images/generations');
    expect(options?.redirect).toBe('error');
    expect(JSON.parse(options?.body as string)).toEqual({
      model: request.model,
      prompt: request.prompt,
      size: '1024x1024',
      response_format: 'b64_json',
      sequential_image_generation: 'disabled',
      stream: false,
      watermark: true,
    });
  });

  it('uses only the GPT usage fields documented for openai-images', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ b64_json: 'YWJj' }],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, generated_images: 1 },
      }),
    );
    expect(
      await createRoutedImageProtocol(GPT_ROUTE, 'generate', transport).submit(input, key),
    ).toEqual({
      state: 'returned',
      images: [{ base64: 'YWJj' }],
      observation: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects unsupported Volcengine parameters and invalid routes without outbound requests', async () => {
    const transport = vi.fn<typeof fetch>();
    const protocol = createRoutedImageProtocol(SEEDREAM_ROUTE, 'generate', transport);
    for (const extra of [
      { n: 2 },
      { size: '2048x2048' },
      { output_format: 'png' },
      { quality: 'low' },
      { background: 'transparent' },
      { moderation: 'auto' },
      { user: 'caller' },
    ])
      expect(await protocol.submit({ ...input, ...extra } as typeof input, key)).toEqual({
        state: 'rejected',
        code: 'IMAGE_INPUT_INVALID',
      });
    expect(() =>
      createRoutedImageProtocol(
        { ...SEEDREAM_ROUTE, driver: 'seedream-unknown' as ImageDriver },
        'generate',
        transport,
      ),
    ).toThrow('IMAGE_PROTOCOL_UNSUPPORTED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('ignores malformed or credential-echo observations without discarding valid output', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          data: [{ b64_json: 'YWJj' }],
          usage: { generated_images: -1, output_tokens: '12', total_tokens: 1e100 },
        },
        { headers: { 'x-request-id': key } },
      ),
    );
    expect(
      await createRoutedImageProtocol(SEEDREAM_ROUTE, 'generate', transport).submit(input, key),
    ).toEqual({
      state: 'returned',
      images: [{ base64: 'YWJj' }],
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('retains a safe request ID if the response stream fails after headers without replay', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(key));
      },
    });
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(broken, { headers: { 'x-request-id': 'req-stream-1' } }));
    expect(
      await createRoutedImageProtocol(SEEDREAM_ROUTE, 'generate', transport).submit(input, key),
    ).toEqual({
      state: 'unknown',
      code: 'IMAGE_SUBMISSION_UNKNOWN',
      observation: { requestId: 'req-stream-1' },
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects invalid or untrusted request fields before any supplier call', async () => {
    const transport = vi.fn<typeof fetch>();
    const protocol = createRoutedImageProtocol(GPT_ROUTE, 'generate', transport);
    for (const extra of [
      { n: 11 },
      { n: 1.5 },
      { size: '4000x2160' },
      { output_format: 'jpeg', background: 'transparent' },
      { owner: 'other' },
      { output_compression: 50 },
    ]) {
      expect(await protocol.submit({ ...input, ...extra } as typeof input, key)).toEqual({
        state: 'rejected',
        code: 'IMAGE_INPUT_INVALID',
      });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps connection loss unknown without retry or raw error disclosure', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error(key));
    expect(
      await createRoutedImageProtocol(GPT_ROUTE, 'generate', transport).submit(input, key),
    ).toEqual({ state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    [{ data: [{ url: 'https://untrusted.example/result' }] }, [null]],
    [{ data: [{ b64_json: 'bad!' }] }, [null]],
    [{ data: [] }, []],
  ])(
    'preserves known missing outputs without resubmitting or fetching URLs',
    async (payload, images) => {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
      expect(
        await createRoutedImageProtocol(GPT_ROUTE, 'generate', transport).submit(input, key),
      ).toEqual({ state: 'returned', images });
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it('keeps an over-count response unknown without resubmission', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }, { b64_json: 'YWJj' }] }));
    expect(
      await createRoutedImageProtocol(GPT_ROUTE, 'generate', transport).submit(input, key),
    ).toEqual({ state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('uses only an injected async transport and preserves the upstream task identity', async () => {
    const transport = vi.fn<typeof fetch>();
    const attempts: number[] = [];
    const asyncTransport = {
      submit: vi.fn(async () => ({ state: 'submitted' as const, upstreamTaskId: 'task-1' })),
      query: vi.fn(async (_input, _key, taskId: string, attempt: number) => {
        attempts.push(attempt);
        return attempt === 1
          ? { state: 'processing' as const, upstreamTaskId: taskId }
          : { state: 'returned' as const, upstreamTaskId: taskId, images: [{ base64: 'YWJj' }] };
      }),
    };
    const protocol = createRoutedImageProtocol(
      GPT_ROUTE,
      'generate',
      transport,
      undefined,
      asyncTransport,
    );
    const request = { ...input, async: true };
    await expect(protocol.submitAsync(request, key)).resolves.toEqual({
      state: 'submitted',
      upstreamTaskId: 'task-1',
    });
    await expect(protocol.queryAsync(request, key, 'task-1', 1)).resolves.toEqual({
      state: 'processing',
      upstreamTaskId: 'task-1',
    });
    await expect(protocol.queryAsync(request, key, 'task-1', 2)).resolves.toEqual({
      state: 'returned',
      upstreamTaskId: 'task-1',
      images: [{ base64: 'YWJj' }],
    });
    expect(asyncTransport.submit).toHaveBeenCalledOnce();
    expect(asyncTransport.query).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([1, 2]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects malformed async task identities without allowing a second submit', async () => {
    const asyncTransport = {
      submit: vi.fn(async () => ({ state: 'submitted' as const, upstreamTaskId: 'bad task' })),
      query: vi.fn(),
    };
    const protocol = createRoutedImageProtocol(
      GPT_ROUTE,
      'generate',
      vi.fn(),
      undefined,
      asyncTransport,
    );
    await expect(protocol.submitAsync({ ...input, async: true }, key)).resolves.toEqual({
      state: 'unknown',
      code: 'IMAGE_SUBMISSION_UNKNOWN',
    });
    expect(asyncTransport.submit).toHaveBeenCalledOnce();
    expect(asyncTransport.query).not.toHaveBeenCalled();
  });

  it('does not turn a provider content-length header into an image storage policy', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: 'YWJj' }] }), {
        headers: { 'content-length': String(65 * 1024 * 1024) },
      }),
    );
    expect(
      await createRoutedImageProtocol(GPT_ROUTE, 'generate', transport).submit(input, key),
    ).toEqual({ state: 'returned', images: [{ base64: 'YWJj' }] });
  });

  it.each([
    [401, 'IMAGE_AUTH'],
    [429, 'IMAGE_LIMITED'],
    [400, 'IMAGE_REJECTED'],
    [500, 'IMAGE_SUBMISSION_UNKNOWN'],
  ])('classifies HTTP %i without disclosing response body', async (status, code) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(key, { status: Number(status) }));
    const result = await createRoutedImageProtocol(GPT_ROUTE, 'generate', transport).submit(
      input,
      key,
    );
    expect('code' in result && result.code).toBe(code);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('validates all four vendor drivers and fails closed on sync submit for async-only routes', async () => {
    expect(IMAGE_DRIVERS).toEqual([
      'openai-images',
      'volcengine-ark-images',
      'vidu-images',
      'kling-images',
    ]);
    for (const route of [GPT_ROUTE, SEEDREAM_ROUTE, VIDU_ROUTE, KLING_MINIMAL_ROUTE]) {
      expect(validateImageRouteConfig(route)).toBe(true);
    }
    expect(
      validateImageInputByRoute(input, { ...GPT_ROUTE, driver: 'unknown' as ImageDriver }),
    ).toBe(false);
    const transport = vi.fn<typeof fetch>();
    await expect(
      createRoutedImageProtocol(VIDU_ROUTE, 'generate', transport).submit(
        { model: 'image-vidu-q2', prompt: 'async only', async: true },
        key,
      ),
    ).resolves.toEqual({ state: 'rejected', code: 'IMAGE_INPUT_INVALID' });
    await expect(
      createRoutedImageProtocol(KLING_MINIMAL_ROUTE, 'generate', transport).submit(
        { model: 'image-kling-v3', prompt: 'async only', async: true },
        key,
      ),
    ).resolves.toEqual({ state: 'rejected', code: 'IMAGE_INPUT_INVALID' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('validates minimal Kling async generate inputs by route and rejects unsupported parameters', () => {
    const validBase = { model: 'image-kling-v3', prompt: 'a blue square', async: true as const };
    expect(validateImageInputByRoute(validBase, KLING_MINIMAL_ROUTE)).toBe(true);
    expect(validateImageInputByRoute({ ...validBase, n: 1 }, KLING_MINIMAL_ROUTE)).toBe(true);
    expect(
      validateImageInputByRoute(
        { ...validBase, operation: 'generate' as const },
        KLING_MINIMAL_ROUTE,
      ),
    ).toBe(true);
    const ref = {
      assetId: '00000000-0000-4000-8000-000000000001',
      key: 'mio/raw/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002',
      sizeBytes: 4,
      etag: 'etag',
      contentType: 'image/png' as const,
    };
    const noSizeRoute: ImageRouteConfig = {
      ...KLING_MINIMAL_ROUTE,
      paramSpec: { ...KLING_MINIMAL_ROUTE.paramSpec, allowedSizes: ['custom-only'] },
    };
    for (const invalid of [
      { model: 'image-kling-v3', prompt: 'sync' },
      { ...validBase, async: false },
      { ...validBase, n: 2 },
      { ...validBase, size: '1080p' },
      { ...validBase, size: '1024x1024' },
      { ...validBase, quality: 'low' as const },
      { ...validBase, output_format: 'png' as const },
      { ...validBase, operation: 'edit' as const, image: ref },
      {
        ...validBase,
        operation: 'outpaint' as const,
        image: ref,
        geometry: { left: 16, top: 0, right: 0, bottom: 0 },
      },
      { ...validBase, images: [ref] },
      { ...validBase, image: ref },
      { ...validBase, mask: ref },
      { ...validBase, geometry: { left: 16, top: 0, right: 0, bottom: 0 } },
    ]) {
      expect(validateImageInputByRoute(invalid, noSizeRoute)).toBe(false);
    }
  });

  it('submits and queries documented Kling async image tasks with magic-byte format detection', async () => {
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const webpBytes = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]);
    let queryStatus = 'submitted';
    let formatStage: 'png' | 'jpeg' | 'webp' | null = null;
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url) === 'https://api.onelinkai.cloud/kling/v1/images/generations') {
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toEqual({
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          model_name: 'image-kling-v3',
          prompt: 'a blue square',
          n: 1,
        });
        return Response.json(
          { code: 0, message: 'SUCCEED', request_id: 'private-req', data: { task_id: 'kling-1' } },
          { headers: { 'x-request-id': 'private-header-req' } },
        );
      }
      if (String(url) === 'https://api.onelinkai.cloud/kling/v1/images/generations/kling-1') {
        expect(init?.method).toBe('GET');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toEqual({ Authorization: `Bearer ${key}` });
        if (!formatStage) {
          return Response.json({
            code: 0,
            data: { task_id: 'kling-1', task_status: queryStatus },
          });
        }
        return Response.json({
          code: 0,
          data: {
            task_id: 'kling-1',
            task_status: queryStatus,
            final_unit_deduction: '1',
            task_result: {
              images: [{ index: 0, url: `https://cdn.kling.example/${formatStage}.bin` }],
            },
          },
        });
      }
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toBeUndefined();
      const body =
        formatStage === 'png' ? pngBytes : formatStage === 'jpeg' ? jpegBytes : webpBytes;
      return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
    });
    const protocol = testKling(transport);
    const request = { model: 'image-kling-v3', prompt: 'a blue square', async: true as const };
    const submitted = await protocol.submit(request, key, AbortSignal.timeout(1000));
    expect(submitted).toEqual({
      state: 'submitted',
      upstreamTaskId: 'kling-1',
      observation: {
        statusCode: 200,
        requestIdPresent: true,
        responsePaths: ['code', 'other', 'data'],
        taskIdPresent: true,
        errorCategory: 'none',
      },
    });
    expect(JSON.stringify(submitted)).not.toContain('private-req');
    expect(JSON.stringify(submitted)).not.toContain('private-header-req');
    for (const inFlight of [
      'not_start',
      'queued',
      'queueing',
      'in_progress',
      'SUBMITTED',
      'processing',
      'NOT_START',
      'IN_PROGRESS',
    ]) {
      queryStatus = inFlight;
      await expect(
        protocol.query(request, key, 'kling-1', 1, AbortSignal.timeout(1000)),
      ).resolves.toEqual({ state: 'processing', upstreamTaskId: 'kling-1' });
    }
    for (const statusValue of ['succeed', 'success', 'SUCCEED', 'SUCCESS'] as const) {
      queryStatus = statusValue;
      for (const [nextStage, bytes] of [
        ['png', pngBytes],
        ['jpeg', jpegBytes],
        ['webp', webpBytes],
      ] as const) {
        formatStage = nextStage;
        const result = await protocol.query(request, key, 'kling-1', 3, AbortSignal.timeout(1000));
        expect(result).toEqual({
          state: 'returned',
          upstreamTaskId: 'kling-1',
          images: [{ base64: Buffer.from(bytes).toString('base64'), format: nextStage }],
        });
        expect(JSON.stringify(result)).not.toContain('final_unit_deduction');
      }
    }
  });

  it('classifies Kling submit and query errors safely without leaking supplier envelopes or retrying', async () => {
    const request = { model: 'image-kling-v3', prompt: 'a blue square', async: true as const };
    for (const [status, expectedState, expectedCode, expectedCategory] of [
      [401, 'rejected', 'IMAGE_AUTH', 'auth'],
      [429, 'rejected', 'IMAGE_LIMITED', 'rate_limit'],
      [400, 'rejected', 'IMAGE_REJECTED', 'rejected'],
      [500, 'unknown', 'IMAGE_SUBMISSION_UNKNOWN', 'upstream'],
    ] as const) {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { code: 999, message: `secret-${key}`, data: { task_id: 'unused' } },
            { status, headers: { 'x-request-id': 'private-req' } },
          ),
        );
      const outcome = await testKling(transport).submit(request, key, AbortSignal.timeout(1000));
      expect(outcome).toEqual({
        state: expectedState,
        code: expectedCode,
        observation: {
          statusCode: status,
          requestIdPresent: true,
          responsePaths: ['code', 'other', 'data'],
          taskIdPresent: false,
          errorCategory: expectedCategory,
        },
      });
      expect(JSON.stringify(outcome)).not.toContain(key);
      expect(JSON.stringify(outcome)).not.toContain('private-req');
      expect(transport).toHaveBeenCalledOnce();
    }

    for (const [payload, expectedCategory, paths] of [
      [
        { code: 1201, message: key, data: { task_id: 'unused' } },
        'upstream',
        ['code', 'other', 'data'],
      ],
      [{ code: 0, data: {} }, 'missing_task_id', ['code', 'data']],
      [{ code: 0, data: { task_id: 'bad task id' } }, 'invalid_task_id', ['code', 'data']],
    ] as const) {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
      const outcome = await testKling(transport).submit(request, key, AbortSignal.timeout(1000));
      expect(outcome).toEqual({
        state: 'unknown',
        code: 'IMAGE_SUBMISSION_UNKNOWN',
        observation: {
          statusCode: 200,
          requestIdPresent: false,
          responsePaths: [...paths],
          taskIdPresent: false,
          errorCategory: expectedCategory,
        },
      });
      expect(JSON.stringify(outcome)).not.toContain(key);
      expect(transport).toHaveBeenCalledOnce();
    }

    for (const [responseFactory, expected] of [
      [
        () => Response.json({ code: 0, data: { task_id: 'kling-1', task_status: 'failed' } }),
        { state: 'failed', code: 'IMAGE_QUERY_FAILED' },
      ],
      [
        () => Response.json({ code: 0, data: { task_id: 'kling-1', task_status: 'failure' } }),
        { state: 'failed', code: 'IMAGE_QUERY_FAILED' },
      ],
      [
        () => Response.json({ code: 0, data: { task_id: 'kling-1', task_status: 'FAILURE' } }),
        { state: 'failed', code: 'IMAGE_QUERY_FAILED' },
      ],
      [() => new Response(key, { status: 401 }), { state: 'failed', code: 'IMAGE_QUERY_FAILED' }],
      [() => new Response(key, { status: 404 }), { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' }],
      [() => new Response(key, { status: 502 }), { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' }],
      [
        () => Response.json({ code: 1002, data: { task_id: 'kling-1', task_status: 'succeed' } }),
        { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' },
      ],
      [
        () =>
          Response.json({ code: 0, data: { task_id: 'other-task', task_status: 'processing' } }),
        { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' },
      ],
      [
        () =>
          Response.json({
            code: 0,
            data: {
              task_id: 'kling-1',
              task_status: 'succeed',
              task_result: {
                images: [
                  { url: 'https://cdn.kling.example/1.png' },
                  { url: 'https://cdn.kling.example/2.png' },
                ],
              },
            },
          }),
        { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' },
      ],
      [
        () =>
          Response.json({
            code: 0,
            data: {
              task_id: 'kling-1',
              task_status: 'succeeded',
              task_result: { images: [{ url: 'https://cdn.kling.example/1.png' }] },
            },
          }),
        { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' },
      ],
      [
        () =>
          Response.json({
            code: 0,
            data: {
              task_id: 'kling-1',
              task_status: 'UNKNOWN',
              task_result: { images: [{ url: 'https://cdn.kling.example/1.png' }] },
            },
          }),
        { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' },
      ],
      [
        () =>
          Response.json({
            code: 0,
            data: {
              task_id: 'kling-1',
              task_status: 'Submitted',
              task_result: { images: [{ url: 'https://cdn.kling.example/1.png' }] },
            },
          }),
        { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' },
      ],
      [
        () =>
          Response.json({
            code: 0,
            data: {
              task_id: 'kling-1',
              task_status: 'succeed',
              task_result: { images: [{ url: 'http://cdn.kling.example/insecure.png' }] },
            },
          }),
        { state: 'unknown', code: 'IMAGE_QUERY_UNKNOWN' },
      ],
    ] as const) {
      const transport = vi.fn<typeof fetch>().mockImplementation(async () => responseFactory());
      const outcome = await testKling(transport).query(
        request,
        key,
        'kling-1',
        1,
        AbortSignal.timeout(1000),
      );
      expect(outcome).toEqual(expected);
      expect(transport).toHaveBeenCalledOnce();
    }
  });
});

import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from 'node:zlib';
import { Agent, MockAgent, Response as UndiciResponse } from 'undici';
import { withPublicHttps } from '../../src/integrations/onelink/public-https.ts';

type Dependencies = NonNullable<Parameters<typeof withPublicHttps>[3]>;

function downloadFixture(addresses: { address: string; family: number }[], all = true) {
  const connected: string[] = [];
  const resolveAll: NonNullable<Dependencies['resolveAll']> = vi.fn((_host, done) =>
    done(null, addresses),
  );
  const agent = new Agent();
  let lookup: LookupFunction;
  const createAgent: NonNullable<Dependencies['createAgent']> = vi.fn((value) => {
    lookup = value;
    return agent;
  });
  const fetch: NonNullable<Dependencies['fetch']> = vi.fn(async (input, options) => {
    const host = new URL(String(input)).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) connected.push(host);
    else
      await new Promise<void>((resolve, reject) => {
        lookup(host, { all }, (error, value) => {
          if (error) return reject(error);
          connected.push(...(Array.isArray(value) ? value.map((item) => item.address) : [value]));
          resolve();
        });
      });
    expect(options?.method).toBe('GET');
    expect(options?.redirect).toBe('error');
    expect(options?.headers).toBeUndefined();
    return new UndiciResponse('image');
  }) as NonNullable<Dependencies['fetch']>;
  return { resolveAll, createAgent, fetch, agent, connected };
}

async function downloadBytes(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}
const downloadText = async (response: Response) => (await downloadBytes(response)).toString();

it('accepts arbitrary public hosts and binds the connection lookup to public addresses only', async () => {
  const f = downloadFixture([
    { address: '10.0.0.7', family: 4 },
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '::ffff:127.0.0.1', family: 6 },
  ]);
  const close = vi.spyOn(f.agent, 'close');
  expect(
    await withPublicHttps(
      new URL('https://new-cdn.example/image'),
      AbortSignal.timeout(2000),
      downloadText,
      f,
    ),
  ).toBe('image');
  expect(f.resolveAll).toHaveBeenCalledOnce();
  expect(f.connected).toEqual(['8.8.8.8', '2606:4700:4700::1111']);
  expect(new URL(String(vi.mocked(f.fetch).mock.calls[0]![0])).hostname).toBe('new-cdn.example');
  expect(close).toHaveBeenCalled();
  expect(f.agent.closed).toBe(true);
});

it.each([
  '127.0.0.1',
  '10.0.0.1',
  '100.64.0.1',
  '169.254.169.254',
  '192.0.2.1',
  '::1',
  '::2',
  'fc00::1',
  'fe80::1',
  '2001:db8::1',
  '::ffff:127.0.0.1',
  '64:ff9b::a00:1',
])('rejects a non-public literal %s before creating a dispatcher', async (address) => {
  const f = downloadFixture([]);
  const host = isIP(address) === 6 ? `[${address}]` : address;
  await expect(
    withPublicHttps(new URL(`https://${host}/`), AbortSignal.timeout(1000), downloadText, f),
  ).rejects.toThrow();
  expect(f.createAgent).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
  await f.agent.close();
});

it('blocks a private DNS answer in a real undici Agent lookup before a connection', async () => {
  const resolveAll = vi.fn<NonNullable<Dependencies['resolveAll']>>((_host, done) =>
    done(null, [{ address: '127.0.0.1', family: 4 }]),
  );
  await expect(
    withPublicHttps(new URL('https://rebind.example/'), AbortSignal.timeout(2000), downloadText, {
      resolveAll,
    }),
  ).rejects.toMatchObject({ cause: { code: 'ENOTFOUND' } });
  expect(resolveAll).toHaveBeenCalledOnce();
});

it('uses the vetted lookup result instead of resolving a rebinding hostname twice', async () => {
  const f = downloadFixture([], false);
  const resolveAll: NonNullable<Dependencies['resolveAll']> = vi
    .fn()
    .mockImplementationOnce((_host, done) => done(null, [{ address: '8.8.8.8', family: 4 }]))
    .mockImplementationOnce((_host, done) => done(null, [{ address: '127.0.0.1', family: 4 }]));
  expect(
    await withPublicHttps(
      new URL('https://rebinding.example/'),
      AbortSignal.timeout(1000),
      downloadText,
      {
        ...f,
        resolveAll,
      },
    ),
  ).toBe('image');
  expect(resolveAll).toHaveBeenCalledOnce();
  expect(f.connected).toEqual(['8.8.8.8']);
});

it.each(['8.8.8.8', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
  'allows a public literal %s without DNS',
  async (address) => {
    const f = downloadFixture([]);
    const host = isIP(address) === 6 ? `[${address}]` : address;
    expect(
      await withPublicHttps(
        new URL(`https://${host}/`),
        AbortSignal.timeout(1000),
        downloadText,
        f,
      ),
    ).toBe('image');
    expect(f.resolveAll).not.toHaveBeenCalled();
  },
);

it('rejects redirects without requesting the destination and destroys its agent', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const source = vi.fn(() => ({
    statusCode: 302,
    data: '',
    responseOptions: { headers: { location: 'https://destination.example/' } },
  }));
  const destination = vi.fn(() => ({ statusCode: 200, data: 'unexpected' }));
  agent.get('https://source.example').intercept({ path: '/', method: 'GET' }).reply(source);
  agent
    .get('https://destination.example')
    .intercept({ path: '/', method: 'GET' })
    .reply(destination);
  const destroy = vi.spyOn(agent, 'destroy').mockImplementation(() => agent.close());
  await expect(
    withPublicHttps(new URL('https://source.example/'), AbortSignal.timeout(1000), downloadText, {
      createAgent: () => agent,
    }),
  ).rejects.toThrow();
  expect(source).toHaveBeenCalledOnce();
  expect(destination).not.toHaveBeenCalled();
  expect(destroy).toHaveBeenCalled();
});

it('cancels unread response bodies, closes the agent, and destroys it on consumer failure', async () => {
  const cancel = vi.fn();
  const response = new UndiciResponse(new ReadableStream<Uint8Array>({ cancel }));
  const f = downloadFixture([{ address: '8.8.8.8', family: 4 }]);
  const close = vi.spyOn(f.agent, 'close');
  const fetch = vi.fn(async () => response) as NonNullable<Dependencies['fetch']>;
  expect(
    await withPublicHttps(
      new URL('https://new-cdn.example/'),
      AbortSignal.timeout(1000),
      async () => 42,
      { ...f, fetch },
    ),
  ).toBe(42);
  expect(cancel).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalled();
  expect(f.agent.closed).toBe(true);
  const failed = downloadFixture([]);
  const destroy = vi.spyOn(failed.agent, 'destroy');
  const failedFetch = vi.fn(async () => new UndiciResponse('image')) as NonNullable<
    Dependencies['fetch']
  >;
  await expect(
    withPublicHttps(
      new URL('https://new-cdn.example/'),
      AbortSignal.timeout(1000),
      async () => {
        throw new Error('consumer failed');
      },
      { ...failed, fetch: failedFetch },
    ),
  ).rejects.toThrow('consumer failed');
  expect(destroy).toHaveBeenCalled();
});

it('aborts a real undici request while its DNS lookup is pending', async () => {
  const controller = new AbortController();
  let finish: Parameters<NonNullable<Dependencies['resolveAll']>>[1] | undefined;
  const pending = withPublicHttps(
    new URL('https://dns-pending.example/'),
    controller.signal,
    downloadText,
    {
      resolveAll: (_host, done) => {
        finish = done;
      },
    },
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  finish!(null, [{ address: '127.0.0.1', family: 4 }]);
  await expect(pending).rejects.toThrow();
});

it('settles an aborted request even when DNS never calls back', async () => {
  const pending = withPublicHttps(
    new URL('https://dns-never.example/'),
    AbortSignal.timeout(50),
    downloadText,
    {
      resolveAll: () => {},
    },
  );
  const outcome = await Promise.race([
    pending.then(
      () => 'unexpected',
      () => 'aborted',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
  ]);
  expect(outcome).toBe('aborted');
});

it.each([
  ['gzip', gzipSync],
  ['deflate', deflateSync],
  ['deflate', deflateRawSync],
  ['br', brotliCompressSync],
  ['zstd', zstdCompressSync],
  ['gzip, br', (value: Buffer) => brotliCompressSync(gzipSync(value))],
] as const)('retains fetch decoding for %s responses', async (name, compress) => {
  const original = Buffer.from('image-data'.repeat(10_000));
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get('https://cdn.example')
    .intercept({ path: '/', method: 'GET' })
    .reply(200, compress(original), { headers: { 'content-encoding': name } });
  const result = await withPublicHttps(
    new URL('https://cdn.example/'),
    AbortSignal.timeout(3000),
    downloadBytes,
    { createAgent: () => agent },
  );
  expect(result).toEqual(original);
});

describe('owner-scoped image object identities', () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  const attemptId = '22222222-2222-4222-8222-222222222222';
  const assetId = '33333333-3333-4333-8333-333333333333';
  const rawId = '44444444-4444-4444-8444-444444444444';
  it('accepts owner raw and image derived object keys and rejects video derived or mismatched keys', () => {
    const fileId = '77777777-7777-4777-8777-777777777777';
    expect(isValidImageAssetObjectKey(assetId, `mio/raw/${assetId}/${rawId}`, 'image/png')).toBe(
      true,
    );
    expect(
      isValidImageAssetObjectKey(
        assetId,
        `mio/derived/${jobId}/images/0-${fileId}.png`,
        'image/png',
      ),
    ).toBe(true);
    expect(
      isValidImageAssetObjectKey(
        assetId,
        `mio/derived/${jobId}/images/15-${fileId}.jpeg`,
        'image/jpeg',
      ),
    ).toBe(true);

    // Reject video derived key, extension/contentType mismatch, out-of-range index (>15), and wrong raw owner assetId
    expect(
      isValidImageAssetObjectKey(
        assetId,
        `mio/derived/${jobId}/${attemptId}/result.mp4`,
        'image/png',
      ),
    ).toBe(false);
    expect(
      isValidImageAssetObjectKey(
        assetId,
        `mio/derived/${jobId}/images/0-${fileId}.png`,
        'image/jpeg',
      ),
    ).toBe(false);
    expect(
      isValidImageAssetObjectKey(
        assetId,
        `mio/derived/${jobId}/images/16-${fileId}.png`,
        'image/png',
      ),
    ).toBe(false);
    expect(isValidImageAssetObjectKey(assetId, `mio/raw/${jobId}/${rawId}`, 'image/png')).toBe(
      false,
    );
  });
});

registerVendorRoutingCases();

function encodedContentImage(format: string, size = '16x16'): Buffer {
  const encoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=blue:s=${size}`,
      '-frames:v',
      '1',
      '-c:v',
      format,
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  if (encoded.status !== 0) throw new Error(encoded.stderr.toString());
  return encoded.stdout;
}

describe('generation image content validation using complete async decoding', () => {
  const decode = createImageDecoder();
  it.each([
    ['png', 'png'],
    ['mjpeg', 'jpeg'],
    ['libwebp', 'webp'],
  ])('accepts decodable %s and rejects a mismatched declared format', async (codec, format) => {
    const bytes = encodedContentImage(codec);
    await expect(decode(bytes, format)).resolves.toBeUndefined();
    await expect(decode(bytes, format === 'png' ? 'jpeg' : 'png')).rejects.toThrow(
      'IMAGE_OUTPUT_INVALID',
    );
  });
  it('rejects missing image data while preserving the existing image dimension policy', async () => {
    await expect(decode(Buffer.from('89504e470d0a1a0a', 'hex'), 'png')).rejects.toThrow(
      'IMAGE_OUTPUT_INVALID',
    );
    await expect(decode(encodedContentImage('png', '4096x16'), 'png')).resolves.toBeUndefined();
  });
  it('rejects truncated pixels even when the header retains dimensions', async () => {
    const bytes = encodedContentImage('png', '256x256');
    await expect(decode(bytes.subarray(0, Math.floor(bytes.length / 2)), 'png')).rejects.toThrow(
      'IMAGE_OUTPUT_INVALID',
    );
  });
});
