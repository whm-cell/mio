import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import * as imageOffload from '@deepseek-ai/dsh-compaction-image-offload';
import type {} from '@deepseek-ai/dsh-compaction-image-offload/projection';
import { afterEach, expect, it, vi } from 'vitest';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import { OneLinkAdapter } from '../../src/dsh/onelink.ts';
import { createConversationVision } from '../../src/dsh/vision.ts';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ConversationRun, ModelObservation } from '../../src/conversations/contracts.ts';
import { AssetError } from '../../src/assets/contracts.ts';
import { DEFAULT_CHAT_IMAGE_BUDGET } from '../../src/providers/contracts.ts';
import { kernelRuntime, ScriptedModel } from '../support/kernel-runtime.ts';
import { protocolResponse } from '../onelink/fixture.ts';

afterEach(() => vi.unstubAllGlobals());
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const snapshot = (anthropic: boolean) => ({
  providerConfigId: 'config',
  providerRevision: 1,
  credentialVersion: 1,
  modelKey: 'key',
  catalogVersion: 1,
  adaptationVersion: 1,
  operation: 'chat' as const,
  profile: anthropic ? ('anthropic-messages' as const) : ('openai-chat' as const),
  modelRef: 'ref',
  modelId: 'fixture-model',
  protocol: anthropic ? ('anthropic-messages' as const) : ('openai-chat' as const),
  capabilityVersion: 'fixture',
  apiKey: 'synthetic-key',
  inputModalities: ['text', 'image'] as ('text' | 'image')[],
  imageBudget: { ...DEFAULT_CHAT_IMAGE_BUDGET, maxRequestImages: 1 },
});

