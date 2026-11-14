import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { Journal } from '../src/adapters/journal.ts';
import { createImageWorker, recoverImageMaterialization } from '../src/image-worker.ts';
import { sealImageKey } from '../../src/compute/image-credentials.ts';
import { validateImage } from '../src/adapters/media.ts';
import type { ImageProfile } from '@mio/compute-contracts';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
function command(input: Record<string, unknown> = {}, profile: ImageProfile = 'gpt-images-v1') {
  const base = {
    messageId: randomUUID(),
    jobId: randomUUID(),
    ownerId: randomUUID(),
    expiresAt: Date.now() + 60_000,
    profile,
    input: { model: 'gpt-image-2', prompt: 'square', ...input },
  };
  const sorted = Object.fromEntries(
    Object.entries(base.input).sort(([a], [b]) => a.localeCompare(b)),
  );
  const binding = JSON.stringify([base.jobId, base.ownerId, base.expiresAt, base.profile, sorted]);
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
      expired.expiresAt = Date.now() - 1;
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
      const wrongProfile = command();
      wrongProfile.profile = 'seedream-4-images-v1';
      expect(await worker(wrongProfile)).toEqual({
        state: 'rejected',
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      journal.close();
      rmSync(directory, { recursive: true });
    }
  });
  it('preserves Seedream JPEG and safe provider observation across failure, restart and recovery', async () => {
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
      'seedream-4-images-v1',
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
});
