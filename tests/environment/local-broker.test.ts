import { afterEach, expect, it, vi } from 'vitest';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { computeCapacity, computeTopology } from '../../scripts/service/compute-broker-topology.ts';
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
      return Response.json({}, { status: 404 });
    }),
  );
  await expect(
    prepareLocalBroker('test', {
      MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT: '15681',
      MIO_LOCAL_RABBITMQ_PASSWORD: 'never-log-secret',
    }),
  ).rejects.toThrow(
    'LOCAL_BROKER_REQUEST_UNKNOWN: PUT vhosts/mio-test; inspect broker then rerun initialization',
  );
  expect(methods.filter((method) => method !== 'GET')).toEqual(['PUT']);
});

it('preserves retired image resources and only prepares the heavy-media topology', async () => {
  vi.spyOn(ComputeBroker, 'connect').mockResolvedValue({
    close: async () => {},
  } as unknown as ComputeBroker);

  const state = new Map<string, unknown>();
  state.set('vhosts/mio-test', { name: 'mio-test' });
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
    configure: '^$',
    write: '^mio\\.compute\\.commands\\.v1$',
    read: '^mio\\.compute\\.results\\.v1$',
  });
  state.set('permissions/mio-test/mio-test-b', {
    user: 'mio-test-b',
    vhost: 'mio-test',
    configure: '^$',
    write: '^mio\\.compute\\.results\\.v1$',
    read: '^mio\\.compute\\.commands\\.v1$',
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
