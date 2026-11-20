import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { expect, it, vi } from 'vitest';
import type {
  ConversationImageReference,
  ConversationRun,
  ConversationVision,
} from '../../src/conversations/contracts.ts';
import { prepareVisionRequest, visionAttachmentStore } from '../../src/dsh/vision-request.ts';
import { DEFAULT_CHAT_IMAGE_BUDGET } from '../../src/providers/contracts.ts';

const ref = (id: string): ConversationImageReference => ({
  attachmentId: id,
  mediaType: 'image/png',
  bytes: 2,
  width: 1,
  height: 1,
});
const image = (id: string) => ({
  type: 'image' as const,
  attachment: { ...ref(id), attachmentId: AttachmentId(id) },
});
const user = (id: string) =>
  createUserMessage({
    content: [{ type: 'text', text: 'inspect' }, image(id)],
    source: { kind: 'user' },
  });
const tool = (id: string) =>
  createToolResultMessage({
    content: [image(id)],
    callId: ToolCallId('prior-tool'),
    isError: false,
  });
const request = (messages: GenerateOptions['messages']): GenerateOptions => ({
  provider: 'fixture',
  model: 'fixture',
  sessionId: 'fixture' as never,
  maxTokens: 100,
  messages,
  signal: new AbortController().signal,
});
const preview = vi.fn<ConversationVision['preview']>(async (_owner, attachment) => ({
  attachment,
  variantId: 'variant',
  data: Buffer.from('ab'),
  mediaType: 'image/png',
  bytes: 2,
  width: 1,
  height: 1,
  depth: 'uchar',
  space: 'srgb',
  hasAlpha: false,
  fingerprint: 'stable',
}));
const vision: ConversationVision = {
  prepareRequest: async (_owner, id) => ({ reference: ref(id), previewBytes: 2 }),
  prepare: async (_owner, id) => ref(id),
  preview,
  target: () => ({ width: 1, height: 1, maxBytes: 100 }),
  assetId: (value) => value.attachmentId,
  acquireRequest: async () => () => {},
};
const run = (old: number) => ({ userId: 'owner', offloadableImages: () => old }) as ConversationRun;

it('counts repeated occurrences and actual base64 bytes while decoding each distinct image once', async () => {
  preview.mockClear();
  const options = request([tool('same'), user('same')]);
  const expected = new Map();
  const budget = { ...DEFAULT_CHAT_IMAGE_BUDGET, maxRequestImages: 2, maxRequestImageBytes: 7 };
  await expect(
    prepareVisionRequest(options, run(1), vision, budget, expected),
  ).rejects.toMatchObject({
    code: 'IMAGE_OFFLOAD_REQUIRED',
    failure: { offloadImages: 1 },
  });
  expect(preview).toHaveBeenCalledTimes(1);
  await expect(
    prepareVisionRequest(options, run(0), vision, budget, expected),
  ).rejects.toMatchObject({ code: 'IMAGE_INPUT_INVALID' });
  expect(options.messages[0]!.content[0]).toMatchObject({ type: 'image' });
});

it.each([1, 2, 3, 4])('uses the exact base64 boundary for %s source bytes', async (bytes) => {
  const options = request([user(`size-${bytes}`)]);
  const encoded = Math.ceil(bytes / 3) * 4;
  const makePreview: ConversationVision['preview'] = async (_owner, attachment) => ({
    attachment,
    variantId: 'variant',
    data: Buffer.alloc(bytes),
    mediaType: 'image/png',
    bytes,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
    fingerprint: `size-${bytes}`,
  });
  preview.mockImplementationOnce(makePreview);
  await expect(
    prepareVisionRequest(
      options,
      run(1),
      vision,
      {
        ...DEFAULT_CHAT_IMAGE_BUDGET,
        maxRequestImageBytes: encoded,
      },
      new Map(),
    ),
  ).resolves.toBeDefined();
  preview.mockImplementationOnce(makePreview);
  await expect(
    prepareVisionRequest(
      options,
      run(1),
      vision,
      {
        ...DEFAULT_CHAT_IMAGE_BUDGET,
        maxRequestImageBytes: encoded - 1,
      },
      new Map(),
    ),
  ).rejects.toMatchObject({ code: 'IMAGE_OFFLOAD_REQUIRED', failure: { offloadImages: 1 } });
});

it('prechecks occurrence count before reading and never offloads current tool images', async () => {
  preview.mockClear();
  const options = request([tool('old'), user('new')]);
  const budget = { ...DEFAULT_CHAT_IMAGE_BUDGET, maxRequestImages: 1 };
  await expect(
    prepareVisionRequest(options, run(1), vision, budget, new Map()),
  ).rejects.toMatchObject({
    code: 'IMAGE_OFFLOAD_REQUIRED',
    failure: { offloadImages: 1 },
  });
  expect(preview).not.toHaveBeenCalled();
  await expect(
    prepareVisionRequest(
      request([tool('current-a'), tool('current-b')]),
      run(0),
      vision,
      budget,
      new Map(),
    ),
  ).rejects.toMatchObject({ code: 'IMAGE_INPUT_INVALID' });
  expect(preview).not.toHaveBeenCalled();
});

it('rejects changed preview fingerprints on the actual attachment reread', async () => {
  preview.mockClear();
  const options = request([user('stable')]);
  const expected = new Map();
  await prepareVisionRequest(options, run(0), vision, DEFAULT_CHAT_IMAGE_BUDGET, expected);
  preview.mockImplementationOnce(async (_owner, attachment) => ({
    attachment,
    variantId: 'variant',
    data: Buffer.from('cd'),
    mediaType: 'image/png',
    bytes: 2,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
    fingerprint: 'changed',
  }));
  const store = visionAttachmentStore(vision, 'owner', expected);
  await expect(
    store.readImageRequest(
      image('stable').attachment,
      { width: 1, height: 1, maxBytes: 100 },
      options.signal,
    ),
  ).rejects.toMatchObject({ code: 'IMAGE_SOURCE_CHANGED' });
});
