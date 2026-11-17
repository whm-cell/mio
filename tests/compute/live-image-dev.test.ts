import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { Journal } from '../../compute/src/adapters/journal.ts';
import {
  captureLiveArtifacts,
  liveImageParameters,
  liveRouteDeclaration,
} from './live-image-loop.ts';

const sourceRoot = resolve('.');
const runner = join(sourceRoot, 'tests/compute/live-image-loop.ts');
const audit = readFileSync(join(sourceRoot, 'tests/compute/live-image-audit.ts'), 'utf8');
const taskId = 'controlled-live-task';
const jobId = '84cb192a-0ead-4b30-a3d3-acda0185829f';
const assetId = '3668392d-57b8-4ba4-bbd4-81114725bbae';
const ownerId = 'd3d39a4c-fbaa-4aa2-82ed-8b6037ae18c9';
const output = {
  key: `mio/derived/${jobId}/images/0-${assetId}.png`,
  sizeBytes: 4,
  sha256: createHash('sha256').update('test').digest('hex'),
  contentType: 'image/png',
};

function fixtureFile(root: string, name: string, source: string) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function fixtureProject(version: 3 | 6, omitImage = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mio-dev-entry-')));
  for (let remaining = 100; ; remaining--) {
    try {
      captureLiveArtifacts(root);
      break;
    } catch (error) {
      const missing = error as NodeJS.ErrnoException;
      if (!remaining || missing.code !== 'ENOENT' || !missing.path?.startsWith(`${root}${sep}`))
        throw error;
      if (basename(missing.path) === 'dist') {
        mkdirSync(missing.path, { recursive: true });
        writeFileSync(join(missing.path, 'fixture.js'), '');
      } else {
        mkdirSync(dirname(missing.path), { recursive: true });
        writeFileSync(missing.path, '');
      }
    }
  }
  fixtureFile(root, 'tests/compute/live-image-audit.ts', audit);
  fixtureFile(root, 'package.json', '{"type":"module"}');
  fixtureFile(root, '.gitignore', '*\n');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('add', '-f', '.gitignore');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'fixture',
  );
  const commit = git('rev-parse', 'HEAD');
  fixtureFile(
    root,
    `.work/tasks/${taskId}/state.json`,
    JSON.stringify({
      workspace: root,
      plan: { id: taskId },
      stage: 'C1_EVIDENCE_PENDING',
      contractRevision: 1,
      checkpoint: { candidate: { commit, contractRevision: 1 } },
    }),
  );
  mkdirSync(join(root, '.runtime'));
  const journal = new Journal(join(root, 'journal'), 'fixture-worker', true);
  journal.close();
  if (version === 3 || omitImage) {
    const db = new DatabaseSync(join(root, 'journal/journal.sqlite3'));
    db.exec('DROP TABLE image_attempts');
    if (version === 3)
      db.exec(`DROP INDEX attempts_cleanup;
        ALTER TABLE attempts RENAME COLUMN ack_dispatched TO acknowledged;
        CREATE INDEX attempts_cleanup ON attempts(attempt_id) WHERE phase IN ('succeeded','failed') AND acknowledged=1 AND cleaned=0;
        UPDATE metadata SET schema_version=3;`);
    db.close();
  }
  const modelId = 'image-kling-v3';
  const declaration = liveRouteDeclaration('kling-async', modelId);
  const command = {
    type: 'image.request',
    jobId,
    ownerId,
    credential: { fixture: true },
    profile: 'kling-images',
    route: declaration,
    input: { ...liveImageParameters('kling-async'), model: modelId },
    expiresAt: Date.now() + 600_000,
  };
  fixtureFile(
    root,
    'fixture.json',
    JSON.stringify({ root, jobId, assetId, ownerId, output, command }),
  );
  return root;
}

