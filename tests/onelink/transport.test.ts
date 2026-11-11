import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { chatTransport } from '../../src/integrations/onelink/chat.ts';

it('uses the actual fetch redirect refusal and never forwards authentication to the redirect target', async () => {
  let targetCalls = 0;
  let sourceCalls = 0;
  const target = createServer((_request, response) => {
    targetCalls++;
    response.end('must not reach');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetAddress = target.address();
  if (!targetAddress || typeof targetAddress === 'string') throw new Error('fixture address');
  const source = createServer((_request, response) => {
    sourceCalls++;
    response.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/leak` });
    response.end();
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const address = source.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  const nativeFetch = fetch;
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    return nativeFetch(`http://127.0.0.1:${address.port}/redirect`, {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      signal: request.signal,
      redirect: request.redirect,
    });
  };
  try {
    const guarded = chatTransport('synthetic-redirect-key', '/v1/chat/completions', {}, transport);
    await expect(
      guarded('https://api.onelinkai.cloud/v1/chat/completions', { method: 'POST', body: '{}' }),
    ).rejects.toThrow('ONELINK_TRANSPORT_FAILED');
    expect(sourceCalls).toBe(1);
    expect(targetCalls).toBe(0);
    await expect(
      guarded('https://different.invalid/v1/chat/completions', { method: 'POST' }),
    ).rejects.toThrow('ONELINK_DESTINATION_DENIED');
    expect(sourceCalls).toBe(1);
  } finally {
    source.closeAllConnections();
    target.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => source.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve())),
    ]);
  }
});
