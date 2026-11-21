import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { authOptions, readAuthConfig } from '../../src/auth/config.ts';
import { createAuthHandler } from '../../src/auth/http.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import { authDatabase } from '../support/auth-database.ts';

let database: Awaited<ReturnType<typeof authDatabase>>;
let pool: Pool;
const servers: ReturnType<typeof createServer>[] = [];
const auths: Awaited<ReturnType<typeof createAuthentication>>[] = [];
const origins: string[] = [];
let delivered = new Map<string, string>();
let failSend = false;
const secret = randomBytes(40).toString('hex');
const password = 'correct-horse-phone-test-19';

const sender = async (phone: string, code: string) => {
  delivered.set(phone, code);
  if (failSend) throw new Error('provider failure with private details');
};
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
function call(path: string, body?: unknown, session?: string, instance = 0) {
  return fetch(`${origins[instance]}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: origins[instance]!,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { cookie: session } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function emailUser() {
  const response = await call('/api/auth/sign-up/email', {
    name: 'Owner',
    email: `${randomUUID()}@example.test`,
    password,
  });
  expect(response.status).toBe(200);
  return cookie(response);
}
async function identity(session: string) {
  const response = await call('/api/v1/me', undefined, session);
  expect(response.status).toBe(200);
  return (await response.json()) as { userId: string; sessionId: string };
}
async function send(path: string, phoneNumber: string, session?: string) {
  const response = await call(path, { phoneNumber }, session);
  expect(response.status, await response.clone().text()).toBe(200);
  return delivered.get(phoneNumber.startsWith('+86') ? phoneNumber : `+86${phoneNumber}`)!;
}

beforeAll(async () => {
  database = await authDatabase();
  pool = new Pool({ connectionString: database.url });
  for (let index = 0; index < 2; index++) {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    origins.push(`http://127.0.0.1:${address.port}`);
    servers.push(server);
  }
  const configs = origins.map((origin) =>
    readAuthConfig({
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: database.url,
    })!,
  );
  await (await getMigrations(authOptions(configs[0]!, pool))).runMigrations();
  for (const [index, config] of configs.entries()) {
    const auth = await createAuthentication(config, undefined, sender);
    auths.push(auth);
    servers[index]!.on('request', createAuthHandler(config, auth));
  }
}, 45000);

beforeEach(async () => {
  delivered = new Map();
  failSend = false;
  await pool.query('DELETE FROM "rateLimit"');
  await pool.query('DELETE FROM "mioSmsBudget"');
  await pool.query('DELETE FROM "mioPhoneChallenge"');
});

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(auths.map((auth) => auth.close()));
  if (pool) await pool.end();
  if (database) await database.close();
}, 30000);

it('rejects partial SMS configuration and limits above the defaults', () => {
  expect(() => readAuthConfig({ MIO_AUTH_SMS_ENABLED: 'true' })).toThrow('AUTH_CONFIG');
  const base = {
    MIO_AUTH_BASE_URL: origins[0],
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: database.url,
  };
  expect(() => readAuthConfig({ ...base, MIO_AUTH_SMS_ENABLED: 'true' })).toThrow('AUTH_CONFIG');
  expect(() => readAuthConfig({ ...base, MIO_AUTH_SMS_PHONE_HOUR_LIMIT: '6' })).toThrow(
    'AUTH_CONFIG',
  );
});