function installFixture(root: string) {
  const transport = fixtureFile(
    root,
    'transport.mjs',
    `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (input, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      appendFileSync(process.env.FIXTURE_ROOT + '/upstream.jsonl', JSON.stringify({ method }) + '\\n');
      if (method === 'POST') return process.env.FIXTURE_FAILURE === 'yes'
        ? new Response('{}', { status: 401 })
        : Response.json({ code: 0, data: { task_id: 'actual-task' } });
      return Response.json({ code: 0, data: { task_status: 'succeed' } });
    };
  `,
  );
  const worker = fixtureFile(
    root,
    'worker.mjs',
    `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { Journal } from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'compute/src/adapters/journal.ts')).href)};
    const root = process.env.FIXTURE_ROOT;
    const fixture = JSON.parse(readFileSync(root + '/fixture.json', 'utf8'));
    const journal = new Journal(root + '/journal', 'fixture-worker');
    journal.beginImage(fixture.jobId, 'fixture');
    process.once('SIGTERM', () => { journal.close(); process.exit(0); });
    const response = await fetch('https://api.onelinkai.cloud/kling/v1/images/generations', {
      method: 'POST', headers: { authorization: 'synthetic-secret' }
    });
    if (!response.ok) {
      journal.imagePhase(fixture.jobId, 'rejected', '{}');
      writeFileSync(root + '/failed', '1');
    } else {
      const { data } = await response.json();
      writeFileSync(root + '/submitted', JSON.stringify({ upstreamTaskId: data.task_id }));
      await fetch('https://api.onelinkai.cloud/kling/v1/images/generations/' + data.task_id, {
        headers: { authorization: 'synthetic-secret' }, signal: AbortSignal.timeout(10000)
      });
      if (process.env.FIXTURE_LATE === 'yes') {
        writeFileSync(root + '/advance-clock', '1100000');
        await new Promise((done) => setTimeout(done, 2500));
      }
      if (process.env.FIXTURE_TIMEOUT === 'yes') {
        writeFileSync(root + '/advance-clock', '1500000');
        await new Promise((done) => setTimeout(done, 10000));
      }
      journal.imagePhase(fixture.jobId, 'completed', JSON.stringify({ outputs: [fixture.output] }));
      writeFileSync(root + '/completed', '1');
    }
    setInterval(() => {}, 1000);
  `,
  );
  const child = fixtureFile(
    root,
    'child.mjs',
    `
    import { EventEmitter } from 'node:events';
    import { writeFileSync, rmSync } from 'node:fs';
    import { spawn as nativeSpawn } from 'node:child_process';
    export * from 'node:child_process';
    export function spawn(file, args, options) {
      if (args[0] === 'fixture-app') {
        const child = new EventEmitter();
        child.exitCode = null; child.signalCode = null;
        writeFileSync(process.env.FIXTURE_ROOT + '/a-running', '1');
        child.kill = (signal) => {
          if (process.env.FIXTURE_CLEANUP_FAILURE === 'yes') throw new Error('fixture cleanup failure');
          rmSync(process.env.FIXTURE_ROOT + '/a-running', { force: true }); child.signalCode = signal; queueMicrotask(() => child.emit('exit', null, signal)); return true;
        };
        return child;
      }
      if (args[0] === 'compute/dist/main.js') {
        writeFileSync(process.env.FIXTURE_ROOT + '/b-running', '1');
        const child = nativeSpawn(file, [process.env.FIXTURE_WORKER], {
          ...options,
          env: { ...options.env, FIXTURE_ROOT: process.env.FIXTURE_ROOT,
            FIXTURE_FAILURE: process.env.FIXTURE_FAILURE,
            FIXTURE_LATE: process.env.FIXTURE_LATE,
            FIXTURE_TIMEOUT: process.env.FIXTURE_TIMEOUT,
            NODE_OPTIONS: '--import=' + process.env.FIXTURE_TRANSPORT + ' ' + options.env.NODE_OPTIONS }
        });
        child.once('exit', () => rmSync(process.env.FIXTURE_ROOT + '/b-running', { force: true }));
        return child;
      }
      return nativeSpawn(file, args, options);
    }
  `,
  );
  const pg = fixtureFile(
    root,
    'pg.mjs',
    `
    import { existsSync, readFileSync } from 'node:fs';
    const root = process.env.FIXTURE_ROOT;
    const fixture = JSON.parse(readFileSync(root + '/fixture.json', 'utf8'));
    export class Pool {
      constructor(options) {
        if (options.connectionString !== 'postgresql://fixture@localhost/assets_dev') throw new Error('wrong observer database');
      }
      async query(sql) {
        if (sql.includes('AS video_outbox')) return { rows: [{ video: 0, image: 0, video_outbox: 0, image_outbox: 0 }] };
        if (sql.includes('j.command,o.sent_at')) return { rows: [{ command: fixture.command, sent_at: new Date() }] };
        if (sql.includes('SELECT async_deadline')) return { rows: [{ async_deadline: new Date(fixture.command.expiresAt), async_max_queries: 8 }] };
        if (sql.includes('j.upstream_task_id,j.query_attempt,j.state')) {
          if (!existsSync(root + '/submitted')) return { rows: [{ upstream_task_id: null, query_attempt: 0, state: 'accepted' }] };
          const saved = JSON.parse(readFileSync(root + '/submitted', 'utf8'));
          return { rows: [{ upstream_task_id: saved.upstreamTaskId, query_attempt: 1, state: 'submitted',
            query_command: { upstreamTaskId: saved.upstreamTaskId, queryAttempt: 1, jobId: fixture.jobId, ownerId: fixture.ownerId } }] };
        }
        throw new Error('Unexpected fixture SQL');
      }
      async end() {}
    }
  `,
  );
  const support = fixtureFile(
    root,
    'support.mjs',
    `
    const root = process.env.FIXTURE_ROOT;
    export async function parseLiveAuthInput() { return { kind: 'apiKey', apiKey: 'synthetic-secret' }; }
    export async function preparePersistentDevEnvironment() {
      return { values: { MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT: '12345', MIO_LOCAL_RABBITMQ_PASSWORD: 'fixture' }, host: {},
        origin: 'http://fixture.local', runtimeEnv: {
          DSH_HOME: root, MIO_COS_BUCKET: 'fixture-bucket', MIO_COS_REGION: 'fixture-region',
          MIO_COS_SECRET_ID: 'fixture', MIO_COS_SECRET_KEY: 'fixture', MIO_IMAGE_KEY_ID: 'fixture', MIO_IMAGE_PUBLIC_KEY: 'fixture',
          MIO_ASSETS_DATABASE_URL: 'postgresql://fixture@localhost/assets_dev',
          MIO_COMPUTE_DATABASE_URL: 'postgresql://fixture@localhost/wrong_compute_db'
        } };
    }
    export async function authenticateOrCreateRetainedDevOwner() {
      return { email: 'owner@fixture.test', password: 'fixture-password', userId: '${ownerId}', cookie: 'owner=1', apiKey: 'synthetic-secret' };
    }
  `,
  );
  const profile = fixtureFile(
    root,
    'profile.mjs',
    `export const launcher = () => 'fixture-app'; export async function prepareProfile() {}`,
  );
  const local = fixtureFile(
    root,
    'local.mjs',
    `export function localWorkerEnvironment() { return {
    MIO_COMPUTE_DIRECTORY: process.env.FIXTURE_ROOT + '/journal', MIO_COMPUTE_INSTANCE_ID: 'fixture-worker',
    MIO_COS_SECRET_ID: 'fixture', MIO_COS_SECRET_KEY: 'fixture', MIO_IMAGE_PRIVATE_KEY: 'fixture'
  }; }`,
  );
  const broker = fixtureFile(root, 'broker.mjs', 'export async function prepareLocalBroker() {}');
  const media = fixtureFile(root, 'media.mjs', 'export function validateImage() {}');
  const hook = fixtureFile(
    root,
    'hook.mjs',
    `
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { existsSync, readFileSync } from 'node:fs';
    const root = process.env.FIXTURE_ROOT;
    const fixture = JSON.parse(readFileSync(root + '/fixture.json', 'utf8'));
    const now = Date.now.bind(Date);
    Date.now = () => now() + (existsSync(root + '/advance-clock') ? Number(readFileSync(root + '/advance-clock', 'utf8')) : 0);
    const modules = ${JSON.stringify({ pg, support, profile, local, broker, media, child })};
    registerHooks({ resolve(specifier, context, next) {
      let target;
      if (specifier === 'pg') target = modules.pg;
      if (specifier.endsWith('/local-dev-live.ts')) target = modules.support;
      if (specifier.endsWith('/profile.ts')) target = modules.profile;
      if (specifier.endsWith('/local-compute-environment.ts')) target = modules.local;
      if (specifier.endsWith('/local-broker.ts')) target = modules.broker;
      if (specifier.endsWith('/compute/src/adapters/media.ts')) target = modules.media;
      if (specifier === 'node:child_process' && !context.parentURL?.endsWith('/child.mjs')) target = modules.child;
      return target ? { url: pathToFileURL(target).href, shortCircuit: true } : next(specifier, context);
    }});
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init.method || 'GET').toUpperCase();
      if (url.hostname === '127.0.0.1') {
        if (url.pathname.endsWith('/connections')) {
          const result = [];
          if (existsSync(root + '/a-running')) {
            result.push({ user: 'mio-dev-a', vhost: 'mio-dev' }, { user: 'mio-dev-a', vhost: 'mio-dev' });
            if (process.env.FIXTURE_EXTRA_CONNECTION === 'yes') result.push({ user: 'mio-dev-a', vhost: 'mio-dev' });
          }
          if (existsSync(root + '/b-running')) result.push({ user: 'mio-dev-b', vhost: 'mio-dev' }, { user: 'mio-dev-b', vhost: 'mio-dev' });
          return Response.json(result);
        }
        return Response.json({ messages_ready: 0, messages_unacknowledged: 0, consumers: 0 });
      }
      if (url.hostname.endsWith('myqcloud.com')) return new Response('test');
      if (url.pathname === '/readyz') return new Response('ok');
      if (url.pathname === '/api/auth/sign-up/email') return Response.json({});
      if (url.pathname === '/api/auth/sign-in/email') {
        const other = JSON.parse(init.body).email !== 'owner@fixture.test';
        return Response.json({}, { headers: { 'set-cookie': other ? 'other=1' : 'owner=1' } });
      }
      if (url.pathname === '/api/v1/providers/onelink') return Response.json({ hasKey: false, revision: 1 });
      if (url.pathname === '/api/v1/providers/onelink/credential') return Response.json({});
      if (url.pathname === '/api/v1/providers/onelink/test') return Response.json({ status: 'connected' });
      if (url.pathname === '/api/v1/providers/onelink/models') return Response.json({
        provider: { credentialVersion: 1, catalog: { version: 1 } },
        items: [{ modelId: 'image-kling-v3', modelRef: 'fixture-ref', discovered: true, credentialVersion: 1, catalogVersion: 1 }]
      });
      if (url.pathname === '/api/v1/compute/images' && method === 'POST') {
        if (process.env.FIXTURE_ADMISSION_ERROR === 'yes') throw new Error('fixture response lost');
        return Response.json({ jobId: fixture.jobId, requestedCount: 1, status: 'accepted', assetIds: [], outputs: [] }, { status: 202 });
      }
      if (url.pathname.startsWith('/api/v1/compute/images/')) {
        if (init.headers?.cookie?.includes('other=1')) return new Response('', { status: 404 });
        const completed = existsSync(root + '/completed');
        const failed = existsSync(root + '/failed');
        return Response.json({ jobId: fixture.jobId, requestedCount: 1, status: completed ? 'completed' : failed ? 'rejected' : 'processing',
          errorCode: failed ? 'IMAGE_INPUT_INVALID' : null, assetIds: completed ? [fixture.assetId] : [],
          outputs: completed ? [{ index: 0, assetId: fixture.assetId }] : [] });
      }
      if (url.pathname.startsWith('/api/v1/assets/')) {
        if (!init.headers?.cookie) return new Response('', { status: 401 });
        if (init.headers.cookie.includes('other=1')) return new Response('', { status: 404 });
        return Response.json({ status: 'ready', contentType: 'image/png', size: 4,
          downloadUrl: 'https://fixture-bucket.cos.fixture-region.myqcloud.com/' + fixture.output.key });
      }
      throw new Error('Unexpected fixture request');
    };
  `,
  );
  return { hook, worker, transport };
}

