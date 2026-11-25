import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import * as imageOffload from '@deepseek-ai/dsh-compaction-image-offload';
import { SessionId } from '@deepseek-ai/dsh-session';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ConversationEngine,
  ConversationImageReference,
  ConversationRun,
  ConversationTurnContext,
  ConversationVision,
} from '../../src/conversations/contracts.ts';
import { createDshConversationEngine } from '../../src/dsh/conversations.ts';
import * as mixedPersistence from '../../src/dsh/mixed-session-persistence.ts';
import { OBSERVATION_UNAVAILABLE } from '../../src/dsh/onelink.ts';
import { createConversationVision } from '../../src/dsh/vision.ts';
import type { ChatProfile, ChatRuntimeSnapshot } from '../../src/providers/contracts.ts';
import { kernelRuntime, modelOptions, ScriptedModel } from '../support/kernel-runtime.ts';
import { protocolResponse } from './fixture.ts';

const cleanups: (() => Promise<void>)[] = [];
const wireRequests: { path: string; body: { model: string; messages: unknown[] } }[] = [];
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const sourceId = 'fork-source';
const targetId = 'fork-target';
const ownerId = 'fixture-owner';
const invalid = { code: 'CONVERSATION_FORK_BOUNDARY_INVALID', status: 409 };

afterEach(async () => {
  try {
    vi.restoreAllMocks();
    for (const close of cleanups.splice(0).reverse()) await close();
  } finally {
    wireRequests.splice(0);
    vi.unstubAllGlobals();
  }
});

function fixtureModel(
  modelId: string,
  protocol: ChatProfile,
  inputModalities: ChatRuntimeSnapshot['inputModalities'] = ['text'],
): ChatRuntimeSnapshot {
  return {
    providerConfigId: 'fixture-provider',
    providerRevision: 1,
    credentialVersion: 1,
    modelKey: modelId,
    catalogVersion: 1,
    adaptationVersion: 1,
    operation: 'chat',
    profile: protocol,
    modelRef: `onelink:chat:${modelId}`,
    modelId,
    protocol,
    capabilityVersion: 'fixture-v1',
    apiKey: 'synthetic-fixture-only',
    inputModalities,
  };
}

const modelA = fixtureModel('model-a', 'openai-chat');
const modelB = fixtureModel('model-b', 'anthropic-messages');

async function fixture(vision?: ConversationVision) {
  const scratch = await mkdtemp(join(tmpdir(), 'mio-m6-fork-'));
  const legacyRoot = join(scratch, 'sessions');
  const compressedRoot = join(scratch, 'sessions-zstd');
  cleanups.push(() => rm(scratch, { recursive: true, force: true }));
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe('https://api.onelinkai.cloud');
    const body = (await request.clone().json()) as (typeof wireRequests)[number]['body'];
    wireRequests.push({ path: url.pathname, body });
    if (JSON.stringify(body.messages.at(-1)).includes('fixture force upstream error'))
      return Response.json({ error: { message: 'fixture provider failed' } }, { status: 503 });
    return protocolResponse(request, `public answer ${wireRequests.length}`);
  });

  return async (legacy = false) => {
    const ctx = await kernelRuntime(
      legacyRoot,
      new ScriptedModel([]),
      legacy ? undefined : (ctx) => ctx.plugin(mixedPersistence, { legacyRoot, compressedRoot }),
    );
    cleanups.push(() => ctx.fiber.dispose());
    if (vision) await ctx.plugin(imageOffload);
    const engine = createDshConversationEngine(
      ctx,
      { databaseURL: 'unused', byok: true },
      undefined,
      vision,
    );
    cleanups.push(() => engine.close());
    return {
      ctx,
      engine,
      async close() {
        await engine.close();
        await ctx.fiber.dispose();
      },
    };
  };
}

function send(
  engine: ConversationEngine,
  id: string,
  snapshot: ChatRuntimeSnapshot,
  text: string,
  options: {
    images?: ConversationImageReference[];
    turnContext?: ConversationTurnContext;
    observe?: ConversationRun['observe'];
  } = {},
) {
  return engine.run(
    id,
    text,
    text,
    async () => {},
    () => {},
    {
      userId: ownerId,
      conversationId: id,
      dshSessionId: id,
      requestId: text,
      snapshot,
      observe: options.observe ?? (async () => {}),
    },
    options.images,
    undefined,
    undefined,
    options.turnContext,
  );
}

async function artifact(ctx: Context, id: string) {
  const result = await ctx.sessionPersistence.stat(SessionId(id));
  if (!result?.location) throw new Error(`Missing persisted fixture ${id}`);
  return result.location.path;
}

