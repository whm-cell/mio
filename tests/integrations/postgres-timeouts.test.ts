import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createAdminStore } from '../../src/admin/store.ts';
import { createAssetStore } from '../../src/assets/store.ts';
import { withAuthTransaction } from '../../src/auth/transaction.ts';
import { computeTransaction } from '../../src/compute/database.ts';
import { createMediaStore } from '../../src/compute/media/store.ts';
import { createComputeStore } from '../../src/compute/transcode/store.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import { transaction } from '../../src/generations/transaction.ts';
import { createMaterialStore } from '../../src/materials/store.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>> | undefined;
let observer: Pool | undefined;

beforeAll(async () => {
  // Never let this fault-injection suite fall back to a temporary PG cluster.
  const url = process.env.MIO_TEST_DATABASE_URL;
  if (!url) throw new Error('VF3_REQUIRES_EXISTING_REGRESSION_DATABASE');
  const target = new URL(url);
  if (
    process.env.GITHUB_ACTIONS !== 'true' &&
    (target.pathname !== '/mio_regression_test' || target.username !== 'mio_regression')
  )
    throw new Error('VF3_REQUIRES_MIO_DEV_REGRESSION_DATABASE');
  database = await authDatabase();
  observer = new Pool({ connectionString: database.observerURL, connectionTimeoutMillis: 5000 });
  const identity = (
    await observer.query(
      'SELECT current_database() AS database, current_user AS role, current_schema() AS schema',
    )
  ).rows[0] as { database: string; role: string; schema: string };
  process.stdout.write(`VF3_DATABASE_IDENTITY ${JSON.stringify(identity)}\n`);
  await observer.query('CREATE TABLE vf3_effects (id text PRIMARY KEY)');
});

afterAll(async () => {
  await observer?.end();
  await database?.close();
});

const openPool = (queryTimeout = 1000, statementTimeout = 2000) =>
  new Pool({
    connectionString: database!.url,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: statementTimeout,
    query_timeout: queryTimeout,
  });

it.each([
  { name: 'compute', run: computeTransaction },
  { name: 'auth', run: withAuthTransaction },
])(
  'preserves the $name root error and replaces a live session after failed rollback',
  async ({ run }) => {
    const pool = openPool();
    const client = await pool.connect();
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    client.release();
    const root = new Error('fixture application rejected after a write');
    const rollback = new Error('fixture rollback delivery failed');
    const original = client.query;
    // A deterministic delivery failure: ROLLBACK does not reach the real server.
    const query = vi.spyOn(client, 'query').mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      if (args[0] === 'ROLLBACK') return Promise.reject(rollback);
      return Reflect.apply(original, this, args);
    });
    const id = randomUUID();
    try {
      const failure = await run(pool, async (connection) => {
        await connection.query('INSERT INTO vf3_effects(id) VALUES($1)', [id]);
        throw root;
      }).catch((error: unknown) => error);
      expect.soft(failure).toBe(root);
      const next = await pool.query('SELECT pg_backend_pid() AS pid');
      expect.soft(next.rows[0].pid).not.toBe(pid);
      expect((await observer!.query('SELECT id FROM vf3_effects WHERE id=$1', [id])).rows).toEqual(
        [],
      );
    } finally {
      query.mockRestore();
      await pool.end();
    }
  },
);

