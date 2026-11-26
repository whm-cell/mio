import { afterEach, expect, it, vi } from 'vitest';
import {
  COMMAND_EXCHANGE,
  COMMAND_QUEUE,
  COMMAND_ROUTING_KEY,
  RESULT_QUEUE,
  VIDEO_PROBE_COMMAND_QUEUE,
  VIDEO_PROBE_COMMAND_ROUTING_KEY,
  VIDEO_PROBE_RESULT_ROUTING_KEY,
} from '@mio/compute-contracts';
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
      if (init.method === 'DELETE') {
        const slash = path.lastIndexOf('/');
        const bindingPath = path.slice(0, slash);
        const key = decodeURIComponent(path.slice(slash + 1));
        const bindings = values.get(bindingPath);
        if (!Array.isArray(bindings)) return new Response(null, { status: 404 });
        values.set(
          bindingPath,
          bindings.filter((binding) => binding.properties_key !== key),
        );
        return new Response(null, { status: 204 });
      }
      const body: unknown = JSON.parse(String(init.body));
      if (init.method === 'POST') {
        const bindings = values.get(path);
        values.set(path, [...(Array.isArray(bindings) ? bindings : []), body]);
      } else values.set(path, body);
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
    if (item.method === 'POST') {
      const bindings = state.get(item.path);
      state.set(item.path, [...(Array.isArray(bindings) ? bindings : []), item.body]);
    } else state.set(item.path, item.body);
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
      if (method === 'POST') {
        const bindings = state.get(path);
        state.set(path, [...(Array.isArray(bindings) ? bindings : []), body]);
      } else state.set(path, body);
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

it('upgrades an existing video and audio topology after exact operator ACL provisioning', async () => {
  const instanceId = `mio-test-${'1'.repeat(64)}`;
  const env = { ...testEnv, MIO_LOCAL_COMPUTE_INSTANCE_ID: instanceId };
  const { values, writes } = brokerFixture();
  values.set('vhosts/mio-test', { description: 'existing vhost' });
  values.set(policyPath, testPolicy);
  const aPath = 'permissions/mio-test/mio-test-a';
  const bPath = 'permissions/mio-test/mio-test-b';
  for (const role of ['a', 'b'] as const)
    values.set(`users/mio-test-${role}`, { ...userMetadata, passwordMarker: role });
  values.set(aPath, {
    ...computePermissions('a'),
    read: '^(?:mio\\.compute\\.results\\.v1|mio\\.compute\\.audio\\.results\\.v1)$',
  });
  values.set(bPath, {
    ...computePermissions('b'),
    read: '^(?:mio\\.compute\\.commands\\.v1|mio\\.compute\\.audio\\.commands\\.v1)$',
  });
  const topology = computeTopology('mio-test', [instanceId]);
  const additions = topology.filter(({ path }) => /mio\.compute\.(media|worker)[.-]/.test(path));
  for (const scope of topology.filter((entry) => !additions.includes(entry))) {
    if (scope.method === 'POST') {
      const existing = values.get(scope.path);
      values.set(scope.path, [...(Array.isArray(existing) ? existing : []), scope.body]);
    } else values.set(scope.path, { ...scope.body, messages: 3 });
  }
  const audioStreamPath = 'queues/mio-test/mio.compute.audio.results.v1';
  const audioStream = values.get(audioStreamPath);
  expect(audioStream).toMatchObject({ messages: 3, arguments: { 'x-queue-type': 'stream' } });
  await expect(prepareLocalBroker('test', env)).rejects.toThrow(`LOCAL_BROKER_CONFLICT: ${aPath}`);
  expect(writes).toEqual([]);

  // Only the deployment administrator changes role ACLs. The initializer never writes them.
  values.set(aPath, computePermissions('a'));
  values.set(bPath, computePermissions('b', instanceId));
  const connect = vi
    .spyOn(ComputeBroker, 'connect')
    .mockResolvedValue({ close: async () => {} } as ComputeBroker);
  await prepareLocalBroker('test', env);
  expect(writes).toEqual(additions.map(({ path }) => path));
  const before = [...writes];
  await prepareLocalBroker('test', env);
  expect(writes).toEqual(before);
  expect(connect).toHaveBeenCalledTimes(4);
  expect(values.get('users/mio-test-a')).toMatchObject({ passwordMarker: 'a', tags: [] });
  expect(values.get('users/mio-test-b')).toMatchObject({ passwordMarker: 'b', tags: [] });
  expect(values.get(audioStreamPath)).toBe(audioStream);
});

