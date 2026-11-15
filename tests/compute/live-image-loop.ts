import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import {
  COMMAND_EXCHANGE,
  COMMAND_QUEUE,
  COMMAND_ROUTING_KEY,
  RESULT_EXCHANGE,
  RESULT_ROUTING_KEY,
} from '@mio/compute-contracts';
import type { ImageCommandV1, ImageResultV1 } from '@mio/compute-contracts';
import { connect } from 'amqplib';
import { launcher, prepareProfile } from '../../scripts/service/profile.ts';
import { readProviderConfig } from '../../src/providers/config.ts';
import { decryptCredential } from '../../src/providers/credentials.ts';
import type { CredentialEnvelope } from '../../src/providers/credentials.ts';
import { validateImage } from '../../compute/src/adapters/media.ts';

// This is a single-run, explicitly opted-in acceptance entry, not an application launcher.
// All credentials, cookies, output bodies and URLs remain in this process or private files.
assert.equal(process.env.MIO_RUN_LIVE_IMAGE, 'yes', 'LIVE_OPT_IN');
const SCENARIOS = ['vidu-async', 'seedream-sync', 'gpt-sync', 'gpt-edit'] as const;
type Scenario = (typeof SCENARIOS)[number];
function parseCliArguments(argv: string[]) {
  let cliScenario: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--scenario') {
      assert(cliScenario === undefined && i + 1 < argv.length, 'LIVE_ARGUMENTS');
      cliScenario = argv[++i];
    } else if (arg.startsWith('--scenario=')) {
      assert(cliScenario === undefined, 'LIVE_ARGUMENTS');
      cliScenario = arg.slice('--scenario='.length);
    } else {
      positional.push(arg);
    }
  }
  const envScenario = process.env.MIO_LIVE_IMAGE_SCENARIO;
  assert(!cliScenario || !envScenario || cliScenario === envScenario, 'LIVE_ARGUMENTS');
  const raw = cliScenario ?? (envScenario && envScenario.length ? envScenario : undefined);
  const selected = raw ?? 'vidu-async';
  assert((SCENARIOS as readonly string[]).includes(selected), 'LIVE_SCENARIO');
  return {
    scenario: selected as Scenario,
    explicitScenario: raw !== undefined,
    positional,
  };
}
const {
  scenario,
  explicitScenario,
  positional: [phase, runArgument, first, second, candidate, ...extra],
} = parseCliArguments(process.argv.slice(2));
assert(
  ['prepare', 'execute'].includes(phase ?? '') &&
    runArgument &&
    first &&
    second &&
    candidate &&
    !extra.length,
  'LIVE_ARGUMENTS',
);
assert.match(candidate, /^[a-f0-9]{64}$/, 'LIVE_CANDIDATE');
const project = resolve('.');
const directory = resolve(runArgument);
assert(directory.startsWith(`${resolve('.runtime')}${sep}`), 'LIVE_PRIVATE_DIRECTORY');
const originPath = join(directory, 'state.json');
const history = join(directory, 'events.jsonl');
type Environment = Record<string, string>;
type Infrastructure = {
  runDirectory: string;
  project: string;
  postgresDatabase: string;
  rabbitVhost: string;
  ports: { postgres: number; amqp: number; management: number };
};
type State = {
  candidate: string;
  scenario?: Scenario;
  origin: string;
  a: Environment;
  b: Environment;
  owner: { email: string; password: string; userId: string };
  other: { email: string; password: string };
  modelRef: string;
  infrastructure: string;
};
function privateEnv(path: string): Environment {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077), 'LIVE_PRIVATE_ENV');
  return parseEnv(readFileSync(path, 'utf8')) as Environment;
}
function infrastructureManifest(directory: string): Infrastructure {
  const path = join(directory, 'manifest.json');
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077), 'LIVE_PRIVATE_MANIFEST');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Infrastructure;
  assert(
    value.runDirectory === directory &&
      /^miow3[a-z0-9]+$/.test(value.project) &&
      /^mio_w3_[a-z0-9_]+$/.test(value.postgresDatabase) &&
      /^mio-w3-[a-z0-9]+$/.test(value.rabbitVhost),
    'LIVE_INFRASTRUCTURE_SCOPE',
  );
  assert(
    Object.values(value.ports).every(
      (port) => Number.isInteger(port) && port > 1023 && port < 65536,
    ),
    'LIVE_INFRASTRUCTURE_PORTS',
  );
  return value;
}
function record(event: string, data: Record<string, unknown> = {}) {
  writeFileSync(history, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`, {
    flag: 'a',
    mode: 0o600,
  });
  console.log(event, JSON.stringify(data));
}
function fileHash(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function save(path: string, value: unknown, onceOnly = false) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    ...(onceOnly ? { flag: 'wx' } : {}),
  });
}
function queryAuditSummary() {
  const issued: number[] = [];
  const responses: number[] = [];
  const traces: number[] = [];
  for (let attempt = 1; attempt <= 8; attempt++) {
    if (existsSync(join(directory, `supplier-query-${attempt}.json`))) issued.push(attempt);
    if (existsSync(join(directory, `supplier-query-${attempt}-response.json`)))
      responses.push(attempt);
    if (existsSync(join(directory, `supplier-query-${attempt}-trace.json`))) traces.push(attempt);
  }
  const missingResponses = issued.filter((attempt) => !responses.includes(attempt));
  const missingTraces = responses.filter((attempt) => !traces.includes(attempt));
  return { issued, responses, traces, missingResponses, missingTraces };
}
async function settleQueryAudit() {
  for (let i = 0; i < 50; i++) {
    const audit = queryAuditSummary();
    if (!audit.missingResponses.length && !audit.missingTraces.length) break;
    await delay(100);
  }
}
function child(
  file: string,
  args: string[],
  env: Environment,
  log: string,
  cwd = project,
): ChildProcess {
  const fd = openSync(join(directory, log), 'a', 0o600);
  try {
    return spawn(process.execPath, [file, ...args], {
      cwd,
      env,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
}
function command(file: string, args: string[], env: Environment) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: project,
    env,
    timeout: 30_000,
    stdio: 'ignore',
  });
  assert.equal(result.status, 0, 'LIVE_COMMAND_FAILED');
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object', 'LIVE_PORT');
  const port = address.port;
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
  return port;
}
async function startApp(state: Pick<State, 'a' | 'origin'>) {
  const process = child(launcher(), ['--profile', 'mio'], state.a, 'app.log', directory);
  try {
    for (let i = 0; i < 150; i++) {
      assert(process.exitCode === null && process.signalCode === null, 'LIVE_APP_EXITED');
      try {
        if ((await fetch(`${state.origin}/readyz`, { signal: AbortSignal.timeout(500) })).ok)
          return process;
      } catch {
        /* listener is starting */
      }
      await delay(100);
    }
    throw new Error('LIVE_APP_TIMEOUT');
  } catch (error) {
    try {
      await stop(process);
    } catch {
      record('cleanup-failed', {
        component: 'app-start',
        alive: process.exitCode === null && process.signalCode === null,
      });
    }
    throw error;
  }
}
async function stop(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit');
  process.kill('SIGTERM');
  // Synchronous ffprobe/ffmpeg can delay signal handling by up to 25 seconds.
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<boolean>((done) => {
      timer = setTimeout(() => done(false), 45_000);
    });
    const result = await Promise.race([exited.then(() => true), timeout]);
    assert(result, 'LIVE_STOP_TIMEOUT');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function interruptHeldWorker(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit');
  assert(process.kill('SIGKILL'), 'LIVE_WORKER_INTERRUPT');
  await bounded(exited);
  assert.equal(process.signalCode, 'SIGKILL', 'LIVE_WORKER_INTERRUPT');
}
async function bounded(action: Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_done, fail) => {
      timer = setTimeout(() => fail(new Error('LIVE_WAIT_TIMEOUT')), 10_000);
    });
    await Promise.race([action, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function request(
  origin: string,
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25_000),
  });
}
function session(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function login(origin: string, identity: { email: string; password: string }) {
  const response = await request(origin, '/api/auth/sign-in/email', 'POST', identity);
  assert.equal(response.status, 200, 'LIVE_LOGIN');
  const cookie = session(response);
  assert(cookie, 'LIVE_COOKIE');
  return cookie;
}
async function providerKey(path: string) {
  const config = readProviderConfig(privateEnv(path));
  assert(config, 'LIVE_SOURCE_PROVIDER_CONFIG');
  const pool = new Pool({ connectionString: config.databaseURL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const rows = await client.query<
      CredentialEnvelope & { id: string; owner_id: string; credential_version: number }
    >(
      "SELECT id,owner_id,credential_version,cipher_format,master_key_id,nonce,ciphertext,auth_tag FROM mio_provider_configs WHERE enabled=true AND credential_auth_state='valid'",
    );
    assert.equal(rows.rowCount, 1, 'LIVE_SOURCE_PROVIDER_COUNT');
    const row = rows.rows[0]!;
    const key = decryptCredential(
      row,
      { ownerId: row.owner_id, providerId: row.id, credentialVersion: row.credential_version },
      config,
    );
    await client.query('COMMIT');
    return key;
  } finally {
    client.release();
    await pool.end();
  }
}
async function prepare() {
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const infrastructure = resolve(first!);
  const manifest = infrastructureManifest(infrastructure);
  const pg = privateEnv(join(infrastructure, 'postgres.env'));
  const brokerA = privateEnv(join(infrastructure, 'rabbit-a.env'));
  const brokerB = privateEnv(join(infrastructure, 'rabbit-b.env'));
  const database = new URL(pg.MIO_TEST_DATABASE_URL!);
  assert(
    database.hostname === '127.0.0.1' &&
      database.port === String(manifest.ports.postgres) &&
      database.pathname === `/${manifest.postgresDatabase}`,
    'LIVE_DATABASE_SCOPE',
  );
  assert(
    brokerA.MIO_COMPUTE_BROKER_USER !== brokerB.MIO_COMPUTE_BROKER_USER &&
      brokerA.MIO_COMPUTE_EXPECTED_RESULT_USER === brokerB.MIO_COMPUTE_BROKER_USER &&
      brokerB.MIO_COMPUTE_EXPECTED_COMMAND_USER === brokerA.MIO_COMPUTE_BROKER_USER,
    'LIVE_BROKER_IDENTITIES',
  );
  for (const role of [brokerA, brokerB]) {
    const broker = new URL(role.RABBITMQ_URL!);
    assert(
      broker.hostname === '127.0.0.1' &&
        broker.port === String(manifest.ports.amqp) &&
        decodeURIComponent(broker.pathname.slice(1)) === manifest.rabbitVhost &&
        decodeURIComponent(broker.username) === role.MIO_COMPUTE_BROKER_USER,
      'LIVE_BROKER_SCOPE',
    );
  }
  const empty = new Pool({ connectionString: pg.MIO_TEST_DATABASE_URL });
  try {
    const tables = await empty.query<{ count: string }>(
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
    );
    assert.equal(Number(tables.rows[0]!.count), 0, 'LIVE_DATABASE_NOT_EMPTY');
  } finally {
    await empty.end();
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const base = {
    PATH: process.env.PATH ?? '',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    NODE_ENV: 'test',
  };
  const a: Environment = {
    ...base,
    ...brokerA,
    DSH_HOME: join(directory, 'dsh'),
    DSH_AGENTS_HOME: join(directory, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    MIO_API_TOKEN: randomBytes(32).toString('hex'),
    MIO_HOST: '127.0.0.1',
    MIO_PORT: String(port),
    MIO_AUTH_BASE_URL: origin,
    MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    MIO_AUTH_DATABASE_URL: pg.MIO_TEST_DATABASE_URL!,
    MIO_ASSETS_DATABASE_URL: pg.MIO_TEST_DATABASE_URL!,
    MIO_PROVIDERS_DATABASE_URL: pg.MIO_TEST_DATABASE_URL!,
    MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
    MIO_PROVIDERS_MASTER_KEY_ID: 'w3-live',
    MIO_COMPUTE_ENABLED: 'true',
    MIO_IMAGE_KEY_ID: 'w3-live',
    MIO_IMAGE_PUBLIC_KEY: keys.publicKey,
    MIO_COS_BUCKET: 'mio-compute-assets-1302811912',
    MIO_COS_REGION: 'ap-beijing',
    MIO_COS_SECRET_ID: 'placeholder',
    MIO_COS_SECRET_KEY: 'placeholder',
  };
  const b: Environment = {
    ...base,
    ...brokerB,
    MIO_COMPUTE_DIRECTORY: join(directory, 'journal'),
    MIO_COMPUTE_INSTANCE_ID: randomUUID(),
    MIO_IMAGE_KEY_ID: 'w3-live',
    MIO_IMAGE_PRIVATE_KEY: keys.privateKey,
    MIO_LIVE_IMAGE_AUDIT_DIRECTORY: directory,
    MIO_LIVE_IMAGE_SCENARIO: scenario,
  };
  save(join(directory, 'private-config.json'), { a, b }, true);
  record('prepare-start', {
    candidate,
    scenario,
    runnerSha256: fileHash('tests/compute/live-image-loop.ts'),
    auditSha256: fileHash('tests/compute/live-image-audit.ts'),
    appEntrySha256: fileHash('dist/plugin.js'),
    workerEntrySha256: fileHash('compute/dist/main.js'),
  });
  for (const migration of ['auth', 'assets', 'compute', 'providers'])
    command(`scripts/service/migrate-${migration}.ts`, ['--apply'], a);
  command('compute/dist/main.js', ['init'], b);
  await prepareProfile(a.DSH_HOME!, project);
  const app = await startApp({ a, origin });
  try {
    const owner = {
      email: `w3-${randomUUID()}@example.test`,
      password: randomBytes(24).toString('hex'),
      userId: '',
    };
    const other = {
      email: `w3-${randomUUID()}@example.test`,
      password: randomBytes(24).toString('hex'),
    };
    for (const identity of [owner, other]) {
      const response = await request(origin, '/api/auth/sign-up/email', 'POST', {
        name: 'W3 acceptance',
        email: identity.email,
        password: identity.password,
      });
      assert.equal(response.status, 200, 'LIVE_SIGNUP');
    }
    const cookie = await login(origin, { email: owner.email, password: owner.password });
    const me = await request(origin, '/api/v1/me', 'GET', undefined, cookie);
    assert.equal(me.status, 200, 'LIVE_IDENTITY');
    owner.userId = ((await me.json()) as { userId: string }).userId;
    const key = await providerKey(second!);
    assert.equal(
      (
        await request(
          origin,
          '/api/v1/providers/onelink/credential',
          'PUT',
          { apiKey: key, expectedRevision: 0 },
          cookie,
        )
      ).status,
      200,
      'LIVE_PROVIDER_SAVE',
    );
    const discover = await request(origin, '/api/v1/providers/onelink/test', 'POST', {}, cookie);
    assert.equal(discover.status, 200, 'LIVE_DISCOVERY_HTTP');
    const discovery = (await discover.json()) as {
      status: string;
      ids: string[];
      checkedAt: string;
      credentialVersion: number;
    };
    assert.equal(discovery.status, 'connected', 'LIVE_DISCOVERY');
    const catalog = await request(
      origin,
      '/api/v1/providers/onelink/models',
      'GET',
      undefined,
      cookie,
    );
    assert.equal(catalog.status, 200, 'LIVE_CATALOG_HTTP');
    const models = (await catalog.json()) as {
      provider: {
        credentialVersion: number;
        catalog: { version: number; credentialVersion: number; current: boolean };
      };
      items: {
        modelId: string;
        modelRef: string;
        discovered: boolean;
        credentialVersion: number;
        catalogVersion: number;
      }[];
    };
    const currentItems = models.items.filter((item) => item.discovered);
    assert(
      Array.isArray(discovery.ids) &&
        new Set(discovery.ids).size === discovery.ids.length &&
        currentItems.length === discovery.ids.length &&
        currentItems.every((item) => discovery.ids.includes(item.modelId)) &&
        models.provider.catalog.current &&
        discovery.credentialVersion === models.provider.credentialVersion &&
        models.provider.catalog.credentialVersion === models.provider.credentialVersion,
      'LIVE_CATALOG_SNAPSHOT',
    );
    save(
      join(directory, 'discovery-snapshot.json'),
      {
        status: discovery.status,
        checkedAt: discovery.checkedAt,
        credentialVersion: models.provider.credentialVersion,
        catalogVersion: models.provider.catalog.version,
        items: currentItems.map((item) => ({
          modelId: item.modelId,
          discovered: item.discovered,
          credentialVersion: item.credentialVersion,
          catalogVersion: item.catalogVersion,
        })),
      },
      true,
    );
    const selected = models.items.find(
      (item) =>
        item.discovered &&
        (scenario === 'vidu-async'
          ? item.modelId === 'image-vidu-q2'
          : scenario === 'seedream-sync'
            ? item.modelId === 'doubao-seedream-4.0'
            : item.modelId === 'gpt-image-1' || item.modelId.startsWith('gpt-image-')),
    );
    assert(
      selected &&
        selected.credentialVersion === models.provider.credentialVersion &&
        selected.catalogVersion === models.provider.catalog.version,
      'LIVE_MODEL_NOT_FOUND',
    );
    const view = await request(origin, '/api/v1/providers/onelink', 'GET', undefined, cookie);
    const revision = ((await view.json()) as { revision: number }).revision;
    const declaration = join(directory, 'declaration.json');
    const expectedProfile =
      scenario === 'vidu-async'
        ? 'vidu-image-v1'
        : scenario === 'seedream-sync'
          ? 'seedream-4-images-v1'
          : 'gpt-images-v1';
    save(
      declaration,
      scenario === 'vidu-async'
        ? {
            modelRef: selected.modelRef,
            operation: 'image.generate',
            profile: 'vidu-image-v1',
            sourceKind: 'protocol-reference',
            source: 'https://docs.onelinkai.cloud/8653257m0',
            sourceVersion: '2026-11-14',
            classification: 'image',
            metadata: {
              image: {
                modes: ['generate'],
                references: { maxImages: 7 },
                async: { operations: ['generate'], maxQueries: 8, maxAgeSeconds: 600 },
              },
            },
          }
        : scenario === 'seedream-sync'
          ? {
              modelRef: selected.modelRef,
              operation: 'image.generate',
              profile: 'seedream-4-images-v1',
              sourceKind: 'protocol-reference',
              source: 'https://docs.onelinkai.cloud/8655248m0',
              sourceVersion: '2026-11-14',
              classification: 'image',
            }
          : {
              modelRef: selected.modelRef,
              operation: 'image.generate',
              profile: 'gpt-images-v1',
              sourceKind: 'protocol-reference',
              source: 'https://docs.onelinkai.cloud/8882392m0',
              sourceVersion: '2026-11-14',
              classification: 'image',
              metadata: {
                image:
                  scenario === 'gpt-edit'
                    ? {
                        modes: ['generate', 'edit'],
                        mask: { format: 'png' },
                        references: { maxImages: 4 },
                      }
                    : { modes: ['generate'] },
              },
            },
      true,
    );
    command(
      'scripts/service/import-provider-adaptation.ts',
      [owner.userId, String(revision), declaration],
      a,
    );
    const adapted = await request(
      origin,
      '/api/v1/providers/onelink/models',
      'GET',
      undefined,
      cookie,
    );
    assert.equal(adapted.status, 200, 'LIVE_ADAPTATION_HTTP');
    const entries = (
      (await adapted.json()) as {
        items: {
          modelRef: string;
          discovered: boolean;
          credentialVersion: number;
          catalogVersion: number;
          image: {
            runnable: boolean;
            adaptation: {
              operation: string;
              profile: string;
              declarationVersion: number;
              sourceKind: string;
              metadata: {
                image?: {
                  modes?: string[];
                  async?: { operations: string[]; maxQueries: number; maxAgeSeconds: number };
                };
              };
            } | null;
          };
        }[];
      }
    ).items;
    const selectedAdaptation = entries.find((item) => item.modelRef === selected.modelRef);
    const adaptation = selectedAdaptation?.image.adaptation;
    const asyncMetadata = adaptation?.metadata?.image?.async;
    assert(
      selectedAdaptation?.discovered &&
        selectedAdaptation.credentialVersion === models.provider.credentialVersion &&
        selectedAdaptation.catalogVersion === models.provider.catalog.version &&
        selectedAdaptation?.image.runnable &&
        adaptation?.operation === 'image.generate' &&
        adaptation.profile === expectedProfile &&
        adaptation.sourceKind === 'protocol-reference' &&
        Number.isSafeInteger(adaptation.declarationVersion) &&
        adaptation.declarationVersion > 0 &&
        (scenario !== 'vidu-async' ||
          (JSON.stringify(asyncMetadata?.operations) === JSON.stringify(['generate']) &&
            asyncMetadata?.maxQueries === 8 &&
            asyncMetadata?.maxAgeSeconds === 600)) &&
        entries.filter((item) => item.image.adaptation?.profile === expectedProfile).length === 1,
      'LIVE_ADAPTATION',
    );
    save(
      join(directory, 'selected-adaptation.json'),
      {
        scenario,
        modelId: selected.modelId,
        discovered: selectedAdaptation.discovered,
        credentialVersion: selectedAdaptation.credentialVersion,
        catalogVersion: selectedAdaptation.catalogVersion,
        operation: adaptation.operation,
        profile: adaptation.profile,
        sourceKind: adaptation.sourceKind,
        adaptationVersion: adaptation.declarationVersion,
        ...(asyncMetadata ? { async: asyncMetadata } : {}),
      },
      true,
    );
    save(
      originPath,
      {
        candidate: candidate!,
        scenario,
        origin,
        a,
        b,
        owner,
        other,
        modelRef: selected.modelRef,
        infrastructure,
      } satisfies State,
      true,
    );
    record('prepare-complete', {
      scenario,
      modelId: selected.modelId,
      selection: 'exact current successful discovery item; not a static model-count or prefix rule',
      directoryMembers: models.items.length,
      discovered: true,
      credentialVersion: selectedAdaptation.credentialVersion,
      catalogVersion: selectedAdaptation.catalogVersion,
      adaptationVersion: adaptation.declarationVersion,
      operation: adaptation.operation,
      profile: adaptation.profile,
      ...(asyncMetadata
        ? {
            maxQueries: asyncMetadata.maxQueries,
            maxAgeSeconds: asyncMetadata.maxAgeSeconds,
          }
        : {}),
      supplierPosts: 0,
    });
  } finally {
    await stop(app);
  }
}

type ImageView = { jobId: string; status: string; errorCode: string | null; assetIds: string[] };
type SavedOutput = { key: string; sizeBytes: number; sha256: string; contentType: string };
type SanitizedSubmissionObservation = {
  statusCode?: number;
  requestIdPresent?: boolean;
  responsePaths?: ('task_id' | 'state' | 'creations' | 'error' | 'other')[];
  taskIdPresent?: boolean;
  errorCategory?:
    | 'none'
    | 'auth'
    | 'rate_limit'
    | 'rejected'
    | 'upstream'
    | 'missing_task_id'
    | 'invalid_task_id'
    | 'malformed_response'
    | 'transport'
    | 'aborted';
};
const submissionObservationPaths = new Set(['task_id', 'state', 'creations', 'error', 'other']);
const submissionErrorCategories = new Set([
  'none',
  'auth',
  'rate_limit',
  'rejected',
  'upstream',
  'missing_task_id',
  'invalid_task_id',
  'malformed_response',
  'transport',
  'aborted',
]);
function safeSubmissionObservation(value: unknown): SanitizedSubmissionObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const observation: SanitizedSubmissionObservation = {};
  if (
    Number.isSafeInteger(input.statusCode) &&
    Number(input.statusCode) >= 100 &&
    Number(input.statusCode) <= 599
  )
    observation.statusCode = Number(input.statusCode);
  if (typeof input.requestIdPresent === 'boolean')
    observation.requestIdPresent = input.requestIdPresent;
  if (Array.isArray(input.responsePaths)) {
    const paths: ('task_id' | 'state' | 'creations' | 'error' | 'other')[] = [];
    for (const path of input.responsePaths) {
      if (typeof path === 'string' && submissionObservationPaths.has(path)) {
        const typed = path as (typeof paths)[number];
        if (!paths.includes(typed)) paths.push(typed);
      }
      if (paths.length === 5) break;
    }
    observation.responsePaths = paths;
  }
  if (typeof input.taskIdPresent === 'boolean') observation.taskIdPresent = input.taskIdPresent;
  if (typeof input.errorCategory === 'string' && submissionErrorCategories.has(input.errorCategory))
    observation.errorCategory = input.errorCategory as NonNullable<
      SanitizedSubmissionObservation['errorCategory']
    >;
  return Object.keys(observation).length ? observation : null;
}
function journalSubmissionObservation(
  journalDirectory: string,
  jobId: string,
): SanitizedSubmissionObservation | null {
  const path = join(journalDirectory, 'journal.sqlite3');
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT payload FROM image_attempts WHERE job_id=?').get(jobId);
    if (!row || typeof row.payload !== 'string') return null;
    const parsed = JSON.parse(row.payload) as { observation?: unknown };
    return safeSubmissionObservation(parsed.observation);
  } catch {
    return null;
  } finally {
    db.close();
  }
}
async function assetBytes(
  state: State,
  cookie: string,
  otherCookie: string,
  assetId: string,
  expected: SavedOutput,
) {
  const path = `/api/v1/assets/${assetId}`;
  assert.equal((await request(state.origin, path)).status, 401, 'LIVE_ASSET_UNAUTHENTICATED');
  assert.equal(
    (await request(state.origin, path, 'GET', undefined, otherCookie)).status,
    404,
    'LIVE_ASSET_OTHER_OWNER',
  );
  const response = await request(state.origin, path, 'GET', undefined, cookie);
  assert.equal(response.status, 200, 'LIVE_ASSET_GET');
  const asset = (await response.json()) as {
    contentType: string;
    size: number;
    downloadUrl: string;
  };
  assert(
    asset.contentType === expected.contentType && asset.size === expected.sizeBytes,
    'LIVE_ASSET_METADATA',
  );
  const url = new URL(asset.downloadUrl);
  assert(
    url.protocol === 'https:' &&
      url.hostname === `${state.a.MIO_COS_BUCKET}.cos.${state.a.MIO_COS_REGION}.myqcloud.com`,
    'LIVE_ASSET_HOST',
  );
  const securityToken = url.searchParams.get('x-cos-security-token');
  if (state.a.MIO_COS_SESSION_TOKEN) {
    assert.equal(securityToken, state.a.MIO_COS_SESSION_TOKEN, 'LIVE_ASSET_TOKEN_ENCODING');
  } else {
    assert.equal(securityToken, null, 'LIVE_ASSET_TOKEN_ABSENT_FOR_STATIC_CREDENTIAL');
  }
  const download = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.equal(download.status, 200, 'LIVE_ASSET_DOWNLOAD');
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.length, expected.sizeBytes, 'LIVE_ASSET_SIZE');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    expected.sha256,
    'LIVE_ASSET_HASH',
  );
  validateImage(bytes, asset.contentType.slice('image/'.length));
}
async function commandQueueState(infrastructure: string) {
  const manifest = infrastructureManifest(infrastructure);
  const admin = privateEnv(join(infrastructure, 'rabbit-admin.env'));
  const management = new URL(admin.RABBITMQ_MANAGEMENT_URL!);
  assert(
    management.hostname === '127.0.0.1' &&
      management.port === String(manifest.ports.management) &&
      admin.RABBITMQ_DEFAULT_VHOST === manifest.rabbitVhost,
    'LIVE_MANAGEMENT_SCOPE',
  );
  const endpoint = new URL(
    `/api/queues/${encodeURIComponent(manifest.rabbitVhost)}/${encodeURIComponent(COMMAND_QUEUE)}`,
    management,
  );
  const response = await fetch(endpoint, {
    headers: {
      authorization: `Basic ${Buffer.from(`${admin.RABBITMQ_DEFAULT_USER}:${admin.RABBITMQ_DEFAULT_PASS}`).toString('base64')}`,
    },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, 'LIVE_MQ_MANAGEMENT');
  return (await response.json()) as {
    messages_ready?: number;
    messages_unacknowledged?: number;
    consumers?: number;
  };
}
async function waitCommandQueue(infrastructure: string, consumers: number) {
  for (let i = 0; i < 30; i++) {
    const state = await commandQueueState(infrastructure);
    if (
      state.messages_ready === 0 &&
      state.messages_unacknowledged === 0 &&
      state.consumers === consumers
    )
      return;
    await delay(1000);
  }
  throw new Error('LIVE_COMMAND_QUEUE_NOT_DRAINED');
}
async function waitHeldQueryRedelivery(infrastructure: string) {
  for (let i = 0; i < 30; i++) {
    const state = await commandQueueState(infrastructure);
    if (state.messages_ready === 1 && state.messages_unacknowledged === 0 && state.consumers === 0)
      return;
    await delay(1000);
  }
  throw new Error('LIVE_QUERY_NOT_REQUEUED');
}
async function openObserver(state: State, command: ImageCommandV1, expected: SavedOutput) {
  const admin = privateEnv(join(state.infrastructure, 'rabbit-admin.env'));
  const url = new URL(state.b.RABBITMQ_URL!);
  url.username = admin.RABBITMQ_DEFAULT_USER!;
  url.password = admin.RABBITMQ_DEFAULT_PASS!;
  const connection = await connect(url.toString());
  try {
    const channel = await connection.createChannel();
    const queue = await channel.assertQueue('', { exclusive: true, autoDelete: true });
    await channel.bindQueue(queue.queue, RESULT_EXCHANGE, RESULT_ROUTING_KEY);
    let sent = false;
    let early = false;
    let complete: (message: string) => void = () => {};
    const observed = new Promise<string>((done) => {
      complete = done;
    });
    await channel.consume(
      queue.queue,
      (message) => {
        if (!message) return;
        if (!sent) {
          early = true;
          return;
        }
        try {
          const result = JSON.parse(message.content.toString('utf8')) as ImageResultV1;
          const output = result.outputs[0];
          if (
            message.properties.userId === state.b.MIO_COMPUTE_BROKER_USER &&
            result.type === 'image.result' &&
            result.jobId === command.jobId &&
            result.commandId === command.messageId &&
            result.state === 'completed' &&
            result.outputs.length === 1 &&
            output?.key === expected.key &&
            output.sha256 === expected.sha256 &&
            output.sizeBytes === expected.sizeBytes &&
            output.contentType === expected.contentType
          )
            complete(result.messageId);
        } catch {
          /* An unrelated or malformed copy is not evidence. */
        }
      },
      { noAck: true },
    );
    return {
      connection,
      start() {
        assert(!early, 'LIVE_REPLAY_EARLY_RESULT');
        sent = true;
      },
      async result() {
        let timer: NodeJS.Timeout | undefined;
        try {
          const timeout = new Promise<never>((_done, fail) => {
            timer = setTimeout(() => fail(new Error('LIVE_REPLAY_NOT_OBSERVED')), 30_000);
          });
          return await Promise.race([observed, timeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    };
  } catch (error) {
    try {
      await bounded(connection.close());
    } catch {
      record('cleanup-failed', { component: 'observer', alive: 'unknown' });
    }
    throw error;
  }
}
async function replay(state: State, command: ImageCommandV1) {
  const connection = await connect(state.a.RABBITMQ_URL!);
  let failure: unknown;
  let closeFailed = false;
  try {
    const channel = await connection.createConfirmChannel();
    channel.publish(COMMAND_EXCHANGE, COMMAND_ROUTING_KEY, Buffer.from(JSON.stringify(command)), {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId: command.messageId,
      userId: state.a.MIO_COMPUTE_BROKER_USER!,
    });
    await bounded(channel.waitForConfirms());
  } catch (error) {
    failure = error;
  } finally {
    try {
      await bounded(connection.close());
    } catch {
      closeFailed = true;
      record('cleanup-failed', { component: 'replay-connection', alive: 'unknown' });
    }
  }
  if (failure) throw failure;
  if (closeFailed) throw new Error('LIVE_CLEANUP_INCOMPLETE');
}
async function execute() {
  const state = JSON.parse(readFileSync(originPath, 'utf8')) as State;
  assert.equal(state.candidate, candidate, 'LIVE_CANDIDATE_CHANGED');
  const activeScenario: Scenario = state.scenario ?? 'vidu-async';
  assert(!explicitScenario || activeScenario === scenario, 'LIVE_SCENARIO_CHANGED');
  const isAsync = activeScenario === 'vidu-async';
  const expectedProfile =
    activeScenario === 'vidu-async'
      ? 'vidu-image-v1'
      : activeScenario === 'seedream-sync'
        ? 'seedream-4-images-v1'
        : 'gpt-images-v1';
  state.b.MIO_LIVE_IMAGE_SCENARIO = activeScenario;
  const aCos = privateEnv(first!);
  const rawBCos = privateEnv(second!);
  const bCos: Environment = { ...rawBCos };
  if (resolve(first!) === resolve(second!)) {
    assert(
      rawBCos.MIO_LOCAL_COMPUTE_COS_SECRET_ID && rawBCos.MIO_LOCAL_COMPUTE_COS_SECRET_KEY,
      'LIVE_COS_WORKER_IDENTITIES',
    );
    bCos.MIO_COS_SECRET_ID = rawBCos.MIO_LOCAL_COMPUTE_COS_SECRET_ID;
    bCos.MIO_COS_SECRET_KEY = rawBCos.MIO_LOCAL_COMPUTE_COS_SECRET_KEY;
    if (rawBCos.MIO_LOCAL_COMPUTE_COS_SESSION_TOKEN)
      bCos.MIO_COS_SESSION_TOKEN = rawBCos.MIO_LOCAL_COMPUTE_COS_SESSION_TOKEN;
    else delete bCos.MIO_COS_SESSION_TOKEN;
  }
  for (const env of [aCos, bCos]) {
    assert(
      env.MIO_COS_BUCKET === 'mio-compute-assets-1302811912' &&
        env.MIO_COS_REGION === 'ap-beijing' &&
        env.MIO_COS_SECRET_ID &&
        env.MIO_COS_SECRET_KEY &&
        (env.MIO_COS_SESSION_TOKEN === undefined ||
          (env.MIO_COS_SESSION_TOKEN && !/\s/.test(env.MIO_COS_SESSION_TOKEN))),
      'LIVE_COS_SCOPE',
    );
  }
  assert.notEqual(aCos.MIO_COS_SECRET_ID, bCos.MIO_COS_SECRET_ID, 'LIVE_COS_IDENTITIES');
  const cosKeys = ['MIO_COS_BUCKET', 'MIO_COS_REGION', 'MIO_COS_SECRET_ID', 'MIO_COS_SECRET_KEY'];
  for (const key of cosKeys) {
    state.a[key] = aCos[key]!;
    state.b[key] = bCos[key]!;
  }
  if (aCos.MIO_COS_SESSION_TOKEN) state.a.MIO_COS_SESSION_TOKEN = aCos.MIO_COS_SESSION_TOKEN;
  else delete state.a.MIO_COS_SESSION_TOKEN;
  if (bCos.MIO_COS_SESSION_TOKEN) state.b.MIO_COS_SESSION_TOKEN = bCos.MIO_COS_SESSION_TOKEN;
  else delete state.b.MIO_COS_SESSION_TOKEN;
  save(
    join(directory, 'execute-started.json'),
    { candidate, scenario: activeScenario, at: new Date().toISOString() },
    true,
  );
  save(join(directory, 'runtime-config.json'), { a: state.a, b: state.b }, true);
  const pool = new Pool({ connectionString: state.a.MIO_AUTH_DATABASE_URL });
  let app: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  let heldWorker = false;
  let observer: Awaited<ReturnType<typeof openObserver>> | undefined;
  let operationFailure: unknown;
  const cleanupFailures: string[] = [];
  try {
    app = await startApp(state);
    let cookie = await login(state.origin, {
      email: state.owner.email,
      password: state.owner.password,
    });
    let otherCookie = await login(state.origin, state.other);
    const body = {
      requestId: randomUUID(),
      modelRef: state.modelRef,
      parameters: isAsync
        ? {
            prompt: 'A simple blue square on a white background.',
            async: true,
            size: '1080p',
          }
        : {
            prompt: 'A simple blue square on a white background.',
            n: 1,
            size: '1024x1024',
          },
    };
    const created = await request(state.origin, '/api/v1/compute/images', 'POST', body, cookie);
    assert.equal(created.status, 202, 'LIVE_IMAGE_ADMISSION');
    const accepted = (await created.json()) as ImageView;
    record('image-accepted', {
      scenario: activeScenario,
      jobId: accepted.jobId,
      requestId: body.requestId,
    });
    let frozen: ImageCommandV1 | undefined;
    for (let i = 0; i < 100; i++) {
      const result = await pool.query<{ command: ImageCommandV1; sent_at: Date | null }>(
        'SELECT j.command,o.sent_at FROM mio_image_jobs j JOIN mio_image_outbox o ON o.job_id=j.id WHERE j.id=$1',
        [accepted.jobId],
      );
      if (result.rows[0]?.sent_at) {
        frozen = result.rows[0].command;
        break;
      }
      await delay(200);
    }
    assert(frozen && frozen.profile === expectedProfile && frozen.credential, 'LIVE_OUTBOX');
    save(join(directory, 'encrypted-command.json'), frozen, true);
    record('message-published', { jobId: accepted.jobId, messageId: frozen.messageId });
    let image: ImageView | undefined;
    let queryAttempts = 0;
    if (isAsync) {
      worker = child(
        'compute/dist/main.js',
        ['start'],
        {
          ...state.b,
          MIO_LIVE_IMAGE_HOLD_FIRST_QUERY: 'yes',
          NODE_OPTIONS: `--import=${resolve('tests/compute/live-image-audit.ts')}`,
        },
        'worker.log',
      );
      heldWorker = true;
      let persistedTask: string | undefined;
      let deadline: Date | undefined;
      for (let i = 0; i < 120; i++) {
        assert(worker.exitCode === null && worker.signalCode === null, 'LIVE_WORKER_EXITED');
        const response = await request(
          state.origin,
          `/api/v1/compute/images/${accepted.jobId}`,
          'GET',
          undefined,
          cookie,
        );
        assert.equal(response.status, 200, 'LIVE_IMAGE_GET');
        image = (await response.json()) as ImageView;
        if (['unknown', 'rejected', 'failed', 'materialization_failed'].includes(image.status))
          break;
        if (existsSync(join(directory, 'supplier-query-held.json'))) {
          const result = await pool.query<{
            upstream_task_id: string | null;
            query_attempt: number;
            async_deadline: Date | null;
            sent_at: Date | null;
          }>(
            'SELECT j.upstream_task_id,j.query_attempt,j.async_deadline,o.sent_at FROM mio_image_jobs j JOIN mio_image_outbox o ON o.job_id=j.id WHERE j.id=$1',
            [accepted.jobId],
          );
          const saved = result.rows[0];
          if (
            saved?.upstream_task_id &&
            saved.query_attempt === 1 &&
            saved.async_deadline &&
            saved.sent_at
          ) {
            persistedTask = saved.upstream_task_id;
            deadline = saved.async_deadline;
            break;
          }
        }
        await delay(500);
      }
      let submissionObservation: SanitizedSubmissionObservation | null = null;
      if (!persistedTask || !deadline) {
        if (image?.status === 'unknown') {
          await stop(worker);
          worker = undefined;
          heldWorker = false;
        }
        submissionObservation =
          image?.status === 'unknown'
            ? journalSubmissionObservation(state.b.MIO_COMPUTE_DIRECTORY!, accepted.jobId)
            : null;
        const facts = await pool.query<{
          upstream_task_id: string | null;
          query_attempt: number;
        }>('SELECT upstream_task_id,query_attempt FROM mio_image_jobs WHERE id=$1', [
          accepted.jobId,
        ]);
        if (facts.rows[0]?.upstream_task_id)
          save(
            join(directory, 'known-task.json'),
            { upstreamTaskId: facts.rows[0].upstream_task_id },
            true,
          );
        record('image-outcome', {
          jobId: accepted.jobId,
          status: image?.status ?? 'timeout',
          errorCode: image?.errorCode ?? null,
          supplierPostObserved: existsSync(join(directory, 'supplier-post-started.json')),
          taskIdPresent: Boolean(facts.rows[0]?.upstream_task_id),
          scheduledAttempts: facts.rows[0]?.query_attempt ?? null,
          observation: submissionObservation,
        });
        throw new Error('LIVE_SUBMISSION_NOT_READY');
      }
      assert(!existsSync(join(directory, 'supplier-query-1.json')), 'LIVE_QUERY_ALREADY_SENT');
      await stop(app);
      app = undefined;
      await interruptHeldWorker(worker);
      worker = undefined;
      heldWorker = false;
      await waitHeldQueryRedelivery(state.infrastructure);
      record('restart-before-query', { appStopped: true, workerInterrupted: true, requeued: true });
      // The worker owns the journal's exclusive SQLite lock until it has exited.
      const before = new DatabaseSync(join(state.b.MIO_COMPUTE_DIRECTORY!, 'journal.sqlite3'), {
        readOnly: true,
      });
      try {
        const saved = before
          .prepare('SELECT phase,payload FROM image_attempts WHERE job_id=?')
          .get(accepted.jobId);
        const payload = JSON.parse(String(saved?.payload)) as { upstreamTaskId?: string };
        assert(
          saved?.phase === 'submitted' && payload.upstreamTaskId === persistedTask,
          'LIVE_SUBMISSION_JOURNAL',
        );
      } finally {
        before.close();
      }
      save(join(directory, 'allowed-task.json'), { upstreamTaskId: persistedTask }, true);
      record('query-held-before-network', {
        taskIdPresent: true,
        journalTaskMatches: true,
        queryAttempt: 1,
        deadline: deadline.toISOString(),
        supplierQueriesForwarded: 0,
      });
      app = await startApp(state);
      cookie = await login(state.origin, {
        email: state.owner.email,
        password: state.owner.password,
      });
      otherCookie = await login(state.origin, state.other);
      assert.equal(
        (
          await request(
            state.origin,
            `/api/v1/compute/images/${accepted.jobId}`,
            'GET',
            undefined,
            otherCookie,
          )
        ).status,
        404,
        'LIVE_IMAGE_OTHER_OWNER',
      );
      assert.equal(
        (
          await request(
            state.origin,
            `/api/v1/compute/images/${accepted.jobId}/recover`,
            'POST',
            {},
            otherCookie,
          )
        ).status,
        404,
        'LIVE_IMAGE_OTHER_RECOVERY',
      );
      worker = child(
        'compute/dist/main.js',
        ['start'],
        { ...state.b, NODE_OPTIONS: `--import=${resolve('tests/compute/live-image-audit.ts')}` },
        'worker.log',
      );
      while (Date.now() <= deadline.getTime() + 10_000) {
        assert(worker.exitCode === null && worker.signalCode === null, 'LIVE_WORKER_EXITED');
        const response = await request(
          state.origin,
          `/api/v1/compute/images/${accepted.jobId}`,
          'GET',
          undefined,
          cookie,
        );
        assert.equal(response.status, 200, 'LIVE_IMAGE_GET');
        image = (await response.json()) as ImageView;
        if (
          [
            'completed',
            'partial',
            'unknown',
            'rejected',
            'failed',
            'materialization_failed',
          ].includes(image.status)
        )
          break;
        await delay(1000);
      }
      queryAttempts = Array.from({ length: 8 }, (_, index) =>
        existsSync(join(directory, `supplier-query-${index + 1}.json`)),
      ).filter(Boolean).length;
      const currentTask = await pool.query<{
        query_attempt: number;
        upstream_task_id: string | null;
      }>('SELECT query_attempt,upstream_task_id FROM mio_image_jobs WHERE id=$1', [accepted.jobId]);
      assert(
        currentTask.rows[0]?.upstream_task_id === persistedTask &&
          currentTask.rows[0].query_attempt <= 8,
        'LIVE_QUERY_IDENTITY_OR_LIMIT',
      );
      assert(!existsSync(join(directory, 'supplier-query-limit-blocked.json')), 'LIVE_QUERY_LIMIT');
      assert(
        !existsSync(join(directory, 'supplier-query-mismatch-blocked.json')),
        'LIVE_QUERY_TASK_MISMATCH',
      );
      record('image-outcome', {
        jobId: accepted.jobId,
        status: image?.status ?? 'timeout',
        errorCode: image?.errorCode ?? null,
        supplierPostObserved: existsSync(join(directory, 'supplier-post-started.json')),
        taskIdPresent: true,
        queryAttempts,
        scheduledAttempts: currentTask.rows[0].query_attempt,
        otherOwnerDenied: true,
        observation: submissionObservation,
      });
    } else {
      assert.equal(
        (
          await request(
            state.origin,
            `/api/v1/compute/images/${accepted.jobId}`,
            'GET',
            undefined,
            otherCookie,
          )
        ).status,
        404,
        'LIVE_IMAGE_OTHER_OWNER',
      );
      assert.equal(
        (
          await request(
            state.origin,
            `/api/v1/compute/images/${accepted.jobId}/recover`,
            'POST',
            {},
            otherCookie,
          )
        ).status,
        404,
        'LIVE_IMAGE_OTHER_RECOVERY',
      );
      worker = child(
        'compute/dist/main.js',
        ['start'],
        { ...state.b, NODE_OPTIONS: `--import=${resolve('tests/compute/live-image-audit.ts')}` },
        'worker.log',
      );
      for (let i = 0; i < 240; i++) {
        assert(worker.exitCode === null && worker.signalCode === null, 'LIVE_WORKER_EXITED');
        const response = await request(
          state.origin,
          `/api/v1/compute/images/${accepted.jobId}`,
          'GET',
          undefined,
          cookie,
        );
        assert.equal(response.status, 200, 'LIVE_IMAGE_GET');
        image = (await response.json()) as ImageView;
        if (
          [
            'completed',
            'partial',
            'unknown',
            'rejected',
            'failed',
            'materialization_failed',
          ].includes(image.status)
        )
          break;
        await delay(1000);
      }
      record('image-outcome', {
        scenario: activeScenario,
        jobId: accepted.jobId,
        status: image?.status ?? 'timeout',
        errorCode: image?.errorCode ?? null,
        supplierPostObserved: existsSync(join(directory, 'supplier-post-started.json')),
        otherOwnerDenied: true,
      });
    }
    assert(image?.status === 'completed' && image.assetIds.length === 1, 'LIVE_IMAGE_INCOMPLETE');
    assert(
      existsSync(join(directory, 'supplier-post-started.json')) &&
        existsSync(join(directory, 'supplier-post-allowed.json')) &&
        !existsSync(join(directory, 'supplier-post-repeat-blocked.json')) &&
        !existsSync(join(directory, 'supplier-post-unexpected-blocked.json')),
      'LIVE_ATTEMPT_COUNT',
    );
    if (isAsync) await settleQueryAudit();
    await stop(worker);
    worker = undefined;
    const db = new DatabaseSync(join(state.b.MIO_COMPUTE_DIRECTORY!, 'journal.sqlite3'), {
      readOnly: true,
    });
    let output: SavedOutput;
    try {
      const row = db
        .prepare('SELECT phase,payload FROM image_attempts WHERE job_id=?')
        .get(accepted.jobId);
      assert.equal(row?.phase, 'completed', 'LIVE_JOURNAL_PHASE');
      const payload = JSON.parse(String(row.payload)) as {
        outputs: SavedOutput[];
        observation?: Record<string, unknown>;
      };
      assert.equal(payload.outputs.length, 1, 'LIVE_JOURNAL_OUTPUT');
      output = payload.outputs[0]!;
      assert(
        new RegExp(`^mio/derived/${accepted.jobId}/images/0-[0-9a-f-]{36}\\.(png|jpeg|webp)$`).test(
          output.key,
        ) &&
          ['image/png', 'image/jpeg', 'image/webp'].includes(output.contentType) &&
          (activeScenario !== 'seedream-sync' ||
            (output.key.endsWith('.jpeg') && output.contentType === 'image/jpeg')),
        'LIVE_JOURNAL_OBJECT',
      );
      record('journal-complete', {
        jobId: accepted.jobId,
        objectKey: output.key,
        sha256: output.sha256,
        size: output.sizeBytes,
        observation: payload.observation ?? null,
      });
    } finally {
      db.close();
    }
    await assetBytes(state, cookie, otherCookie, image.assetIds[0]!, output);
    record('owner-download-verified', {
      assetId: image.assetIds[0],
      tokenRoundTrip: true,
      otherOwnerDenied: true,
    });
    await stop(app);
    app = undefined;
    app = await startApp(state);
    cookie = await login(state.origin, {
      email: state.owner.email,
      password: state.owner.password,
    });
    otherCookie = await login(state.origin, state.other);
    const duplicate = await request(state.origin, '/api/v1/compute/images', 'POST', body, cookie);
    assert.equal(duplicate.status, 202, 'LIVE_IDEMPOTENT_HTTP');
    assert.equal(
      ((await duplicate.json()) as ImageView).jobId,
      accepted.jobId,
      'LIVE_IDEMPOTENT_JOB',
    );
    await assetBytes(state, cookie, otherCookie, image.assetIds[0]!, output);
    // B's first process has exited and drained before the exclusive observer exists.
    await waitCommandQueue(state.infrastructure, 0);
    observer = await openObserver(state, frozen, output);
    worker = child(
      'compute/dist/main.js',
      ['start'],
      { ...state.b, NODE_OPTIONS: `--import=${resolve('tests/compute/live-image-audit.ts')}` },
      'worker.log',
    );
    await waitCommandQueue(state.infrastructure, 1);
    observer.start();
    await replay(state, frozen);
    const replayResultId = await observer.result();
    assert(
      !existsSync(join(directory, 'supplier-post-repeat-blocked.json')) &&
        !existsSync(join(directory, 'supplier-post-unexpected-blocked.json')),
      'LIVE_REPEAT_ATTEMPT',
    );
    const final = await request(
      state.origin,
      `/api/v1/compute/images/${accepted.jobId}`,
      'GET',
      undefined,
      cookie,
    );
    const finalImage = (await final.json()) as ImageView;
    const finalQueries = Array.from({ length: 8 }, (_, index) =>
      existsSync(join(directory, `supplier-query-${index + 1}.json`)),
    ).filter(Boolean).length;
    assert(
      final.status === 200 &&
        finalImage.status === 'completed' &&
        finalImage.assetIds.length === 1 &&
        finalImage.assetIds[0] === image.assetIds[0] &&
        finalQueries === queryAttempts,
      'LIVE_REPLAY_RESULT',
    );
    record('restart-replay-verified', {
      scenario: activeScenario,
      jobId: accepted.jobId,
      assetId: image.assetIds[0],
      replayResultId,
      supplierPostAttempts: 1,
      supplierPostsAllowed: 1,
      ...(isAsync ? { supplierQueries: queryAttempts } : {}),
    });
  } catch (error) {
    operationFailure = error;
    record('operation-failed', { code: safeCode(error) });
  } finally {
    try {
      if (heldWorker) await interruptHeldWorker(worker);
      else {
        if (isAsync) await settleQueryAudit();
        await stop(worker);
      }
    } catch {
      cleanupFailures.push('worker');
    }
    if (isAsync) {
      const audit = queryAuditSummary();
      const supplierEvents = join(directory, 'supplier-http-events.jsonl');
      const transportErrors: number[] = [];
      if (existsSync(supplierEvents)) {
        for (const line of readFileSync(supplierEvents, 'utf8').split('\n')) {
          try {
            const event = JSON.parse(line) as { event?: unknown; attempt?: unknown };
            if (event.event === 'query-transport-error' && typeof event.attempt === 'number')
              transportErrors.push(event.attempt);
          } catch {
            // The detailed trace remains the authoritative private original.
          }
        }
      }
      record('query-audit-summary', { ...audit, transportErrors });
      if (
        !operationFailure &&
        (!audit.issued.length ||
          audit.missingResponses.length ||
          audit.missingTraces.length ||
          audit.responses.length !== audit.issued.length ||
          audit.traces.length !== audit.responses.length)
      )
        operationFailure = new Error('LIVE_QUERY_AUDIT_INCOMPLETE');
    }
    try {
      if (observer) await bounded(observer.connection.close());
    } catch {
      cleanupFailures.push('observer');
    }
    try {
      await stop(app);
    } catch {
      cleanupFailures.push('app');
    }
    try {
      await bounded(pool.end());
    } catch {
      cleanupFailures.push('pool');
    }
    if (cleanupFailures.length)
      record('cleanup-failed', {
        components: cleanupFailures,
        workerAlive: Boolean(worker && worker.exitCode === null && worker.signalCode === null),
        appAlive: Boolean(app && app.exitCode === null && app.signalCode === null),
      });
  }
  if (operationFailure) throw operationFailure;
  if (cleanupFailures.length) throw new Error('LIVE_CLEANUP_INCOMPLETE');
}

function safeCode(error: unknown) {
  const first = error instanceof Error ? error.message.split('\n', 1)[0]! : '';
  return /^LIVE_[A-Z_]+$/.test(first) ? first : 'LIVE_UNEXPECTED_FAILURE';
}
try {
  if (phase === 'prepare') await prepare();
  else await execute();
} catch (error) {
  const message = safeCode(error);
  if (existsSync(directory)) record('failed', { code: message });
  else console.error(message);
  process.exitCode = 1;
}
