import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AssetError } from '../../src/assets/contracts.ts';
import { createConversationHandler } from '../../src/conversations/http.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { createConversationService } from '../../src/conversations/service.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import type {
  ConversationEngine,
  ConversationVision,
  Principal,
} from '../../src/conversations/contracts.ts';
import { DEFAULT_CHAT_IMAGE_BUDGET } from '../../src/providers/contracts.ts';
import type { ChatRuntimeSnapshot } from '../../src/providers/contracts.ts';
import { authDatabase } from '../support/auth-database.ts';

const actor: Principal = { userId: 'owner', sessionId: 'login' };
const selection = {
  providerConfigId: 'config',
  modelRef: 'ref',
  modelId: 'model',
  modelKey: 'key',
  protocol: 'openai-chat',
} as const;
let snapshot: ChatRuntimeSnapshot;
const provider = {
  selectChat: vi.fn(async () => selection),
  resolveChat: vi.fn(async () => snapshot),
  recordVerification: vi.fn(async () => {}),
};
const makeRef = (id: string) => ({
  attachmentId: id,
  mediaType: 'image/png' as const,
  bytes: 3,
  width: 1,
  height: 1,
});
const vision: ConversationVision = {
  prepare: async (_owner, id) => makeRef(id),
  prepareRequest: vi.fn(async (_owner, id) => ({ reference: makeRef(id), previewBytes: 3 })),
  target: () => ({ width: 1, height: 1, maxBytes: 1024 }),
  preview: vi.fn<ConversationVision['preview']>(async (_owner, ref) => ({
    variantId: 'variant',
    attachment: ref,
    data: Buffer.from('abc'),
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
    fingerprint: 'hash',
  })),
  assetId: (ref) => ref.attachmentId,
  acquireRequest: async () => () => {},
};
const engine: ConversationEngine = {
  available: true,
  create: async () => {},
  history: async () => ({ items: [], nextAfterSeq: -1, hasMore: false }),
  run: vi.fn<ConversationEngine['run']>(async (_id, _requestId, _text, durable) => {
    await durable();
    return 'completed';
  }),
  cancel: async () => {},
  close: async () => {},
};
let database: Awaited<ReturnType<typeof authDatabase>>;
let observer: Pool;
let store: Awaited<ReturnType<typeof createConversationStore>>;
let service: ReturnType<typeof createConversationService>;
let server: ReturnType<typeof createServer>;
let origin: string;

beforeAll(async () => {
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL });
  await observer.query(conversationSchemaSQL);
  store = await createConversationStore(database.url);
  service = createConversationService(store, engine, provider, vision);
  const http = createConversationHandler(
    service,
    async (headers) => ({
      userId: headers.get('cookie') === 'other' ? 'other' : 'owner',
      sessionId: 'login',
    }),
    ['http://fixture.test'],
  );
  server = createServer(http.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  origin = `http://127.0.0.1:${address.port}`;
}, 45000);

beforeEach(() => {
  vi.resetAllMocks();
  snapshot = {
    ...selection,
    providerRevision: 1,
    credentialVersion: 1,
    catalogVersion: 1,
    adaptationVersion: 1,
    capabilityVersion: 'fixture',
    operation: 'chat',
    profile: 'openai-chat',
    apiKey: 'fixture',
    inputModalities: ['text', 'image'],
    imageBudget: { ...DEFAULT_CHAT_IMAGE_BUDGET },
  };
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (service) await service.close();
  if (observer) await observer.end();
  if (database) await database.close();
}, 30000);