const engineConfig = { databaseURL: 'unused', byok: true };
function ownedImages(objects: ReadonlyMap<string, Buffer>, missing = 'not owned') {
  return createConversationVision(async (owner, assetId, expected, signal) => {
    signal.throwIfAborted();
    const data = objects.get(assetId);
    if (owner !== 'owner' || !data) throw new Error(missing);
    const etagDigest = digest(`etag:${assetId}`),
      sourceDigest = digest(data);
    if (expected && (expected.etagDigest !== etagDigest || expected.sourceDigest !== sourceDigest))
      throw new Error('changed');
    return { assetId, contentType: 'image/png', data, etagDigest, sourceDigest };
  });
}
function captureRequests(respond: (request: Request, count: number) => Response) {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push((await request.clone().json()) as Record<string, unknown>);
    return respond(request, requests.length);
  });
  return requests;
}
function inspectionResponse(calls: { id: string; assetId: string }[], id = 'tool') {
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  return new Response(
    [
      event({
        id,
        object: 'chat.completion.chunk',
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: calls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: {
                  name: 'inspect_image_asset',
                  arguments: JSON.stringify({ assetId: call.assetId }),
                },
              })),
            },
            finish_reason: null,
          },
        ],
      }),
      event({
        id,
        object: 'chat.completion.chunk',
        model: 'fixture',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
      'data: [DONE]\n\n',
    ].join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function conversationRun(
  dshSessionId: string,
  requestId: string,
  selected: ConversationRun['snapshot'],
  observe: ConversationRun['observe'] = async () => {},
): ConversationRun {
  return {
    userId: 'owner',
    conversationId: 'conversation',
    dshSessionId,
    requestId,
    snapshot: selected,
    observe,
  };
}
async function closeVisionEngine(
  engine: ReturnType<typeof createDshConversationEngine>,
  ctx: Awaited<ReturnType<typeof kernelRuntime>>,
  root: string,
) {
  await engine.close();
  await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}

it.each([false, true])(
  'sends owned image, offloads only old image, and replays JSONL (Messages=%s)',
  async (anthropic) => {
    const root = await mkdtemp(join(tmpdir(), 'mio-vision-engine-'));
    const ctx = await kernelRuntime(root, new ScriptedModel([]));
    await ctx.plugin(imageOffload);
    const assetA = randomUUID(),
      assetB = randomUUID();
    const pngA = await sharp({
      create: { width: 4, height: 3, channels: 4, background: '#ff000080' },
    })
      .png()
      .toBuffer();
    const pngB = await sharp({
      create: { width: 4, height: 3, channels: 4, background: '#00ff0080' },
    })
      .png()
      .toBuffer();
    const objects = new Map<string, Buffer>([
      [assetA, pngA],
      [assetB, pngB],
    ]);
    const vision = ownedImages(objects, 'not found');
    const requests = captureRequests((request, count) => {
      return protocolResponse(request, `reply ${count}`);
    });
    const engine = createDshConversationEngine(ctx, engineConfig, undefined, vision);
    const observations: ModelObservation[] = [];
    const selected = snapshot(anthropic);
    const bind = (requestId: string): ConversationRun =>
      conversationRun('vision-session', requestId, selected, async (value) => {
        observations.push(value);
      });
    try {
      const refA = await vision.prepare('owner', assetA, new AbortController().signal);
      const refB = await vision.prepare('owner', assetB, new AbortController().signal);
      await engine.create('vision-session', selected);
      expect(
        await engine.run(
          'vision-session',
          'first',
          'first picture',
          async () => {},
          () => {},
          bind('first'),
          [refA],
        ),
      ).toBe('completed');
      expect(
        await engine.run(
          'vision-session',
          'second',
          'second picture',
          async () => {},
          () => {},
          bind('second'),
          [refB],
        ),
      ).toBe('completed');
      expect(await engine.retainedAssetIds?.('vision-session')).toEqual([assetB]);
      expect(requests).toHaveLength(2);
      expect(observations).toHaveLength(2);
      const wire = JSON.stringify(requests[1]);
      expect(wire).toContain(assetA);
      expect(wire).toContain('inspect_image_asset');
      expect(wire).toContain(pngB.toString('base64'));
      expect(wire).not.toContain(pngA.toString('base64'));
      if (anthropic) {
        expect(wire).toContain('"type":"base64"');
        expect(wire).toContain('"media_type":"image/png"');
      } else expect(wire).toContain('data:image/png;base64,');
      const history = await engine.history('vision-session', -1, 100);
      expect(history.items.filter((item) => item.role === 'user')).toEqual([
        expect.objectContaining({ text: 'first picture', imageAssetIds: [assetA] }),
        expect.objectContaining({ text: 'second picture', imageAssetIds: [assetB] }),
      ]);
      const raw = await ctx.mioKernel.history('vision-session');
      expect(raw.events.filter((event) => event.type === 'image/offload')).toHaveLength(1);
      expect(JSON.stringify(raw)).not.toContain(pngA.toString('base64'));
      expect(JSON.stringify(raw)).not.toContain(pngB.toString('base64'));
      expect(JSON.stringify(raw)).not.toContain('synthetic-key');
    } finally {
      await closeVisionEngine(engine, ctx, root);
    }
  },
  30000,
);

it('keeps four image IDs in order in real history and omits them for text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-vision-history-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  await ctx.plugin(imageOffload);
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
  const images = await Promise.all(
    colors.map((background) =>
      sharp({ create: { width: 3, height: 2, channels: 3, background } })
        .png()
        .toBuffer(),
    ),
  );
  const objects = new Map<string, Buffer>(ids.map((id, index) => [id, images[index]!]));
  const vision = ownedImages(objects);
  const requests = captureRequests((request) => {
    return protocolResponse(request, 'reply');
  });
  const engine = createDshConversationEngine(ctx, engineConfig, undefined, vision);
  const selected = {
    ...snapshot(false),
    imageBudget: { ...DEFAULT_CHAT_IMAGE_BUDGET, maxRequestImages: 4 },
  };
  const bind = (requestId: string): ConversationRun =>
    conversationRun('ordered-history', requestId, selected);
  try {
    const signal = new AbortController().signal;
    const refs = await Promise.all(ids.map((id) => vision.prepare('owner', id, signal)));
    const previews = await Promise.all(
      refs.map((ref) =>
        vision.preview(
          'owner',
          ref,
          vision.target(ref, {
            maxPixels: selected.imageBudget.requestImagePixelBudget,
            maxBytes: selected.imageBudget.requestImageMaxBytes,
          }),
          signal,
        ),
      ),
    );
    await engine.create('ordered-history', selected);
    expect(
      await engine.run(
        'ordered-history',
        'text',
        'plain text',
        async () => {},
        () => {},
        bind('text'),
      ),
    ).toBe('completed');
    expect(
      await engine.run(
        'ordered-history',
        'images',
        'four pictures',
        async () => {},
        () => {},
        bind('images'),
        refs,
      ),
    ).toBe('completed');
    expect(requests).toHaveLength(2);
    const messages = requests[1]!.messages as {
      role: string;
      content: { type: string; image_url?: { url: string } }[];
    }[];
    const user = messages.filter((message) => message.role === 'user').at(-1)!;
    expect(
      user.content
        .filter((block) => block.type === 'image_url')
        .map((block) => block.image_url?.url),
    ).toEqual(
      previews.map(
        (preview) =>
          `data:${preview.mediaType};base64,${Buffer.from(preview.data).toString('base64')}`,
      ),
    );
    const history = await engine.history('ordered-history', -1, 100);
    const users = history.items.filter((item) => item.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ text: 'plain text' });
    expect(users[0]).not.toHaveProperty('imageAssetIds');
    expect(users[1]).toMatchObject({ text: 'four pictures', imageAssetIds: ids });
  } finally {
    await closeVisionEngine(engine, ctx, root);
  }
}, 30000);

