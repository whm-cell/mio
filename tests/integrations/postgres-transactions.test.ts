import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AdminError } from '../../src/admin/contracts.ts';
import { AdminStore } from '../../src/admin/store.ts';
import { AudioError } from '../../src/audio/contracts.ts';
import { VoiceError } from '../../src/audio/voices/contracts.ts';
import { withAuthTransaction } from '../../src/auth/transaction.ts';
import { computeTransaction } from '../../src/compute/database.ts';
import { ConversationStore } from '../../src/conversations/store.ts';
import { transaction } from '../../src/generations/transaction.ts';
import { withMaterialTransaction } from '../../src/materials/auth-store.ts';
import { MaterialError } from '../../src/materials/contracts.ts';
import { ProviderError } from '../../src/providers/contracts.ts';
import { ProviderStore } from '../../src/providers/store.ts';

const provider = (pool: Pool) =>
  new ProviderStore(pool, {} as ConstructorParameters<typeof ProviderStore>[1]);
const conversation = (pool: Pool) => new ConversationStore(pool, new EventEmitter() as PoolClient);
const actor = { userId: 'fixture-owner', sessionId: 'fixture-session' };

const adapters: { name: string; run: (pool: Pool) => Promise<unknown>; error?: () => Error }[] = [
  {
    name: 'compute',
    run: (pool: Pool) => computeTransaction(pool, (c) => c.query('SELECT fixture')),
  },
  {
    name: 'auth',
    run: (pool: Pool) => withAuthTransaction(pool, (c) => c.query('SELECT fixture')),
  },
  {
    name: 'generations reference',
    run: (pool: Pool) => transaction(pool, (c) => c.query('SELECT fixture')),
  },
  {
    name: 'providers',
    run: (pool: Pool) => provider(pool).beginRefresh(actor.userId),
    error: () => new ProviderError(409, 'PROVIDER_REVISION_CONFLICT'),
  },
  {
    name: 'audio through providers',
    run: (pool: Pool) => provider(pool).audio.claim(),
    error: () => new AudioError(409, 'AUDIO_FIXTURE_CONFLICT'),
  },
  {
    name: 'admin',
    run: (pool: Pool) =>
      new AdminStore(pool, null, false, null).createSession('admin', 'digest', new Date(0)),
    error: () => new AdminError(409, 'ADMIN_FIXTURE_CONFLICT'),
  },
  {
    name: 'conversation ordinary',
    run: (pool: Pool) => conversation(pool).archive(actor, 'conversation'),
  },
  {
    name: 'conversation reception reconciliation',
    run: (pool: Pool) =>
      conversation(pool).reconcileReception(actor, 'conversation', 'request', 'digest'),
  },
  {
    name: 'conversation finish',
    run: (pool: Pool) => conversation(pool).finish('conversation', 'request', 'failed'),
  },
  {
    name: 'materials',
    run: (pool: Pool) => withMaterialTransaction(pool, (c) => c.query('SELECT fixture')),
    error: () => new MaterialError(409, 'MATERIAL_OPERATION_SUPERSEDED'),
  },
];

function checkout(root: Error, rollbackError?: Error, disconnect = false) {
  const client = new EventEmitter();
  const release = vi.fn<(discard?: boolean) => void>();
  const query = vi.fn(async (sql: string) => {
    if (sql === 'ROLLBACK') {
      if (rollbackError) throw rollbackError;
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'BEGIN' || sql.startsWith('SET LOCAL ')) return { rows: [], rowCount: 0 };
    if (disconnect) client.emit('error', root);
    throw root;
  });
  Object.assign(client, { query, release });
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, query, release };
}