it('fails closed before SMS or WeChat work when the authentication rate store fails', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = readAuthConfig({
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: database.url,
    MIO_AUTH_WECHAT_ENABLED: 'true',
    MIO_AUTH_WECHAT_APP_ID: 'fixture-app',
    MIO_AUTH_WECHAT_APP_SECRET: 'fixture-secret',
  })!;
  let consumed = 0;
  let sent = 0;
  const auth = await createAuthentication(
    config,
    {
      async consume() {
        consumed++;
        throw new Error('private rate-store detail');
      },
    },
    async () => {
      sent++;
    },
  );
  server.on('request', createAuthHandler(config, auth));
  const count = async (table: string) =>
    Number((await pool.query(`SELECT count(*) FROM "${table}"`)).rows[0].count);
  try {
    const before = await Promise.all(
      ['mioSmsBudget', 'mioPhoneChallenge', 'verification'].map(count),
    );
    for (const [path, body] of [
      ['/api/auth/phone-number/send-otp', { phoneNumber: '13800138090' }],
      ['/api/auth/sign-in/social', { provider: 'wechat' }],
    ] as const) {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private rate-store detail');
    }
    const callback = await fetch(`${origin}/api/auth/callback/wechat?state=fixture&code=fixture`, {
      redirect: 'manual',
    });
    expect(callback.status).toBe(503);
    expect(consumed).toBe(3);
    expect(sent).toBe(0);
    expect(
      await Promise.all(['mioSmsBudget', 'mioPhoneChallenge', 'verification'].map(count)),
    ).toEqual(before);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await auth.close();
  }
});

it('migrates an existing email schema while preserving its user and session', async () => {
  const schema = `mio_old_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const scoped = new URL(database.url);
  scoped.searchParams.set('options', `-csearch_path=${schema}`);
  const oldPool = new Pool({ connectionString: scoped.toString() });
  let upgraded: Awaited<ReturnType<typeof createAuthentication>> | undefined;
  try {
    const config = readAuthConfig({
      MIO_AUTH_BASE_URL: origins[0],
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_DATABASE_URL: scoped.toString(),
    })!;
    const oldOptions = authOptions(config, oldPool);
    oldOptions.plugins = [];
    await (await getMigrations(oldOptions)).runMigrations();
    const oldAuth = betterAuth(oldOptions);
    const registered = await oldAuth.handler(
      new Request(`${origins[0]}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin: origins[0]!, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Old owner',
          email: `${randomUUID()}@example.test`,
          password,
        }),
      }),
    );
    expect(registered.status).toBe(200);
    const previousUser = (await registered.clone().json()) as { user: { id: string } };
    const previousCookie = cookie(registered);
    const plan = await getMigrations(authOptions(config, oldPool));
    expect(plan.toBeCreated.length).toBeGreaterThan(0);
    expect(plan.toBeAdded.length).toBeGreaterThan(0);
    await plan.runMigrations();
    upgraded = await createAuthentication(config);
    const after = await upgraded.identity(new Headers({ cookie: previousCookie }));
    expect(after?.userId).toBe(previousUser.user.id);
    expect((await getMigrations(authOptions(config, oldPool))).toBeCreated).toHaveLength(0);
  } finally {
    if (upgraded) await upgraded.close();
    await oldPool.end();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

it('registers and signs in once by phone, reserving placeholder email for the service', async () => {
  const reserved = await call('/api/auth/sign-up/email', {
    name: 'Owner',
    email: 'claimed@auth.mio.invalid',
    password,
  });
  expect(reserved.status).toBe(403);
  const phoneNumber = '13800138011';
  const code = await send('/api/auth/phone-number/send-otp', phoneNumber);
  const response = await call('/api/auth/phone-number/verify', { phoneNumber, code });
  expect(response.status, await response.clone().text()).toBe(200);
  const loggedIn = await identity(cookie(response));
  const row = await pool.query<{ email: string; emailVerified: boolean; phoneNumber: string }>(
    'SELECT email, "emailVerified", "phoneNumber" FROM "user" WHERE id = $1',
    [loggedIn.userId],
  );
  expect(row.rows[0]).toMatchObject({ emailVerified: false, phoneNumber: `+86${phoneNumber}` });
  expect(row.rows[0]!.email).toMatch(/^phone-.+@auth\.mio\.invalid$/);
  expect((await call('/api/auth/phone-number/verify', { phoneNumber, code })).status).toBe(400);
});

it('isolates login and binding intent, binds the original user and rejects a different session', async () => {
  const owner = await emailUser();
  const other = await emailUser();
  const ownerId = (await identity(owner)).userId;
  const phoneNumber = '13800138012';
  const loginCode = await send('/api/auth/phone-number/send-otp', phoneNumber);
  expect(
    (await call('/api/auth/phone-binding/confirm', { phoneNumber, code: loginCode }, owner)).status,
  ).toBe(400);
  await pool.query('DELETE FROM "mioSmsBudget"');
  const bindCode = await send('/api/auth/phone-binding/send-otp', phoneNumber, owner);
  expect(
    (await call('/api/auth/phone-binding/confirm', { phoneNumber, code: bindCode }, other)).status,
  ).toBe(400);
  expect(
    (await call('/api/auth/phone-binding/confirm', { phoneNumber, code: bindCode }, owner)).status,
  ).toBe(200);
  expect((await identity(owner)).userId).toBe(ownerId);
  await pool.query('DELETE FROM "mioSmsBudget"');
  const newCode = await send('/api/auth/phone-number/send-otp', phoneNumber);
  const login = await call('/api/auth/phone-number/verify', { phoneNumber, code: newCode });
  expect(login.status).toBe(200);
  expect((await identity(cookie(login))).userId).toBe(ownerId);
});

it('serializes correct OTP consumption across two HTTP instances sharing PostgreSQL', async () => {
  const phoneNumber = '13800138013';
  const code = await send('/api/auth/phone-number/send-otp', phoneNumber);
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      call('/api/auth/phone-number/verify', { phoneNumber, code }, undefined, index % 2),
    ),
  );
  expect(results.filter((response) => response.status === 200)).toHaveLength(1);
  expect(results.filter((response) => response.status !== 200)).toHaveLength(5);
  expect(
    Number(
      (
        await pool.query('SELECT count(*) FROM "user" WHERE "phoneNumber" = $1', [
          `+86${phoneNumber}`,
        ])
      ).rows[0].count,
    ),
  ).toBe(1);
});

