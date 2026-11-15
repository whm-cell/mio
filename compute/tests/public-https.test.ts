import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from 'node:zlib';
import { Agent, MockAgent, Response as UndiciResponse } from 'undici';
import { expect, it, vi } from 'vitest';
import { withPublicHttps } from '../src/adapters/public-https.ts';

type Dependencies = NonNullable<Parameters<typeof withPublicHttps>[3]>;

function fixture(addresses: { address: string; family: number }[], all = true) {
  const connected: string[] = [];
  const resolveAll: NonNullable<Dependencies['resolveAll']> = vi.fn((_host, done) =>
    done(null, addresses),
  );
  const agent = new Agent();
  let lookup: LookupFunction;
  const createAgent: NonNullable<Dependencies['createAgent']> = vi.fn((value) => {
    lookup = value;
    return agent;
  });
  const fetch: NonNullable<Dependencies['fetch']> = vi.fn(async (input, options) => {
    const host = new URL(String(input)).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) connected.push(host);
    else
      await new Promise<void>((resolve, reject) => {
        lookup(host, { all }, (error, value) => {
          if (error) return reject(error);
          connected.push(...(Array.isArray(value) ? value.map((item) => item.address) : [value]));
          resolve();
        });
      });
    expect(options?.method).toBe('GET');
    expect(options?.redirect).toBe('error');
    expect(options?.headers).toBeUndefined();
    return new UndiciResponse('image');
  }) as NonNullable<Dependencies['fetch']>;
  return { resolveAll, createAgent, fetch, agent, connected };
}

async function bytes(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}
const text = async (response: Response) => (await bytes(response)).toString();

it('accepts arbitrary public hosts and binds the connection lookup to public addresses only', async () => {
  const f = fixture([
    { address: '10.0.0.7', family: 4 },
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '::ffff:127.0.0.1', family: 6 },
  ]);
  const close = vi.spyOn(f.agent, 'close');
  expect(
    await withPublicHttps(
      new URL('https://new-cdn.example/image'),
      AbortSignal.timeout(2000),
      text,
      f,
    ),
  ).toBe('image');
  expect(f.resolveAll).toHaveBeenCalledOnce();
  expect(f.connected).toEqual(['8.8.8.8', '2606:4700:4700::1111']);
  expect(new URL(String(vi.mocked(f.fetch).mock.calls[0]![0])).hostname).toBe('new-cdn.example');
  expect(close).toHaveBeenCalled();
  expect(f.agent.closed).toBe(true);
});

it.each([
  '127.0.0.1',
  '10.0.0.1',
  '100.64.0.1',
  '169.254.169.254',
  '192.0.2.1',
  '::1',
  '::2',
  'fc00::1',
  'fe80::1',
  '2001:db8::1',
  '::ffff:127.0.0.1',
  '64:ff9b::a00:1',
])('rejects a non-public literal %s before creating a dispatcher', async (address) => {
  const f = fixture([]);
  const host = isIP(address) === 6 ? `[${address}]` : address;
  await expect(
    withPublicHttps(new URL(`https://${host}/`), AbortSignal.timeout(1000), text, f),
  ).rejects.toThrow();
  expect(f.createAgent).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
  await f.agent.close();
});

it('blocks a private DNS answer in a real undici Agent lookup before a connection', async () => {
  const resolveAll = vi.fn<NonNullable<Dependencies['resolveAll']>>((_host, done) =>
    done(null, [{ address: '127.0.0.1', family: 4 }]),
  );
  await expect(
    withPublicHttps(new URL('https://rebind.example/'), AbortSignal.timeout(2000), text, {
      resolveAll,
    }),
  ).rejects.toMatchObject({ cause: { code: 'ENOTFOUND' } });
  expect(resolveAll).toHaveBeenCalledOnce();
});

it('uses the vetted lookup result instead of resolving a rebinding hostname twice', async () => {
  const f = fixture([], false);
  const resolveAll: NonNullable<Dependencies['resolveAll']> = vi
    .fn()
    .mockImplementationOnce((_host, done) => done(null, [{ address: '8.8.8.8', family: 4 }]))
    .mockImplementationOnce((_host, done) => done(null, [{ address: '127.0.0.1', family: 4 }]));
  expect(
    await withPublicHttps(new URL('https://rebinding.example/'), AbortSignal.timeout(1000), text, {
      ...f,
      resolveAll,
    }),
  ).toBe('image');
  expect(resolveAll).toHaveBeenCalledOnce();
  expect(f.connected).toEqual(['8.8.8.8']);
});

