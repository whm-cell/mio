import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAllowedOneLinkClientIds } from '../../src/auth/config.ts';
import {
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