describe.each(adapters)('$name transaction failure contract', (adapter) => {
  it('preserves the primary/domain error and discards when rollback also fails', async () => {
    const root = adapter.error?.() ?? new Error('fixture original failure');
    const f = checkout(root, new Error('fixture rollback read timeout'));
    await expect(adapter.run(f.pool)).rejects.toBe(root);
    expect(f.query.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(1);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.client.listenerCount('error')).toBe(0);
  });

  it('keeps a successfully rolled-back client reusable without leaving a listener', async () => {
    const root = adapter.error?.() ?? new Error('fixture original failure');
    const f = checkout(root);
    await expect(adapter.run(f.pool)).rejects.toBe(root);
    expect(f.release).toHaveBeenCalledOnce();
    expect(Boolean(f.release.mock.calls[0]?.[0])).toBe(false);
    expect(f.client.listenerCount('error')).toBe(0);
  });

  it('handles a checked-out disconnect and avoids rollback on the dead connection', async () => {
    const root = adapter.error?.() ?? new Error('fixture connection lost');
    const f = checkout(root, undefined, true);
    await expect(adapter.run(f.pool)).rejects.toBe(root);
    expect(f.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.client.listenerCount('error')).toBe(0);
  });
});

it.each([
  { error: new VoiceError(409, 'VOICE_FIXTURE_CONFLICT') },
  { error: new AudioError(409, 'AUDIO_FIXTURE_CONFLICT') },
  { error: new ProviderError(409, 'PROVIDER_REVISION_CONFLICT') },
])('retains provider-owned error identity: $error.code', async ({ error }) => {
  const f = checkout(error, new Error('fixture rollback failure'));
  await expect(provider(f.pool).beginRefresh(actor.userId)).rejects.toBe(error);
  expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
});

it.each([
  {
    name: 'provider unavailable',
    run: (pool: Pool) => provider(pool).beginRefresh(actor.userId),
    error: new Error('private database detail'),
    code: 'PROVIDER_UNAVAILABLE',
    status: 503,
  },
  {
    name: 'admin unavailable',
    run: (pool: Pool) =>
      new AdminStore(pool, null, false, null).createSession('admin', 'digest', new Date(0)),
    error: new Error('private database detail'),
    code: 'ADMIN_UNAVAILABLE',
    status: 503,
  },
  {
    name: 'admin template collision',
    run: (pool: Pool) =>
      new AdminStore(pool, null, false, null).createSession('admin', 'digest', new Date(0)),
    error: Object.assign(new Error('collision'), {
      code: '23505',
      constraint: 'template_key_unique',
    }),
    code: 'TEMPLATE_KEY_TAKEN',
    status: 409,
  },
  {
    name: 'admin model collision',
    run: (pool: Pool) =>
      new AdminStore(pool, null, false, null).createSession('admin', 'digest', new Date(0)),
    error: Object.assign(new Error('collision'), {
      code: '23505',
      constraint: 'catalog_models_pkey',
    }),
    code: 'MODEL_ALREADY_EXISTS',
    status: 409,
  },
  {
    name: 'admin username collision',
    run: (pool: Pool) =>
      new AdminStore(pool, null, false, null).createSession('admin', 'digest', new Date(0)),
    error: Object.assign(new Error('collision'), { code: '23505' }),
    code: 'ADMIN_USERNAME_TAKEN',
    status: 409,
  },
  {
    name: 'material unavailable',
    run: (pool: Pool) => withMaterialTransaction(pool, (c) => c.query('SELECT fixture')),
    error: new Error('private database detail'),
    code: 'MATERIAL_UNAVAILABLE',
    status: 503,
  },
  {
    name: 'material collision',
    run: (pool: Pool) => withMaterialTransaction(pool, (c) => c.query('SELECT fixture')),
    error: Object.assign(new Error('collision'), { code: '23505' }),
    code: 'UPSTREAM_RESOURCE_COLLISION',
    status: 409,
  },
])('preserves existing domain mapping after failed rollback: $name', async (test) => {
  const f = checkout(test.error, new Error('fixture rollback failure'));
  await expect(test.run(f.pool)).rejects.toMatchObject({ code: test.code, status: test.status });
  expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
});