it.each(['jpeg', 'webp'] as const)(
  'previews and sends an owned %s image through the actual loop',
  async (format) => {
    const root = await mkdtemp(join(tmpdir(), 'mio-vision-format-'));
    const ctx = await kernelRuntime(root, new ScriptedModel([]));
    await ctx.plugin(imageOffload);
    const assetId = randomUUID();
    const data = await sharp({
      create: { width: 5, height: 3, channels: 3, background: '#557799' },
    })
      [format]()
      .toBuffer();
    const mediaType = `image/${format}` as const;
    const vision = createConversationVision(async (owner, id, expected, signal) => {
      signal.throwIfAborted();
      if (owner !== 'owner' || id !== assetId) throw new Error('not owned');
      const etagDigest = digest('etag'),
        sourceDigest = digest(data);
      if (
        expected &&
        (expected.etagDigest !== etagDigest || expected.sourceDigest !== sourceDigest)
      )
        throw new Error('changed');
      return { assetId, contentType: mediaType, data, etagDigest, sourceDigest };
    });
    const requests = captureRequests((request) => {
      return protocolResponse(request, 'reply');
    });
    const engine = createDshConversationEngine(ctx, engineConfig, undefined, vision);
    const selected = snapshot(false);
    const run: ConversationRun = conversationRun('format', 'format', selected);
    try {
      const ref = await vision.prepare('owner', assetId, new AbortController().signal);
      const target = vision.target(ref, {
        maxPixels: selected.imageBudget.requestImagePixelBudget,
        maxBytes: selected.imageBudget.requestImageMaxBytes,
      });
      const preview = await vision.preview('owner', ref, target, new AbortController().signal);
      const actual = await sharp(preview.data).metadata();
      expect(actual).toMatchObject({ width: preview.width, height: preview.height });
      await engine.create('format', selected);
      expect(
        await engine.run(
          'format',
          'format',
          'describe',
          async () => {},
          () => {},
          run,
          [ref],
        ),
      ).toBe('completed');
      expect(JSON.stringify(requests[0]!.messages)).toContain(
        `data:${preview.mediaType};base64,${Buffer.from(preview.data).toString('base64')}`,
      );
    } finally {
      await closeVisionEngine(engine, ctx, root);
    }
  },
  30000,
);

