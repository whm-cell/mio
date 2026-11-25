import { createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAllowedOneLinkClientIds } from '../../src/auth/config.ts';
import {
  buildOneLinkAuthorizeUrl,
  maskOneLinkSub,
  parseOneLinkAccessToken,
  readOneLinkSsoConfig,
  registerOneLinkSsoClient,
} from '../../src/integrations/onelink/sso.ts';
import type { OneLinkSsoConfig } from '../../src/integrations/onelink/sso.ts';

const SYNTHETIC_ENC_KEY = 'synthetic-test-only-enc-key-32ch';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

async function startDouble(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<{ origin: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      handler(request, response, Buffer.concat(chunks).toString('utf8'));
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return { origin: `http://127.0.0.1:${address.port}` };
}

function makeConfig(registerUrl: string, overrides?: Partial<OneLinkSsoConfig>): OneLinkSsoConfig {
  return {
    environment: 'test',
    encryptionKey: SYNTHETIC_ENC_KEY,
    authorizeUrl: 'https://scenic.wanlian.cloud/authorize',
    registerUrl,
    clientName: 'miioo',
    appName: 'Miioo',
    ...overrides,
  };
}

describe('readOneLinkSsoConfig', () => {
  it('returns undefined when none of the required group variables is defined', () => {
    expect(readOneLinkSsoConfig({})).toBeUndefined();
    expect(
      readOneLinkSsoConfig({
        MIO_ENVIRONMENT: 'staging',
        MIO_ONELINK_SSO_CLIENT_NAME: 'miioo',
      }),
    ).toBeUndefined();
  });

  it('fails closed on partial configuration without leaking the key', () => {
    const partialCases: NodeJS.ProcessEnv[] = [
      { MIO_ONELINK_SSO_ENC_KEY: SYNTHETIC_ENC_KEY },
      { MIO_ONELINK_SSO_AUTHORIZE_URL: 'https://scenic.wanlian.cloud/authorize' },
      { MIO_ONELINK_SSO_REGISTER_URL: 'https://api-test.wanlian.cloud/sso/client/register' },
      {
        MIO_ONELINK_SSO_ENC_KEY: SYNTHETIC_ENC_KEY,
        MIO_ONELINK_SSO_AUTHORIZE_URL: 'https://scenic.wanlian.cloud/authorize',
      },
    ];
    for (const env of partialCases) {
      expect(() => readOneLinkSsoConfig(env)).toThrow(/^ONELINK_SSO_CONFIG:/);
    }
  });

  it('rejects invalid encryption keys, URLs, client names, app names and environments', () => {
    const base: NodeJS.ProcessEnv = {
      MIO_ONELINK_SSO_ENC_KEY: SYNTHETIC_ENC_KEY,
      MIO_ONELINK_SSO_AUTHORIZE_URL: 'https://scenic.wanlian.cloud/authorize',
      MIO_ONELINK_SSO_REGISTER_URL: 'https://api-test.wanlian.cloud/sso/client/register',
    };
    const invalidCases: NodeJS.ProcessEnv[] = [
      { ...base, MIO_ONELINK_SSO_ENC_KEY: '' },
      { ...base, MIO_ONELINK_SSO_ENC_KEY: 'a'.repeat(31) },
      { ...base, MIO_ONELINK_SSO_ENC_KEY: 'a'.repeat(33) },
      { ...base, MIO_ONELINK_SSO_ENC_KEY: 'a'.repeat(64) },
      { ...base, MIO_ONELINK_SSO_ENC_KEY: 'a'.repeat(65) },
      { ...base, MIO_ONELINK_SSO_ENC_KEY: '密'.repeat(32) },
      { ...base, MIO_ONELINK_SSO_ENC_KEY: `${'a'.repeat(31)}密` },
      { ...base, MIO_ONELINK_SSO_ENC_KEY: `${'a'.repeat(15)} ${'a'.repeat(16)}` },
      { ...base, MIO_ONELINK_SSO_ENC_KEY: `${'a'.repeat(31)}\n` },
      { ...base, MIO_ONELINK_SSO_AUTHORIZE_URL: 'http://scenic.wanlian.cloud/authorize' },
      {
        ...base,
        MIO_ONELINK_SSO_REGISTER_URL: 'http://api-test.wanlian.cloud/sso/client/register',
      },
      {
        ...base,
        MIO_ONELINK_SSO_AUTHORIZE_URL: 'https://user:pass@scenic.wanlian.cloud/authorize',
      },
      {
        ...base,
        MIO_ONELINK_SSO_REGISTER_URL: 'https://user@api-test.wanlian.cloud/sso/client/register',
      },
      { ...base, MIO_ONELINK_SSO_AUTHORIZE_URL: 'not-a-url' },
      { ...base, MIO_ONELINK_SSO_CLIENT_NAME: '' },
      { ...base, MIO_ONELINK_SSO_CLIENT_NAME: 'miioo app' },
      { ...base, MIO_ONELINK_SSO_CLIENT_NAME: 'routerClientId' },
      { ...base, MIO_ONELINK_SSO_CLIENT_NAME: 'x'.repeat(51) },
      { ...base, MIO_ONELINK_SSO_APP_NAME: '   ' },
      { ...base, MIO_ONELINK_SSO_APP_NAME: 'Miioo\u0007' },
      { ...base, MIO_ONELINK_SSO_APP_NAME: 'x'.repeat(51) },
      { ...base, MIO_ONELINK_SSO_ENV: 'bad env!' },
      { ...base, MIO_ONELINK_SSO_ENV: '' },
    ];
    for (const env of invalidCases) {
      let caught: unknown;
      try {
        readOneLinkSsoConfig(env);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/^ONELINK_SSO_CONFIG:/);
      if (env.MIO_ONELINK_SSO_ENC_KEY) {
        expect((caught as Error).message).not.toContain(env.MIO_ONELINK_SSO_ENC_KEY);
      }
    }
  });

  it('parses valid HTTPS and loopback HTTP configs with defaults and overrides', () => {
    const defaulted = readOneLinkSsoConfig({
      MIO_ENVIRONMENT: 'staging',
      MIO_ONELINK_SSO_ENC_KEY: SYNTHETIC_ENC_KEY,
      MIO_ONELINK_SSO_AUTHORIZE_URL: 'https://scenic.wanlian.cloud/authorize',
      MIO_ONELINK_SSO_REGISTER_URL: 'https://api-test.wanlian.cloud/sso/client/register',
    });
    expect(defaulted).toEqual({
      environment: 'staging',
      encryptionKey: SYNTHETIC_ENC_KEY,
      authorizeUrl: 'https://scenic.wanlian.cloud/authorize',
      registerUrl: 'https://api-test.wanlian.cloud/sso/client/register',
      clientName: 'miioo',
      appName: 'Miioo',
    });

    const loopback = readOneLinkSsoConfig({
      MIO_ONELINK_SSO_ENC_KEY: SYNTHETIC_ENC_KEY,
      MIO_ONELINK_SSO_AUTHORIZE_URL: 'http://127.0.0.1:4100/authorize',
      MIO_ONELINK_SSO_REGISTER_URL: 'http://localhost:4100/sso/client/register',
      MIO_ONELINK_SSO_CLIENT_NAME: 'miioo_qa',
      MIO_ONELINK_SSO_APP_NAME: 'Miioo QA',
      MIO_ONELINK_SSO_ENV: 'qa-1',
    });
    expect(loopback).toEqual({
      environment: 'qa-1',
      encryptionKey: SYNTHETIC_ENC_KEY,
      authorizeUrl: 'http://127.0.0.1:4100/authorize',
      registerUrl: 'http://localhost:4100/sso/client/register',
      clientName: 'miioo_qa',
      appName: 'Miioo QA',
    });
  });
});

describe('resolveAllowedOneLinkClientIds', () => {
  it('returns pinned expectedClientId when present and always excludes routerClientId', () => {
    expect(resolveAllowedOneLinkClientIds('miioo', 'miiooClientId', 'pinnedClientId')).toEqual([
      'pinnedClientId',
    ]);
    expect(resolveAllowedOneLinkClientIds('miioo', 'miiooClientId', 'routerClientId')).toEqual([]);
    expect(resolveAllowedOneLinkClientIds('miioo', null, null)).toEqual(['miioo', 'miiooClientId']);
    expect(resolveAllowedOneLinkClientIds('miioo', 'miiooClientId', null)).toEqual([
      'miiooClientId',
      'miioo',
    ]);
    expect(resolveAllowedOneLinkClientIds('miioo', 'custom-id', null)).toEqual([
      'custom-id',
      'miioo',
      'miiooClientId',
    ]);
    expect(resolveAllowedOneLinkClientIds('router', 'routerClientId', null)).toEqual(['router']);
  });
});

describe('registerOneLinkSsoClient', () => {
  it('handles 200, 362, 363, 364 and rejects invalid 200 payloads without retry or key leak', async () => {
    const requests: {
      method: string | undefined;
      contentType: string | undefined;
      body: string;
    }[] = [];
    let mode = '200';
    const { origin } = await startDouble((request, response, body) => {
      requests.push({
        method: request.method,
        contentType: request.headers['content-type'],
        body,
      });
      if (mode === '200') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            traceId: 'trace-200',
            code: 200,
            message: 'ok',
            data: { clientId: 'miiooClientId', clientName: 'miioo' },
          }),
        );
        return;
      }
      if (mode === '362') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ traceId: 'trace-362', code: 362, message: 'already exists' }),
        );
        return;
      }
      if (mode === '363') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ traceId: 'trace-363', code: 363, message: 'name contains spaces' }),
        );
        return;
      }
      if (mode === '364') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ traceId: 'trace-364', code: 364, message: 'template missing' }),
        );
        return;
      }
      if (mode === '200-missing-id') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ traceId: 'trace-miss', code: 200, data: {} }));
        return;
      }
      if (mode === '200-router-id') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            traceId: 'trace-router',
            code: 200,
            data: { clientId: 'routerClientId', clientName: 'miioo' },
          }),
        );
        return;
      }
      if (mode === '200-wrong-name') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            traceId: 'trace-name',
            code: 200,
            data: { clientId: 'otherClientId', clientName: 'other' },
          }),
        );
        return;
      }
      if (mode === 'http-500-code-200') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            traceId: 'trace-500',
            code: 200,
            data: { clientId: 'miiooClientId', clientName: 'miioo' },
          }),
        );
        return;
      }
      if (mode === 'key-echo') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            traceId: `leak-${SYNTHETIC_ENC_KEY}`,
            code: 200,
            message: `raw-${SYNTHETIC_ENC_KEY}`,
            data: { clientId: `cid-${SYNTHETIC_ENC_KEY}`, clientName: 'miioo' },
          }),
        );
        return;
      }
    });

    const config = makeConfig(`${origin}/sso/client/register`);

    mode = '200';
    expect(await registerOneLinkSsoClient(config)).toEqual({
      kind: 'registered',
      code: 200,
      clientId: 'miiooClientId',
      clientName: 'miioo',
      traceId: 'trace-200',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ clientName: 'miioo' }),
    });

    mode = '362';
    expect(await registerOneLinkSsoClient(config)).toEqual({
      kind: 'already_exists',
      code: 362,
      traceId: 'trace-362',
    });

    mode = '363';
    expect(await registerOneLinkSsoClient(config)).toEqual({
      kind: 'rejected',
      code: 363,
      errorCode: 'ONELINK_CLIENT_NAME_INVALID',
      traceId: 'trace-363',
    });

    mode = '364';
    expect(await registerOneLinkSsoClient(config)).toEqual({
      kind: 'rejected',
      code: 364,
      errorCode: 'ONELINK_CLIENT_TEMPLATE_MISSING',
      traceId: 'trace-364',
    });

    mode = '200-missing-id';
    expect(await registerOneLinkSsoClient(config)).toEqual({
      kind: 'failed',
      code: 200,
      errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
      traceId: 'trace-miss',
    });

    mode = '200-router-id';
    expect(await registerOneLinkSsoClient(config)).toEqual({
      kind: 'failed',
      code: 200,
      errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
      traceId: 'trace-router',
    });

    mode = '200-wrong-name';
    expect(await registerOneLinkSsoClient(config)).toEqual({
      kind: 'failed',
      code: 200,
      errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
      traceId: 'trace-name',
    });

    mode = 'http-500-code-200';
    expect(await registerOneLinkSsoClient(config)).toEqual({
      kind: 'failed',
      code: 200,
      errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
      traceId: 'trace-500',
    });

    mode = 'key-echo';
    const leaked = await registerOneLinkSsoClient(config);
    expect(leaked).toEqual({
      kind: 'failed',
      code: 200,
      errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
      traceId: null,
    });
    expect(JSON.stringify(leaked)).not.toContain(SYNTHETIC_ENC_KEY);
    expect(requests).toHaveLength(9);
  });

  it('rejects malformed non-JSON upstream bodies without leaking content', async () => {
    const rawHtml = `<html><body>502 Bad Gateway internal-leak-${SYNTHETIC_ENC_KEY}</body></html>`;
    const { origin } = await startDouble((_request, response) => {
      response.writeHead(502, { 'content-type': 'text/html' });
      response.end(rawHtml);
    });

    const result = await registerOneLinkSsoClient(makeConfig(`${origin}/sso/client/register`));
    expect(result).toEqual({
      kind: 'failed',
      code: null,
      errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
      traceId: null,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Bad Gateway');
    expect(serialized).not.toContain('internal-leak');
    expect(serialized).not.toContain(SYNTHETIC_ENC_KEY);
  });

  it('rejects redirects without following them', async () => {
    let targetHits = 0;
    const { origin } = await startDouble((request, response) => {
      if (request.url === '/sso/client/register') {
        response.writeHead(302, { location: '/redirected-target' });
        response.end();
        return;
      }
      targetHits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 200, data: { clientId: 'shouldNotFollow' } }));
    });

    const result = await registerOneLinkSsoClient(makeConfig(`${origin}/sso/client/register`));
    expect(result).toEqual({
      kind: 'failed',
      code: null,
      errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
      traceId: null,
    });
    expect(targetHits).toBe(0);
  });

  it('rejects response bodies larger than 32 KiB without leaking upstream content', async () => {
    const oversizedPayload = JSON.stringify({
      code: 200,
      data: { clientId: 'miiooClientId' },
      pad: `${SYNTHETIC_ENC_KEY}-${'x'.repeat(34 * 1024)}`,
    });
    const { origin } = await startDouble((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(oversizedPayload);
    });

    const result = await registerOneLinkSsoClient(makeConfig(`${origin}/sso/client/register`));
    expect(result).toEqual({
      kind: 'failed',
      code: null,
      errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
      traceId: null,
    });
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_ENC_KEY);
  });

  it('enforces real abort timeout with zero retries', async () => {
    let requestCount = 0;
    let closed!: () => void;
    const responseClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const { origin } = await startDouble((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"code":200');
      response.on('close', closed);
    });

    const result = await registerOneLinkSsoClient(makeConfig(`${origin}/sso/client/register`), {
      timeoutMs: 120,
    });
    await responseClosed;
    expect(result).toEqual({
      kind: 'failed',
      code: null,
      errorCode: 'ONELINK_REGISTER_UPSTREAM_FAILED',
      traceId: null,
    });
    expect(requestCount).toBe(1);
  });
});