it('does not activate a failed send and retains its budget across instances', async () => {
  const phoneNumber = '13800138014';
  failSend = true;
  const sent = await call('/api/auth/phone-number/send-otp', { phoneNumber });
  expect(sent.status).toBe(503);
  expect(await sent.text()).not.toContain('private details');
  const code = delivered.get(`+86${phoneNumber}`)!;
  expect((await call('/api/auth/phone-number/verify', { phoneNumber, code })).status).toBe(400);
  failSend = false;
  expect(
    (await call('/api/auth/phone-number/send-otp', { phoneNumber }, undefined, 1)).status,
  ).toBe(429);
});

it('limits wrong attempts, rejects extra fields and blocks replay', async () => {
  const phoneNumber = '13800138015';
  const code = await send('/api/auth/phone-number/send-otp', phoneNumber);
  const wrong = code === '000000' ? '000001' : '000000';
  expect(
    (await call('/api/auth/phone-number/verify', { phoneNumber, code, updatePhoneNumber: true }))
      .status,
  ).toBe(400);
  for (let index = 0; index < 3; index++)
    expect((await call('/api/auth/phone-number/verify', { phoneNumber, code: wrong })).status).toBe(
      400,
    );
  expect((await call('/api/auth/phone-number/verify', { phoneNumber, code })).status).toBe(400);
});

it('serializes concurrent sends against the shared phone budget', async () => {
  const phoneNumber = '13800138016';
  let sends = 0;
  const originalSet = delivered.set.bind(delivered);
  delivered.set = (key, value) => {
    sends++;
    return originalSet(key, value);
  };
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      call('/api/auth/phone-number/send-otp', { phoneNumber }, undefined, index % 2),
    ),
  );
  expect(results.filter((response) => response.status === 200)).toHaveLength(1);
  expect(results.filter((response) => response.status === 429)).toHaveLength(5);
  expect(sends).toBe(1);
});

