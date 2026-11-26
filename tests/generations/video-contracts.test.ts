import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeVideoCreateRequest,
  videoRequestHash,
  VIDEO_MAX_PROMPT_CODEPOINTS,
} from '../../src/generations/video/contracts.ts';

const modelRef = `onelink:model:${randomUUID()}`;

function request(parameters: Record<string, unknown>, requestId = randomUUID()) {
  return decodeVideoCreateRequest({
    requestId,
    modelRef,
    expectedCapabilitiesVersion: 'cap-v1',
    parameters,
  });
}

describe('video request contract', () => {
  it('counts Unicode code points without expanding the prompt into an array', () => {
    const prompt = '😀'.repeat(VIDEO_MAX_PROMPT_CODEPOINTS);
    expect(request({ mode: 'text_to_video', prompt }).parameters.prompt).toBe(prompt);
    expect(() => request({ mode: 'text_to_video', prompt: `${prompt}😀` })).toThrowError(
      expect.objectContaining({ code: 'VIDEO_INPUT_INVALID' }),
    );
  });

  it('rejects unknown fields and mode-specific input residue', () => {
    expect(() =>
      decodeVideoCreateRequest({
        requestId: randomUUID(),
        modelRef,
        expectedCapabilitiesVersion: 'cap-v1',
        ownerId: randomUUID(),
        parameters: { mode: 'text_to_video', prompt: 'hello' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'VIDEO_INPUT_INVALID' }));

    expect(() =>
      request({
        mode: 'first_frame',
        prompt: 'hello',
        firstFrame: { assetId: randomUUID() },
        references: [{ assetId: randomUUID(), mediaType: 'image' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'VIDEO_INPUT_INVALID' }));
  });

  it('bounds total references across fields and retains input order in the request identity', () => {
    const references = Array.from({ length: 16 }, () => ({
      assetId: randomUUID(),
      mediaType: 'image',
      role: 'reference',
    }));
    const accepted = request({ mode: 'full', prompt: 'hello', references });
    expect(accepted.parameters.references).toHaveLength(16);
    expect(() =>
      request({
        mode: 'full',
        prompt: 'hello',
        references: [...references, { assetId: randomUUID(), mediaType: 'image' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'VIDEO_INPUT_INVALID' }));

    const requestId = randomUUID();
    const parameters = { mode: 'full', prompt: 'hello', references: references.slice(0, 2) };
    const first = request(parameters, requestId);
    const sameOrder = request(structuredClone(parameters), requestId);
    const reversed = request(
      { ...parameters, references: parameters.references.toReversed() },
      requestId,
    );
    const hash = videoRequestHash(first);
    expect(videoRequestHash(sameOrder)).toBe(hash);
    expect(videoRequestHash(reversed)).not.toBe(hash);
  });

  it.each([
    [undefined, 'd07ca2e2c1ddf66382a1d50dd695b1f2bb9189e3850906494383b00789a116f4'],
    [true, '249348d3bcb5ab084258204f84e224cf76cf81f557d74b84692d79b49f112183'],
    [false, 'a04b1a370cbf1ddb4da095bc4bd217840b4450175628baf69050ea7e130d7bdd'],
  ])('keeps persisted request hash bytes for generateAudio=%s', (generateAudio, hash) => {
    const decoded = decodeVideoCreateRequest({
      parameters: {
        prompt: 'Sail past the reeds.',
        ...(generateAudio !== undefined ? { generateAudio } : {}),
        durationSeconds: 8,
        ratio: '16:9',
        mode: 'text_to_video',
      },
      expectedCapabilitiesVersion: 'cap-v1',
      modelRef: 'onelink:model:00000000-0000-4000-8000-000000000036',
      requestId: '00000000-0000-4000-8000-000000000032',
    });
    expect(videoRequestHash(decoded)).toBe(hash);
  });

  it('requires an explicitly typed video reference for video reference modes', () => {
    expect(() =>
      request({
        mode: 'video_edit',
        prompt: 'edit this',
        references: [{ assetId: randomUUID(), mediaType: 'image' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'VIDEO_INPUT_INVALID' }));
    expect(
      request({
        mode: 'video_edit',
        prompt: 'edit this',
        references: [{ assetId: randomUUID(), mediaType: 'video' }],
      }).parameters.mode,
    ).toBe('video_edit');
  });
});