it('requires an explicit probe cutover, then binds and verifies before removing the former route', async () => {
  const oldPath = `bindings/mio-test/e/${COMMAND_EXCHANGE}/q/${COMMAND_QUEUE}`;
  const newPath = `bindings/mio-test/e/${COMMAND_EXCHANGE}/q/${VIDEO_PROBE_COMMAND_QUEUE}`;
  const former = {
    routing_key: VIDEO_PROBE_COMMAND_ROUTING_KEY,
    arguments: {},
    properties_key: VIDEO_PROBE_COMMAND_ROUTING_KEY,
  };
  const transcode = {
    routing_key: COMMAND_ROUTING_KEY,
    arguments: {},
    properties_key: COMMAND_ROUTING_KEY,
  };
  const executed = `${oldPath}/${former.properties_key}`;
  let failBeforeBinding = false;
  const { values, writes } = brokerFixture(async () => {
    if (writes.at(-1) === newPath && failBeforeBinding) throw new Error('unknown binding reply');
    if (writes.at(-1) === executed)
      expect(values.get(newPath)).toMatchObject([{ routing_key: VIDEO_PROBE_COMMAND_ROUTING_KEY }]);
  });
  const commandQueue = `queues/mio-test/${COMMAND_QUEUE}`;
  const original = {
    ...computeTopology('mio-test').find((entry) => entry.path === commandQueue)!.body,
    messages_ready: 2,
    messages_unacknowledged: 1,
  };
  values.set('vhosts/mio-test', {});
  values.set(policyPath, testPolicy);
  values.set(commandQueue, original);
  values.set(oldPath, [transcode, former]);
  provisionTestRoles(values);
  const connect = vi.spyOn(ComputeBroker, 'connect').mockResolvedValue({
    close: async () => {},
  } as ComputeBroker);

  await expect(prepareLocalBroker('test', testEnv)).rejects.toThrow(
    'LOCAL_BROKER_VIDEO_PROBE_MIGRATION_REQUIRED',
  );
  expect(writes).toEqual([]);
  expect(connect).not.toHaveBeenCalled();
  failBeforeBinding = true;
  await expect(prepareLocalBroker('test', testEnv, true)).rejects.toThrow(
    `LOCAL_BROKER_REQUEST_UNKNOWN: POST ${newPath}`,
  );
  expect(values.get(oldPath)).toEqual([transcode, former]);
  expect(writes).not.toContain(executed);
  failBeforeBinding = false;
  writes.length = 0;
  await prepareLocalBroker('test', testEnv, true);
  expect(writes.indexOf(newPath)).toBeGreaterThanOrEqual(0);
  expect(writes.indexOf(executed)).toBeGreaterThan(writes.indexOf(newPath));
  expect(values.get(oldPath)).toEqual([transcode]);
  expect(values.get(commandQueue)).toBe(original);
  expect(computeTopology('mio-test')).toContainEqual(
    expect.objectContaining({
      path: expect.stringMatching(new RegExp(`/q/${RESULT_QUEUE}$`)),
      body: { routing_key: VIDEO_PROBE_RESULT_ROUTING_KEY, arguments: {} },
    }),
  );
  expect(new RegExp(computePermissions('a').read).test(VIDEO_PROBE_COMMAND_QUEUE)).toBe(false);
  expect(new RegExp(computePermissions('b').read).test(VIDEO_PROBE_COMMAND_QUEUE)).toBe(true);
  expect(
    new RegExp(computePermissions('b').read).test('mio.compute.video.probe.commands.dlq.v1'),
  ).toBe(false);
  writes.length = 0;
  await prepareLocalBroker('test', testEnv);
  expect(writes).toEqual([]);
});