async function conversation() {
  return (await service.create(actor, 'ref')).id;
}
const post = (id: string, value: unknown, cookie = 'owner') =>
  fetch(`${origin}/api/v1/conversations/${id}/messages`, {
    method: 'POST',
    headers: { origin: 'http://fixture.test', cookie, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });

it('rejects a third fresh image preparation without queueing or receiving while replay stays available', async () => {
  const replayId = await conversation();
  const replay = {
    requestId: 'replay-under-load',
    text: 'accepted',
    imageAssetIds: [randomUUID()],
  };
  expect((await post(replayId, replay)).status).toBe(202);
  const ids = await Promise.all([conversation(), conversation(), conversation()]);
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let active = 0;
  vi.mocked(vision.prepareRequest).mockImplementation(async (_owner, assetId) => {
    active++;
    if (active === 2) entered.resolve();
    await release.promise;
    return { reference: makeRef(assetId), previewBytes: 3 };
  });
  const input = (requestId: string) => ({
    requestId,
    text: 'describe',
    imageAssetIds: [randomUUID()],
  });
  const first = post(ids[0]!, input('first-under-load'));
  const second = post(ids[1]!, input('second-under-load'));
  const retry = input('retry-after-overload');
  try {
    await entered.promise;
    const reads = vi.mocked(vision.prepareRequest).mock.calls.length;
    const overloaded = await post(ids[2]!, retry);
    expect(overloaded.status).toBe(503);
    expect(await overloaded.json()).toMatchObject({ error: { code: 'IMAGE_UNAVAILABLE' } });
    expect(vision.prepareRequest).toHaveBeenCalledTimes(reads);
    expect(
      (await service.request(actor, ids[2]!, retry.requestId).catch((error) => error)).code,
    ).toBe('REQUEST_NOT_FOUND');
    expect((await post(replayId, replay)).status).toBe(202);
    expect(vision.prepareRequest).toHaveBeenCalledTimes(reads);
  } finally {
    release.resolve();
    expect((await first).status).toBe(202);
    expect((await second).status).toBe(202);
  }
  expect((await post(ids[2]!, retry)).status).toBe(202);
});

it('checks ownership and text-only capability before asset reads and maps asset errors', async () => {
  const id = await conversation();
  const body = { requestId: 'one', text: 'describe', imageAssetIds: [randomUUID()] };
  expect((await post(id, body, 'other')).status).toBe(404);
  expect(vision.prepareRequest).not.toHaveBeenCalled();
  snapshot = { ...snapshot, inputModalities: ['text'] };
  const textOnly = await post(id, body);
  expect(textOnly.status).toBe(409);
  expect(await textOnly.json()).toMatchObject({ error: { code: 'MODEL_MODALITY_UNSUPPORTED' } });
  expect(vision.prepareRequest).not.toHaveBeenCalled();

  snapshot = { ...snapshot, inputModalities: ['text', 'image'] };
  const reconcile = vi.spyOn(store, 'reconcileReception');
  vi.mocked(vision.prepareRequest).mockRejectedValueOnce(new AssetError(404, 'ASSET_NOT_FOUND'));
  const missing = await post(id, body);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { code: 'ASSET_NOT_FOUND' } });
  expect(reconcile).not.toHaveBeenCalled();
  reconcile.mockRestore();
});

it('serializes competing IDs without holding a PG row lock during image preflight', async () => {
  const id = await conversation();
  const asset = randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(vision.prepareRequest).mockImplementationOnce(async (_owner, imageId) => {
    entered.resolve();
    await release.promise;
    return { reference: makeRef(imageId), previewBytes: 3 };
  });
  const first = service.send(actor, id, 'same', 'hello', [asset]);
  await entered.promise;
  const connection = await observer.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT id FROM mio_conversations WHERE id=$1 FOR UPDATE NOWAIT', [id]);
    await connection.query('ROLLBACK');
  } finally {
    connection.release();
  }
  const second = service.send(actor, id, 'same', 'different', [asset]);
  release.resolve();
  expect((await first).requestId).toBe('same');
  await expect(second).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
  expect(vision.prepareRequest).toHaveBeenCalledTimes(1);
  expect(engine.run).toHaveBeenCalledTimes(1);
});

it('allows a waiting competitor to retry after preflight failure', async () => {
  const id = await conversation();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(vision.prepareRequest).mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    throw new AssetError(404, 'ASSET_NOT_FOUND');
  });
  const first = service.send(actor, id, 'retry', 'first', [randomUUID()]);
  const failed = expect(first).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  await entered.promise;
  const second = service.send(actor, id, 'retry', 'second', [randomUUID()]);
  release.resolve();
  await failed;
  expect((await second).requestId).toBe('retry');
  expect(vision.prepareRequest).toHaveBeenCalledTimes(2);
});