it('reopens an offloaded session and re-inspects its old asset after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-vision-reinspect-'));
  let ctx = await kernelRuntime(root, new ScriptedModel([]));
  await ctx.plugin(imageOffload);
  const oldId = randomUUID(),
    recentId = randomUUID();
  const old = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();
  const recent = await sharp({
    create: { width: 3, height: 2, channels: 3, background: '#00ff00' },
  })
    .png()
    .toBuffer();
  const objects = new Map<string, Buffer>([
    [oldId, old],
    [recentId, recent],
  ]);
  const vision = ownedImages(objects);
  const requests = captureRequests((request, count) => {
    if (count !== 3) return protocolResponse(request, 'done');
    return inspectionResponse([{ id: 'reinspect', assetId: oldId }]);
  });
  const selected = snapshot(false);
  const bind = (requestId: string): ConversationRun =>
    conversationRun('reinspect', requestId, selected);
  let engine = createDshConversationEngine(ctx, engineConfig, undefined, vision);
  try {
    const first = await vision.prepare('owner', oldId, new AbortController().signal);
    const second = await vision.prepare('owner', recentId, new AbortController().signal);
    await engine.create('reinspect', selected);
    expect(
      await engine.run(
        'reinspect',
        'one',
        'old',
        async () => {},
        () => {},
        bind('one'),
        [first],
      ),
    ).toBe('completed');
    expect(
      await engine.run(
        'reinspect',
        'two',
        'recent',
        async () => {},
        () => {},
        bind('two'),
        [second],
      ),
    ).toBe('completed');
    await engine.close();
    await ctx.fiber.dispose();
    ctx = await kernelRuntime(root, new ScriptedModel([]));
    await ctx.plugin(imageOffload);
    engine = createDshConversationEngine(ctx, engineConfig, undefined, vision);
    expect(
      await engine.run(
        'reinspect',
        'three',
        'reinspect old',
        async () => {},
        () => {},
        bind('three'),
      ),
    ).toBe('completed');
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[3]!.messages)).toContain(old.toString('base64'));
    expect(JSON.stringify(requests[3]!.messages)).not.toContain(recent.toString('base64'));
    const raw = await ctx.mioKernel.history('reinspect');
    expect(raw.events.filter((event) => event.type === 'image/offload')).toHaveLength(2);
    expect(JSON.stringify(raw)).not.toContain(old.toString('base64'));
    expect(JSON.stringify(raw)).not.toContain(recent.toString('base64'));
  } finally {
    await closeVisionEngine(engine, ctx, root);
  }
}, 30000);

it.each([false, true])(
  'allows inspect_image_asset without the compute image bridge (Messages=%s)',
  async (anthropic) => {
    const root = await mkdtemp(join(tmpdir(), 'mio-vision-tool-'));
    const ctx = await kernelRuntime(root, new ScriptedModel([]));
    await ctx.plugin(imageOffload);
    const assetId = randomUUID();
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0088ee' } })
      .png()
      .toBuffer();
    const vision = createConversationVision(async (owner, id, expected, signal) => {
      signal.throwIfAborted();
      if (owner !== 'owner' || id !== assetId) throw new Error('not found');
      const etagDigest = digest('etag'),
        sourceDigest = digest(png);
      if (
        expected &&
        (expected.etagDigest !== etagDigest || expected.sourceDigest !== sourceDigest)
      )
        throw new Error('changed');
      return { assetId, contentType: 'image/png', data: png, etagDigest, sourceDigest };
    });
    const requests = captureRequests((request, count) => {
      if (count > 1) return protocolResponse(request, 'inspection complete');
      if (!anthropic) return inspectionResponse([{ id: 'inspect-call', assetId }], 'chatcmpl_tool');
      const body = [
        {
          type: 'message_start',
          message: {
            id: 'msg_tool',
            type: 'message',
            role: 'assistant',
            model: 'fixture',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'inspect-call',
            name: 'inspect_image_asset',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify({ assetId }) },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 4 },
        },
        { type: 'message_stop' },
      ]
        .map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
        .join('');
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const engine = createDshConversationEngine(ctx, engineConfig, undefined, vision);
    const selected = snapshot(anthropic);
    const observed: ModelObservation[] = [];
    const run: ConversationRun = conversationRun(
      'tool-session',
      'inspect',
      selected,
      async (value) => {
        observed.push(value);
      },
    );
    try {
      await engine.create('tool-session', selected);
      expect(
        await engine.run(
          'tool-session',
          'inspect',
          'inspect this asset',
          async () => {},
          () => {},
          run,
        ),
      ).toBe('completed');
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0]!.tools)).toContain('inspect_image_asset');
      expect(JSON.stringify(requests[1]!.messages)).toContain(png.toString('base64'));
      const sent = JSON.stringify(requests[1]!.messages);
      if (anthropic) {
        expect(sent).toContain('"type":"base64"');
        expect(sent).toContain('"media_type":"image/png"');
      } else expect(sent).toContain('data:image/png;base64,');
      const raw = await ctx.mioKernel.history('tool-session');
      expect(JSON.stringify(raw)).not.toContain(png.toString('base64'));
      expect(JSON.stringify(raw)).not.toContain('synthetic-key');
      expect(observed).toHaveLength(2);
    } finally {
      await closeVisionEngine(engine, ctx, root);
    }
  },
  30000,
);