function decryptEncParam(enc: string, key: string): Record<string, unknown> {
  const parts = enc.split(':');
  expect(parts).toHaveLength(3);
  const [ivB64, authTagB64, cipherB64] = parts;
  const iv = Buffer.from(ivB64!, 'base64');
  const authTag = Buffer.from(authTagB64!, 'base64');
  const ciphertext = Buffer.from(cipherB64!, 'base64');
  expect(iv).toHaveLength(12);
  expect(authTag).toHaveLength(16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as Record<string, unknown>;
}

function makeJwt(payload: unknown, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }) {
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedHeader}.${encodedPayload}.synthetic-sig`;
}

describe('buildOneLinkAuthorizeUrl', () => {
  it('encrypts the exact 6-field Wanlian payload in iv:authTag:ciphertext AES-256-GCM format', () => {
    const config = makeConfig('https://api-test.wanlian.cloud/sso/client/register');
    const fixedIv = Buffer.from('0102030405060708090a0b0c', 'hex');
    const fixedTimestamp = 1_764_000_000_123;
    const baseURL = 'https://mio-tunnel.example.test';

    const url = buildOneLinkAuthorizeUrl(config, {
      baseURL,
      timestamp: fixedTimestamp,
      iv: fixedIv,
    });
    expect(url).not.toContain(SYNTHETIC_ENC_KEY);

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://scenic.wanlian.cloud');
    expect(parsed.pathname).toBe('/authorize');
    expect([...parsed.searchParams.keys()]).toEqual(['enc']);

    const rawEnc = parsed.searchParams.get('enc')!;
    expect(url).toContain(`enc=${encodeURIComponent(rawEnc)}`);
    const [ivB64] = rawEnc.split(':');
    expect(ivB64).toBe(fixedIv.toString('base64'));

    const decrypted = decryptEncParam(rawEnc, SYNTHETIC_ENC_KEY);
    expect(Object.keys(decrypted).sort()).toEqual([
      'callback',
      'clientName',
      'clientType',
      'name',
      'timestamp',
      'url',
    ]);
    expect(decrypted).toEqual({
      clientType: 'web',
      clientName: 'miioo',
      name: 'Miioo',
      url: baseURL,
      callback: `${baseURL}/api/auth/callback/onelink`,
      timestamp: fixedTimestamp,
    });

    // Default random IV produces distinct enc strings on consecutive calls.
    const first = buildOneLinkAuthorizeUrl(config, { baseURL, timestamp: fixedTimestamp });
    const second = buildOneLinkAuthorizeUrl(config, { baseURL, timestamp: fixedTimestamp });
    expect(first).not.toBe(second);
  });

  it('rejects invalid IV, key length, clientName, baseURL or timestamp without leaking the encryption key', () => {
    const config = makeConfig('https://api-test.wanlian.cloud/sso/client/register');
    const invalidCalls = [
      () =>
        buildOneLinkAuthorizeUrl(config, {
          baseURL: 'https://mio.example.test',
          iv: Buffer.alloc(16),
        }),
      () =>
        buildOneLinkAuthorizeUrl(
          { ...config, encryptionKey: 'short-key' },
          { baseURL: 'https://mio.example.test' },
        ),
      () =>
        buildOneLinkAuthorizeUrl(
          { ...config, clientName: '' },
          { baseURL: 'https://mio.example.test' },
        ),
      () =>
        buildOneLinkAuthorizeUrl(
          { ...config, clientName: 'miioo app' },
          { baseURL: 'https://mio.example.test' },
        ),
      () =>
        buildOneLinkAuthorizeUrl(
          { ...config, clientName: 'routerClientId' },
          { baseURL: 'https://mio.example.test' },
        ),
      () =>
        buildOneLinkAuthorizeUrl(
          { ...config, clientName: 'x'.repeat(51) },
          { baseURL: 'https://mio.example.test' },
        ),
      () => buildOneLinkAuthorizeUrl(config, { baseURL: 'https://mio.example.test/with-path' }),
      () => buildOneLinkAuthorizeUrl(config, { baseURL: 'ftp://mio.example.test' }),
      () =>
        buildOneLinkAuthorizeUrl(config, {
          baseURL: 'https://mio.example.test',
          timestamp: -1,
        }),
    ];
    for (const invoke of invalidCalls) {
      let caught: unknown;
      try {
        invoke();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/^ONELINK_SSO_CRYPTO:/);
      expect((caught as Error).message).not.toContain(SYNTHETIC_ENC_KEY);
      expect((caught as Error).message).not.toContain('short-key');
    }
  });
});

describe('parseOneLinkAccessToken', () => {
  const allowed = ['miioo', 'miiooClientId'] as const;
  const nowMs = 1_764_000_000_000;
  const futureExp = Math.floor(nowMs / 1000) + 3600;

  it('accepts valid JWT payloads for miioo, miiooClientId and omitted/null client_id', () => {
    expect(
      parseOneLinkAccessToken(
        makeJwt({ sub: 'ol-user-001', client_id: 'miioo', exp: futureExp }),
        allowed,
        nowMs,
      ),
    ).toEqual({ ok: true, sub: 'ol-user-001', clientId: 'miioo' });

    expect(
      parseOneLinkAccessToken(
        makeJwt({ sub: 'ol-user-002', client_id: 'miiooClientId', exp: futureExp }),
        allowed,
        nowMs,
      ),
    ).toEqual({ ok: true, sub: 'ol-user-002', clientId: 'miiooClientId' });

    expect(parseOneLinkAccessToken(makeJwt({ sub: 'ol-user-003' }), allowed, nowMs)).toEqual({
      ok: true,
      sub: 'ol-user-003',
      clientId: null,
    });

    expect(
      parseOneLinkAccessToken(makeJwt({ sub: 'ol-user-004', client_id: null }), allowed, nowMs),
    ).toEqual({ ok: true, sub: 'ol-user-004', clientId: null });
  });

  it('rejects malformed JWT syntax, invalid Base64URL and non-object JSON payloads', () => {
    const header = Buffer.from('{"alg":"RS256"}').toString('base64url');
    const malformedCases: unknown[] = [
      undefined,
      null,
      123,
      '',
      'a.b',
      'a.b.c.d',
      'a..c',
      `${header}.invalid+base64.sig`,
      `${header}.invalid/base64.sig`,
      `${header}.eyJzdWIiOiJ4In0=.sig`,
      `${header}.${'a'.repeat(16 * 1024)}.sig`,
    ];
    for (const token of malformedCases) {
      expect(parseOneLinkAccessToken(token, allowed, nowMs)).toEqual({
        ok: false,
        reason: 'malformed_jwt',
      });
    }

    const nonJsonPayload = Buffer.from('not-json', 'utf8').toString('base64url');
    const invalidUtf8Payload = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url');
    const truncatedBase64Url = `${Buffer.from('{"sub":"xy"}', 'utf8').toString('base64url')}A`;
    for (const token of [
      `${header}.${nonJsonPayload}.sig`,
      `${header}.${invalidUtf8Payload}.sig`,
      `${header}.${truncatedBase64Url}.sig`,
      makeJwt(null),
      makeJwt(['sub']),
      makeJwt('plain-string'),
      makeJwt(42),
    ]) {
      expect(parseOneLinkAccessToken(token, allowed, nowMs)).toEqual({
        ok: false,
        reason: 'invalid_payload',
      });
    }
  });

  it('rejects missing, empty, untrimmed, overlong or control-character sub claims', () => {
    const invalidSubPayloads = [
      {},
      { sub: '' },
      { sub: '   ' },
      { sub: ' user-1' },
      { sub: 'user-1 ' },
      { sub: 'user\n1' },
      { sub: 'user\u00001' },
      { sub: 'user\u007f1' },
      { sub: 'x'.repeat(257) },
      { sub: 12345 },
      { sub: null },
    ];
    for (const payload of invalidSubPayloads) {
      expect(parseOneLinkAccessToken(makeJwt(payload), allowed, nowMs)).toEqual({
        ok: false,
        reason: 'invalid_sub',
      });
    }
  });

  it('rejects expired and non-numeric exp claims', () => {
    expect(parseOneLinkAccessToken(makeJwt({ sub: 'ol-user', exp: 0 }), allowed, nowMs)).toEqual({
      ok: false,
      reason: 'expired',
    });

    expect(
      parseOneLinkAccessToken(
        makeJwt({ sub: 'ol-user', exp: Math.floor(nowMs / 1000) - 1 }),
        allowed,
        nowMs,
      ),
    ).toEqual({ ok: false, reason: 'expired' });

    expect(
      parseOneLinkAccessToken(
        makeJwt({ sub: 'ol-user', exp: Math.floor(nowMs / 1000) }),
        allowed,
        nowMs,
      ),
    ).toEqual({ ok: false, reason: 'expired' });

    for (const exp of ['1999999999', null, true, {}]) {
      expect(parseOneLinkAccessToken(makeJwt({ sub: 'ol-user', exp }), allowed, nowMs)).toEqual({
        ok: false,
        reason: 'invalid_payload',
      });
    }
  });

  it('always rejects routerClientId and mismatched or invalid client_id claims', () => {
    expect(
      parseOneLinkAccessToken(
        makeJwt({ sub: 'ol-user', client_id: 'routerClientId', exp: futureExp }),
        ['routerClientId', ...allowed],
        nowMs,
      ),
    ).toEqual({ ok: false, reason: 'router_client_rejected' });

    expect(
      parseOneLinkAccessToken(
        makeJwt({ sub: 'ol-user', client_id: 'otherClientId', exp: futureExp }),
        allowed,
        nowMs,
      ),
    ).toEqual({ ok: false, reason: 'client_id_mismatch' });

    for (const clientId of ['', 123, {}]) {
      expect(
        parseOneLinkAccessToken(
          makeJwt({ sub: 'ol-user', client_id: clientId, exp: futureExp }),
          allowed,
          nowMs,
        ),
      ).toEqual({ ok: false, reason: 'invalid_payload' });
    }
  });
});

describe('maskOneLinkSub', () => {
  it('masks long and short subjects without exposing the full value', () => {
    expect(maskOneLinkSub('onelink-user-987654')).toBe('one***654');
    expect(maskOneLinkSub('12345678')).toBe('123***678');
    expect(maskOneLinkSub('1234567')).toBe('***67');
    expect(maskOneLinkSub('abc')).toBe('***bc');
    expect(maskOneLinkSub('ab')).toBe('***');
    expect(maskOneLinkSub('x')).toBe('***');
  });
});
