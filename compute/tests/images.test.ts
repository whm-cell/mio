import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE_PROFILES,
  IMAGE_PROFILE_RULES,
  parseImageQuery,
  parseImageResult,
  validImageInput,
  type ImageProfile,
  type ImageProfileRule,
} from '@mio/compute-contracts';
import { createImageProtocol, createViduAsyncImageTransport } from '../src/images.ts';
import type { ReadImage } from '../src/images.ts';

const input = { model: 'gpt-image-2', prompt: 'a blue square' };
const key = 'private-test-credential';

function testVidu(transport: typeof fetch, read: ReadImage) {
  return createViduAsyncImageTransport(transport, read, async (url, signal, consume) =>
    consume(await transport(url, { method: 'GET', redirect: 'error', signal })),
  );
}

function queryCommand() {
  return {
    version: 1 as const,
    type: 'image.query' as const,
    messageId: randomUUID(),
    commandId: randomUUID(),
    jobId: randomUUID(),
    ownerId: 'owner',
    expiresAt: Date.now() + 60_000,
    profile: 'gpt-images-v1' as const,
    operation: 'generate' as const,
    input: { ...input, async: true },
    upstreamTaskId: 'task-1',
    queryAttempt: 1,
    credential: {
      version: 1 as const,
      keyId: 'key',
      wrappedKey: 'wrapped',
      nonce: 'nonce',
      ciphertext: 'ciphertext',
      tag: 'tag',
    },
  };
}