it('forks an old plaintext log into Zstandard, cold continues under B, and refreshes private project access', async () => {
  const open = await fixture();
  const legacy = await open(true);
  const inheritedContext = {
    purpose: 'drama-script',
    projectContext: '{"summary":"PRIVATE_REVOKED"}',
  } as const;
  await legacy.engine.create(sourceId, modelA);
  expect(
    await send(legacy.engine, sourceId, modelA, 'first story scene', {
      turnContext: inheritedContext,
    }),
  ).toBe('completed');
  expect(JSON.stringify(wireRequests[0]!.body.messages)).toContain('PRIVATE_REVOKED');
  expect(
    await send(legacy.engine, sourceId, modelA, 'second story scene', {
      turnContext: inheritedContext,
    }),
  ).toBe('completed');
  const cutoff = await legacy.engine.resolveForkBoundary!(sourceId);
  expect(
    await send(legacy.engine, sourceId, modelB, 'source third secret scene', {
      turnContext: inheritedContext,
    }),
  ).toBe('completed');
  const original = await legacy.ctx.mioKernel.readPersistedHistory(sourceId);
  const expectedSeed = original.events.slice(0, cutoff + 1);
  const legacyPath = await artifact(legacy.ctx, sourceId);
  expect(legacyPath.endsWith('.jsonl')).toBe(true);
  const originalBytes = await readFile(legacyPath);
  await legacy.close();

  const mixed = await open();
  expect(await mixed.engine.resolveForkBoundary!(sourceId, cutoff)).toBe(cutoff);
  await mixed.engine.fork!(sourceId, targetId, cutoff, modelB);
  expect(wireRequests).toHaveLength(3);
  const targetPath = await artifact(mixed.ctx, targetId);
  expect(targetPath.endsWith('.jsonl.zstd')).toBe(true);
  const seedBytes = await readFile(targetPath);
  expect(seedBytes.subarray(0, 4).toString('hex')).toBe('28b52ffd');
  const target = await mixed.ctx.mioKernel.readPersistedHistory(targetId);
  expect(target.header).toMatchObject({ isSeeded: true, parentSession: sourceId });
  expect(target.inheritedEventCount).toBe(cutoff + 1);
  expect(target.events.slice(0, cutoff + 1)).toEqual(expectedSeed);
  expect(target.events.at(-1)).toMatchObject({
    seq: cutoff + 1,
    type: 'session/end-seed',
    data: { inherited: true },
  });
  expect(
    target.events
      .filter((event) => event.type === 'model/selection')
      .map((event) => event.data.model),
  ).toEqual([modelA.modelId]);
  await mixed.close();

  const cold = await open();
  expect(cold.ctx.agents.list()).toEqual([]);
  const history = await cold.engine.history(targetId, -1, 100);
  expect(history.items.flatMap((item) => (item.role === 'user' ? [item.text] : []))).toEqual([
    'first story scene',
    'second story scene',
  ]);
  expect(JSON.stringify(history)).not.toContain('PRIVATE_REVOKED');
  expect(await readFile(targetPath)).toEqual(seedBytes);
  const freshlyAuthorized = {
    purpose: 'drama-script',
    projectContext: '{"summary":"PRIVATE_FRESH"}',
  } as const;
  expect(
    await send(cold.engine, targetId, modelB, 'child third story scene', {
      turnContext: { purpose: 'drama-script' },
    }),
  ).toBe('completed');
  expect(wireRequests).toHaveLength(4);
  const child = wireRequests.at(-1)!;
  expect(child).toMatchObject({ path: '/v1/messages', body: { model: modelB.modelId } });
  const wire = JSON.stringify(child.body.messages);
  for (const retained of [
    'first story scene',
    'public answer 1',
    'second story scene',
    'public answer 2',
    'child third story scene',
    '先前的项目上下文快照已失效。',
  ])
    expect(wire).toContain(retained);
  for (const excluded of ['source third secret scene', 'public answer 3', 'PRIVATE_REVOKED'])
    expect(wire).not.toContain(excluded);
  expect(
    await send(cold.engine, targetId, modelB, 'child freshly authorized', {
      turnContext: freshlyAuthorized,
    }),
  ).toBe('completed');
  expect(JSON.stringify(wireRequests.at(-1)!.body.messages)).toContain('PRIVATE_FRESH');
  expect(JSON.stringify(wireRequests.at(-1)!.body.messages)).not.toContain('PRIVATE_REVOKED');
  const childRaw = await cold.ctx.mioKernel.readPersistedHistory(targetId);
  expect(
    childRaw.events
      .filter((event) => event.type === 'model/selection')
      .map((event) => event.data.model),
  ).toEqual([modelA.modelId, modelB.modelId]);
  const childCutoff = await cold.engine.resolveForkBoundary!(targetId);
  const grandchildId = 'fork-grandchild';
  await cold.engine.fork!(targetId, grandchildId, childCutoff, modelB);
  const grandchild = await cold.ctx.mioKernel.readPersistedHistory(grandchildId);
  expect(grandchild.header).toMatchObject({ isSeeded: true, parentSession: targetId });
  expect(grandchild.inheritedEventCount).toBe(childCutoff + 1);
  expect(grandchild.events.slice(0, childCutoff + 1)).toEqual(
    childRaw.events.slice(0, childCutoff + 1),
  );
  expect(
    grandchild.events
      .filter((event) => event.type === 'session/end-seed' && event.data.inherited)
      .map((event) => event.seq),
  ).toEqual([cutoff + 1, childCutoff + 1]);
  expect(await cold.engine.history(grandchildId, -1, 100)).toEqual(
    await cold.engine.history(targetId, -1, 100),
  );
  expect(wireRequests).toHaveLength(5);
  expect(await readFile(legacyPath)).toEqual(originalBytes);
});