it.each(['8.8.8.8', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
  'allows a public literal %s without DNS',
  async (address) => {
    const f = fixture([]);
    const host = isIP(address) === 6 ? `[${address}]` : address;
    expect(
      await withPublicHttps(new URL(`https://${host}/`), AbortSignal.timeout(1000), text, f),
    ).toBe('image');
    expect(f.resolveAll).not.toHaveBeenCalled();
  },
);

it('rejects redirects without requesting the destination and destroys its agent', async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const source = vi.fn(() => ({
    statusCode: 302,
    data: '',
    responseOptions: { headers: { location: 'https://destination.example/' } },
  }));
  const destination = vi.fn(() => ({ statusCode: 200, data: 'unexpected' }));
  agent.get('https://source.example').intercept({ path: '/', method: 'GET' }).reply(source);
  agent
    .get('https://destination.example')
    .intercept({ path: '/', method: 'GET' })
    .reply(destination);
  const destroy = vi.spyOn(agent, 'destroy').mockImplementation(() => agent.close());
  await expect(
    withPublicHttps(new URL('https://source.example/'), AbortSignal.timeout(1000), text, {
      createAgent: () => agent,
    }),
  ).rejects.toThrow();
  expect(source).toHaveBeenCalledOnce();
  expect(destination).not.toHaveBeenCalled();
  expect(destroy).toHaveBeenCalled();
});

it('cancels unread response bodies, closes the agent, and destroys it on consumer failure', async () => {
  const cancel = vi.fn();
  const response = new UndiciResponse(new ReadableStream<Uint8Array>({ cancel }));
  const f = fixture([{ address: '8.8.8.8', family: 4 }]);
  const close = vi.spyOn(f.agent, 'close');
  const fetch = vi.fn(async () => response) as NonNullable<Dependencies['fetch']>;
  expect(
    await withPublicHttps(
      new URL('https://new-cdn.example/'),
      AbortSignal.timeout(1000),
      async () => 42,
      { ...f, fetch },
    ),
  ).toBe(42);
  expect(cancel).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalled();
  expect(f.agent.closed).toBe(true);
  const failed = fixture([]);
  const destroy = vi.spyOn(failed.agent, 'destroy');
  const failedFetch = vi.fn(async () => new UndiciResponse('image')) as NonNullable<
    Dependencies['fetch']
  >;
  await expect(
    withPublicHttps(
      new URL('https://new-cdn.example/'),
      AbortSignal.timeout(1000),
      async () => {
        throw new Error('consumer failed');
      },
      { ...failed, fetch: failedFetch },
    ),
  ).rejects.toThrow('consumer failed');
  expect(destroy).toHaveBeenCalled();
});

it('aborts a real undici request while its DNS lookup is pending', async () => {
  const controller = new AbortController();
  let finish: Parameters<NonNullable<Dependencies['resolveAll']>>[1] | undefined;
  const pending = withPublicHttps(
    new URL('https://dns-pending.example/'),
    controller.signal,
    text,
    {
      resolveAll: (_host, done) => {
        finish = done;
      },
    },
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  finish!(null, [{ address: '127.0.0.1', family: 4 }]);
  await expect(pending).rejects.toThrow();
});

it('settles an aborted request even when DNS never calls back', async () => {
  const pending = withPublicHttps(
    new URL('https://dns-never.example/'),
    AbortSignal.timeout(50),
    text,
    {
      resolveAll: () => {},
    },
  );
  const outcome = await Promise.race([
    pending.then(
      () => 'unexpected',
      () => 'aborted',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
  ]);
  expect(outcome).toBe('aborted');
});

it.each([
  ['gzip', gzipSync],
  ['deflate', deflateSync],
  ['deflate', deflateRawSync],
  ['br', brotliCompressSync],
  ['zstd', zstdCompressSync],
  ['gzip, br', (value: Buffer) => brotliCompressSync(gzipSync(value))],
] as const)('retains fetch decoding for %s responses', async (name, compress) => {
  const original = Buffer.from('image-data'.repeat(10_000));
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get('https://cdn.example')
    .intercept({ path: '/', method: 'GET' })
    .reply(200, compress(original), { headers: { 'content-encoding': name } });
  const result = await withPublicHttps(
    new URL('https://cdn.example/'),
    AbortSignal.timeout(3000),
    bytes,
    { createAgent: () => agent },
  );
  expect(result).toEqual(original);
});