it.each([
  ['success', 6],
  ['success', 3],
  ['late', 6],
  ['timeout', 6],
  ['failure', 6],
  ['cleanup-failure', 6],
  ['admission-error', 6],
  ['occupied', 6],
  ['invalid-journal', 6],
] as const)(
  'runs the dev entry with %s and journal version %s',
  async (outcome, version) => {
    const root = fixtureProject(version, outcome === 'invalid-journal');
    const { hook, worker, transport } = installFixture(root);
    const runDirectory = join(root, '.runtime', 'run');
    try {
      const process = spawn(
        globalThis.process.execPath,
        [
          `--import=${hook}`,
          runner,
          '--scenario',
          'kling-async',
          'dev',
          runDirectory,
          'synthetic-key',
          taskId,
        ],
        {
          cwd: root,
          env: {
            PATH: globalThis.process.env.PATH,
            MIO_RUN_LIVE_IMAGE: 'yes',
            FIXTURE_ROOT: root,
            FIXTURE_WORKER: worker,
            FIXTURE_TRANSPORT: transport,
            FIXTURE_FAILURE: outcome === 'failure' || outcome === 'cleanup-failure' ? 'yes' : 'no',
            FIXTURE_CLEANUP_FAILURE: outcome === 'cleanup-failure' ? 'yes' : 'no',
            FIXTURE_ADMISSION_ERROR: outcome === 'admission-error' ? 'yes' : 'no',
            FIXTURE_LATE: outcome === 'late' ? 'yes' : 'no',
            FIXTURE_TIMEOUT: outcome === 'timeout' ? 'yes' : 'no',
            FIXTURE_EXTRA_CONNECTION: outcome === 'occupied' ? 'yes' : 'no',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let logs = '';
      process.stdout.on('data', (chunk: Buffer) => {
        logs += chunk.toString();
      });
      process.stderr.on('data', (chunk: Buffer) => {
        logs += chunk.toString();
      });
      const timer = setTimeout(() => process.kill('SIGKILL'), 20_000);
      const [code] = await once(process, 'exit');
      clearTimeout(timer);
      expect(existsSync(join(runDirectory, 'events.jsonl')), logs).toBe(true);
      const events = readFileSync(join(runDirectory, 'events.jsonl'), 'utf8');
      if (outcome === 'occupied' || outcome === 'invalid-journal') {
        expect(code, logs).not.toBe(0);
        expect(existsSync(join(root, 'upstream.jsonl'))).toBe(false);
        expect(events).toContain(
          outcome === 'occupied' ? 'LIVE_DEV_WINDOW_OCCUPIED' : 'LIVE_DEV_JOURNAL_INVALID',
        );
        return;
      }
      if (outcome === 'admission-error') {
        expect(code, logs).not.toBe(0);
        expect(existsSync(join(root, 'upstream.jsonl'))).toBe(false);
        const recorded = events
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event: string; requestId?: string })
          .find((event) => event.event === 'image-admission-started');
        expect(recorded?.requestId).toMatch(/^[a-f0-9-]{36}$/);
        expect(events).not.toContain('image-accepted');
        return;
      }
      const workerLog = existsSync(join(runDirectory, 'worker.log'))
        ? readFileSync(join(runDirectory, 'worker.log'), 'utf8')
        : '';
      expect(existsSync(join(root, 'upstream.jsonl')), `${logs}\n${events}\n${workerLog}`).toBe(
        true,
      );
      const upstream = readFileSync(join(root, 'upstream.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string });
      expect(upstream.filter((item) => item.method === 'POST')).toHaveLength(1);
      expect(logs + events).not.toContain('synthetic-secret');
      expect(readFileSync(join(runDirectory, 'owner-login.json'), 'utf8')).not.toContain(
        'synthetic-secret',
      );
      expect(statSync(join(runDirectory, 'owner-login.json')).mode & 0o777).toBe(0o600);
      if (outcome === 'timeout') {
        expect(code, logs).not.toBe(0);
        expect(upstream.filter((item) => item.method === 'GET')).toHaveLength(1);
        expect(events).toContain('"status":"timeout","lastStatus":"processing"');
        expect(events).toContain('LIVE_IMAGE_OBSERVATION_TIMEOUT');
        expect(events).not.toContain('LIVE_JOURNAL_PHASE');
      } else if (outcome === 'success' || outcome === 'late') {
        expect(code, logs).toBe(0);
        expect(upstream.filter((item) => item.method === 'GET')).toHaveLength(1);
        expect(JSON.parse(readFileSync(join(runDirectory, 'allowed-task.json'), 'utf8'))).toEqual({
          upstreamTaskId: 'actual-task',
          deadline: expect.any(Number),
        });
        expect(events).toContain('dev-live-verified');
        if (outcome === 'late') expect(existsSync(join(root, 'advance-clock'))).toBe(true);
      } else {
        expect(code, logs).not.toBe(0);
        expect(upstream.filter((item) => item.method === 'GET')).toHaveLength(0);
        expect(existsSync(join(runDirectory, 'allowed-task.json'))).toBe(false);
        expect(events).toContain('"status":"rejected"');
        if (outcome === 'cleanup-failure') {
          expect(events).toContain('cleanup-failed');
          expect(events).toContain('LIVE_JOURNAL_PHASE');
          expect(events).not.toContain('LIVE_CLEANUP_INCOMPLETE');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
