import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Agent, createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sms } from 'tencentcloud-sdk-nodejs-sms';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createTencentSmsSender } from '../../src/integrations/tencent-sms.ts';

afterEach(() => vi.restoreAllMocks());

it('makes one signed SDK request with the expected template and rejects provider errors', async () => {
  const request = vi.spyOn(sms.v20210111.Client.prototype, 'request');
  request.mockResolvedValueOnce({ SendStatusSet: [{ Code: 'Ok' }] });
  const send = createTencentSmsSender({
    secretId: 'test-id',
    secretKey: 'test-key',
    appId: 'test-app',
    signName: 'test-sign',
    templateId: 'test-template',
    region: 'ap-test',
  });
  await send('+8613800138090', '123456');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![0]).toBe('SendSms');
  expect(request.mock.calls[0]![1]).toEqual({
    PhoneNumberSet: ['+8613800138090'],
    SmsSdkAppId: 'test-app',
    SignName: 'test-sign',
    TemplateId: 'test-template',
    TemplateParamSet: ['123456', '5'],
  });
  expect((request.mock.calls[0]![2] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  request.mockRejectedValueOnce(new Error('private provider error'));
  await expect(send('+8613800138090', '123456')).rejects.toThrow('SMS_UNAVAILABLE');
  expect(request).toHaveBeenCalledTimes(2);
});

it('aborts the SDK response body at its signal deadline without retrying', async () => {
  let requests = 0;
  let closed!: () => void;
  const responseClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"Response":');
    response.on('close', closed);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const client = new sms.v20210111.Client({
    credential: { secretId: 'test-id', secretKey: 'test-key' },
    region: 'ap-test',
    profile: {
      httpProfile: { protocol: 'http://', endpoint: `127.0.0.1:${address.port}`, reqTimeout: 2 },
    },
  });
  try {
    await expect(
      client.request('SendSms', {}, { signal: AbortSignal.timeout(150) }),
    ).rejects.toThrow();
    await responseClosed;
    expect(requests).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type Scenario = {
  mode: 'success' | 'same' | 'cross' | 'downgrade' | 'slow';
  status?: 307 | 308;
  first: number;
  target: number;
  body: string;
  targetBody: string;
  closeHeaders: string[];
  authorization: string[];
  onClose?: () => void;
};
let scenario: Scenario;
let certificate: Buffer;
let source: ReturnType<typeof createTlsServer>;
let target: ReturnType<typeof createTlsServer>;
let downgrade: ReturnType<typeof createServer>;

function port(server: typeof source | typeof downgrade) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return address.port;
}

beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mio-sms-tls-'));
  let key: Buffer;
  try {
    const keyPath = join(directory, 'key.pem');
    const certPath = join(directory, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      { stdio: 'ignore' },
    );
    key = readFileSync(keyPath);
    certificate = readFileSync(certPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const ok = (response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive' });
    response.end(JSON.stringify({ Response: { SendStatusSet: [{ Code: 'Ok' }] } }));
  };
  const receive = (request: IncomingMessage, done: (body: string) => void) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => done(body));
  };
  target = createTlsServer({ key, cert: certificate }, (request, response) => {
    receive(request, (body) => {
      scenario.target++;
      scenario.targetBody = body;
      ok(response);
    });
  });
  downgrade = createServer((request, response) => {
    receive(request, (body) => {
      scenario.target++;
      scenario.targetBody = body;
      ok(response);
    });
  });
  source = createTlsServer({ key, cert: certificate }, (request, response) => {
    receive(request, (body) => {
      if (request.url === '/again') {
        scenario.target++;
        scenario.targetBody = body;
        return ok(response);
      }
      scenario.first++;
      scenario.body = body;
      scenario.closeHeaders.push(request.headers.connection ?? '');
      scenario.authorization.push(request.headers.authorization ?? '');
      if (scenario.mode === 'success') return ok(response);
      if (scenario.mode === 'slow') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"Response":');
        response.on('close', () => scenario.onClose?.());
        return;
      }
      const location =
        scenario.mode === 'same'
          ? `https://127.0.0.1:${port(source)}/again`
          : scenario.mode === 'cross'
            ? `https://127.0.0.1:${port(target)}/again`
            : `http://127.0.0.1:${port(downgrade)}/again`;
      response.writeHead(scenario.status!, {
        location,
        connection: 'keep-alive',
        'content-length': '0',
      });
      response.end();
    });
  });
  for (const server of [source, target, downgrade]) server.listen(0, '127.0.0.1');
  await Promise.all([source, target, downgrade].map((server) => once(server, 'listening')));
});