it('retries the fixed target after a pre-write or post-write failure and rejects mismatched prefixes', async () => {
  const open = await fixture();
  const { ctx, engine } = await open();
  await engine.create(sourceId, modelA);
  expect(await send(engine, sourceId, modelA, 'settled native input')).toBe('completed');
  const cutoff = await engine.resolveForkBoundary!(sourceId);

  vi.spyOn(ctx.agents, 'create').mockRejectedValueOnce(
    new Error('fixture native creation refused'),
  );
  await expect(engine.fork!(sourceId, targetId, cutoff, modelA)).rejects.toThrow(
    'fixture native creation refused',
  );
  expect(await ctx.sessionPersistence.stat(SessionId(targetId))).toBeUndefined();
  vi.restoreAllMocks();

  const flush = vi
    .spyOn(ctx.mioKernel, 'flush')
    .mockRejectedValueOnce(new Error('fixture lost flush acknowledgement'));
  await expect(engine.fork!(sourceId, targetId, cutoff, modelA)).rejects.toThrow(
    'fixture lost flush acknowledgement',
  );
  const path = await artifact(ctx, targetId);
  const before = await readFile(path);
  const target = await ctx.mioKernel.readPersistedHistory(targetId);
  expect(target.inheritedEventCount).toBe(cutoff + 1);
  expect(target.events.at(-1)).toMatchObject({
    type: 'session/end-seed',
    data: { inherited: true },
  });
  const reopen = vi.spyOn(ctx.agents, 'resume');
  await engine.fork!(sourceId, targetId, cutoff, modelA);
  expect(flush).toHaveBeenCalledOnce();
  expect(reopen).not.toHaveBeenCalled();
  expect(await readFile(path)).toEqual(before);
  expect(wireRequests).toHaveLength(1);

  const dirty = await ctx.mioKernel.resume(targetId, {});
  try {
    dirty.agent.session.append('turn/start', { turn: 2 });
    await ctx.mioKernel.flush(dirty.agent.session);
  } finally {
    await dirty.dispose();
  }
  const beforeRepair = await readFile(path);
  const recovered = await ctx.mioKernel.resume(targetId, {});
  await recovered.dispose();
  const afterRepair = await readFile(path);
  expect(afterRepair).not.toEqual(beforeRepair);
  const repaired = await ctx.mioKernel.readPersistedHistory(targetId);
  expect(repaired.inheritedEventCount).toBe(cutoff + 1);
  expect(repaired.events.slice(-2)).toMatchObject([
    { type: 'turn/end', data: { reason: { kind: 'interrupted' } } },
    { type: 'session/end-seed', data: {} },
  ]);
  reopen.mockClear();
  await engine.fork!(sourceId, targetId, cutoff, modelA);
  expect(reopen).not.toHaveBeenCalled();
  expect(await readFile(path)).toEqual(afterRepair);
  expect(wireRequests).toHaveLength(1);

  const wrongSeed = target.events.slice(0, cutoff + 1).map((event) =>
    event.type === 'user/message' && event.data.source.kind === 'user'
      ? {
          ...event,
          data: {
            ...event.data,
            content: [{ type: 'text' as const, text: 'different visible input' }],
          },
        }
      : event,
  );
  const mismatched = 'foreign-target';
  await ctx.mioKernel.createFork(sourceId, mismatched, wrongSeed, modelOptions);
  const mismatchPath = await artifact(ctx, mismatched);
  const mismatchBefore = await readFile(mismatchPath);
  await expect(engine.fork!(sourceId, mismatched, cutoff, modelA)).rejects.toThrow(
    'MIO_FORK_TARGET_CONFLICT',
  );
  expect(await readFile(mismatchPath)).toEqual(mismatchBefore);
  expect(wireRequests).toHaveLength(1);
});