it('reuses the owned preflight row and rechecks a new active request at final reception', async () => {
  const id = await conversation();
  const owned = vi.spyOn(store, 'owned');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(vision.prepareRequest).mockImplementationOnce(async (_owner, assetId) => {
    entered.resolve();
    await release.promise;
    return { reference: makeRef(assetId), previewBytes: 3 };
  });
  const sending = service.send(actor, id, 'image', 'hello', [randomUUID()]);
  const outcome = sending.catch((error: unknown) => error);
  try {
    await entered.promise;
    expect(owned).toHaveBeenCalledOnce();
    await store.receive(actor, id, 'winner', 'winner-digest', true);
    release.resolve();
    expect(await outcome).toMatchObject({ code: 'CONVERSATION_BUSY' });
    expect(engine.run).not.toHaveBeenCalled();
    await expect(store.request(actor, id, 'image')).rejects.toMatchObject({
      code: 'REQUEST_NOT_FOUND',
    });
    expect(await store.snapshot(actor, id)).toMatchObject({ activeRequestId: 'winner' });
  } finally {
    release.resolve();
    await outcome;
    owned.mockRestore();
    await store.finish(id, 'winner', 'cancelled').catch(() => {});
  }
});

it('returns one receipt to concurrent identical image sends after a single preflight', async () => {
  const id = await conversation();
  const asset = randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(vision.prepareRequest).mockImplementationOnce(async (_owner, imageId) => {
    entered.resolve();
    await release.promise;
    return { reference: makeRef(imageId), previewBytes: 3 };
  });
  const first = service.send(actor, id, 'same-image', 'hello', [asset]);
  await entered.promise;
  const second = service.send(actor, id, 'same-image', 'hello', [asset]);
  release.resolve();
  expect((await first).requestId).toBe('same-image');
  expect((await second).requestId).toBe('same-image');
  expect(vision.prepareRequest).toHaveBeenCalledOnce();
  expect(engine.run).toHaveBeenCalledOnce();
});

it('keeps an image receipt unknown after a lost reception acknowledgement without retrying', async () => {
  const id = await conversation();
  const asset = randomUUID();
  const receive = store.receive.bind(store);
  const lost = vi.spyOn(store, 'receive').mockImplementationOnce(async (...args) => {
    await receive(...args);
    throw new Error('synthetic reception acknowledgement loss');
  });
  try {
    await expect(service.send(actor, id, 'lost', 'hello', [asset])).rejects.toThrow();
    expect(await service.request(actor, id, 'lost')).toMatchObject({
      status: 'unknown',
      error: 'RECEPTION_UNKNOWN',
    });
    vi.mocked(vision.prepareRequest).mockRejectedValueOnce(new Error('asset changed'));
    expect(await service.send(actor, id, 'lost', 'hello', [asset])).toMatchObject({
      status: 'unknown',
    });
    expect(engine.run).not.toHaveBeenCalled();
    expect(vision.prepareRequest).toHaveBeenCalledOnce();
  } finally {
    lost.mockRestore();
  }
});

it('returns an existing receipt before mutable checks and rejects busy new IDs before preflight', async () => {
  const id = await conversation();
  const asset = randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(engine.run).mockImplementationOnce(async (_id, _request, _text, durable) => {
    await durable();
    entered.resolve();
    await release.promise;
    return 'completed';
  });
  const body = { requestId: 'existing', text: 'hello', imageAssetIds: [asset] };
  expect((await post(id, body)).status).toBe(202);
  await entered.promise;
  vi.mocked(provider.resolveChat).mockRejectedValueOnce(new Error('catalog unavailable'));
  expect((await post(id, body)).status).toBe(202);
  expect((await post(id, { ...body, requestId: 'new' })).status).toBe(409);
  expect(vision.prepareRequest).toHaveBeenCalledTimes(1);
  expect(provider.resolveChat).toHaveBeenCalledTimes(2);
  release.resolve();
});