afterAll(async () => {
  await Promise.all(
    [source, target, downgrade].filter(Boolean).map(async (server) => {
      const stopped = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await stopped;
    }),
  );
});

function reset(mode: Scenario['mode'], status?: Scenario['status']) {
  scenario = {
    mode,
    ...(status === undefined ? {} : { status }),
    first: 0,
    target: 0,
    body: '',
    targetBody: '',
    closeHeaders: [],
    authorization: [],
  };
}

/** Use the real SDK and production agent, changing only the test destination and CA. */
function routeSdkToFixture(deadlineMs?: number) {
  const original = sms.v20210111.Client.prototype.request;
  const agents: Agent[] = [];
  vi.spyOn(sms.v20210111.Client.prototype, 'request').mockImplementation(function (
    this: InstanceType<typeof sms.v20210111.Client>,
    action,
    body,
    options,
    callback,
  ) {
    this.endpoint = `127.0.0.1:${port(source)}`;
    const agent = this.profile.httpProfile!.agent as Agent;
    agent.options.ca = certificate;
    agents.push(agent);
    const requestOptions =
      deadlineMs && options && typeof options !== 'function'
        ? { ...options, signal: AbortSignal.timeout(deadlineMs) }
        : options;
    return original.call(this, action, body, requestOptions, callback);
  });
  return agents;
}

it('sends concurrently through distinct one-connection agents using the real SDK', async () => {
  reset('success');
  const agents = routeSdkToFixture();
  const send = createTencentSmsSender({
    secretId: 'test-id',
    secretKey: 'test-key',
    appId: 'test-app',
    signName: 'test-sign',
    templateId: 'test-template',
    region: 'ap-test',
  });
  await Promise.all(Array.from({ length: 8 }, () => send('+8613800138090', '123456')));
  expect(scenario.first).toBe(8);
  expect(new Set(agents).size).toBe(8);
  expect(scenario.closeHeaders).toEqual(Array(8).fill('close'));
  expect(scenario.authorization.every((value) => value.startsWith('TC3-HMAC-SHA256 '))).toBe(true);
  expect(JSON.parse(scenario.body)).toMatchObject({
    PhoneNumberSet: ['+8613800138090'],
    TemplateParamSet: ['123456', '5'],
  });
});

it.each([
  [307, 'same'],
  [307, 'cross'],
  [307, 'downgrade'],
  [308, 'same'],
  [308, 'cross'],
  [308, 'downgrade'],
] as const)('does not forward a %i redirect to %s', async (status, mode) => {
  if (mode !== 'downgrade') {
    reset(mode, status);
    const agent = new Agent({ ca: certificate, keepAlive: false });
    const client = new sms.v20210111.Client({
      credential: { secretId: 'test-id', secretKey: 'test-key' },
      region: 'ap-test',
      profile: {
        httpProfile: {
          endpoint: `127.0.0.1:${port(source)}`,
          agent,
          headers: { Connection: 'close' },
        },
      },
    });
    try {
      await client.request('SendSms', {
        PhoneNumberSet: ['synthetic-phone'],
        TemplateParamSet: ['123456', '5'],
      });
      expect(scenario.first).toBe(1);
      expect(scenario.target).toBe(1);
      expect(scenario.targetBody).toBe(scenario.body);
    } finally {
      agent.destroy();
    }
  }
  reset(mode, status);
  routeSdkToFixture();
  const send = createTencentSmsSender({
    secretId: 'test-id',
    secretKey: 'test-key',
    appId: 'test-app',
    signName: 'test-sign',
    templateId: 'test-template',
    region: 'ap-test',
  });
  await expect(send('+8613800138090', '123456')).rejects.toThrow('SMS_UNAVAILABLE');
  expect(scenario.first).toBe(1);
  expect(scenario.target).toBe(0);
  expect(scenario.closeHeaders).toEqual(['close']);
});

it('aborts a stalled SDK response body and closes its connection', async () => {
  reset('slow');
  let closed!: () => void;
  const responseClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  scenario.onClose = closed;
  const agents = routeSdkToFixture(150);
  const send = createTencentSmsSender({
    secretId: 'test-id',
    secretKey: 'test-key',
    appId: 'test-app',
    signName: 'test-sign',
    templateId: 'test-template',
    region: 'ap-test',
  });
  await expect(send('+8613800138090', '123456')).rejects.toThrow('SMS_UNAVAILABLE');
  await responseClosed;
  expect(scenario.first).toBe(1);
  expect(scenario.target).toBe(0);
  expect(agents).toHaveLength(1);
});
