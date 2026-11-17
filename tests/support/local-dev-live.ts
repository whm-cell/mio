import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { connect as connectTcp, createServer as createTcpServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readLocalEnvironment } from '../../scripts/service/local-environment.ts';
import { launcher, prepareProfile } from '../../scripts/service/profile.ts';

type DevDomain = 'auth' | 'providers' | 'conversations' | 'assets' | 'compute';

type ParsedLiveAuthInput =
  | { kind: 'login'; email: string; password: string; apiKey?: string }
  | { kind: 'apiKey'; apiKey: string };

function isPortListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(listening);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function parseLiveAuthInput(path: string): Promise<ParsedLiveAuthInput> {
  const raw = await readFile(path, 'utf8');
  assert(Buffer.byteLength(raw) <= 8192, 'LIVE_CREDENTIAL_FILE_INVALID');
  const trimmed = raw.trim();
  assert(trimmed.length > 0, 'LIVE_CREDENTIAL_FILE_INVALID');
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as {
      email?: unknown;
      password?: unknown;
      apiKey?: unknown;
    };
    assert(
      typeof parsed.email === 'string' &&
        parsed.email.length > 0 &&
        typeof parsed.password === 'string' &&
        parsed.password.length > 0 &&
        (parsed.apiKey === undefined ||
          (typeof parsed.apiKey === 'string' &&
            parsed.apiKey.length > 0 &&
            parsed.apiKey.length <= 4096 &&
            !/[\s'"*•\u0000-\u001f\u007f]/.test(parsed.apiKey))),
      'LIVE_LOGIN_FILE_INVALID',
    );
    return {
      kind: 'login',
      email: parsed.email,
      password: parsed.password,
      ...(typeof parsed.apiKey === 'string' ? { apiKey: parsed.apiKey } : {}),
    };
  }
  assert(!/[\r\n]/.test(trimmed), 'LIVE_CREDENTIAL_FILE_INVALID');
  const assignment = /^[A-Za-z_][A-Za-z0-9_]{0,47}=(.*)$/.exec(trimmed);
  let apiKey = assignment ? assignment[1]! : trimmed;
  if (
    (apiKey.startsWith('"') && apiKey.endsWith('"')) ||
    (apiKey.startsWith("'") && apiKey.endsWith("'"))
  ) {
    apiKey = apiKey.slice(1, -1);
  }
  assert(
    apiKey.length > 0 && apiKey.length <= 4096 && !/[\s'"*•\u0000-\u001f\u007f]/.test(apiKey),
    'LIVE_CREDENTIAL_FILE_INVALID',
  );
  return { kind: 'apiKey', apiKey };
}

/** Loads persistent .env (mio_dev + mio-dev Redis/RabbitMQ + .runtime/dev/dsh) and runs incremental migrations. */
export async function preparePersistentDevEnvironment(domains: readonly DevDomain[]) {
  const dev = await readLocalEnvironment('dev');
  const appPort = Number(dev.values.MIO_PORT);
  if (await isPortListening(appPort)) {
    throw new Error(
      `DEV_APP_ALREADY_RUNNING: stop pnpm start:dev on port ${appPort} before running a live verification script that manages profile lifecycle`,
    );
  }

  const probe = createTcpServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert(address && typeof address === 'object', 'DEV_LIVE_PORT');
  const livePort = address.port;
  await new Promise<void>((ok, fail) => probe.close((err) => (err ? fail(err) : ok())));
  const liveOrigin = `http://127.0.0.1:${livePort}`;

  const runtimeEnv: NodeJS.ProcessEnv & { DSH_HOME: string; DSH_AGENTS_HOME: string } = {
    ...dev.runtime,
    MIO_HOST: '127.0.0.1',
    MIO_PORT: String(livePort),
    MIO_AUTH_BASE_URL: liveOrigin,
  };
  const authDb = runtimeEnv.MIO_AUTH_DATABASE_URL!;
  if (domains.includes('providers')) {
    runtimeEnv.MIO_PROVIDERS_DATABASE_URL ??= authDb;
    assert(
      runtimeEnv.MIO_PROVIDERS_MASTER_KEY && runtimeEnv.MIO_PROVIDERS_MASTER_KEY_ID,
      'DEV_PROVIDERS_MASTER_KEY_REQUIRED: configure MIO_PROVIDERS_MASTER_KEY and MIO_PROVIDERS_MASTER_KEY_ID in .env',
    );
  }
  if (domains.includes('conversations')) {
    runtimeEnv.MIO_CONVERSATIONS_DATABASE_URL ??= authDb;
  }
  if (domains.includes('assets') || domains.includes('compute')) {
    runtimeEnv.MIO_ASSETS_DATABASE_URL ??= authDb;
  }
  if (domains.includes('compute')) {
    runtimeEnv.MIO_COMPUTE_ENABLED = 'true';
  }

  const ordered: DevDomain[] = ['auth', 'assets', 'compute', 'providers', 'conversations'];
  for (const domain of ordered) {
    if (!domains.includes(domain)) continue;
    const migration = spawnSync(
      process.execPath,
      [`scripts/service/migrate-${domain}.ts`, '--apply'],
      {
        env: runtimeEnv,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(migration.status, 0, `DEV_MIGRATION_FAILED:${domain}`);
  }

  return {
    values: dev.values,
    host: dev.host,
    runtimeEnv,
    origin: liveOrigin,
    databaseUrl: authDb,
    dshHome: runtimeEnv.DSH_HOME,
  };
}

/** Starts and stops the official DSH mio profile against persistent mio_dev without deleting .runtime/dev/dsh. */
export async function createPersistentDevProfileController(
  runtimeEnv: NodeJS.ProcessEnv & { DSH_HOME: string; DSH_AGENTS_HOME: string },
  origin: string,
) {
  const workspace = resolve('.');
  await prepareProfile(runtimeEnv.DSH_HOME, workspace);
  let child: ChildProcess | undefined;

  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const finished = await Promise.race([
      exited.then(() => true),
      delay(10_000, false, { ref: false }),
    ]);
    if (!finished && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  };

  const start = async () => {
    await stop();
    child = spawn(process.execPath, [launcher(), '--profile', 'mio'], {
      cwd: runtimeEnv.DSH_HOME,
      env: runtimeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let attempt = 0; attempt < 120; attempt++) {
      assert(child.exitCode === null && child.signalCode === null, 'DEV_PROFILE_EXITED_EARLY');
      try {
        const res = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1_500) });
        if (res.status === 200) return;
      } catch {
        // Wait for DSH webserver startup.
      }
      await delay(250);
    }
    await stop();
    throw new Error('DEV_PROFILE_READY_TIMEOUT');
  };

  return {
    origin,
    nativeLogRoot: runtimeEnv.DSH_HOME,
    start,
    stop,
    close: stop,
  };
}

export async function authenticateOrCreateRetainedDevOwner(
  origin: string,
  authInput: ParsedLiveAuthInput,
  tag: string,
) {
  const callJson = (path: string, method = 'GET', body?: unknown, cookie = '') =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });

  let email: string;
  let password: string;
  let cookie: string;

  if (authInput.kind === 'login') {
    email = authInput.email;
    password = authInput.password;
    const signedIn = await callJson('/api/auth/sign-in/email', 'POST', { email, password });
    assert.equal(signedIn.status, 200, 'DEV_LOGIN_FAILED');
    cookie = signedIn.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');
  } else {
    email = `live-${tag}-${randomUUID().slice(0, 8)}@mio.dev.local`;
    password = randomBytes(24).toString('hex');
    const signedUp = await callJson('/api/auth/sign-up/email', 'POST', {
      name: `Dev live ${tag}`,
      email,
      password,
    });
    assert.equal(signedUp.status, 200, 'DEV_SIGNUP_FAILED');
    cookie = signedUp.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');
  }
  assert(cookie.length > 0, 'DEV_COOKIE_MISSING');

  const meRes = await callJson('/api/v1/me', 'GET', undefined, cookie);
  assert.equal(meRes.status, 200, 'DEV_ME_FAILED');
  const { userId } = (await meRes.json()) as { userId: string };

  return { email, password, userId, cookie, apiKey: authInput.apiKey };
}
