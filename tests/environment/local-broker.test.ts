import { afterEach, expect, it, vi } from 'vitest';
import { prepareLocalBroker } from '../../scripts/service/local-broker.ts';

afterEach(() => vi.unstubAllGlobals());

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
