import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createWechatClient } from '../../src/integrations/wechat.ts';

afterEach(() => vi.restoreAllMocks());

it('uses fixed destinations, refuses redirects and hides provider failures', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  fetcher.mockResolvedValueOnce(
    Response.json({
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      openid: 'fixture-openid',
      expires_in: 7200,
      scope: 'snsapi_login',
    }),
  );
  fetcher.mockResolvedValueOnce(
    Response.json({ openid: 'fixture-openid', nickname: 'Fixture', unionid: 'optional' }),
  );
  const client = createWechatClient(
    { appId: 'fixture-app', appSecret: 'fixture-secret' },
    'auth.mio.invalid',
  );
  const tokens = await client.exchangeCode('fixture-code');
  const profile = await client.getUserInfo(tokens);
  const legacyHash = createHash('sha256')
    .update(JSON.stringify(['fixture-app', 'fixture-openid']))
    .digest('hex')
    .slice(0, 56);
  expect(profile.user.email).toBe(`wechat-${legacyHash}@auth.mio.invalid`);
  expect(profile.user.emailVerified).toBe(false);
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/sns/oauth2/access_token',
    '/sns/userinfo',
  ]);
  for (const [url, options] of fetcher.mock.calls) {
    expect(new URL(String(url)).origin).toBe('https://api.weixin.qq.com');
    expect(options?.redirect).toBe('error');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
  const redirected = new Response('failure', {
    status: 302,
    headers: { location: 'https://other.test/' },
  });
  fetcher.mockResolvedValueOnce(redirected);
  await expect(client.exchangeCode('fixture-code')).rejects.toThrow('WECHAT_UNAVAILABLE');
  expect(redirected.bodyUsed).toBe(true);
  fetcher.mockRejectedValueOnce(new Error('fixture-secret and fixture-access'));
  await expect(client.exchangeCode('fixture-code')).rejects.toThrow(/^WECHAT_UNAVAILABLE$/);
  fetcher.mockResolvedValueOnce(new Response('x'.repeat(32769)));
  await expect(client.exchangeCode('fixture-code')).rejects.toThrow('WECHAT_UNAVAILABLE');
  fetcher.mockResolvedValueOnce(Response.json({ openid: 'different-openid' }));
  await expect(client.getUserInfo(tokens)).rejects.toThrow('WECHAT_UNAVAILABLE');
  const time = vi.spyOn(performance, 'now');
  time.mockReturnValueOnce(0).mockReturnValueOnce(5000);
  fetcher.mockResolvedValueOnce(Response.json({ openid: 'fixture-openid' }));
  await expect(client.getUserInfo(tokens)).rejects.toThrow('WECHAT_UNAVAILABLE');
});

it('aborts a stalled response body at the request deadline', async () => {
  let closed!: () => void;
  const responseClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"access_token":');
    response.on('close', closed);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, options) =>
    originalFetch(`http://127.0.0.1:${address.port}/`, options),
  );
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => originalTimeout(150));
  try {
    const client = createWechatClient(
      { appId: 'fixture-app', appSecret: 'fixture-secret' },
      'auth.mio.invalid',
    );
    await expect(client.exchangeCode('fixture-code')).rejects.toThrow('WECHAT_UNAVAILABLE');
    await responseClosed;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('does not follow an actual upstream redirect', async () => {
  let destinationRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/destination' });
      response.end();
    } else {
      destinationRequests++;
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, options) =>
    originalFetch(`http://127.0.0.1:${address.port}/redirect`, options),
  );
  try {
    const client = createWechatClient(
      { appId: 'fixture-app', appSecret: 'fixture-secret' },
      'auth.mio.invalid',
    );
    await expect(client.exchangeCode('fixture-code')).rejects.toThrow('WECHAT_UNAVAILABLE');
    expect(destinationRequests).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
