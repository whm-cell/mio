import { migrateSmsBudget } from '../../scripts/service/migrate-auth-sms-budget.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { authDatabase } from '../support/auth-database.ts';
import { authOptions, readAuthConfig } from '../../src/auth/config.ts';
import { authDeletionGuardsSQL } from '../../src/auth/deletion-schema.ts';
import { createAuthentication } from '../../src/auth/service.ts';
import type { AuthRuntimePolicy } from '../../src/auth/config.ts';

export async function deletionAuthFixture() {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  const secret = randomBytes(40).toString('hex');
  const config = readAuthConfig({
    MIO_AUTH_BASE_URL: 'http://127.0.0.1:19191',
    MIO_AUTH_SECRET: secret,
    MIO_AUTH_DATABASE_URL: database.url,
  })!;
  await (await getMigrations(authOptions(config, pool))).runMigrations();
  await pool.query(authDeletionGuardsSQL);
  await migrateSmsBudget(pool, false);
  let policy: AuthRuntimePolicy = {
    emailPasswordEnabled: true,
    smsMode: 'bypass',
    smsBypassCode: '123456',
  };
  const auth = await createAuthentication(config, undefined, undefined, () => policy);
  const request = (path: string, body?: unknown, cookie?: string) =>
    auth.handler(
      new Request(config.baseURL + '/api/auth/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          origin: config.baseURL,
          'content-type': 'application/json',
          'x-mio-client-ip': '192.0.2.22',
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const register = async (email = randomUUID() + '@example.test') => {
    const result = await request('sign-up/email', {
      email,
      password: 'strong-test-password-143',
      name: 'private owner',
    });
    if (result.status !== 200) throw new Error('FIXTURE_SIGNUP: ' + (await result.text()));
    const cookie = result.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const identity = await auth.identity(new Headers({ cookie }));
    if (!identity) throw new Error('FIXTURE_SESSION');
    return { email, cookie, ...identity };
  };
  return {
    database,
    pool,
    config,
    secret,
    auth,
    request,
    register,
    setPolicy: (value: AuthRuntimePolicy) => {
      policy = value;
    },
    async close() {
      await auth.close();
      await pool.end();
      await database.close();
    },
  };
}
