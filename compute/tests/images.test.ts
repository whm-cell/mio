import { describe, expect, it, vi } from 'vitest';
import { createImageProtocol } from '../src/images.ts';

const input = { model: 'gpt-image-2', prompt: 'a blue square' };
const key = 'private-test-credential';

describe('GPT image protocol', () => {
  it('dispatches only explicit implemented operations', () => {
    expect(() => createImageProtocol('guess-from-model', 'generate')).toThrow(
      'IMAGE_PROTOCOL_UNSUPPORTED',
    );
    expect(() => createImageProtocol('gpt-images-v1', 'edit')).toThrow(
      'IMAGE_PROTOCOL_UNSUPPORTED',
    );
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
  it('rejects invalid or untrusted request fields before any paid call', async () => {
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
  it('bounds advertised response size and retains unknown submission', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{}', { headers: { 'content-length': String(65 * 1024 * 1024) } }),
      );
    expect(
      await createImageProtocol('gpt-images-v1', 'generate', transport).submit(input, key),
    ).toEqual({ state: 'unknown', code: 'IMAGE_SUBMISSION_UNKNOWN' });
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
});
