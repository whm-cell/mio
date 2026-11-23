import { afterEach, expect, it, vi } from 'vitest';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import {
  audioResultPolicy,
  computeCapacity,
  computePermissions,
  computeTopology,
} from '../../scripts/service/compute-broker-topology.ts';
import { prepareLocalBroker } from '../../scripts/service/local-broker.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('preflights all resources and refuses drift before creating anything', async () => {
  const methods: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL, init: RequestInit) => {
      methods.push(init.method!);
      const path = input.pathname;
      if (path.endsWith('/ready-to-serve-clients')) return Response.json({ status: 'ok' });
      if (path.endsWith('/feature-flags'))
        return Response.json([{ name: 'stream_queue', state: 'enabled' }]);
      if (path === '/api/vhosts/mio-dev') return Response.json({ name: 'mio-dev' });
      if (path === '/api/queues/mio-dev/mio.compute.results.v1')
        return Response.json({ durable: false, auto_delete: true, arguments: {} });
      return Response.json({}, { status: 404 });
    }),
  );
  await expect(
    prepareLocalBroker('dev', {
      MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT: '15680',
      MIO_LOCAL_RABBITMQ_PASSWORD: 'private',
    }),
  ).rejects.toThrow('LOCAL_BROKER_CONFLICT: queues/mio-dev/mio.compute.results.v1');
  expect(new Set(methods)).toEqual(new Set(['GET']));
});

it('reports an uncertain write without retrying or exposing credentials', async () => {
  const methods: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL, init: RequestInit) => {
      methods.push(init.method!);
      if (init.method !== 'GET') throw new Error('transport failed after request');
      if (input.pathname.endsWith('/ready-to-serve-clients'))
        return Response.json({ status: 'ok' });
      if (input.pathname.endsWith('/feature-flags'))
        return Response.json([{ name: 'stream_queue', state: 'enabled' }]);
      if (input.pathname === '/api/vhosts/mio-test') return Response.json({ name: 'mio-test' });
      return Response.json({}, { status: 404 });
    }),
  );
  await expect(
    prepareLocalBroker('test', {
      MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT: '15681',
      MIO_LOCAL_RABBITMQ_PASSWORD: 'never-log-secret',
    }),
  ).rejects.toThrow(
    'LOCAL_BROKER_REQUEST_UNKNOWN: PUT exchanges/mio-test/mio.compute.commands.v1; inspect broker then rerun initialization',
  );
  expect(methods.filter((method) => method !== 'GET')).toEqual(['PUT']);
});

const testEnv = {
  RABBITMQ_URL: 'amqp://127.0.0.1:56721/mio-test',
  MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT: '15681',
  MIO_LOCAL_RABBITMQ_PASSWORD: 'fixture-admin-password',
  MIO_LOCAL_RABBITMQ_A_PASSWORD: 'fixture-a-password',
  MIO_LOCAL_RABBITMQ_B_PASSWORD: 'fixture-b-password',
};
const policyPath = 'operator-policies/mio-test/mio-capacity';
const audioPolicyPath = `operator-policies/mio-test/${audioResultPolicy.name}`;
const testPolicy = {
  pattern: '.*',
  definition: computeCapacity,
  priority: 0,
  'apply-to': 'queues',
};
const userMetadata = {
  has_password: true,
  hashing_algorithm: 'rabbit_password_hashing_sha256',
  tags: [],
};

function brokerFixture(beforeWrite?: () => Promise<void>) {
  const values = new Map<string, unknown>([[audioPolicyPath, audioResultPolicy.definition]]);
  const writes: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL, init: RequestInit) => {
      const path = input.pathname.replace(/^\/api\//, '');
      if (path === 'health/checks/ready-to-serve-clients') return Response.json({ status: 'ok' });
      if (path === 'feature-flags')
        return Response.json([{ name: 'stream_queue', state: 'enabled' }]);
      if (init.method === 'GET') {
        return values.has(path)
          ? Response.json(values.get(path))
          : new Response(null, { status: 404 });
      }
      writes.push(path);
      await beforeWrite?.();
      const body: unknown = JSON.parse(String(init.body));
      values.set(path, init.method === 'POST' ? [body] : body);
      return new Response(null, { status: 201 });
    }),
  );
  return { values, writes };
}