describe('GPT image protocol', () => {
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
    const protocol = createImageProtocol(
      'vidu-image-v1',
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
    const protocol = createImageProtocol(
      'gpt-images-v1',
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
    const input = { model: 'fixture-vidu-alt', prompt: 'model fixture', async: true };
    const protocol = createImageProtocol(
      'vidu-image-v1',
      'generate',
      transport,
      read,
      asyncTransport,
    );
    await expect(protocol.submit(input, key)).resolves.toEqual({
      state: 'rejected',
      code: 'IMAGE_INPUT_INVALID',
    });
    expect(transport).not.toHaveBeenCalled();
    await expect(protocol.submitAsync(input, key)).resolves.toMatchObject({
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
      key: 'mio/raw/00000000-0000-4000-8000-000000000002',
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
      key: 'mio/raw/00000000-0000-4000-8000-000000000002',
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
    const protocol = createViduAsyncImageTransport(
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

  it('keeps query credential failures parseable and rejects inconsistent query envelopes', () => {
    const query = queryCommand();
    expect(parseImageQuery(query)).toEqual(query);
    expect(parseImageQuery({ ...query, queryCredential: query.credential })).toEqual({
      ...query,
      queryCredential: query.credential,
    });
    expect(
      parseImageResult({
        version: 1,
        type: 'image.result',
        messageId: randomUUID(),
        commandId: query.commandId,
        jobId: query.jobId,
        state: 'failed',
        outputs: [],
        errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE',
        upstreamTaskId: query.upstreamTaskId,
        queryAttempt: query.queryAttempt,
      }),
    ).toMatchObject({ state: 'failed', errorCode: 'IMAGE_CREDENTIAL_UNAVAILABLE' });
    expect(() =>
      parseImageQuery({
        ...query,
        operation: 'edit',
      }),
    ).toThrow('IMAGE_MESSAGE_INVALID');
    expect(() =>
      parseImageQuery({
        ...query,
        credential: { ...query.credential, keyId: 'x'.repeat(8193) },
      }),
    ).toThrow('IMAGE_MESSAGE_INVALID');
    expect(() =>
      parseImageQuery({
        ...query,
        queryCredential: { ...query.credential, keyId: 'x'.repeat(8193) },
      }),
    ).toThrow('IMAGE_MESSAGE_INVALID');
  });

  it('dispatches only explicit implemented operations', () => {
    expect(() => createImageProtocol('guess-from-model', 'generate')).toThrow(
      'IMAGE_PROTOCOL_UNSUPPORTED',
    );
    expect(() => createImageProtocol('gpt-images-v1', 'edit')).not.toThrow();
    expect(() => createImageProtocol('gpt-images-v1', 'outpaint')).not.toThrow();
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
    const result = await createImageProtocol('gpt-images-v1', 'edit', transport, read).submit(
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
    const result = await createImageProtocol('gpt-images-v1', 'outpaint', transport, read).submit(
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
    expect(
      await createImageProtocol('gpt-images-v1', 'generate', transport).submit(input, key),
    ).toEqual({ state: 'returned', images: [{ base64: 'YWJj' }] });
    expect(transport).toHaveBeenCalledOnce();
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.onelinkai.cloud/v1/images/generations');
    expect(options?.redirect).toBe('error');
    expect(JSON.parse(options?.body as string)).toEqual(input);
    expect(options?.headers).toEqual({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    });
  });
  it('uses the explicit Seedream profile for one watermarked JPEG and retains only safe usage', async () => {
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
      await createImageProtocol('seedream-4-images-v1', 'generate', transport).submit(request, key),
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
  it('uses only the GPT usage fields documented for that profile', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ b64_json: 'YWJj' }],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, generated_images: 1 },
      }),
    );
    expect(
      await createImageProtocol('gpt-images-v1', 'generate', transport).submit(input, key),
    ).toEqual({
      state: 'returned',
      images: [{ base64: 'YWJj' }],
      observation: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('rejects unsupported Seedream parameters and unknown profiles without outbound requests', async () => {
    const transport = vi.fn<typeof fetch>();
    const protocol = createImageProtocol('seedream-4-images-v1', 'generate', transport);
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
    expect(() => createImageProtocol('seedream-unknown', 'generate', transport)).toThrow(
      'IMAGE_PROTOCOL_UNSUPPORTED',
    );
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
      await createImageProtocol('seedream-4-images-v1', 'generate', transport).submit(input, key),
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
      await createImageProtocol('seedream-4-images-v1', 'generate', transport).submit(input, key),
    ).toEqual({
      state: 'unknown',
      code: 'IMAGE_SUBMISSION_UNKNOWN',
      observation: { requestId: 'req-stream-1' },
    });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('rejects invalid or untrusted request fields before any supplier call', async () => {
    const transport = vi.fn<typeof fetch>();
    const protocol = createImageProtocol('gpt-images-v1', 'generate', transport);
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
      await createImageProtocol('gpt-images-v1', 'generate', transport).submit(input, key),
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
        await createImageProtocol('gpt-images-v1', 'generate', transport).submit(input, key),
      ).toEqual({ state: 'returned', images });
      expect(transport).toHaveBeenCalledOnce();
    },
  );
  it('keeps an over-count response unknown without resubmission', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: 'YWJj' }, { b64_json: 'YWJj' }] }));
    expect(
      await createImageProtocol('gpt-images-v1', 'generate', transport).submit(input, key),
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
    const protocol = createImageProtocol(
      'gpt-images-v1',
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
    const protocol = createImageProtocol(
      'gpt-images-v1',
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
      await createImageProtocol('gpt-images-v1', 'generate', transport).submit(input, key),
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
    const result = await createImageProtocol('gpt-images-v1', 'generate', transport).submit(
      input,
      key,
    );
    expect('code' in result && result.code).toBe(code);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('keeps IMAGE_PROFILE_RULES exhaustive across IMAGE_PROFILES and fails closed on unknown profiles', async () => {
    const ruleKeys = Object.keys(IMAGE_PROFILE_RULES).sort();
    expect(ruleKeys).toEqual([...IMAGE_PROFILES].sort());
    const expected: Record<ImageProfile, ImageProfileRule> = {
      'gpt-images-v1': {
        supportedOperations: ['generate', 'edit', 'outpaint'],
        requiresAsync: false,
        allowGenerateReferences: false,
        fixedOutputFormat: null,
      },
      'seedream-4-images-v1': {
        supportedOperations: ['generate'],
        requiresAsync: false,
        allowGenerateReferences: false,
        fixedOutputFormat: 'jpeg',
      },
      'vidu-image-v1': {
        supportedOperations: ['generate'],
        requiresAsync: true,
        allowGenerateReferences: true,
        fixedOutputFormat: null,
      },
    };
    expect(IMAGE_PROFILE_RULES).toEqual(expected);
    expect(validImageInput(input, 'unknown-profile-v1' as ImageProfile)).toBe(false);
    const transport = vi.fn<typeof fetch>();
    await expect(
      createImageProtocol('vidu-image-v1', 'generate', transport).submit(
        { model: 'image-vidu-q2', prompt: 'async only', async: true },
        key,
      ),
    ).resolves.toEqual({ state: 'rejected', code: 'IMAGE_INPUT_INVALID' });
    expect(transport).not.toHaveBeenCalled();
  });
});
