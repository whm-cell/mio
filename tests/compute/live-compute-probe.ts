import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, openSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { connect as connectTcp, createServer as createTcpServer } from 'node:net';
import type { Server as TcpServer, Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { Pool } from 'pg';
import * as Mio from '../../src/plugin.ts';
import { readAssetConfig } from '../../src/assets/config.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { authDatabase } from '../support/auth-database.ts';

// Run only with the authorized private COS bucket and isolated business vhost.
if (process.env.MIO_RUN_COMPUTE_PROBE !== 'yes')
  throw new Error('LIVE_COMPUTE_PROBE_REQUIRES_EXPLICIT_TEST_ENV');
if (
  !process.env.MIO_COS_BUCKET ||
  !process.env.MIO_COS_REGION ||
  !process.env.MIO_COS_SECRET_ID ||
  !process.env.MIO_COS_SECRET_KEY ||
  !process.env.RABBITMQ_URL ||
  !process.env.MIO_COMPUTE_BROKER_USER ||
  !process.env.MIO_COMPUTE_EXPECTED_RESULT_USER
)
  throw new Error('LIVE_COMPUTE_PROBE_CONFIG_REQUIRED');

const portableRoot = process.env.MIO_PORTABLE_ROOT
  ? realpathSync(process.env.MIO_PORTABLE_ROOT)
  : undefined;
const workspace = realpathSync('.');
if (portableRoot && (portableRoot === workspace || portableRoot.startsWith(`${workspace}${sep}`)))
  throw new Error('PORTABLE_ROOT_MUST_BE_OUTSIDE_WORKSPACE');
const runId = randomUUID();
const workerDirectory = portableRoot
  ? join(portableRoot, 'chain-runs', runId, 'worker')
  : resolve('.runtime/compute-chain', runId);
const manifestPath = `.work/tooling/live-compute-${runId}.json`;
const manifest: Record<string, unknown> = {
  runId,
  bucket: process.env.MIO_COS_BUCKET,
  workerDirectory,
  runtimeMode: portableRoot ? 'portable' : 'source',
  complete: false,
};
let phase = 'initialization';
let completed = false;
let database: Awaited<ReturnType<typeof authDatabase>> | undefined;
let observer: Pool | undefined;
let ctx: Context | undefined;
let app: ChildProcess | undefined;
let restartApp: (() => Promise<ChildProcess>) | undefined;
let worker: ChildProcess | undefined;
let inputDirectory: string | undefined;
let proxy: TcpServer | undefined;
let proxyOpen = false;
const sockets = new Set<Socket>();
const wait = (milliseconds: number) =>
  new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
const save = () =>
  writeFile(manifestPath, JSON.stringify({ ...manifest, phase }, null, 2), { mode: 0o600 });
const fail = (code: string): never => {
  throw new Error(code);
};
const stopProcess = async (child: ChildProcess, label: string) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  await Promise.race([exited, wait(10000)]);
  if (child.exitCode === null && child.signalCode === null)
    throw new Error(`${label}_STOP_TIMEOUT`);
};
try {
  await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
  await save();
  inputDirectory = await mkdtemp(join(tmpdir(), 'mio-live-video-'));
  const inputPath = join(inputDirectory, 'input.mp4');
  phase = 'generate-video';
  const generated = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-c:a',
      'aac',
      inputPath,
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (generated.status !== 0) fail('VIDEO_GENERATION_FAILED');
  const bytes = await readFile(inputPath);
  phase = 'database';
  database = await authDatabase();
  manifest.databaseUrl = database.url;
  await save();
  observer = new Pool({ connectionString: database.observerURL });
  const brokerURL = new URL(process.env.RABBITMQ_URL!);
  if (brokerURL.protocol !== 'amqp:' || !['127.0.0.1', 'localhost'].includes(brokerURL.hostname))
    fail('LOCAL_BROKER_REQUIRED');
  const brokerHost = brokerURL.hostname;
  const brokerPort = Number(brokerURL.port || '5672');
  proxy = createTcpServer((client) => {
    client.on('error', () => {});
    if (!proxyOpen) {
      client.destroy();
      return;
    }
    const upstream = connectTcp({ host: brokerHost, port: brokerPort });
    sockets.add(client);
    sockets.add(upstream);
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    upstream.on('error', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolveListen, reject) => {
    proxy!.once('error', reject);
    proxy!.listen(0, '127.0.0.1', resolveListen);
  });
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === 'string') fail('PROXY_ADDRESS_MISSING');
  brokerURL.hostname = '127.0.0.1';
  brokerURL.port = String((proxyAddress as { port: number }).port);
  process.env.RABBITMQ_URL = brokerURL.toString();
  let origin: string;
  if (portableRoot) {
    const listener = createTcpServer();
    await new Promise<void>((resolveListen, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolveListen);
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('APP_ADDRESS_MISSING');
    origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolveClose, reject) =>
      listener.close((error) => (error ? reject(error) : resolveClose())),
    );
  } else {
    ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    await ctx.plugin(NativeExecutor);
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    origin = ctx.webServer.getOrigin();
  }
  const secret = randomBytes(40).toString('hex');
  process.env.MIO_API_TOKEN = secret;
  process.env.MIO_AUTH_DATABASE_URL = database.url;
  process.env.MIO_AUTH_BASE_URL = origin;
  process.env.MIO_AUTH_SECRET = secret;
  process.env.MIO_AUTH_RATE_LIMIT_BACKEND = 'database';
  process.env.MIO_AUTH_ALLOWED_ORIGINS = '[]';
  process.env.MIO_ASSETS_DATABASE_URL = database.url;
  process.env.MIO_COMPUTE_ENABLED = 'true';
  for (const name of ['auth', 'assets', 'compute']) {
    const file = portableRoot
      ? join(portableRoot, 'a/dist/tools/scripts/service', `migrate-${name}.js`)
      : `scripts/service/migrate-${name}.ts`;
    const result = spawnSync(process.execPath, [file, '--apply'], {
      encoding: 'utf8',
      timeout: 30000,
      cwd: portableRoot ?? workspace,
    });
    if (result.status !== 0) fail('MIGRATION_FAILED');
  }
  phase = 'plugin';
  if (portableRoot) {
    const a = join(portableRoot, 'a');
    const host = join(portableRoot, 'host');
    const appHome = join(portableRoot, 'chain-runs', runId, 'dsh-home');
    const prepared = spawnSync(
      process.execPath,
      [join(a, 'dist/tools/scripts/service/prepare-profile.js'), appHome, a],
      { cwd: portableRoot, encoding: 'utf8', timeout: 30000 },
    );
    if (prepared.status !== 0) fail('PORTABLE_PROFILE_FAILED');
    const appEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: process.env.LANG ?? 'C',
      HOME: appHome,
      DSH_HOME: appHome,
      DSH_AGENTS_HOME: join(appHome, 'agents'),
      DSH_TELEMETRY_DISABLED: '1',
      MIO_HOST: '127.0.0.1',
      MIO_PORT: new URL(origin).port,
    };
    for (const name of [
      'MIO_API_TOKEN',
      'MIO_AUTH_DATABASE_URL',
      'MIO_AUTH_BASE_URL',
      'MIO_AUTH_SECRET',
      'MIO_AUTH_RATE_LIMIT_BACKEND',
      'MIO_AUTH_ALLOWED_ORIGINS',
      'MIO_ASSETS_DATABASE_URL',
      'MIO_COS_BUCKET',
      'MIO_COS_REGION',
      'MIO_COS_SECRET_ID',
      'MIO_COS_SECRET_KEY',
      'MIO_COMPUTE_ENABLED',
      'RABBITMQ_URL',
      'MIO_COMPUTE_BROKER_USER',
      'MIO_COMPUTE_EXPECTED_RESULT_USER',
    ])
      appEnv[name] = process.env[name];
    restartApp = async () => {
      const appLog = openSync(join(workerDirectory, 'app.log'), 'a', 0o600);
      let current: ChildProcess;
      try {
        current = spawn(
          process.execPath,
          [join(host, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'mio'],
          { cwd: portableRoot, env: appEnv, stdio: ['ignore', appLog, appLog] },
        );
      } finally {
        closeSync(appLog);
      }
      app = current;
      manifest.appPid = current.pid;
      await save();
      let ready = false;
      for (let i = 0; i < 150; i++) {
        if (current.exitCode !== null || current.signalCode !== null) fail('PORTABLE_APP_EXITED');
        try {
          if ((await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(500) })).ok) {
            ready = true;
            break;
          }
        } catch {
          /* The isolated listener is starting. */
        }
        await wait(100);
      }
      if (!ready) fail('PORTABLE_APP_NOT_READY');
      return current;
    };
    app = await restartApp();
  } else {
    await ctx!.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
  }
  const post = (path: string, value: unknown, cookie = '') =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(value),
    });
  phase = 'signup';
  const signup = await post('/api/auth/sign-up/email', {
    name: 'Compute test',
    email: `compute-${runId}@example.test`,
    password: randomBytes(24).toString('hex'),
  });
  if (signup.status !== 200) fail('SIGNUP_FAILED');
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  if (!cookie) fail('COOKIE_MISSING');
  phase = 'upload-request';
  const created = await post(
    '/api/v1/assets/uploads',
    { filename: 'input.mp4', contentType: 'video/mp4', size: bytes.length },
    cookie,
  );
  if (created.status !== 201) fail('UPLOAD_REQUEST_FAILED');
  const asset = (await created.json()) as { assetId: string; uploadUrl: string };
  manifest.assetId = asset.assetId;
  manifest.stagingKey = `mio/staging/${asset.assetId}`;
  await save();
  phase = 'direct-put';
  if (!(await fetch(asset.uploadUrl, { method: 'PUT', body: bytes })).ok) fail('DIRECT_PUT_FAILED');
  phase = 'complete';
  if ((await post(`/api/v1/assets/${asset.assetId}/complete`, {}, cookie)).status !== 200)
    fail('COMPLETE_FAILED');
  const input = (
    await observer.query<{ raw_key: string }>('SELECT raw_key FROM mio_assets WHERE id=$1', [
      asset.assetId,
    ])
  ).rows[0];
  if (!input?.raw_key) throw new Error('RAW_KEY_MISSING');
  manifest.rawKey = input.raw_key;
  await save();
  phase = 'submit-with-worker-offline';
  const requestId = randomUUID();
  const submitted = await post(
    '/api/v1/compute/jobs',
    { requestId, assetId: asset.assetId },
    cookie,
  );
  if (submitted.status !== 202) fail('JOB_SUBMISSION_FAILED');
  const job = (await submitted.json()) as { jobId: string };
  manifest.jobId = job.jobId;
  await save();
  const readJob = async () => {
    const response = await fetch(`${origin}/api/v1/compute/jobs/${job.jobId}`, {
      headers: { cookie, origin },
    });
    if (response.status !== 200) fail('JOB_READ_FAILED');
    return (await response.json()) as {
      status: string;
      resultAssetId: string | null;
      errorCode: string | null;
    };
  };
  const pending = (
    await observer.query<{ sent_at: Date | null }>(
      'SELECT sent_at FROM mio_compute_outbox WHERE job_id=$1',
      [job.jobId],
    )
  ).rows[0];
  if (!pending || pending.sent_at !== null || (await readJob()).status !== 'accepted')
    fail('OFFLINE_ADMISSION_NOT_DURABLE');
  console.log('LIVE_COMPUTE_PROBE_ACCEPTED_WITH_BROKER_LINK_OFFLINE');
  if (portableRoot && app && restartApp) {
    phase = 'restart-a-with-pending-outbox';
    await stopProcess(app, 'PORTABLE_APP');
    app = await restartApp();
    const replay = await post(
      '/api/v1/compute/jobs',
      { requestId, assetId: asset.assetId },
      cookie,
    );
    if (
      replay.status !== 200 ||
      ((await replay.json()) as { jobId: string }).jobId !== job.jobId ||
      (await readJob()).status !== 'accepted'
    )
      fail('A_RESTART_STATE_MISMATCH');
    const retained = (
      await observer.query<{ sent_at: Date | null }>(
        'SELECT sent_at FROM mio_compute_outbox WHERE job_id=$1',
        [job.jobId],
      )
    ).rows[0];
    if (!retained || retained.sent_at !== null) fail('A_RESTART_OUTBOX_MISMATCH');
    manifest.appRestartVerified = true;
    await save();
    console.log('LIVE_COMPUTE_PROBE_A_RESTART_PRESERVED_SESSION_JOB_OUTBOX');
  }
  proxyOpen = true;
  let queued = false;
  for (let i = 0; i < 60; i++) {
    if ((await readJob()).status === 'queued') {
      queued = true;
      break;
    }
    await wait(1000);
  }
  if (!queued) fail('JOB_NOT_QUEUED');
  console.log('LIVE_COMPUTE_PROBE_QUEUED_WITH_WORKER_OFFLINE');
  proxyOpen = false;
  for (const socket of sockets) socket.destroy();
  phase = 'start-worker';
  const ffmpegPath = spawnSync('which', ['ffmpeg'], { encoding: 'utf8', timeout: 5000 });
  if (ffmpegPath.status !== 0 || !ffmpegPath.stdout.trim()) fail('FFMPEG_PATH_MISSING');
  const wrapperDirectory = join(workerDirectory, 'bin');
  const ffmpegLog = join(workerDirectory, 'ffmpeg-executions.log');
  await mkdir(wrapperDirectory, { mode: 0o700 });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(wrapperDirectory, 'ffmpeg'),
    `#!/bin/sh\nprintf '%s\\n' invoked >> ${quote(ffmpegLog)}\nexec ${quote(ffmpegPath.stdout.trim())} "$@"\n`,
    { mode: 0o700, flag: 'wx' },
  );
  const workerEnv: NodeJS.ProcessEnv = {
    PATH: `${wrapperDirectory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? '/usr/bin:/bin'}`,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'C',
    MIO_COMPUTE_DIRECTORY: workerDirectory,
    MIO_COMPUTE_INSTANCE_ID: runId,
  };
  const args = [
    `--env-file=${resolve('.runtime/compute-environment/cos-b.env')}`,
    `--env-file=${resolve('.runtime/compute-environment/broker-p3/runtime-b.env')}`,
    portableRoot ? join(portableRoot, 'b/dist/main.js') : 'compute/dist/main.js',
  ];
  const init = spawnSync(process.execPath, [...args, 'init'], {
    env: workerEnv,
    encoding: 'utf8',
    timeout: 30000,
    cwd: portableRoot ?? workspace,
  });
  if (init.status !== 0) fail('WORKER_INIT_FAILED');
  const startWorker = () => {
    const log = openSync(join(workerDirectory, 'worker.log'), 'a', 0o600);
    try {
      return spawn(process.execPath, [...args, 'start'], {
        env: workerEnv,
        stdio: ['ignore', log, log],
        cwd: portableRoot ?? workspace,
      });
    } finally {
      closeSync(log);
    }
  };
  worker = startWorker();
  manifest.workerPid = worker.pid;
  await save();
  phase = 'worker-finishes-while-a-disconnected';
  const current = (
    await observer.query<{ attempt_id: string }>(
      'SELECT attempt_id FROM mio_compute_jobs WHERE id=$1',
      [job.jobId],
    )
  ).rows[0];
  if (!current) throw new Error('ATTEMPT_MISSING');
  const derivedKey = `mio/derived/${job.jobId}/${current.attempt_id}/result.mp4`;
  const assetConfig = readAssetConfig();
  if (!assetConfig) throw new Error('ASSET_CONFIG_MISSING');
  const objects = createCosStorage(assetConfig);
  let uploaded = false;
  for (let i = 0; i < 120; i++) {
    try {
      await objects.head(derivedKey);
      uploaded = true;
      break;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
    if (worker.exitCode !== null || worker.signalCode !== null) fail('WORKER_EXITED');
    await wait(1000);
  }
  if (!uploaded || (await readJob()).status === 'succeeded')
    fail('OFFLINE_RESULT_OBSERVATION_FAILED');
  manifest.derivedKey = derivedKey;
  await save();
  console.log('LIVE_COMPUTE_PROBE_OUTPUT_WHILE_A_DISCONNECTED');
  proxyOpen = true;
  phase = 'wait-for-result';
  let resultAssetId: string | null = null;
  for (let i = 0; i < 180; i++) {
    const status = await readJob();
    if (status.status === 'failed') fail('WORKER_REPORTED_FAILURE');
    if (status.status === 'succeeded') {
      resultAssetId = status.resultAssetId;
      break;
    }
    if (worker.exitCode !== null || worker.signalCode !== null) fail('WORKER_EXITED');
    await wait(1000);
  }
  if (!resultAssetId) fail('RESULT_TIMEOUT');
  manifest.resultAssetId = resultAssetId;
  const output = (
    await observer.query<{ raw_key: string }>('SELECT raw_key FROM mio_assets WHERE id=$1', [
      resultAssetId,
    ])
  ).rows[0];
  if (!output?.raw_key) throw new Error('RESULT_KEY_MISSING');
  manifest.derivedKey = output.raw_key;
  await save();
  phase = 'download-and-inspect';
  const lookup = await fetch(`${origin}/api/v1/assets/${resultAssetId}`, {
    headers: { cookie, origin },
  });
  if (lookup.status !== 200) fail('RESULT_ASSET_READ_FAILED');
  const view = (await lookup.json()) as { status: string; downloadUrl: string };
  if (view.status !== 'ready') fail('RESULT_NOT_READY');
  const download = await fetch(view.downloadUrl);
  if (!download.ok) fail('RESULT_DOWNLOAD_FAILED');
  const resultBytes = Buffer.from(await download.arrayBuffer());
  const outputPath = join(inputDirectory, 'output.mp4');
  await writeFile(outputPath, resultBytes);
  const inspected = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-of', 'json', outputPath],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (inspected.status !== 0) fail('FFPROBE_FAILED');
  const streams = (
    JSON.parse(inspected.stdout) as {
      streams: Array<{
        codec_type: string;
        codec_name: string;
        height?: number;
        avg_frame_rate?: string;
      }>;
    }
  ).streams;
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (
    video?.codec_name !== 'h264' ||
    !video.height ||
    video.height > 720 ||
    video.avg_frame_rate !== '24/1' ||
    audio?.codec_name !== 'aac'
  )
    fail('OUTPUT_PROFILE_MISMATCH');
  const moov = resultBytes.indexOf(Buffer.from('moov')),
    mdat = resultBytes.indexOf(Buffer.from('mdat'));
  if (moov < 0 || mdat < 0 || moov > mdat) fail('FASTSTART_MISSING');
  if (portableRoot) {
    phase = 'restart-b-and-redeliver-completed-attempt';
    await wait(1500);
    await stopProcess(worker, 'PORTABLE_WORKER');
    const journalSnapshot = () => {
      const journal = new DatabaseSync(join(workerDirectory, 'journal.sqlite3'), {
        readOnly: true,
      });
      try {
        return {
          attempts: journal
            .prepare(
              'SELECT attempt_id,command_id,phase,pid,output_sha256,ack_dispatched,cleaned FROM attempts ORDER BY attempt_id',
            )
            .all(),
          events: journal
            .prepare('SELECT message_id,attempt_id,body,confirmed FROM events ORDER BY sequence')
            .all(),
        };
      } finally {
        journal.close();
      }
    };
    const before = journalSnapshot();
    if (
      before.attempts.length !== 1 ||
      before.attempts[0]?.phase !== 'succeeded' ||
      before.attempts[0]?.cleaned !== 1 ||
      before.attempts[0]?.ack_dispatched !== 1
    )
      fail('WORKER_TERMINAL_JOURNAL_MISMATCH');
    const beforeSpawns = await readFile(ffmpegLog, 'utf8');
    if (beforeSpawns.trim().split('\n').length !== 1) fail('FIRST_ATTEMPT_SPAWN_COUNT_MISMATCH');
    worker = startWorker();
    manifest.workerRestartPid = worker.pid;
    await save();
    await wait(1000);
    if (worker.exitCode !== null || worker.signalCode !== null) fail('RESTARTED_WORKER_EXITED');
    await observer.query(
      'UPDATE mio_compute_outbox SET sent_at=NULL,lease_id=NULL,lease_until=NULL WHERE job_id=$1',
      [job.jobId],
    );
    let resent = false;
    let ffmpegSeen = false;
    let sentTick = -1;
    for (let i = 0; i < 100; i++) {
      const ps = spawnSync('ps', ['-axo', 'ppid=,comm='], { encoding: 'utf8', timeout: 5000 });
      if (ps.status !== 0) fail('PROCESS_OBSERVATION_FAILED');
      for (const line of ps.stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (match && Number(match[1]) === worker.pid && /(?:^|\/)ffmpeg$/.test(match[2]!))
          ffmpegSeen = true;
      }
      if (i % 5 === 0 && !resent) {
        const row = (
          await observer.query<{ sent_at: Date | null }>(
            'SELECT sent_at FROM mio_compute_outbox WHERE job_id=$1',
            [job.jobId],
          )
        ).rows[0];
        if (row?.sent_at) {
          resent = true;
          sentTick = i;
        }
      }
      if (worker.exitCode !== null || worker.signalCode !== null) fail('RESTARTED_WORKER_EXITED');
      if (resent && i >= sentTick + 20) break;
      await wait(100);
    }
    if (!resent || ffmpegSeen) fail('REPLAY_SPAWN_OR_PUBLISH_MISMATCH');
    await stopProcess(worker, 'PORTABLE_WORKER');
    const inspectQueue = `import {connect} from 'amqplib';
      import {COMMAND_QUEUE} from '@mio/compute-contracts';
      const c=await connect(process.env.RABBITMQ_URL,{timeout:5000});
      c.on('error',()=>{}); const ch=await c.createChannel(); ch.on('error',()=>{});
      const message=await ch.get(COMMAND_QUEUE,{noAck:false});
      if(message){ch.nack(message,false,true);process.exitCode=1;}
      await ch.close(); await c.close();`;
    const drained = spawnSync(
      process.execPath,
      [
        `--env-file=${resolve('.runtime/compute-environment/broker-p3/runtime-b.env')}`,
        '--input-type=module',
        '-e',
        inspectQueue,
      ],
      { cwd: join(portableRoot, 'b'), env: workerEnv, encoding: 'utf8', timeout: 15000 },
    );
    if (drained.status !== 0) fail('REDELIVERY_NOT_ACKNOWLEDGED');
    const after = journalSnapshot();
    if (JSON.stringify(before) !== JSON.stringify(after)) fail('REPLAY_JOURNAL_CHANGED');
    if ((await readFile(ffmpegLog, 'utf8')) !== beforeSpawns) fail('REPLAY_FFMPEG_RESPAWNED');
    const count = (
      await observer.query<{ count: string }>(
        'SELECT count(*) FROM mio_assets WHERE raw_key LIKE $1',
        [`mio/derived/${job.jobId}/%`],
      )
    ).rows[0];
    if (Number(count?.count) !== 1 || (await readJob()).resultAssetId !== resultAssetId)
      fail('REPLAY_RESULT_DUPLICATED');
    manifest.workerRestartVerified = true;
    manifest.redeliveryVerified = true;
    await save();
    console.log('LIVE_COMPUTE_PROBE_B_RESTART_REDELIVERY_NO_RESPAWN');
  }
  completed = true;
  manifest.complete = true;
  manifest.outputBytes = resultBytes.length;
  phase = 'passed';
  await save();
  console.log(
    `LIVE_COMPUTE_PROBE_OK jobId=${job.jobId} manifest=${manifestPath} outputBytes=${resultBytes.length}`,
  );
} catch (error) {
  manifest.failure = error instanceof Error ? error.message : 'UNKNOWN';
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string')
    manifest.failureCode = cause.code;
  await save().catch(() => {});
  console.error(`LIVE_COMPUTE_PROBE_FAILED phase=${phase} manifest=${manifestPath}`);
  process.exitCode = 1;
} finally {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolveExit) => worker!.once('exit', () => resolveExit())),
      wait(10000),
    ]);
    if (worker.exitCode === null && worker.signalCode === null) {
      manifest.workerStillRunning = true;
      await save().catch(() => {});
      worker.unref();
      console.error('LIVE_COMPUTE_PROBE_WORKER_STILL_STOPPING');
      process.exitCode = 1;
      completed = false;
    }
  }
  if (ctx) await ctx.fiber.dispose();
  if (app && app.exitCode === null && app.signalCode === null) {
    app.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolveExit) => app!.once('exit', () => resolveExit())),
      wait(10000),
    ]);
    if (app.exitCode === null && app.signalCode === null) {
      manifest.appStillRunning = true;
      await save().catch(() => {});
      app.unref();
      process.exitCode = 1;
      completed = false;
    }
  }
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise<void>((resolveClose) => proxy!.close(() => resolveClose()));
  if (observer) await observer.end();
  if (database && completed) await database.close();
  if (inputDirectory && completed) await rm(inputDirectory, { recursive: true, force: true });
}