it('fails closed without an upstream call when an existing image route becomes text-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-vision-revoked-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  await ctx.plugin(imageOffload);
  const assetId = randomUUID();
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0088ee' } })
    .png()
    .toBuffer();
  const vision = createConversationVision(async () => ({
    assetId,
    contentType: 'image/png',
    data: png,
    etagDigest: digest('etag'),
    sourceDigest: digest(png),
  }));
  const requests = captureRequests((request) => {
    return protocolResponse(request, 'reply');
  });
  const engine = createDshConversationEngine(ctx, engineConfig, undefined, vision);
  const selected = snapshot(false);
  const bind = (requestId: string, textOnly = false): ConversationRun =>
    conversationRun(
      'revoked',
      requestId,
      textOnly ? { ...selected, inputModalities: ['text'] } : selected,
    );
  try {
    const image = await vision.prepare('owner', assetId, new AbortController().signal);
    await engine.create('revoked', selected);
    expect(
      await engine.run(
        'revoked',
        'one',
        'image',
        async () => {},
        () => {},
        bind('one'),
        [image],
      ),
    ).toBe('completed');
    expect(
      await engine.run(
        'revoked',
        'two',
        'continue',
        async () => {},
        () => {},
        bind('two', true),
      ),
    ).toBe('failed');
    expect(requests).toHaveLength(1);
    const raw = await ctx.mioKernel.history('revoked');
    expect(raw.events.filter((event) => event.type === 'image/offload')).toHaveLength(0);
  } finally {
    await closeVisionEngine(engine, ctx, root);
  }
}, 30000);

it.each([1, 2])(
  'only offloads a previous tool image when %s current inspections fit',
  async (newCount) => {
    const root = await mkdtemp(join(tmpdir(), 'mio-vision-mixed-'));
    const ctx = await kernelRuntime(root, new ScriptedModel([]));
    await ctx.plugin(imageOffload);
    const oldId = randomUUID(),
      newId = randomUUID();
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcdee' } })
      .png()
      .toBuffer();
    const vision = ownedImages(
      new Map([
        [oldId, png],
        [newId, png],
      ]),
    );
    const toolResponse = (ids: string[]) =>
      inspectionResponse(ids.map((assetId, index) => ({ id: `call-${index}`, assetId })));
    const requests = captureRequests((request, count) => {
      if (count === 1) return toolResponse([oldId]);
      if (count === 3) return toolResponse(Array(newCount).fill(newId));
      return protocolResponse(request, 'inspection complete');
    });
    const engine = createDshConversationEngine(ctx, engineConfig, undefined, vision);
    const selected = snapshot(false);
    const observed: ModelObservation[] = [];
    const bind = (requestId: string): ConversationRun =>
      conversationRun('mixed', requestId, selected, async (value) => {
        observed.push(value);
      });
    try {
      await engine.create('mixed', selected);
      expect(
        await engine.run(
          'mixed',
          'old',
          'inspect old',
          async () => {},
          () => {},
          bind('old'),
        ),
      ).toBe('completed');
      const outcome = await engine.run(
        'mixed',
        'new',
        'inspect new',
        async () => {},
        () => {},
        bind('new'),
      );
      expect(outcome).toBe(newCount === 1 ? 'completed' : 'failed');
      expect(requests).toHaveLength(newCount === 1 ? 4 : 3);
      expect(observed).toHaveLength(requests.length);
      const raw = await ctx.mioKernel.history('mixed');
      expect(raw.events.filter((event) => event.type === 'image/offload')).toHaveLength(
        newCount === 1 ? 1 : 0,
      );
      if (newCount === 1) {
        expect(JSON.stringify(requests[3]!.messages)).toContain(oldId);
        expect(JSON.stringify(requests[3]!.messages)).toContain(png.toString('base64'));
      }
      expect(JSON.stringify(raw)).not.toContain(png.toString('base64'));
    } finally {
      await closeVisionEngine(engine, ctx, root);
    }
  },
  30000,
);

