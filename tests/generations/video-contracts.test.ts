import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeVideoCreateRequest,
  videoRequestHash,
  VIDEO_MAX_PROMPT_CODEPOINTS,
} from '../../src/generations/video-contracts.ts';

const modelRef = `onelink:model:${randomUUID()}`;

function request(parameters: Record<string, unknown>) {
  return decodeVideoCreateRequest({
    requestId: randomUUID(),
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

    const first = request({ mode: 'full', prompt: 'hello', references: references.slice(0, 2) });
    const second = request({
      mode: 'full',
      prompt: 'hello',
      references: [...references.slice(0, 2)].reverse(),
    });
    expect(videoRequestHash(first)).not.toBe(videoRequestHash(second));
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