it('blocks retained images but sends only an offloaded-image placeholder to a text model', async () => {
  const assetId = randomUUID();
  const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#127556' } })
    .png()
    .toBuffer();
  const readSource = vi.fn(async (owner, requested, _expected, signal: AbortSignal) => {
    signal.throwIfAborted();
    expect(owner).toBe(ownerId);
    expect(requested).toBe(assetId);
    return {
      assetId,
      data: png,
      contentType: 'image/png' as const,
      etagDigest: digest(assetId),
      sourceDigest: digest(png),
    };
  });
  const vision = createConversationVision(readSource);
  const open = await fixture(vision);
  const { ctx, engine } = await open();
  const visual = fixtureModel('vision-a', 'openai-chat', ['text', 'image']);

  await engine.create(sourceId, visual);
  expect(await send(engine, sourceId, visual, 'before image')).toBe('completed');
  const beforeImage = await engine.resolveForkBoundary!(sourceId);
  const image = await vision.prepare(ownerId, assetId, AbortSignal.timeout(3000));
  expect(await send(engine, sourceId, visual, 'keep image context', { images: [image] })).toBe(
    'completed',
  );
  expect(JSON.stringify(wireRequests.at(-1)!.body.messages)).toContain('data:image/png;base64,');
  expect(await engine.hasRetainedImages!(sourceId)).toBe(true);
  await engine.fork!(sourceId, targetId, beforeImage, visual);
  expect(await engine.hasRetainedImages!(targetId)).toBe(false);
  expect(wireRequests).toHaveLength(2);

  readSource.mockClear();
  expect(await send(engine, sourceId, modelB, 'text-only route blocked')).toBe('failed');
  expect(wireRequests).toHaveLength(2);
  expect(readSource).not.toHaveBeenCalled();
  const { events } = await ctx.mioKernel.readPersistedHistory(sourceId);
  const originalImage = events.find(
    (event) =>
      event.type === 'user/message' && event.data.content.some((block) => block.type === 'image'),
  )!;
  const offload = await ctx.mioKernel.resume(sourceId, {});
  try {
    offload.agent.session.append('image/offload', {
      targets: [{ seq: originalImage.seq, imageIndexes: [0] }],
    });
    await ctx.mioKernel.flush(offload.agent.session);
  } finally {
    await offload.dispose();
  }

  expect(await engine.hasRetainedImages!(sourceId)).toBe(false);
  expect(await send(engine, sourceId, modelB, 'text after offload')).toBe('completed');
  expect(wireRequests).toHaveLength(3);
  const wire = JSON.stringify(wireRequests.at(-1)!.body.messages);
  expect(wire).toContain('keep image context');
  expect(wire).toContain('image omitted because this model accepts text only');
  expect(wire).toContain('text after offload');
  expect(wire).not.toContain('data:image/');
  expect(readSource).not.toHaveBeenCalled();
  const history = await engine.history(sourceId, -1, 100);
  expect(history.items).toContainEqual({
    role: 'user',
    text: 'keep image context',
    seq: originalImage.seq,
    imageAssetIds: [assetId],
  });
  expect((await ctx.mioKernel.readPersistedHistory(sourceId)).events[originalImage.seq]).toEqual(
    originalImage,
  );
});

it('distinguishes a lost observation from a settled provider failure at the native turn end', async () => {
  const open = await fixture();
  const { ctx, engine } = await open();
  await engine.create(sourceId, modelA);
  expect(await send(engine, sourceId, modelA, 'fixture force upstream error')).toEqual({
    status: 'failed',
    error: 'MODEL_UPSTREAM_ERROR',
  });
  const failed = await engine.resolveForkBoundary!(sourceId);
  const observe = vi.fn(async () => {
    throw new Error('fixture internal observation write failed');
  });
  expect(await send(engine, sourceId, modelA, 'fixture observation lost', { observe })).toBe(
    'unknown',
  );
  expect(observe).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ status: 200, finish: 'stop' }),
  );
  expect(wireRequests).toHaveLength(2);
  const recorded = (await ctx.mioKernel.readPersistedHistory(sourceId)).events.at(-1);
  expect(recorded).toMatchObject({
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { code: OBSERVATION_UNAVAILABLE } } },
  });
  expect(JSON.stringify(recorded)).not.toContain('fixture internal observation write failed');
  expect(await engine.resolveForkBoundary!(sourceId)).toBe(failed);
  await expect(engine.resolveForkBoundary!(sourceId, recorded!.seq)).rejects.toMatchObject(invalid);
});