it('does not register inspection for text-only routes or without an asset bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-vision-no-grant-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  await ctx.plugin(imageOffload);
  const vision = createConversationVision(async () => {
    throw new Error('must not read');
  });
  const requests = captureRequests((request) => {
    return protocolResponse(request, 'reply');
  });
  const selected = snapshot(false);
  const text = { ...selected, inputModalities: ['text'] as ('text' | 'image')[] };
  const withVision = createDshConversationEngine(ctx, engineConfig, undefined, vision);
  const bind = (dshSessionId: string, value: typeof text): ConversationRun =>
    conversationRun(dshSessionId, 'one', value);
  try {
    await withVision.create('text', text);
    expect(
      await withVision.run(
        'text',
        'one',
        'hello',
        async () => {},
        () => {},
        bind('text', text),
      ),
    ).toBe('completed');
    expect(JSON.stringify(requests[0]!.tools ?? [])).not.toContain('inspect_image_asset');
    await withVision.close();
    const secondRoot = await mkdtemp(join(tmpdir(), 'mio-vision-no-bridge-'));
    const secondCtx = await kernelRuntime(secondRoot, new ScriptedModel([]));
    await secondCtx.plugin(imageOffload);
    const noVision = createDshConversationEngine(secondCtx, engineConfig);
    try {
      await noVision.create('no-bridge', selected);
      expect(
        await noVision.run(
          'no-bridge',
          'one',
          'hello',
          async () => {},
          () => {},
          bind('no-bridge', selected),
        ),
      ).toBe('completed');
      expect(JSON.stringify(requests[1]!.tools ?? [])).not.toContain('inspect_image_asset');
    } finally {
      await closeVisionEngine(noVision, secondCtx, secondRoot);
    }
  } finally {
    await closeVisionEngine(withVision, ctx, root);
  }
}, 30000);

