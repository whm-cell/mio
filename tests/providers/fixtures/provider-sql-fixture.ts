import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { expect, onTestFinished, vi } from 'vitest';
import { authDatabase } from '../../support/auth-database.ts';
import { providerSchemaSQL } from '../../../src/providers/schema.ts';
import { adminSchemaSQL } from '../../../src/admin/schema.ts';
import { ProviderStore } from '../../../src/providers/store.ts';
import { AdminStore } from '../../../src/admin/store.ts';
import { createProviderService } from '../../../src/providers/service.ts';
import { createAdminService } from '../../../src/admin/service.ts';
import { makeChatRouteFixture } from './onelink-routes-fixture.ts';

export async function providerSqlFixture(ids = ['batch-a', 'batch-z']) {
  const database = await authDatabase();
  const pools: Pool[] = [];
  const createPool = (name: string) => {
    const url = new URL(database.url);
    url.searchParams.set('application_name', name);
    const pool = new Pool({ connectionString: url.toString(), max: 4, statement_timeout: 5000 });
    pools.push(pool);
    return pool;
  };
  onTestFinished(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await database.close();
  });
  const pool = createPool(database.applicationName);
  await pool.query(providerSchemaSQL);
  await pool.query(adminSchemaSQL);
  const config = {
    databaseURL: database.url,
    masterKey: randomBytes(32),
    masterKeyId: 'sql-fixture',
    catalogWhitelist: true,
  };
  const store = new ProviderStore(pool, config),
    admin = new AdminStore(
      pool,
      null,
      false,
      null,
      { revision: 0, retentionDays: null },
      { revision: 0, quotaBytes: 5_368_709_120, warningAvailableBytes: 1_073_741_824 },
    );
  const service = createProviderService(store, config, async () => {
    throw new Error('EXTERNAL_REQUEST_FORBIDDEN');
  });
  const adminService = createAdminService(admin, service, config);
  const account = {
    id: randomUUID(),
    username: 'sql_fixture',
    isSuperAdmin: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const principal = { admin: account, sessionId: 'fixture', tokenDigest: '0'.repeat(64) };
  await pool.query('INSERT INTO mio_admin_accounts(id,username,password_hash) VALUES($1,$2,$3)', [
    account.id,
    account.username,
    'synthetic-not-a-login-hash',
  ]);
  const actor = { userId: randomUUID(), sessionId: 'fixture' };
  await store.save(actor.userId, 0, 'synthetic-sql-key');
  const providerId = (
    await pool.query<{ id: string }>(
      `UPDATE mio_provider_configs SET catalog_version=1,
    catalog_credential_version=credential_version,catalog_succeeded_at=now(),credential_auth_state='valid',
    latest_refresh_seq=1,last_attempt_seq=1,last_attempt_credential_version=1,last_attempt_started_at=now(),last_attempt_finished_at=now(),last_attempt_status='connected',discovery=$2::jsonb WHERE owner_id=$1 RETURNING id`,
      [
        actor.userId,
        JSON.stringify({
          credentialVersion: 1,
          refreshSeq: 1,
          checkedAt: new Date().toISOString(),
          scope: 'models-only',
          status: 'connected',
          ids,
          error: null,
        }),
      ],
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO mio_provider_models(provider_id,raw_model_id,supplier_metadata,metadata_source,
    credential_version,catalog_version,first_seen_at,last_seen_at,membership_state)
    SELECT $1,id,jsonb_build_object('id',id,'object','model'),'onelink-v1-models',1,1,now(),now(),'current' FROM unnest($2::text[]) id`,
    [providerId, ids],
  );
  const route = (id: string) =>
    makeChatRouteFixture(id, 'openai', { source: 'isolated SQL fixture', sourceVersion: 'v1' });
  if (ids.length) await store.importRoutes(ids.map(route));
  const models = (
    await pool.query<{ model_key: string; raw_model_id: string }>(
      'SELECT model_key,raw_model_id FROM mio_provider_models WHERE provider_id=$1',
      [providerId],
    )
  ).rows;
  const peer = (
    after?: (
      sql: string,
      args: unknown[] | undefined,
      result: QueryResult<Record<string, unknown>>,
    ) => Promise<void> | void,
  ) => {
    const name = database.applicationName + '_' + randomUUID().slice(0, 8);
    const peerPool = createPool(name);
    const trace: string[] = [];
    const proxy = new Proxy(peerPool, {
      get(target, key) {
        if (key === 'connect')
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, property) {
                if (property === 'query')
                  return async (sql: string, args?: unknown[]) => {
                    trace.push(sql);
                    const result = await connection.query<Record<string, unknown>>(sql, args);
                    await after?.(sql, args, result);
                    return result;
                  };
                const value = Reflect.get(connection, property);
                return typeof value === 'function' ? value.bind(connection) : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const peerStore = new ProviderStore(proxy, config),
      peerAdmin = new AdminStore(
        proxy,
        null,
        false,
        null,
        { revision: 0, retentionDays: null },
        { revision: 0, quotaBytes: 5_368_709_120, warningAvailableBytes: 1_073_741_824 },
      );
    return {
      name,
      trace,
      store: peerStore,
      admin: peerAdmin,
      adminService: createAdminService(peerAdmin, service, config),
    };
  };
  const count = async (sql: string, args?: unknown[]) =>
    (await pool.query<{ n: number }>(sql, args)).rows[0]!.n;
  const reverseImportPeers = () => {
    let arrived = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return [0, 1].map(() => {
      let first = true;
      return peer(async (sql, args, result) => {
        // Old scalar loops deterministically deadlock here; set locks return every row before this hook.
        if (
          first &&
          sql.includes('FOR UPDATE') &&
          result.rows.length === 1 &&
          typeof args?.[0] === 'string'
        ) {
          first = false;
          if (++arrived === 2) release();
          await gate;
        }
      });
    });
  };
  const waitBlocked = (applicationName: string) =>
    vi.waitFor(async () =>
      expect(
        (
          await pool.query(
            'SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0',
            [applicationName],
          )
        ).rows,
      ).toHaveLength(1),
    );
  return {
    database,
    pool,
    store,
    admin,
    service,
    adminService,
    config,
    actor,
    account,
    principal,
    providerId,
    models,
    route,
    peer,
    count,
    reverseImportPeers,
    waitBlocked,
  };
}