it('validates HTTP image identities and keeps the legacy digest for omitted or empty images', async () => {
  const id = await conversation();
  const asset = randomUUID();
  for (const imageAssetIds of [
    [asset, asset],
    [asset.toUpperCase()],
    [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    ['not-a-uuid'],
  ]) {
    expect((await post(id, { requestId: 'invalid', text: 'hello', imageAssetIds })).status).toBe(
      400,
    );
  }
  expect(
    (await post(id, { requestId: 'invalid', text: '  ', imageAssetIds: [asset] })).status,
  ).toBe(400);
  expect(vision.prepareRequest).not.toHaveBeenCalled();
  expect((await post(id, { requestId: 'legacy', text: 'hello', imageAssetIds: [] })).status).toBe(
    202,
  );
  const result = await observer.query<{ digest: string }>(
    'SELECT digest FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
    [id, 'legacy'],
  );
  expect(result.rows[0]!.digest).toBe(createHash('sha256').update('hello').digest('hex'));
  expect((await post(id, { requestId: 'legacy', text: 'hello' })).status).toBe(202);
  expect(vision.prepareRequest).not.toHaveBeenCalled();
});

it('binds request identity to ordered image IDs and returns existing receipts first', async () => {
  const id = await conversation();
  const ids = [randomUUID(), randomUUID()];
  const body = { requestId: 'ordered', text: 'hello', imageAssetIds: ids };
  expect((await post(id, body)).status).toBe(202);
  const result = await observer.query<{ digest: string }>(
    'SELECT digest FROM mio_conversation_requests WHERE conversation_id=$1 AND request_id=$2',
    [id, 'ordered'],
  );
  expect(result.rows[0]!.digest).toBe(
    `vision:v1:${createHash('sha256')
      .update(JSON.stringify(['hello', ids]))
      .digest('hex')}`,
  );
  const calls = vi.mocked(vision.prepareRequest).mock.calls.length;
  vi.mocked(provider.resolveChat).mockRejectedValueOnce(new Error('catalog unavailable'));
  expect((await post(id, body)).status).toBe(202);
  const conflict = await post(id, { ...body, imageAssetIds: [...ids].reverse() });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: 'REQUEST_ID_CONFLICT' } });
  expect(vision.prepareRequest).toHaveBeenCalledTimes(calls);
});

it('accepts four distinct images in their original order at the HTTP limit', async () => {
  const id = await conversation();
  const imageAssetIds = Array.from({ length: 4 }, () => randomUUID());
  const response = await post(id, { requestId: 'four', text: 'describe', imageAssetIds });
  expect(response.status, await response.clone().text()).toBe(202);
  expect(vi.mocked(vision.prepareRequest).mock.calls.map((call) => call[1])).toEqual(imageAssetIds);
  expect(vi.mocked(engine.run).mock.calls[0]![6]?.map((image) => image.attachmentId)).toEqual(
    imageAssetIds,
  );
});

it('rejects current image count, encoded byte excess, and changed route before acceptance', async () => {
  const countId = await conversation();
  snapshot = { ...snapshot, imageBudget: { ...snapshot.imageBudget!, maxRequestImages: 1 } };
  const tooMany = await post(countId, {
    requestId: 'count',
    text: 'hello',
    imageAssetIds: [randomUUID(), randomUUID()],
  });
  expect(tooMany.status).toBe(400);
  expect(vision.prepareRequest).not.toHaveBeenCalled();

  const bytesId = await conversation();
  snapshot = { ...snapshot, imageBudget: { ...snapshot.imageBudget!, maxRequestImageBytes: 3 } };
  const tooLarge = await post(bytesId, {
    requestId: 'bytes',
    text: 'hello',
    imageAssetIds: [randomUUID()],
  });
  expect(tooLarge.status).toBe(400);
  expect((await service.request(actor, bytesId, 'bytes').catch((error) => error)).code).toBe(
    'REQUEST_NOT_FOUND',
  );

  const driftId = await conversation();
  snapshot = { ...snapshot, imageBudget: { ...DEFAULT_CHAT_IMAGE_BUDGET } };
  vi.mocked(vision.prepareRequest).mockImplementationOnce(async (_owner, assetId) => {
    snapshot = { ...snapshot, imageBudget: { ...snapshot.imageBudget!, maxRequestImages: 2 } };
    return { reference: makeRef(assetId), previewBytes: 3 };
  });
  const drift = await post(driftId, {
    requestId: 'drift',
    text: 'hello',
    imageAssetIds: [randomUUID()],
  });
  expect(drift.status).toBe(409);
  expect(await drift.json()).toMatchObject({ error: { code: 'MODEL_VISION_CHANGED' } });
  expect((await service.request(actor, driftId, 'drift').catch((error) => error)).code).toBe(
    'REQUEST_NOT_FOUND',
  );
});
