import { createHash, randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { Journal } from '../src/adapters/journal.ts';
import { createImageWorker, recoverImageMaterialization } from '../src/image-worker.ts';
import { createRoutedKlingImageProtocol } from '../src/providers/onelink/kling/index.ts';
import { sealImageKey } from '../../src/compute/image-credentials.ts';
import { validateImage } from '../src/adapters/media.ts';
import type {
  ImageCommandV1,
  ImageDriver,
  ImageInput,
  ImageQueryCommandV1,
  ImageRouteConfig,
} from '@mio/compute-contracts';
import { imageCommandCredentialBinding, imageQueryCredentialBinding } from '@mio/compute-contracts';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const GPT_ROUTE: ImageRouteConfig = {
  driver: 'openai-images',
  vendor: 'openai',
  submitPath: '/v1/images/generations',
  editPath: '/v1/images/edits',
  queryPathTemplate: null,
  requiresAsync: false,
  effectiveWatermark: null,
  paramSpec: {
    supportedOperations: ['generate', 'edit'],
    requiresAsync: false,
    maxN: 10,
    allowExplicitN: true,
    allowedSizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
    allowCustomDimensions: true,
    maxReferenceImages: 16,
    allowGenerateReferences: false,
    allowMaskPng: true,
    allowOutpaintGeometry: false,
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

const KLING_ROUTE: ImageRouteConfig = {
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

function defaultRouteFor(profile: ImageDriver): ImageRouteConfig {
  switch (profile) {
    case 'openai-images':
      return GPT_ROUTE;
    case 'volcengine-ark-images':
      return SEEDREAM_ROUTE;
    case 'kling-images':
      return KLING_ROUTE;
    case 'vidu-images':
      throw new Error('unexpected vidu-images without explicit route');
  }
}

function command(
  input: Record<string, unknown> = {},
  profile: ImageDriver = 'openai-images',
  route: ImageRouteConfig = defaultRouteFor(profile),
): ImageCommandV1 {
  const base = {
    version: 1 as const,
    type: 'image.request' as const,
    messageId: randomUUID(),
    jobId: randomUUID(),
    ownerId: randomUUID(),
    expiresAt: Date.now() + 60_000,
    profile,
    route,
    input: { model: 'gpt-image-2', prompt: 'square', ...input } as ImageInput,
  };
  const binding = imageCommandCredentialBinding(base);
  return { ...base, credential: sealImageKey('test-secret', binding, 'b1', keys.publicKey) };
}

function imageOutput(
  job: string,
  index: number,
  fileId: string,
  format: string,
  sizeBytes: number,
  sha256 = 'a'.repeat(64),
) {
  return {
    key: `mio/derived/${job}/images/${index}-${fileId}.${format}`,
    sizeBytes,
    sha256,
    etag: 'etag',
    contentType: `image/${format}`,
  };
}

describe('durable image execution', () => {
  it('persists attempted file IDs before COS and allocates a fresh ID after an uncertain write', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const request = command();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }] }));
    const fileIds: string[] = [];
    const materialize = vi.fn(
      async (job: string, index: number, _data: string, format: string, fileId: string) => {
        fileIds.push(fileId);
        if (fileIds.length === 1) throw new Error('storage timeout');
        return {
          key: `mio/derived/${job}/images/${index}-${fileId}.${format}`,
          sizeBytes: 3,
          sha256: 'a'.repeat(64),
          etag: 'etag',
          contentType: `image/${format}`,
        };
      },
    );
    try {
      const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
      expect((await worker(request)).state).toBe('materializing');
      const first = JSON.parse(journal.image(request.jobId)!.payload!);
      expect(first.attemptedFileIds['0']).toEqual([fileIds[0]]);
      expect(first.pendingFileIds['0']).toBe(fileIds[0]);
      expect((await worker(request)).state).toBe('completed');
      const second = JSON.parse(journal.image(request.jobId)!.payload!);
      expect(fileIds).toHaveLength(2);
      expect(fileIds[0]).not.toBe(fileIds[1]);
      expect(second.attemptedFileIds['0']).toEqual(fileIds);
      expect(second.pendingFileIds?.['0']).toBeUndefined();
      expect(second.outputs[0].key).toContain(`-${fileIds[1]}`);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('rejects expired or modified credential bindings before submission', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const transport = vi.fn<typeof fetch>();
    try {
      const worker = createImageWorker(journal, 'b1', keys.privateKey, vi.fn(), transport);
      const expired = command();
      expired.expiresAt = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(expired.expiresAt);
      expect(await worker(expired)).toEqual({
        state: 'rejected',
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
      });
      const tampered = command();
      tampered.input.prompt = 'changed after sealing';
      expect(await worker(tampered)).toEqual({
        state: 'rejected',
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
      });
      const wrongRoute = command();
      wrongRoute.route = { ...GPT_ROUTE, vendor: 'tampered' };
      expect(await worker(wrongRoute)).toEqual({
        state: 'rejected',
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('preserves Volcengine Seedream JPEG and safe provider observation across failure, restart and recovery', async () => {
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
        'mjpeg',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    expect(encoded.status).toBe(0);
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const instance = randomUUID();
    let journal = new Journal(directory, instance, true);
    const request = command(
      { model: 'doubao-seedream-4.0', n: 1, size: '1024x1024' },
      'volcengine-ark-images',
    );
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          data: [{ b64_json: encoded.stdout.toString('base64') }],
          usage: { generated_images: 1, output_tokens: 120, total_tokens: 150 },
        },
        { headers: { 'x-request-id': 'req-seedream-1' } },
      ),
    );
    let output: ReturnType<typeof imageOutput> | undefined;
    let attempt = 0;
    const materialize = vi.fn(
      async (job: string, index: number, data: string, format: string, fileId: string) => {
        expect(format).toBe('jpeg');
        if (++attempt <= 3) throw new Error('temporary');
        validateImage(Buffer.from(data, 'base64'), format);
        output = imageOutput(job, index, fileId, format, encoded.stdout.length);
        return output!;
      },
    );
    const observation = {
      requestId: 'req-seedream-1',
      generatedImages: 1,
      outputTokens: 120,
      totalTokens: 150,
    };
    try {
      const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
      expect((await worker(request)).state).toBe('materializing');
      expect((await worker(request)).state).toBe('materializing');
      expect((await worker(request)).state).toBe('materialization_failed');
      expect(JSON.parse(journal.image(request.jobId)!.payload!).observation).toEqual(observation);
      journal.close();
      journal = new Journal(directory, instance);
      expect(
        (
          await recoverImageMaterialization(
            journal,
            request.jobId,
            request.messageId,
            1,
            materialize,
          )
        ).outcome,
      ).toEqual({ state: 'completed', outputs: [output] });
      expect(JSON.parse(journal.image(request.jobId)!.payload!).observation).toEqual(observation);
      expect(
        await createImageWorker(journal, 'b1', keys.privateKey, materialize, transport)(request),
      ).toEqual({ state: 'completed', outputs: [output] });
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('retains an upstream request ID on unknown and rejected outcomes without retry', async () => {
    for (const outcome of ['unknown', 'rejected'] as const) {
      const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
      const instance = randomUUID();
      let journal = new Journal(directory, instance, true);
      const request = command();
      const response =
        outcome === 'unknown'
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error('offline'));
                },
              }),
              { headers: { 'x-request-id': 'req-unknown' } },
            )
          : new Response('', { status: 429, headers: { 'x-request-id': 'req-rejected' } });
      const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
      try {
        const worker = createImageWorker(journal, 'b1', keys.privateKey, vi.fn(), transport);
        expect((await worker(request)).state).toBe(outcome);
        const expectedId = `req-${outcome}`;
        expect(JSON.parse(journal.image(request.jobId)!.payload!).observation).toEqual({
          requestId: expectedId,
        });
        journal.close();
        journal = new Journal(directory, instance);
        expect(
          (await createImageWorker(journal, 'b1', keys.privateKey, vi.fn(), transport)(request))
            .state,
        ).toBe(outcome);
        expect(JSON.parse(journal.image(request.jobId)!.payload!).observation).toEqual({
          requestId: expectedId,
        });
        expect(transport).toHaveBeenCalledOnce();
      } finally {
        journal.close();
        rmSync(directory, { recursive: true });
      }
    }
  });

  it('resumes a legacy double-update journal identity without a supplier request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-legacy-'));
    const instance = randomUUID();
    let journal = new Journal(directory, instance, true);
    const request = command({ prompt: '历史图像 🌙\u0000é', n: 1 });
    // This is the pre-migration algorithm; do not derive this fixture from foundation/hash.
    const identity = createHash('sha256')
      .update(imageCommandCredentialBinding(request))
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(request.credential).sort(([a], [b]) => a.localeCompare(b)),
          ),
        ),
      )
      .digest('hex');
    const transport = vi.fn<typeof fetch>();
    const materialize = vi.fn(
      async (job: string, index: number, _data: string, format: string, fileId: string) =>
        imageOutput(job, index, fileId, format, 3),
    );
    try {
      journal.beginImage(request.jobId, identity);
      journal.imagePhase(
        request.jobId,
        'returned',
        JSON.stringify({
          commandId: request.messageId,
          format: 'png',
          expectedCount: 1,
          images: [{ base64: 'YWJj' }],
          outputs: [],
        }),
      );
      journal.close();
      journal = new Journal(directory, instance);
      const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
      const result = await worker(request);
      expect(result).toMatchObject({ state: 'completed', outputs: [{ sizeBytes: 3 }] });
      expect(await worker(request)).toEqual(result);
      expect(journal.image(request.jobId)?.identity).toBe(identity);
      expect(materialize).toHaveBeenCalledOnce();
      expect(transport).not.toHaveBeenCalled();
      await expect(
        worker({ ...request, input: { ...request.input, prompt: 'changed' } }),
      ).rejects.toThrow('IMAGE_COMMAND_CONFLICT');
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('restarts materialization without another paid POST and preserves command identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const instance = randomUUID();
    let journal = new Journal(directory, instance, true);
    const request = command();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }] }));
    let output: ReturnType<typeof imageOutput> | undefined;
    let first = true;
    const materialize = vi.fn(
      async (job: string, index: number, _data: string, format: string, fileId: string) => {
        if (first) {
          first = false;
          throw new Error('offline');
        }
        output = imageOutput(job, index, fileId, format, 3);
        return output;
      },
    );
    try {
      expect(
        await createImageWorker(journal, 'b1', keys.privateKey, materialize, transport)(request),
      ).toEqual({ state: 'materializing', outputs: [] });
      journal.close();
      journal = new Journal(directory, instance);
      const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
      expect(await worker(request)).toEqual({ state: 'completed', outputs: [output] });
      expect(await worker(request)).toEqual({ state: 'completed', outputs: [output] });
      expect(transport).toHaveBeenCalledOnce();
      expect(materialize).toHaveBeenCalledTimes(2);
      await expect(worker({ ...request, ownerId: randomUUID() })).rejects.toThrow(
        'IMAGE_COMMAND_CONFLICT',
      );
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('exposes durable outputs when a later output fails and resumes the remainder only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const request = command({ n: 2 });
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }, { b64_json: 'ZGVm' }] }));
    const outputs: ReturnType<typeof imageOutput>[] = [];
    let calls = 0;
    const materialize = vi.fn(
      async (job: string, index: number, _data: string, format: string, fileId: string) => {
        if (++calls === 2) throw new Error('offline');
        const output = imageOutput(job, index, fileId, format, 3, String(index).repeat(64));
        outputs.push(output);
        return output;
      },
    );
    try {
      const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
      expect(await worker(request)).toEqual({ state: 'materializing', outputs: [outputs[0]] });
      expect(await worker(request)).toEqual({
        state: 'completed',
        outputs: [outputs[0], outputs[1]],
      });
      expect(transport).toHaveBeenCalledOnce();
      expect(materialize).toHaveBeenCalledTimes(3);
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('retains ambiguous submission across restart without replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const instance = randomUUID();
    let journal = new Journal(directory, instance, true);
    const request = command();
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection lost'));
    const materialize = vi.fn();
    try {
      expect(
        await createImageWorker(journal, 'b1', keys.privateKey, materialize, transport)(request),
      ).toEqual({ state: 'unknown', errorCode: 'IMAGE_SUBMISSION_UNKNOWN' });
      journal.close();
      journal = new Journal(directory, instance);
      expect(
        await createImageWorker(journal, 'b1', keys.privateKey, materialize, transport)(request),
      ).toEqual({ state: 'unknown', errorCode: 'IMAGE_SUBMISSION_UNKNOWN' });
      expect(transport).toHaveBeenCalledOnce();
      expect(materialize).not.toHaveBeenCalled();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('persists sanitized async submission diagnostics without changing the unknown boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const request = command({ async: true });
    const asyncTransport = {
      submit: vi.fn(async () => ({
        state: 'unknown' as const,
        code: 'IMAGE_SUBMISSION_UNKNOWN' as const,
        observation: {
          statusCode: 503,
          requestIdPresent: true,
          responsePaths: ['task_id', 'other'] as Array<'task_id' | 'other'>,
          taskIdPresent: false,
          errorCategory: 'upstream' as const,
        },
      })),
      query: vi.fn(),
    };
    try {
      const worker = createImageWorker(
        journal,
        'b1',
        keys.privateKey,
        vi.fn(),
        fetch,
        undefined,
        asyncTransport,
      );
      await expect(worker(request)).resolves.toEqual({
        state: 'unknown',
        errorCode: 'IMAGE_SUBMISSION_UNKNOWN',
      });
      const row = journal.image(request.jobId)!;
      expect(row.phase).toBe('unknown');
      expect(JSON.parse(row.payload!)).toEqual({
        code: 'IMAGE_SUBMISSION_UNKNOWN',
        observation: {
          statusCode: 503,
          requestIdPresent: true,
          responsePaths: ['task_id', 'other'],
          taskIdPresent: false,
          errorCategory: 'upstream',
        },
      });
      await expect(worker(request)).resolves.toEqual({
        state: 'unknown',
        errorCode: 'IMAGE_SUBMISSION_UNKNOWN',
      });
      expect(asyncTransport.submit).toHaveBeenCalledOnce();
      expect(asyncTransport.query).not.toHaveBeenCalled();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('exposes a supplier short response as partial across restart without another POST', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const instance = randomUUID();
    let journal = new Journal(directory, instance, true);
    const request = command({ n: 2 });
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }] }));
    let output: ReturnType<typeof imageOutput> | undefined;
    const materialize = vi.fn(
      async (job: string, index: number, _data: string, format: string, fileId: string) => {
        output = imageOutput(job, index, fileId, format, 3);
        return output;
      },
    );
    try {
      expect(
        await createImageWorker(journal, 'b1', keys.privateKey, materialize, transport)(request),
      ).toEqual({ state: 'partial', outputs: [output] });
      journal.close();
      journal = new Journal(directory, instance);
      expect(await createImageWorker(journal, '', '', materialize, transport)(request)).toEqual({
        state: 'partial',
        outputs: [output],
      });
      expect(transport).toHaveBeenCalledOnce();
      expect(materialize).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('allows one explicit materialization recovery after three failures and republishes saved completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const instance = randomUUID();
    let journal = new Journal(directory, instance, true);
    const request = command();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }] }));
    let output: ReturnType<typeof imageOutput> | undefined;
    let calls = 0;
    const materialize = vi.fn(
      async (job: string, index: number, _data: string, format: string, fileId: string) => {
        if (++calls <= 5) throw new Error('offline');
        output = imageOutput(job, index, fileId, format, 3);
        return output!;
      },
    );
    try {
      const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
      expect((await worker(request)).state).toBe('materializing');
      expect((await worker(request)).state).toBe('materializing');
      expect((await worker(request)).state).toBe('materialization_failed');
      expect((await worker(request)).state).toBe('materialization_failed');
      expect(materialize).toHaveBeenCalledTimes(3);
      journal.close();
      journal = new Journal(directory, instance);
      const failed = await recoverImageMaterialization(
        journal,
        request.jobId,
        request.messageId,
        1,
        materialize,
      );
      expect(failed.outcome.state).toBe('materialization_failed');
      expect(
        await recoverImageMaterialization(
          journal,
          request.jobId,
          request.messageId,
          1,
          materialize,
        ),
      ).toEqual(failed);
      expect(materialize).toHaveBeenCalledTimes(4);
      const secondFailure = await recoverImageMaterialization(
        journal,
        request.jobId,
        request.messageId,
        2,
        materialize,
      );
      expect(secondFailure.outcome.state).toBe('materialization_failed');
      journal.close();
      journal = new Journal(directory, instance);
      expect(
        (
          await recoverImageMaterialization(
            journal,
            request.jobId,
            request.messageId,
            1,
            materialize,
          )
        ).outcome.state,
      ).toBe('materialization_failed');
      expect(materialize).toHaveBeenCalledTimes(5);
      const recovered = await recoverImageMaterialization(
        journal,
        request.jobId,
        request.messageId,
        3,
        materialize,
      );
      expect(recovered).toEqual({
        commandId: request.messageId,
        outcome: { state: 'completed', outputs: [output] },
      });
      expect(
        await recoverImageMaterialization(
          journal,
          request.jobId,
          request.messageId,
          3,
          materialize,
        ),
      ).toEqual(recovered);
      expect(materialize).toHaveBeenCalledTimes(6);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('rejects a new command without image keys without sending it upstream', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const transport = vi.fn<typeof fetch>();
    try {
      const request = command();
      const worker = createImageWorker(journal, '', '', vi.fn(), transport);
      expect(await worker(request)).toEqual({
        state: 'rejected',
        errorCode: 'IMAGE_HANDLER_UNAVAILABLE',
      });
      expect(await worker(request)).toEqual({
        state: 'rejected',
        errorCode: 'IMAGE_HANDLER_UNAVAILABLE',
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('retains a valid later PNG when an earlier upstream item has invalid base64', async () => {
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
        'png',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    expect(encoded.status).toBe(0);
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const instance = randomUUID();
    let journal = new Journal(directory, instance, true);
    const request = command({ n: 2 });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ b64_json: 'bad!' }, { b64_json: encoded.stdout.toString('base64') }],
      }),
    );
    const materialize = vi.fn(
      async (job: string, index: number, data: string, format: string, fileId: string) => {
        const bytes = Buffer.from(data, 'base64');
        validateImage(bytes, format);
        return {
          key: `mio/derived/${job}/images/${index}-${fileId}.${format}`,
          sizeBytes: bytes.length,
          sha256: 'a'.repeat(64),
          etag: 'etag',
          contentType: `image/${format}`,
        };
      },
    );
    try {
      const result = await createImageWorker(
        journal,
        'b1',
        keys.privateKey,
        materialize,
        transport,
      )(request);
      expect(result.state).toBe('partial');
      expect('outputs' in result && result.outputs[0]?.key).toMatch(
        new RegExp(`^mio/derived/${request.jobId}/images/1-[0-9a-f-]{36}\\.png$`),
      );
      journal.close();
      journal = new Journal(directory, instance);
      expect(await createImageWorker(journal, '', '', materialize, transport)(request)).toEqual(
        result,
      );
      expect(materialize).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it.each([
    [{}, [{ b64_json: 'bad!' }]],
    [{ n: 2 }, [{ b64_json: 'bad!' }, { b64_json: 'bad!' }]],
    [{ n: 2 }, []],
  ])(
    'marks a known response with no usable outputs partial without another POST',
    async (input, data) => {
      const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
      const journal = new Journal(directory, randomUUID(), true);
      const request = command(input);
      const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data }));
      const materialize = vi.fn();
      try {
        const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
        expect(await worker(request)).toEqual({ state: 'partial', outputs: [] });
        expect(await worker(request)).toEqual({ state: 'partial', outputs: [] });
        expect(materialize).not.toHaveBeenCalled();
        expect(transport).toHaveBeenCalledOnce();
      } finally {
        journal.close();
        rmSync(directory, { recursive: true });
      }
    },
  );

  it('retains valid returned bytes through missing decoder tools and resumes without another POST', async () => {
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
        'png',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    expect(encoded.status).toBe(0);
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const instance = randomUUID();
    let journal = new Journal(directory, instance, true);
    const request = command();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: [{ b64_json: encoded.stdout.toString('base64') }] }),
      );
    let output: ReturnType<typeof imageOutput> | undefined;
    const materialize = vi.fn(
      async (job: string, index: number, data: string, format: string, fileId: string) => {
        validateImage(Buffer.from(data, 'base64'), format);
        output = imageOutput(job, index, fileId, format, encoded.stdout.length);
        return output!;
      },
    );
    const priorPath = process.env.PATH;
    try {
      process.env.PATH = '/nonexistent-mio-image-tools';
      const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
      expect((await worker(request)).state).toBe('materializing');
      expect((await worker(request)).state).toBe('materializing');
      expect((await worker(request)).state).toBe('materialization_failed');
      expect(journal.image(request.jobId)?.payload).toContain(encoded.stdout.toString('base64'));
      journal.close();
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      journal = new Journal(directory, instance);
      const recovered = await recoverImageMaterialization(
        journal,
        request.jobId,
        request.messageId,
        1,
        materialize,
      );
      expect(recovered.outcome).toEqual({ state: 'completed', outputs: [output] });
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('retains an indeterminate corrupt PNG and exposes a valid later output without reposting', async () => {
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
        'png',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    expect(encoded.status).toBe(0);
    const valid = encoded.stdout;
    const corrupt = Buffer.from(valid);
    const idat = corrupt.indexOf('IDAT');
    expect(idat).toBeGreaterThan(0);
    corrupt[idat + 8] = corrupt[idat + 8]! ^ 0xff;
    expect(() => validateImage(valid, 'png')).not.toThrow();
    expect(() => validateImage(corrupt, 'png')).toThrow('IMAGE_VALIDATION_INCOMPLETE');
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const instance = randomUUID();
    let journal = new Journal(directory, instance, true);
    const request = command({ n: 2 });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ b64_json: corrupt.toString('base64') }, { b64_json: valid.toString('base64') }],
      }),
    );
    let output: ReturnType<typeof imageOutput> | undefined;
    const materialize = vi.fn(
      async (job: string, index: number, data: string, format: string, fileId: string) => {
        validateImage(Buffer.from(data, 'base64'), format);
        output = imageOutput(job, index, fileId, format, valid.length);
        return output!;
      },
    );
    try {
      const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
      expect(await worker(request)).toEqual({ state: 'materializing', outputs: [output] });
      expect(await worker(request)).toEqual({ state: 'materializing', outputs: [output] });
      expect(await worker(request)).toEqual({ state: 'materialization_failed', outputs: [output] });
      const saved = JSON.parse(journal.image(request.jobId)!.payload!);
      expect(saved.images[0].base64).toBe(corrupt.toString('base64'));
      journal.close();
      journal = new Journal(directory, instance);
      expect(
        (
          await recoverImageMaterialization(
            journal,
            request.jobId,
            request.messageId,
            1,
            materialize,
          )
        ).outcome,
      ).toEqual({ state: 'materialization_failed', outputs: [output] });
      expect(materialize.mock.calls.map((args) => args[1])).toEqual([0, 1, 0, 0, 0]);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('continues later outputs when the first materialization fails and retries only the missing index', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const request = command({ n: 2 });
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }, { b64_json: 'ZGVm' }] }));
    const outputs: ReturnType<typeof imageOutput>[] = [];
    let first = true;
    const materialize = vi.fn(
      async (job: string, index: number, _data: string, format: string, fileId: string) => {
        if (index === 0 && first) {
          first = false;
          throw new Error('temporary');
        }
        const output = imageOutput(job, index, fileId, format, 3, String(index).repeat(64));
        outputs.push(output);
        return output;
      },
    );
    try {
      const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
      expect(await worker(request)).toEqual({ state: 'materializing', outputs: [outputs[0]] });
      expect(await worker(request)).toEqual({
        state: 'completed',
        outputs: [outputs[1], outputs[0]],
      });
      expect(materialize.mock.calls.map((args) => args[1])).toEqual([0, 1, 0]);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('marks invalid decoded content as missing and still retains a later valid output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const request = command({ n: 2 });
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }, { b64_json: 'ZGVm' }] }));
    let output: ReturnType<typeof imageOutput> | undefined;
    const materialize = vi.fn(
      async (job: string, index: number, _data: string, format: string, fileId: string) => {
        if (index === 0) throw new Error('IMAGE_OUTPUT_INVALID');
        output = imageOutput(job, index, fileId, format, 3);
        return output!;
      },
    );
    try {
      const worker = createImageWorker(journal, 'b1', keys.privateKey, materialize, transport);
      expect(await worker(request)).toEqual({ state: 'partial', outputs: [output] });
      const saved = JSON.parse(journal.image(request.jobId)!.payload!);
      expect(saved.pendingFileIds).toBeUndefined();
      expect(saved.attemptedFileIds['0']).toHaveLength(1);
      expect(await worker(request)).toEqual({ state: 'partial', outputs: [output] });
      expect(materialize.mock.calls.map((args) => args[1])).toEqual([0, 1]);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('submits async once, queries a persisted upstream task, and materializes only on return', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const request = command({ async: true });
    const transport = vi.fn<typeof fetch>();
    const asyncTransport = {
      submit: vi.fn(async () => ({ state: 'submitted' as const, upstreamTaskId: 'task-async-1' })),
      query: vi.fn(async (_input, _key, taskId: string, attempt: number) =>
        attempt === 1
          ? { state: 'processing' as const, upstreamTaskId: taskId }
          : {
              state: 'returned' as const,
              upstreamTaskId: taskId,
              images: [{ base64: 'YWJj', format: 'jpeg' as const }],
            },
      ),
    };
    const materialize = vi.fn(
      async (job: string, index: number, _data: string, format: string, fileId: string) =>
        imageOutput(job, index, fileId, format, 3),
    );
    const query = (attempt: number): ImageQueryCommandV1 => {
      const value: ImageQueryCommandV1 = {
        version: 1,
        type: 'image.query',
        messageId: randomUUID(),
        commandId: request.messageId,
        jobId: request.jobId,
        ownerId: request.ownerId,
        expiresAt: request.expiresAt,
        profile: request.profile,
        route: request.route,
        operation: 'generate',
        input: request.input as ImageQueryCommandV1['input'],
        upstreamTaskId: 'task-async-1',
        queryAttempt: attempt,
        credential: request.credential,
        queryDeadline: request.expiresAt,
      };
      return {
        ...value,
        queryCredential: sealImageKey(
          'test-secret',
          imageQueryCredentialBinding(value),
          'b1',
          keys.publicKey,
        ),
      };
    };
    try {
      const worker = createImageWorker(
        journal,
        'b1',
        keys.privateKey,
        materialize,
        transport,
        undefined,
        asyncTransport,
      );
      await expect(worker(request)).resolves.toEqual({
        state: 'submitted',
        upstreamTaskId: 'task-async-1',
        queryAttempt: 0,
      });
      await expect(worker(query(1))).resolves.toEqual({
        state: 'processing',
        upstreamTaskId: 'task-async-1',
        queryAttempt: 1,
      });
      await expect(worker(query(2))).resolves.toEqual({
        state: 'completed',
        outputs: [expect.objectContaining({ sizeBytes: 3 })],
      });
      expect(asyncTransport.submit).toHaveBeenCalledOnce();
      expect(asyncTransport.query).toHaveBeenCalledTimes(2);
      expect(transport).not.toHaveBeenCalled();
      expect(materialize).toHaveBeenCalledOnce();
      expect(materialize.mock.calls[0]?.[3]).toBe('jpeg');
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('does not resubmit after an async query becomes unknown', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const request = command({ async: true });
    const asyncTransport = {
      submit: vi.fn(async () => ({
        state: 'submitted' as const,
        upstreamTaskId: 'task-unknown-1',
      })),
      query: vi.fn(async () => ({
        state: 'unknown' as const,
        code: 'IMAGE_QUERY_UNKNOWN' as const,
      })),
    };
    const query: ImageQueryCommandV1 = {
      version: 1,
      type: 'image.query',
      messageId: randomUUID(),
      commandId: request.messageId,
      jobId: request.jobId,
      ownerId: request.ownerId,
      expiresAt: request.expiresAt,
      profile: request.profile,
      route: request.route,
      operation: 'generate',
      input: request.input as ImageQueryCommandV1['input'],
      upstreamTaskId: 'task-unknown-1',
      queryAttempt: 1,
      credential: request.credential,
      queryDeadline: request.expiresAt,
    };
    query.queryCredential = sealImageKey(
      'test-secret',
      imageQueryCredentialBinding(query),
      'b1',
      keys.publicKey,
    );
    try {
      const worker = createImageWorker(
        journal,
        'b1',
        keys.privateKey,
        vi.fn(),
        fetch,
        undefined,
        asyncTransport,
      );
      await expect(worker(request)).resolves.toMatchObject({ state: 'submitted' });
      await expect(worker(query)).resolves.toEqual({
        state: 'failed',
        errorCode: 'IMAGE_QUERY_UNKNOWN',
        upstreamTaskId: 'task-unknown-1',
        queryAttempt: 1,
      });
      await expect(worker(request)).resolves.toEqual({
        state: 'failed',
        errorCode: 'IMAGE_QUERY_UNKNOWN',
        upstreamTaskId: 'task-unknown-1',
        queryAttempt: 1,
      });
      expect(asyncTransport.submit).toHaveBeenCalledOnce();
      expect(asyncTransport.query).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('recovers a known task with the current key without trusting legacy or duplicate queries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const request = command({ async: true });
    const asyncTransport = {
      submit: vi.fn(async () => ({ state: 'submitted' as const, upstreamTaskId: 'task-rotate' })),
      query: vi.fn(async (_input, _key, taskId: string, attempt: number) =>
        attempt === 2
          ? { state: 'processing' as const, upstreamTaskId: taskId }
          : { state: 'returned' as const, upstreamTaskId: taskId, images: [{ base64: 'YWJj' }] },
      ),
    };
    const query = (attempt: number): ImageQueryCommandV1 => ({
      version: 1,
      type: 'image.query',
      messageId: randomUUID(),
      commandId: request.messageId,
      jobId: request.jobId,
      ownerId: request.ownerId,
      expiresAt: request.expiresAt,
      profile: request.profile,
      route: request.route,
      operation: 'generate',
      input: request.input as ImageQueryCommandV1['input'],
      upstreamTaskId: 'task-rotate',
      queryAttempt: attempt,
      credential: request.credential,
      queryDeadline: request.expiresAt,
    });
    const sealed = (value: ImageQueryCommandV1, key: string) => ({
      ...value,
      queryCredential: sealImageKey(key, imageQueryCredentialBinding(value), 'b1', keys.publicKey),
    });
    const materialize = vi.fn(
      async (job: string, index: number, _data: string, format: string, fileId: string) =>
        imageOutput(job, index, fileId, format, 3),
    );
    try {
      const worker = createImageWorker(
        journal,
        'b1',
        keys.privateKey,
        materialize,
        fetch,
        undefined,
        asyncTransport,
      );
      await expect(worker(request)).resolves.toMatchObject({ state: 'submitted' });
      const legacy = query(1);
      delete legacy.queryDeadline;
      await expect(worker(legacy)).resolves.toMatchObject({
        state: 'failed',
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
        upstreamTaskId: 'task-rotate',
        queryAttempt: 1,
      });
      const rotated = sealed(query(1), 'rotated-secret');
      await expect(worker(rotated)).resolves.toMatchObject({
        state: 'failed',
        queryAttempt: 1,
      });
      expect(asyncTransport.query).not.toHaveBeenCalled();
      const second = sealed(query(2), 'rotated-secret');
      await expect(worker({ ...second, ownerId: randomUUID() })).rejects.toThrow(
        'IMAGE_COMMAND_CONFLICT',
      );
      await expect(worker({ ...second, upstreamTaskId: 'other-task' })).rejects.toThrow(
        'IMAGE_QUERY_UNKNOWN',
      );
      await expect(worker(second)).resolves.toMatchObject({
        state: 'processing',
        queryAttempt: 2,
      });
      expect(asyncTransport.query.mock.calls[0]?.[1]).toBe('rotated-secret');
      await worker(second);
      await worker(rotated);
      expect(asyncTransport.query).toHaveBeenCalledOnce();
      const third = sealed(query(3), 'rotated-secret');
      await expect(worker({ ...third, queryAttempt: 4 })).resolves.toMatchObject({
        state: 'failed',
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
        queryAttempt: 4,
      });
      const fifth = sealed(query(5), 'rotated-secret');
      await expect(worker({ ...fifth, messageId: randomUUID() })).resolves.toMatchObject({
        state: 'failed',
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
        queryAttempt: 5,
      });
      const sixth = sealed(query(6), 'rotated-secret');
      await expect(
        worker({ ...sixth, queryDeadline: request.expiresAt - 1000 }),
      ).resolves.toMatchObject({
        state: 'failed',
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
        queryAttempt: 6,
      });
      const late = { ...query(7), queryDeadline: Date.now() - 1 };
      await expect(worker(sealed(late, 'rotated-secret'))).resolves.toMatchObject({
        state: 'failed',
        errorCode: 'IMAGE_QUERY_LIMIT',
        queryAttempt: 7,
      });
      await expect(worker(sealed(query(8), 'restored-secret'))).resolves.toMatchObject({
        state: 'completed',
      });
      expect(asyncTransport.query.mock.calls[1]?.[1]).toBe('restored-secret');
      expect(asyncTransport.submit).toHaveBeenCalledOnce();
      expect(asyncTransport.query).toHaveBeenCalledTimes(2);
      expect(materialize).toHaveBeenCalledOnce();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('does not query when either the deadline or the query credential is missing', async () => {
    for (const missing of ['queryDeadline', 'queryCredential'] as const) {
      const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
      const journal = new Journal(directory, randomUUID(), true);
      const request = command({ async: true });
      const asyncTransport = {
        submit: vi.fn(async () => ({
          state: 'submitted' as const,
          upstreamTaskId: 'task-missing',
        })),
        query: vi.fn(async () => ({
          state: 'unknown' as const,
          code: 'IMAGE_QUERY_UNKNOWN' as const,
        })),
      };
      const query: ImageQueryCommandV1 = {
        version: 1,
        type: 'image.query',
        messageId: randomUUID(),
        commandId: request.messageId,
        jobId: request.jobId,
        ownerId: request.ownerId,
        expiresAt: request.expiresAt,
        profile: request.profile,
        route: request.route,
        operation: 'generate',
        input: request.input as ImageQueryCommandV1['input'],
        upstreamTaskId: 'task-missing',
        queryAttempt: 1,
        credential: request.credential,
        queryDeadline: request.expiresAt,
      };
      query.queryCredential = sealImageKey(
        'current',
        imageQueryCredentialBinding(query),
        'b1',
        keys.publicKey,
      );
      delete query[missing];
      try {
        const worker = createImageWorker(
          journal,
          'b1',
          keys.privateKey,
          vi.fn(),
          fetch,
          undefined,
          asyncTransport,
        );
        await worker(request);
        await expect(worker(query)).resolves.toMatchObject({
          state: 'failed',
          errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
          upstreamTaskId: 'task-missing',
          queryAttempt: 1,
        });
        expect(asyncTransport.query).not.toHaveBeenCalled();
        expect(asyncTransport.submit).toHaveBeenCalledOnce();
      } finally {
        journal.close();
        rmSync(directory, { recursive: true });
      }
    }
  });

  it.each(['succeed', 'success'] as const)(
    'dispatches kling-images (%s) through default worker async transport and replays completion without repeat POST or GET',
    async (terminalStatus) => {
      const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
      const journal = new Journal(directory, randomUUID(), true);
      const request = command({ model: 'image-kling-v3', async: true }, 'kling-images');
      let postCalls = 0;
      let getCalls = 0;
      let downloadCalls = 0;
      const transport = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        if (String(url) === 'https://api.onelinkai.cloud/kling/v1/images/generations') {
          postCalls++;
          expect(init?.method).toBe('POST');
          expect(JSON.parse(String(init?.body))).toEqual({
            model_name: 'image-kling-v3',
            prompt: 'square',
            n: 1,
          });
          return Response.json({ code: 0, data: { task_id: 'kling-worker-1' } });
        }
        if (
          String(url) === 'https://api.onelinkai.cloud/kling/v1/images/generations/kling-worker-1'
        ) {
          const inFlight = ['NOT_START', 'queued', 'in_progress', 'SUBMITTED'][getCalls++];
          return inFlight
            ? Response.json({
                code: 0,
                data: { task_id: 'kling-worker-1', task_status: inFlight },
              })
            : Response.json({
                code: 0,
                data: {
                  task_id: 'kling-worker-1',
                  task_status: terminalStatus,
                  task_result: { images: [{ index: 0, url: 'https://cdn.kling.example/out.png' }] },
                },
              });
        }
        downloadCalls++;
        return new Response(pngBytes, { headers: { 'content-type': 'image/png' } });
      });
      const materialize = vi.fn(
        async (job: string, index: number, _data: string, format: string, fileId: string) =>
          imageOutput(job, index, fileId, format, pngBytes.length),
      );
      const query = (attempt: number): ImageQueryCommandV1 => {
        const value: ImageQueryCommandV1 = {
          version: 1,
          type: 'image.query',
          messageId: randomUUID(),
          commandId: request.messageId,
          jobId: request.jobId,
          ownerId: request.ownerId,
          expiresAt: request.expiresAt,
          profile: 'kling-images',
          route: request.route,
          operation: 'generate',
          input: request.input as ImageQueryCommandV1['input'],
          upstreamTaskId: 'kling-worker-1',
          queryAttempt: attempt,
          credential: request.credential,
          queryDeadline: request.expiresAt,
        };
        return {
          ...value,
          queryCredential: sealImageKey(
            'test-secret',
            imageQueryCredentialBinding(value),
            'b1',
            keys.publicKey,
          ),
        };
      };
      try {
        const defaultWorker = createImageWorker(
          journal,
          'b1',
          keys.privateKey,
          materialize,
          transport,
        );
        await expect(defaultWorker(request)).resolves.toEqual({
          state: 'submitted',
          upstreamTaskId: 'kling-worker-1',
          queryAttempt: 0,
        });
        for (const attempt of [1, 2, 3, 4]) {
          await expect(defaultWorker(query(attempt))).resolves.toEqual({
            state: 'processing',
            upstreamTaskId: 'kling-worker-1',
            queryAttempt: attempt,
          });
        }
        const downloadAwareWorker = createImageWorker(
          journal,
          'b1',
          keys.privateKey,
          materialize,
          transport,
          undefined,
          createRoutedKlingImageProtocol(
            KLING_ROUTE,
            transport,
            undefined,
            async (url, signal, consume) =>
              consume(await transport(url, { method: 'GET', redirect: 'error', signal })),
          ),
        );
        const finalQuery = query(5);
        const completedOutcome = await downloadAwareWorker(finalQuery);
        expect(completedOutcome).toEqual({
          state: 'completed',
          outputs: [
            expect.objectContaining({ sizeBytes: pngBytes.length, contentType: 'image/png' }),
          ],
        });
        await expect(defaultWorker(request)).resolves.toEqual(completedOutcome);
        await expect(downloadAwareWorker(finalQuery)).resolves.toEqual(completedOutcome);
        expect(postCalls).toBe(1);
        expect(getCalls).toBe(5);
        expect(downloadCalls).toBe(1);
        expect(materialize).toHaveBeenCalledOnce();
        expect(materialize.mock.calls[0]?.[3]).toBe('png');
      } finally {
        journal.close();
        rmSync(directory, { recursive: true });
      }
    },
  );

  it('maps OneLink gateway Kling failure status to IMAGE_QUERY_FAILED without resubmitting', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mio-image-'));
    const journal = new Journal(directory, randomUUID(), true);
    const request = command({ model: 'image-kling-v3', async: true }, 'kling-images');
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url) === 'https://api.onelinkai.cloud/kling/v1/images/generations'
          ? Response.json({ code: 0, data: { task_id: 'kling-fail-1' } })
          : Response.json({ code: 0, data: { task_id: 'kling-fail-1', task_status: 'failure' } }),
      );
    const queryCmd: ImageQueryCommandV1 = {
      version: 1,
      type: 'image.query',
      messageId: randomUUID(),
      commandId: request.messageId,
      jobId: request.jobId,
      ownerId: request.ownerId,
      expiresAt: request.expiresAt,
      profile: 'kling-images',
      route: request.route,
      operation: 'generate',
      input: request.input as ImageQueryCommandV1['input'],
      upstreamTaskId: 'kling-fail-1',
      queryAttempt: 1,
      credential: request.credential,
      queryDeadline: request.expiresAt,
    };
    queryCmd.queryCredential = sealImageKey(
      'test-secret',
      imageQueryCredentialBinding(queryCmd),
      'b1',
      keys.publicKey,
    );
    try {
      const worker = createImageWorker(journal, 'b1', keys.privateKey, vi.fn(), transport);
      await expect(worker(request)).resolves.toMatchObject({ state: 'submitted' });
      await expect(worker(queryCmd)).resolves.toEqual({
        state: 'failed',
        errorCode: 'IMAGE_QUERY_FAILED',
        upstreamTaskId: 'kling-fail-1',
        queryAttempt: 1,
      });
      await expect(worker(request)).resolves.toEqual({
        state: 'failed',
        errorCode: 'IMAGE_QUERY_FAILED',
        upstreamTaskId: 'kling-fail-1',
        queryAttempt: 1,
      });
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });
});