it('rejects a bound number belonging to another user and a revoked binding session', async () => {
  const first = await emailUser();
  const second = await emailUser();
  const phoneNumber = '13800138017';
  const firstCode = await send('/api/auth/phone-binding/send-otp', phoneNumber, first);
  expect(
    (await call('/api/auth/phone-binding/confirm', { phoneNumber, code: firstCode }, first)).status,
  ).toBe(200);
  await pool.query('DELETE FROM "mioSmsBudget"');
  const secondCode = await send('/api/auth/phone-binding/send-otp', phoneNumber, second);
  expect(
    (await call('/api/auth/phone-binding/confirm', { phoneNumber, code: secondCode }, second))
      .status,
  ).toBe(409);
  expect(
    (await call('/api/auth/phone-binding/confirm', { phoneNumber, code: secondCode }, second))
      .status,
  ).toBe(400);
  await pool.query('DELETE FROM "mioSmsBudget"');
  const anotherPhone = '13800138018';
  const code = await send('/api/auth/phone-binding/send-otp', anotherPhone, second);
  expect((await call('/api/auth/sign-out', {}, second)).status).toBe(200);
  expect(
    (await call('/api/auth/phone-binding/confirm', { phoneNumber: anotherPhone, code }, second))
      .status,
  ).toBe(401);
});

async function observeBlockedVerifier(
  lockerPid: number,
  statement: string,
  expiry: { at: Date; crossed: boolean; waiterPid?: number },
) {
  return vi.waitFor(
    async () => {
      const { rows } = await pool.query<{
        pid: number;
        startedBeforeExpiry: boolean;
        expired: boolean;
      }>(
        `SELECT pid, query_start < $3::timestamptz AS "startedBeforeExpiry",
              clock_timestamp() >= $3::timestamptz AS expired
       FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = $4
         AND wait_event_type = 'Lock' AND query = $2 AND $1::int = ANY(pg_blocking_pids(pid))`,
        [lockerPid, statement, expiry.at, database.applicationName],
      );
      expect(rows).toHaveLength(1);
      const waiter = rows[0]!;
      expect(waiter.startedBeforeExpiry).toBe(true);
      expect(waiter.expired).toBe(expiry.crossed);
      if (expiry.waiterPid !== undefined) expect(waiter.pid).toBe(expiry.waiterPid);
      return waiter.pid;
    },
    { timeout: 2000, interval: 10 },
  );
}

it('checks expiry after waiting for the challenge row lock', async () => {
  const phoneNumber = '13800138019';
  const code = await send('/api/auth/phone-number/send-otp', phoneNumber);
  const challengeKey = createHash('sha256').update(`login\0+86${phoneNumber}`).digest('hex');
  const locker = await pool.connect();
  let waiting: Promise<Response> | undefined;
  try {
    await locker.query('BEGIN');
    const { rows } = await locker.query<{ pid: number; expiresAt: Date }>(
      `SELECT pg_backend_pid() AS pid, "expiresAt"
       FROM "mioPhoneChallenge" WHERE "challengeKey" = $1 FOR UPDATE`,
      [challengeKey],
    );
    expect(rows).toHaveLength(1);
    const { pid, expiresAt } = rows[0]!;
    const statement = 'SELECT * FROM "mioPhoneChallenge" WHERE "challengeKey" = $1 FOR UPDATE';
    waiting = call('/api/auth/phone-number/verify', { phoneNumber, code });
    void waiting.catch(() => {});
    const waiterPid = await observeBlockedVerifier(pid, statement, {
      at: expiresAt,
      crossed: false,
    });
    // Set the new deadline only after the verifying statement is already waiting.
    const updated = await locker.query<{ expiresAt: Date }>(
      `UPDATE "mioPhoneChallenge"
       SET "expiresAt" = date_trunc('milliseconds', clock_timestamp()) + interval '25 milliseconds'
       WHERE "challengeKey" = $1 RETURNING "expiresAt"`,
      [challengeKey],
    );
    await observeBlockedVerifier(pid, statement, {
      at: updated.rows[0]!.expiresAt,
      crossed: true,
      waiterPid,
    });
    await locker.query('COMMIT');
    const response = await waiting;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_OTP' });
    const count = await pool.query('SELECT count(*) FROM "user" WHERE "phoneNumber" = $1', [
      `+86${phoneNumber}`,
    ]);
    expect(Number(count.rows[0].count)).toBe(0);
  } finally {
    try {
      await locker.query('ROLLBACK');
    } finally {
      locker.release();
      await waiting?.catch(() => {});
    }
  }
});