it('enforces inspect ownership and the shared 12-call turn budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-vision-grant-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  await ctx.plugin(imageOffload);
  const own = randomUUID(),
    foreign = randomUUID();
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcdef' } })
    .png()
    .toBuffer();
  const vision = createConversationVision(async (owner, id, expected, signal) => {
    signal.throwIfAborted();
    if (owner !== 'owner' || id !== own) throw new AssetError(404, 'ASSET_NOT_FOUND');
    const etagDigest = digest('etag'),
      sourceDigest = digest(png);
    if (expected && (expected.etagDigest !== etagDigest || expected.sourceDigest !== sourceDigest))
      throw new Error('changed');
    return { assetId: id, contentType: 'image/png', data: png, etagDigest, sourceDigest };
  });
  const prepare = vi.spyOn(vision, 'prepare');
  const toolResponse = (ids: string[]) =>
    inspectionResponse(ids.map((assetId, index) => ({ id: `inspect-${index}`, assetId })));
  const requests = captureRequests((request, count) => {
    if (count === 1) return toolResponse([foreign]);
    if (count === 3) return toolResponse(Array(13).fill(own));
    return protocolResponse(request, 'done');
  });
  const engine = createDshConversationEngine(ctx, engineConfig, undefined, vision);
  const selected = {
    ...snapshot(false),
    imageBudget: { ...DEFAULT_CHAT_IMAGE_BUDGET, maxRequestImages: 16 },
  };
  const bind = (requestId: string): ConversationRun =>
    conversationRun('grant', requestId, selected);
  try {
    await engine.create('grant', selected);
    expect(
      await engine.run(
        'grant',
        'foreign',
        'inspect other',
        async () => {},
        () => {},
        bind('foreign'),
      ),
    ).toBe('completed');
    expect(JSON.stringify(requests[1]!.messages)).toContain('ASSET_NOT_FOUND');
    expect(JSON.stringify(requests[1]!.messages)).not.toContain(png.toString('base64'));
    prepare.mockClear();
    expect(
      await engine.run(
        'grant',
        'budget',
        'inspect many',
        async () => {},
        () => {},
        bind('budget'),
      ),
    ).toBe('completed');
    expect(prepare).toHaveBeenCalledTimes(12);
    expect(JSON.stringify(requests[3]!.messages)).toContain('MIO_TOOL_BUDGET_EXCEEDED');
    const raw = await ctx.mioKernel.history('grant');
    expect(JSON.stringify(raw)).not.toContain(png.toString('base64'));
  } finally {
    prepare.mockRestore();
    await closeVisionEngine(engine, ctx, root);
  }
}, 30000);

it('cancels an in-flight inspect read when the engine closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-vision-cancel-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  await ctx.plugin(imageOffload);
  const assetId = randomUUID();
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const vision = createConversationVision(async (_owner, _id, _expected, signal) => {
    entered.resolve();
    return await new Promise<never>((_resolve, reject) => {
      const cancel = () => {
        aborted.resolve();
        reject(signal.reason);
      };
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
  });
  const requests = captureRequests(() => {
    return inspectionResponse([{ id: 'inspect', assetId }]);
  });
  const engine = createDshConversationEngine(ctx, engineConfig, undefined, vision);
  const selected = snapshot(false);
  const observations: ModelObservation[] = [];
  const run: ConversationRun = conversationRun('cancel', 'cancel', selected, async (value) => {
    observations.push(value);
  });
  try {
    await engine.create('cancel', selected);
    const running = engine.run(
      'cancel',
      'cancel',
      'inspect',
      async () => {},
      () => {},
      run,
    );
    await entered.promise;
    await engine.close();
    await aborted.promise;
    expect(await running).toBe('unknown');
    expect(requests).toHaveLength(1);
    expect(observations).toHaveLength(1);
  } finally {
    await closeVisionEngine(engine, ctx, root);
  }
}, 30000);

it('does not persist a local finish as a supplier observation before transport starts', async () => {
  const finish = vi.spyOn(PiAiAdapter.prototype, 'prepareCall').mockImplementation(async () => ({
    model: {
      provider: 'onelink-openai',
      id: 'fixture-model',
      name: 'fixture-model',
      inputModalities: ['text'],
    },
    stream: async function* () {
      yield {
        type: 'finish' as const,
        reason: {
          kind: 'error' as const,
          failure: { code: 'LOCAL_FAILURE', message: 'local failure' },
        },
      };
    },
  }));
  const observed: ModelObservation[] = [];
  const controller = new AbortController();
  const selected = snapshot(false);
  const run: ConversationRun = conversationRun('local', 'local', selected, async (value) => {
    observed.push(value);
  });
  const transport = vi.fn();
  vi.stubGlobal('fetch', transport);
  const adapter = new OneLinkAdapter();
  const release = adapter.bind(controller.signal, run);
  try {
    const call = await adapter.prepareCall('onelink-openai', selected.modelId, controller.signal);
    const stream = call.stream({
      provider: 'onelink-openai',
      model: selected.modelId,
      maxTokens: 1024,
      sessionId: 'local' as never,
      signal: controller.signal,
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      ],
    });
    for await (const chunk of stream) void chunk;
    expect(transport).not.toHaveBeenCalled();
    expect(observed).toEqual([]);
  } finally {
    release();
    finish.mockRestore();
  }
});