function provisionTestRoles(values: Map<string, unknown>) {
  for (const role of ['a', 'b'] as const) {
    values.set(`users/mio-test-${role}`, userMetadata);
    values.set(`permissions/mio-test/mio-test-${role}`, computePermissions(role));
  }
}

it('lists a missing vhost and scoped prerequisites without making declarations in it', async () => {
  const { values, writes } = brokerFixture();
  values.set('users/mio-test-a', userMetadata);
  await expect(prepareLocalBroker('test', testEnv)).rejects.toThrow(
    'LOCAL_BROKER_PREPROVISION_REQUIRED: vhosts/mio-test, operator-policies/mio-test/mio-capacity, permissions/mio-test/mio-test-a, users/mio-test-b, permissions/mio-test/mio-test-b',
  );
  expect(writes).toEqual([]);
});

it('declares exchanges before provisioning and completes queues and bindings once capacity is set', async () => {
  const { values, writes } = brokerFixture();
  const connect = vi.spyOn(ComputeBroker, 'connect').mockResolvedValue({
    close: async () => {},
  } as ComputeBroker);
  values.set('vhosts/mio-test', { description: 'operator managed' });
  await expect(prepareLocalBroker('test', testEnv)).rejects.toThrow(
    'LOCAL_BROKER_PREPROVISION_REQUIRED: operator-policies/mio-test/mio-capacity, users/mio-test-a, permissions/mio-test/mio-test-a, users/mio-test-b, permissions/mio-test/mio-test-b',
  );
  const topology = computeTopology('mio-test');
  const exchanges = topology.filter(({ path }) => path.startsWith('exchanges/'));
  expect(exchanges).toHaveLength(4);
  expect(writes).toEqual(exchanges.map(({ path }) => path));

  values.set(policyPath, testPolicy);
  await expect(prepareLocalBroker('test', testEnv)).rejects.toThrow(
    'LOCAL_BROKER_PREPROVISION_REQUIRED: users/mio-test-a, permissions/mio-test/mio-test-a, users/mio-test-b, permissions/mio-test/mio-test-b',
  );
  expect(writes).toEqual(topology.map(({ path }) => path));
  expect(connect).not.toHaveBeenCalled();

  provisionTestRoles(values);
  await prepareLocalBroker('test', testEnv);
  expect(writes).toEqual(topology.map(({ path }) => path));
  expect(connect).toHaveBeenCalledTimes(2);
});

it('allows the independent administrator to provision every protected resource before concurrent declarations', async () => {
  const bothReady = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let arrivals = 0;
  const { values, writes } = brokerFixture(async () => {
    if (++arrivals === 2) bothReady.resolve();
    await release.promise;
  });
  const vhost = { description: 'operator managed', tags: ['owned'] };
  values.set('vhosts/mio-test', vhost);
  const initializations = Promise.allSettled([
    prepareLocalBroker('test', testEnv),
    prepareLocalBroker('test', { ...testEnv, MIO_LOCAL_RABBITMQ_A_PASSWORD: 'another-a-password' }),
  ]);
  const edits = new Map([
    [policyPath, { ...testPolicy, priority: 5 }],
    ['users/mio-test-a', { ...userMetadata, tags: ['monitoring'], operatorPassword: 'retained' }],
    ['permissions/mio-test/mio-test-a', { configure: '^$', write: '^other$', read: '^other$' }],
  ] as [string, unknown][]);
  try {
    await Promise.race([
      bothReady.promise,
      initializations.then(() => {
        throw new Error('initializers finished before declarations');
      }),
    ]);
    for (const [path, value] of edits) values.set(path, value);
  } finally {
    release.resolve();
  }
  const results = await initializations;
  for (const result of results) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBeInstanceOf(Error);
      expect(result.reason.message as string).toContain('LOCAL_BROKER_PREPROVISION_REQUIRED');
      expect(result.reason.message as string).not.toContain('fixture-a-password');
    }
  }
  expect(writes).toHaveLength(8);
  expect(writes.every((path) => path.startsWith('exchanges/'))).toBe(true);
  for (const [path, value] of edits) expect(values.get(path)).toEqual(value);
  expect(values.get('vhosts/mio-test')).toEqual(vhost);
  await expect(prepareLocalBroker('test', testEnv)).rejects.toThrow(
    'LOCAL_BROKER_CONFLICT: operator-policies/mio-test/mio-capacity',
  );
  expect(writes).toHaveLength(8);
});