it('rechecks binding session expiry after its row lock is released', async () => {
  const owner = await emailUser();
  const { sessionId, userId } = await identity(owner);
  const phoneNumber = '13800138020';
  const code = await send('/api/auth/phone-binding/send-otp', phoneNumber, owner);
  const locker = await pool.connect();
  let waiting: Promise<Response> | undefined;
  try {
    await locker.query('BEGIN');
    const { rows } = await locker.query<{ pid: number; expiresAt: Date }>(
      `SELECT pg_backend_pid() AS pid, "expiresAt"
       FROM "session" WHERE id = $1 AND "userId" = $2 FOR UPDATE`,
      [sessionId, userId],
    );
    expect(rows).toHaveLength(1);
    const { pid, expiresAt } = rows[0]!;
    const statement = 'SELECT id FROM "session" WHERE id = $1 AND "userId" = $2 FOR UPDATE';
    waiting = call('/api/auth/phone-binding/confirm', { phoneNumber, code }, owner);
    void waiting.catch(() => {});
    const waiterPid = await observeBlockedVerifier(pid, statement, {
      at: expiresAt,
      crossed: false,
    });
    const updated = await locker.query<{ expiresAt: Date }>(
      `UPDATE "session"
       SET "expiresAt" = date_trunc('milliseconds', clock_timestamp()) + interval '25 milliseconds'
       WHERE id = $1 AND "userId" = $2 RETURNING "expiresAt"`,
      [sessionId, userId],
    );
    await observeBlockedVerifier(pid, statement, {
      at: updated.rows[0]!.expiresAt,
      crossed: true,
      waiterPid,
    });
    await locker.query('COMMIT');
    const response = await waiting;
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'SESSION_REQUIRED' });
    const user = await pool.query('SELECT "phoneNumber" FROM "user" WHERE id = $1', [userId]);
    expect(user.rows[0].phoneNumber).toBeNull();
  } finally {
    try {
      await locker.query('ROLLBACK');
    } finally {
      locker.release();
      await waiting?.catch(() => {});
    }
  }
});

it('does not restore a consumed code when session creation fails', async () => {
  const phoneNumber = '13800138021';
  const code = await send('/api/auth/phone-number/send-otp', phoneNumber);
  await pool.query(`CREATE FUNCTION reject_phone_session() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test session creation failure'; END $$`);
  await pool.query(
    'CREATE TRIGGER reject_phone_session BEFORE INSERT ON "session" FOR EACH ROW EXECUTE FUNCTION reject_phone_session()',
  );
  try {
    const failure = await call('/api/auth/phone-number/verify', { phoneNumber, code });
    expect(failure.status).toBeGreaterThanOrEqual(500);
    expect(failure.headers.getSetCookie()).toHaveLength(0);
  } finally {
    await pool.query('DROP TRIGGER reject_phone_session ON "session"');
    await pool.query('DROP FUNCTION reject_phone_session()');
  }
  expect((await call('/api/auth/phone-number/verify', { phoneNumber, code })).status).toBe(400);
});

it('retains the rolling hourly phone budget after the cooldown has elapsed', async () => {
  const phoneNumber = '13800138022';
  for (let index = 0; index < 5; index++) {
    expect((await call('/api/auth/phone-number/send-otp', { phoneNumber })).status).toBe(200);
    await pool.query(`UPDATE "mioSmsBudget" SET events = (
      SELECT COALESCE(json_agg((value::text)::bigint - 61000)::text, '[]')
      FROM json_array_elements(events::json)
    )`);
  }
  expect(
    (await call('/api/auth/phone-number/send-otp', { phoneNumber }, undefined, 1)).status,
  ).toBe(429);
});