it('reuses a healthy session after rollback and keeps its rejected write invisible', async () => {
  const pool = openPool();
  const client = await pool.connect();
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  client.release();
  const root = new Error('fixture rejected');
  const id = randomUUID();
  try {
    await expect(
      computeTransaction(pool, async (connection) => {
        await connection.query('INSERT INTO vf3_effects(id) VALUES($1)', [id]);
        throw root;
      }),
    ).rejects.toBe(root);
    expect((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid);
    expect((await observer!.query('SELECT id FROM vf3_effects WHERE id=$1', [id])).rows).toEqual(
      [],
    );
  } finally {
    await pool.end();
  }
});

it('evicts an active client when its read timeout also removes a queued rollback', async () => {
  const pool = openPool(100, 2000);
  let pid: number | undefined;
  let primary: unknown;
  const id = randomUUID();
  try {
    const failure = await computeTransaction(pool, async (connection) => {
      pid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await connection.query('INSERT INTO vf3_effects(id) VALUES($1)', [id]);
      try {
        await connection.query('SELECT pg_sleep(1)');
      } catch (error) {
        primary = error;
        throw error;
      }
    }).catch((error: unknown) => error);
    expect(primary).toBeInstanceOf(Error);
    expect(primary).toMatchObject({ message: 'Query read timeout' });
    expect.soft(failure).toBe(primary);
    const nextQuery = { text: 'SELECT pg_backend_pid() AS pid', query_timeout: 1500 };
    expect.soft((await pool.query(nextQuery)).rows[0].pid).not.toBe(pid);
    expect((await observer!.query('SELECT id FROM vf3_effects WHERE id=$1', [id])).rows).toEqual(
      [],
    );
  } finally {
    await pool.end();
  }
});

it('preserves server statement cancellation and reuses the successfully rolled-back session', async () => {
  const pool = openPool(1000, 50);
  let pid: number | undefined;
  try {
    await expect(
      computeTransaction(pool, async (connection) => {
        pid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        await connection.query('SELECT pg_sleep(0.2)');
      }),
    ).rejects.toMatchObject({ code: '57014' });
    expect((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid);
  } finally {
    await pool.end();
  }
});

it.each([
  { name: 'compute', run: computeTransaction },
  { name: 'auth', run: withAuthTransaction },
  { name: 'generations reference', run: transaction },
])('does not imply a lost $name COMMIT acknowledgment undoes a durable write', async ({ run }) => {
  const pool = openPool();
  const client = await pool.connect();
  client.release();
  const lost = new Error('fixture lost COMMIT acknowledgment');
  const original = client.query;
  const query = vi.spyOn(client, 'query').mockImplementation(function (
    this: Client,
    ...args: unknown[]
  ) {
    const result = Reflect.apply(original, this, args);
    if (args[0] === 'COMMIT')
      return result.then(() => {
        throw lost;
      });
    return result;
  });
  const id = randomUUID();
  try {
    await expect(
      run(pool, async (connection) => {
        await connection.query('INSERT INTO vf3_effects(id) VALUES($1)', [id]);
      }),
    ).rejects.toBe(lost);
    expect((await observer!.query('SELECT id FROM vf3_effects WHERE id=$1', [id])).rows).toEqual([
      { id },
    ]);
  } finally {
    query.mockRestore();
    await pool.end();
  }
});

const factories = [
  {
    name: 'providers',
    open: (url: string) =>
      createProviderStore({ databaseURL: url } as Parameters<typeof createProviderStore>[0]),
  },
  {
    name: 'admin',
    open: (url: string) =>
      createAdminStore({ databaseURL: url } as Parameters<typeof createAdminStore>[0]),
  },
  { name: 'conversations', open: createConversationStore },
  { name: 'materials', open: createMaterialStore },
  { name: 'assets', open: createAssetStore },
  { name: 'compute media', open: createMediaStore },
  { name: 'compute transcode', open: createComputeStore },
];

it.each(factories)(
  'retains the 5s SQL budget with an 8s read margin in the $name pool',
  async ({ open }) => {
    const original = Client.prototype.query;
    let budget: { statement_timeout: number; query_timeout: number } | undefined;
    // Fail schema discovery through the actual driver, before creating domain state.
    const query = vi.spyOn(Client.prototype, 'query').mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      budget = (this as unknown as { connectionParameters: typeof budget }).connectionParameters;
      return Reflect.apply(original, this, ['SELECT 1/0', ...args.slice(1)]);
    });
    try {
      await expect(open(database!.url)).rejects.toThrow();
      expect(budget).toMatchObject({ statement_timeout: 5000, query_timeout: 8000 });
    } finally {
      query.mockRestore();
    }
  },
);