it('reports permission drift observed after declarations even when both role logins succeed', async () => {
  const path = 'permissions/mio-test/mio-test-b';
  const saved = { ...computePermissions('b'), read: '^mio\\.compute\\..*$' };
  const { values, writes } = brokerFixture(async () => {
    if (writes.length === 1) values.set(path, saved);
  });
  values.set('vhosts/mio-test', {});
  values.set(policyPath, testPolicy);
  provisionTestRoles(values);
  const connect = vi.spyOn(ComputeBroker, 'connect').mockResolvedValue({
    close: async () => {},
  } as ComputeBroker);
  const ready = vi.spyOn(console, 'log');

  await expect(prepareLocalBroker('test', testEnv)).rejects.toThrow(
    `LOCAL_BROKER_CONFLICT: ${path}`,
  );
  expect(connect).toHaveBeenCalledTimes(2);
  expect(values.get(path)).toEqual(saved);
  expect(writes).toEqual(computeTopology('mio-test').map(({ path }) => path));
  expect(ready).not.toHaveBeenCalled();
});

it('lists prerequisites removed during declarations when a role login also fails', async () => {
  const path = 'permissions/mio-test/mio-test-b';
  const { values, writes } = brokerFixture(async () => {
    if (writes.length === 1) {
      values.delete(policyPath);
      values.delete(path);
    }
  });
  values.set('vhosts/mio-test', {});
  values.set(policyPath, testPolicy);
  provisionTestRoles(values);
  vi.spyOn(ComputeBroker, 'connect')
    .mockResolvedValueOnce({ close: async () => {} } as ComputeBroker)
    .mockRejectedValueOnce(new Error('role cannot enter vhost'));

  await expect(prepareLocalBroker('test', testEnv)).rejects.toThrow(
    `LOCAL_BROKER_PREPROVISION_REQUIRED: ${policyPath}, ${path}`,
  );
  expect(values.has(policyPath)).toBe(false);
  expect(values.has(path)).toBe(false);
  expect(writes).toEqual(computeTopology('mio-test').map(({ path }) => path));
});

it('preserves retired image resources when the current topology already matches', async () => {
  vi.spyOn(ComputeBroker, 'connect').mockResolvedValue({
    close: async () => {},
  } as unknown as ComputeBroker);

  const state = new Map<string, unknown>();
  state.set('vhosts/mio-test', { name: 'mio-test' });
  state.set(audioPolicyPath, audioResultPolicy.definition);
  state.set('operator-policies/mio-test/mio-capacity', {
    pattern: '.*',
    definition: computeCapacity,
    priority: 0,
    'apply-to': 'queues',
  });
  for (const item of computeTopology('mio-test')) {
    state.set(item.path, item.method === 'POST' ? [item.body] : item.body);
  }
  const legacyImageQueue = { messages: 3, durable: true, arguments: { 'x-queue-type': 'quorum' } };
  state.set('queues/mio-test/mio.compute.image.commands.v1', legacyImageQueue);
  state.set('users/mio-test-a', {
    name: 'mio-test-a',
    has_password: true,
    hashing_algorithm: 'rabbit_password_hashing_sha256',
    tags: [],
  });
  state.set('users/mio-test-b', {
    name: 'mio-test-b',
    has_password: true,
    hashing_algorithm: 'rabbit_password_hashing_sha256',
    tags: [],
  });
  state.set('permissions/mio-test/mio-test-a', {
    user: 'mio-test-a',
    vhost: 'mio-test',
    ...computePermissions('a'),
  });
  state.set('permissions/mio-test/mio-test-b', {
    user: 'mio-test-b',
    vhost: 'mio-test',
    ...computePermissions('b'),
  });

  const mutations: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL, init: RequestInit) => {
      const method = init.method ?? 'GET';
      const path = input.pathname.replace(/^\/api\//, '');
      if (path === 'health/checks/ready-to-serve-clients') return Response.json({ status: 'ok' });
      if (path === 'feature-flags')
        return Response.json([{ name: 'stream_queue', state: 'enabled' }]);
      if (method === 'GET') {
        if (!state.has(path)) return Response.json({}, { status: 404 });
        return Response.json(state.get(path));
      }
      const body = init.body ? (JSON.parse(String(init.body)) as unknown) : {};
      mutations.push({ method, path, body });
      state.set(path, method === 'POST' ? [body] : body);
      return new Response(null, { status: 201 });
    }),
  );

  const env = {
    RABBITMQ_URL: 'amqp://127.0.0.1:56721/mio-test',
    MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT: '15681',
    MIO_LOCAL_RABBITMQ_PASSWORD: 'admin-password',
    MIO_LOCAL_RABBITMQ_A_PASSWORD: 'a-password',
    MIO_LOCAL_RABBITMQ_B_PASSWORD: 'b-password',
  };

  await prepareLocalBroker('test', env);
  expect(mutations).toEqual([]);
  expect(state.get('queues/mio-test/mio.compute.image.commands.v1')).toBe(legacyImageQueue);
  expect(computeTopology('mio-test').some((entry) => entry.path.includes('image'))).toBe(false);

  mutations.length = 0;
  await prepareLocalBroker('test', env);
  expect(mutations).toEqual([]);
});

it('rejects non-legacy Role B permission drift with LOCAL_BROKER_CONFLICT before writing anything', async () => {
  const methods: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL, init: RequestInit) => {
      methods.push(init.method ?? 'GET');
      const path = input.pathname.replace(/^\/api\//, '');
      if (path === 'health/checks/ready-to-serve-clients') return Response.json({ status: 'ok' });
      if (path === 'feature-flags')
        return Response.json([{ name: 'stream_queue', state: 'enabled' }]);
      if (path === 'permissions/mio-test/mio-test-b') {
        return Response.json({
          user: 'mio-test-b',
          vhost: 'mio-test',
          configure: '^$',
          write: '^mio\\.compute\\.results\\.v1$',
          read: '^mio\\.compute\\..*$',
        });
      }
      return Response.json({}, { status: 404 });
    }),
  );
  await expect(
    prepareLocalBroker('test', {
      MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT: '15681',
      MIO_LOCAL_RABBITMQ_PASSWORD: 'admin-password',
      MIO_LOCAL_RABBITMQ_A_PASSWORD: 'a-password',
      MIO_LOCAL_RABBITMQ_B_PASSWORD: 'b-password',
    }),
  ).rejects.toThrow('LOCAL_BROKER_CONFLICT: permissions/mio-test/mio-test-b');
  expect(new Set(methods)).toEqual(new Set(['GET']));
});

it('leaves the new stream absent until its own scoped retention policy exists', async () => {
  const { values, writes } = brokerFixture();
  values.set('vhosts/mio-test', {});
  values.set(policyPath, testPolicy);
  values.delete(audioPolicyPath);
  provisionTestRoles(values);
  vi.spyOn(ComputeBroker, 'connect').mockResolvedValue({
    close: async () => {},
  } as ComputeBroker);

  await expect(prepareLocalBroker('test', testEnv)).rejects.toThrow(
    `LOCAL_BROKER_PREPROVISION_REQUIRED: ${audioPolicyPath}`,
  );
  expect(writes.some((path) => path.endsWith('/mio.compute.results.v1'))).toBe(true);
  expect(writes.some((path) => path.endsWith('/mio.compute.audio.results.v1'))).toBe(false);
  values.set(audioPolicyPath, audioResultPolicy.definition);
  await prepareLocalBroker('test', testEnv);
  expect(writes.filter((path) => path.endsWith('/mio.compute.audio.results.v1'))).toHaveLength(2);
});
