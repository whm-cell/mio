import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { Journal } from '../src/adapters/journal.ts';
import { captureLiveArtifacts } from '../../tests/compute/live-image-loop.ts';

it('records the first real-provider attempt and blocks a second without forwarding credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  try {
    await import('../../tests/compute/live-image-audit.ts');
    const url = 'https://api.onelinkai.cloud/vidu/ent/v2/reference2image';
    const options = { method: 'POST', headers: { authorization: 'synthetic-secret' } };
    await fetch(url, options);
    expect(() => fetch(url, options)).toThrow('LIVE_IMAGE_REPEAT_POST_BLOCKED');
    expect(transport).toHaveBeenCalledOnce();
    const first = readFileSync(join(directory, 'supplier-post-started.json'), 'utf8');
    const allowed = readFileSync(join(directory, 'supplier-post-allowed.json'), 'utf8');
    const blocked = readFileSync(join(directory, 'supplier-post-repeat-blocked.json'), 'utf8');
    expect(first + allowed + blocked).not.toContain('synthetic-secret');
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it('allows A model discovery and non-provider reads/PUTs without spending the supplier POST lock', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  try {
    await import('../../tests/compute/live-image-audit.ts');
    await fetch('https://api.onelinkai.cloud/v1/models');
    await fetch('https://bucket.cos.example/mio/raw/image');
    await fetch('https://bucket.cos.example/mio/staging/image', { method: 'PUT', body: 'fixture' });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(existsSync(join(directory, 'supplier-post-started.json'))).toBe(false);
    expect(existsSync(join(directory, 'supplier-post-allowed.json'))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it('records and blocks an unexpected provider endpoint without allowing an outbound request', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  try {
    await import('../../tests/compute/live-image-audit.ts');
    expect(() => fetch('https://api.onelinkai.cloud/unexpected', { method: 'POST' })).toThrow(
      'LIVE_IMAGE_UNEXPECTED_PROVIDER_POST',
    );
    expect(transport).not.toHaveBeenCalled();
    expect(readFileSync(join(directory, 'supplier-post-started.json'), 'utf8')).toContain('at');
    expect(
      readFileSync(join(directory, 'supplier-post-unexpected-blocked.json'), 'utf8'),
    ).toContain('at');
    expect(() => readFileSync(join(directory, 'supplier-post-allowed.json'), 'utf8')).toThrow();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it('holds the first query before network access and allows interrupted-worker cleanup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const module = pathToFileURL(resolve('tests/compute/live-image-audit.ts')).href;
  const source = `
    import { writeFileSync } from 'node:fs';
    globalThis.fetch = async () => { writeFileSync(process.env.MIO_LIVE_IMAGE_AUDIT_DIRECTORY + '/forwarded', 'unexpected'); return new Response('ok'); };
    await import(${JSON.stringify(module)});
    void fetch('https://api.onelinkai.cloud/vidu/ent/v2/tasks/private-task/creations');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: {
      ...process.env,
      MIO_LIVE_IMAGE_AUDIT_DIRECTORY: directory,
      MIO_LIVE_IMAGE_HOLD_FIRST_QUERY: 'yes',
    },
    stdio: 'ignore',
  });
  try {
    await vi.waitFor(
      () => expect(existsSync(join(directory, 'supplier-query-held.json'))).toBe(true),
      {
        timeout: 5000,
      },
    );
    expect(existsSync(join(directory, 'forwarded'))).toBe(false);
    expect(existsSync(join(directory, 'supplier-query-1.json'))).toBe(false);
    const exited = once(child, 'exit');
    expect(child.kill('SIGKILL')).toBe(true);
    const [, signal] = await exited;
    expect(signal).toBe('SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(directory, { recursive: true });
  }
}, 10000);

it('reads the journal only after the worker releases its exclusive lock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-journal-'));
  const journal = new Journal(directory, randomUUID(), true);
  let closed = false;
  try {
    const held = new DatabaseSync(join(directory, 'journal.sqlite3'), { readOnly: true });
    try {
      expect(() => held.prepare('SELECT phase,payload FROM image_attempts LIMIT 1').get()).toThrow(
        /locked/,
      );
    } finally {
      held.close();
    }
    journal.close();
    closed = true;
    const released = new DatabaseSync(join(directory, 'journal.sqlite3'), { readOnly: true });
    try {
      expect(
        released.prepare('SELECT phase,payload FROM image_attempts LIMIT 1').get(),
      ).toBeUndefined();
    } finally {
      released.close();
    }
  } finally {
    if (!closed) journal.close();
    rmSync(directory, { recursive: true });
  }
});

it('prints only a valid failure code when the current CLI rejects sensitive trailing details', async () => {
  const runtime = resolve('.runtime');
  mkdirSync(runtime, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(realpathSync(runtime), 'mio-live-safe-code-')));
  try {
    const preload = join(directory, 'preload.mjs');
    writeFileSync(
      preload,
      `
const OriginalError = globalThis.Error;
globalThis.Error = class extends OriginalError {
  constructor(message, options) {
    super(typeof message === 'string' && message.startsWith('LIVE_LEGACY_PHASE_RETIRED')
      ? (process.env.MIO_TEST_INVALID_CODE
        ? 'private-sensitive-tail\\nLIVE_DATABASE_NOT_EMPTY'
        : 'LIVE_DATABASE_NOT_EMPTY\\nprivate-sensitive-tail')
      : message, options);
  }
};`,
      { mode: 0o600 },
    );
    for (const invalid of [false, true]) {
      const run = join(directory, invalid ? 'invalid' : 'valid');
      const child = spawn(
        process.execPath,
        [
          resolve('tests/compute/live-image-loop.ts'),
          'prepare',
          run,
          '/unused-infra',
          '/unused-key',
          'live-safe-code',
        ],
        {
          env: {
            ...process.env,
            MIO_RUN_LIVE_IMAGE: 'yes',
            MIO_TEST_INVALID_CODE: invalid ? 'yes' : '',
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const [code] = await once(child, 'close');
      expect(code).toBe(1);
      expect(output.trim()).toBe(invalid ? 'LIVE_UNEXPECTED_FAILURE' : 'LIVE_DATABASE_NOT_EMPTY');
      expect(output).not.toContain('private-sensitive-tail');
      expect(existsSync(run)).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
}, 10000);

it('sanitizes current dev failures in both CLI output and retained events without external operations', async () => {
  const runtime = resolve('.runtime');
  mkdirSync(runtime, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(realpathSync(runtime), 'mio-dev-safe-events-')));
  try {
    const project = join(directory, 'project');
    mkdirSync(project);
    for (let remaining = 100; ; remaining--) {
      try {
        captureLiveArtifacts(project);
        break;
      } catch (error) {
        const missing = error as NodeJS.ErrnoException;
        if (
          remaining === 0 ||
          missing.code !== 'ENOENT' ||
          !missing.path?.startsWith(project + sep)
        )
          throw error;
        if (basename(missing.path) === 'dist') {
          mkdirSync(missing.path, { recursive: true });
          writeFileSync(join(missing.path, 'fixture.js'), 'synthetic');
        } else {
          mkdirSync(dirname(missing.path), { recursive: true });
          writeFileSync(missing.path, 'synthetic');
        }
      }
    }
    writeFileSync(join(project, 'package.json'), '{"type":"module"}\n');
    const fixtureRuntime = join(project, '.runtime');
    mkdirSync(fixtureRuntime);
    writeFileSync(join(project, '.gitignore'), '.work/\n.runtime/\ndist/\n');
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: project, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git('init', '-q');
    git('add', '-A');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'fixture',
    );
    const commit = git('rev-parse', 'HEAD');
    const taskId = 'dev-safe-events';
    const taskDirectory = join(project, '.work', 'tasks', taskId);
    mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(taskDirectory, 'state.json'),
      JSON.stringify({
        workspace: project,
        plan: { id: taskId },
        stage: 'C1_EVIDENCE_PENDING',
        contractRevision: 0,
        checkpoint: { candidate: { commit, contractRevision: 0 } },
      }),
      { mode: 0o600 },
    );
    const setupUrl = pathToFileURL(resolve('tests/support/local-dev-live.ts')).href;
    const preflightUrl = pathToFileURL(resolve('scripts/service/generation-cutover.ts')).href;
    for (const invalid of [false, true]) {
      const observations = join(
        fixtureRuntime,
        invalid ? 'invalid-observations.jsonl' : 'valid-observations.jsonl',
      );
      const setupPath = join(fixtureRuntime, 'setup.mjs');
      const preflightPath = join(fixtureRuntime, 'preflight.mjs');
      const preload = join(fixtureRuntime, 'preload.mjs');
      const record = `import { appendFileSync } from 'node:fs';
const record = (event, data = {}) => appendFileSync(${JSON.stringify(observations)}, JSON.stringify({event, ...data}) + '\\n', {mode: 0o600});`;
      writeFileSync(
        setupPath,
        `${record}
export async function preparePersistentDevEnvironment(domains) {
  record('fixture-setup', {domains});
  return ${JSON.stringify({
    origin: 'http://127.0.0.1:1',
    values: { MIO_LOCAL_COMPUTE_DIRECTORY: join(fixtureRuntime, 'compute') },
    runtimeEnv: {
      MIO_ASSETS_DATABASE_URL: 'postgresql://fixture.invalid/media',
      MIO_GENERATIONS_DATA_DIR: join(fixtureRuntime, 'generations'),
      DSH_HOME: join(fixtureRuntime, 'dsh'),
    },
  })};
}
export async function authenticateOrCreateRetainedDevOwner() { throw new Error('UNEXPECTED_AUTH'); }
export async function parseLiveAuthInput() { throw new Error('UNEXPECTED_AUTH'); }
`,
        { mode: 0o600 },
      );
      writeFileSync(
        preflightPath,
        `${record}
export async function inspectGenerationCutover(pool, options) {
  record('fixture-preflight', {probeCos: options.probeCos});
  throw new Error(${JSON.stringify(invalid ? 'private-sensitive-tail\nLIVE_CUTOVER_PREFLIGHT' : 'LIVE_CUTOVER_PREFLIGHT\nprivate-sensitive-tail')});
}
`,
        { mode: 0o600 },
      );
      writeFileSync(
        preload,
        `${record}
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
const blocked = () => { record('unexpected-external-operation'); throw new Error('EXTERNAL_OPERATION_BLOCKED'); };
globalThis.fetch = blocked;
net.Socket.prototype.connect = blocked;
pg.Pool.prototype.query = blocked;
pg.Pool.prototype.connect = blocked;
const end = pg.Pool.prototype.end;
pg.Pool.prototype.end = function (...args) { record('pool-ended'); return end.apply(this, args); };
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  if (command !== 'git' || !['rev-parse', 'status'].includes(args[0])) return blocked();
  record('candidate-git-check', {command: args[0]});
  return spawnSync(command, args, options);
};
for (const name of ['spawn', 'exec', 'execFile', 'fork', 'execSync', 'execFileSync']) childProcess[name] = blocked;
syncBuiltinESMExports();
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (resolved.url === ${JSON.stringify(setupUrl)}) return {url: ${JSON.stringify(pathToFileURL(setupPath).href)}, shortCircuit: true};
  if (resolved.url === ${JSON.stringify(preflightUrl)}) return {url: ${JSON.stringify(pathToFileURL(preflightPath).href)}, shortCircuit: true};
  return resolved;
}});
`,
        { mode: 0o600 },
      );
      const run = join(fixtureRuntime, invalid ? 'invalid-run' : 'valid-run');
      const child = spawn(
        process.execPath,
        [resolve('tests/compute/live-image-loop.ts'), 'dev', run, '/unused-auth', taskId],
        {
          cwd: project,
          env: {
            PATH: process.env.PATH,
            MIO_RUN_LIVE_IMAGE: 'yes',
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const [code] = await once(child, 'close');
      const expected = invalid ? 'LIVE_UNEXPECTED_FAILURE' : 'LIVE_CUTOVER_PREFLIGHT';
      expect(code).toBe(1);
      expect(output.trim()).toBe(expected);
      const events = readFileSync(join(run, 'events.jsonl'), 'utf8');
      expect(output + events).not.toContain('private-sensitive-tail');
      expect(
        events
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([{ at: expect.any(String), event: 'failed-or-unknown', code: expected }]);
      const activity = readFileSync(observations, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(activity).toEqual([
        { event: 'candidate-git-check', command: 'rev-parse' },
        { event: 'candidate-git-check', command: 'status' },
        { event: 'fixture-setup', domains: ['auth', 'assets', 'generations', 'providers'] },
        { event: 'fixture-preflight', probeCos: true },
        { event: 'pool-ended' },
      ]);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
}, 10000);

it('marks a received response before its diagnostic trace is available', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  writeFileSync(
    join(directory, 'allowed-task.json'),
    JSON.stringify({ upstreamTaskId: 'task', deadline: Date.now() + 600_000 }),
  );
  try {
    await import('../../tests/compute/live-image-audit.ts');
    const response = await fetch('https://api.onelinkai.cloud/vidu/ent/v2/tasks/task/creations');
    expect(existsSync(join(directory, 'supplier-query-1-response.json'))).toBe(true);
    expect(existsSync(join(directory, 'supplier-query-1-trace.json'))).toBe(false);
    controller.enqueue(new TextEncoder().encode('{"state":"processing"}'));
    controller.close();
    expect(await response.json()).toEqual({ state: 'processing' });
    await vi.waitFor(() =>
      expect(existsSync(join(directory, 'supplier-query-1-trace.json'))).toBe(true),
    );
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it('allows only the saved task and at most eight query attempts without logging credentials', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const states = [
    'created',
    'queueing',
    'processing',
    'success',
    'failed',
    'private-state',
    null,
    undefined,
  ];
  let responseIndex = 0;
  const transport = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      state: states[responseIndex++],
      creations: [{ url: 'https://image01.vidu.zone/private-path?token=private-token' }],
      task_id: 'private-task',
      secret: 'synthetic-secret',
    }),
  );
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubGlobal('fetch', transport);
  writeFileSync(
    join(directory, 'allowed-task.json'),
    JSON.stringify({ upstreamTaskId: 'private-task', deadline: Date.now() + 600_000 }),
    {
      mode: 0o600,
    },
  );
  try {
    await import('../../tests/compute/live-image-audit.ts');
    expect(() =>
      fetch('https://api.onelinkai.cloud/vidu/ent/v2/tasks/other-task/creations'),
    ).toThrow('LIVE_QUERY_TASK_MISMATCH');
    const url = 'https://api.onelinkai.cloud/vidu/ent/v2/tasks/private-task/creations';
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetch(url, { headers: { authorization: 'synthetic-secret' } });
      expect(((await response.json()) as { task_id: string }).task_id).toBe('private-task');
    }
    expect(() => fetch(url)).toThrow('LIVE_QUERY_LIMIT_BLOCKED');
    expect(transport).toHaveBeenCalledTimes(8);
    await vi.waitFor(() =>
      expect(
        readFileSync(join(directory, 'supplier-http-events.jsonl'), 'utf8').trim().split('\n'),
      ).toHaveLength(8),
    );
    await vi.waitFor(() => {
      for (let attempt = 1; attempt <= 8; attempt++) {
        expect(existsSync(join(directory, `supplier-query-${attempt}-response.json`))).toBe(true);
        expect(existsSync(join(directory, `supplier-query-${attempt}-trace.json`))).toBe(true);
      }
    });
    const events = readFileSync(join(directory, 'supplier-http-events.jsonl'), 'utf8');
    expect(events).not.toContain('synthetic-secret');
    expect(events).not.toContain('private-task');
    expect(events).not.toContain('private-path');
    expect(events).not.toContain('private-token');
    expect(events.trim().split('\n')).toHaveLength(8);
    const facts = events
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .sort((a, b) => a.attempt - b.attempt);
    expect(facts.map((event) => event.state)).toEqual([
      'created',
      'queueing',
      'processing',
      'success',
      'failed',
      'other',
      'unknown',
      'unknown',
    ]);
    expect(facts[0]).toMatchObject({
      status: 200,
      stateType: 'string',
      creationsType: 'array',
      creationsCount: 1,
      firstUrlPresent: true,
      firstUrlSyntaxAllowed: true,
    });
    expect(existsSync(join(directory, 'supplier-query-limit-blocked.json'))).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it.each([
  ['vidu-async', 'https://api.onelinkai.cloud/vidu/ent/v2/reference2image'],
  ['kling-async', 'https://api.onelinkai.cloud/kling/v1/images/generations'],
  ['seedream-sync', 'https://api.onelinkai.cloud/volc/api/v3/images/generations'],
  ['gpt-sync', 'https://api.onelinkai.cloud/v1/images/generations'],
  ['gpt-edit', 'https://api.onelinkai.cloud/v1/images/edits'],
] as const)(
  'enforces the single-POST interlock for explicit scenario %s (%s)',
  async (scenario, allowedUrl) => {
    vi.resetModules();
    const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
    vi.stubEnv('MIO_LIVE_IMAGE_SCENARIO', scenario);
    vi.stubGlobal('fetch', transport);
    try {
      await import('../../tests/compute/live-image-audit.ts');
      const options = { method: 'POST', headers: { authorization: 'synthetic-secret' } };
      await fetch(allowedUrl, options);
      expect(() => fetch(allowedUrl, options)).toThrow('LIVE_IMAGE_REPEAT_POST_BLOCKED');
      expect(transport).toHaveBeenCalledOnce();
      expect(existsSync(join(directory, 'supplier-post-started.json'))).toBe(true);
      expect(existsSync(join(directory, 'supplier-post-allowed.json'))).toBe(true);
      expect(existsSync(join(directory, 'supplier-post-repeat-blocked.json'))).toBe(true);
      expect(existsSync(join(directory, 'supplier-post-unexpected-blocked.json'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true });
    }
  },
);

it.each([
  ['seedream-sync', 'https://api.onelinkai.cloud/v1/images/generations', 'POST'],
  ['seedream-sync', 'https://api.onelinkai.cloud/vidu/ent/v2/tasks/task/creations', 'GET'],
  ['seedream-sync', 'https://api.onelinkai.cloud/kling/v1/images/generations/task', 'GET'],
  ['seedream-sync', 'https://unexpected.example/volc/api/v3/images/generations', 'POST'],
  ['gpt-sync', 'https://api.onelinkai.cloud/v1/images/edits', 'POST'],
  ['gpt-edit', 'https://api.onelinkai.cloud/v1/images/generations', 'POST'],
  ['vidu-async', 'https://unexpected.example/vidu/ent/v2/reference2image', 'POST'],
  ['vidu-async', 'https://api.onelinkai.cloud/kling/v1/images/generations/task', 'GET'],
  ['kling-async', 'https://api.onelinkai.cloud/vidu/ent/v2/reference2image', 'POST'],
  ['kling-async', 'https://api.onelinkai.cloud/v1/images/generations', 'POST'],
  ['kling-async', 'https://api.onelinkai.cloud/volc/api/v3/images/generations', 'POST'],
  ['kling-async', 'https://api.onelinkai.cloud/kling/v1/images/omni-image', 'POST'],
  ['kling-async', 'https://api.onelinkai.cloud/vidu/ent/v2/tasks/task/creations', 'GET'],
  ['kling-async', 'https://unexpected.example/kling/v1/images/generations', 'POST'],
] as const)(
  'blocks cross-scenario or unexpected host/path requests in %s (%s %s)',
  async (scenario, rejectedUrl, method) => {
    vi.resetModules();
    const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
    vi.stubEnv('MIO_LIVE_IMAGE_SCENARIO', scenario);
    vi.stubGlobal('fetch', transport);
    try {
      await import('../../tests/compute/live-image-audit.ts');
      expect(() => fetch(rejectedUrl, { method })).toThrow('LIVE_IMAGE_UNEXPECTED_PROVIDER_POST');
      expect(transport).not.toHaveBeenCalled();
      expect(existsSync(join(directory, 'supplier-post-started.json'))).toBe(true);
      expect(existsSync(join(directory, 'supplier-post-unexpected-blocked.json'))).toBe(true);
      expect(existsSync(join(directory, 'supplier-post-allowed.json'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true });
    }
  },
);

it('enforces Kling task-ID matching, eight-query cap, and sanitized envelope diagnostics without logging URLs', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  const statuses = [
    'NOT_START',
    'queued',
    'IN_PROGRESS',
    'SUBMITTED',
    'SUCCEED',
    'success',
    'FAILURE',
    'UNKNOWN',
  ];
  let responseIndex = 0;
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
    const currentStatus = statuses[responseIndex++];
    return Response.json({
      code: responseIndex === 6 ? 1001 : 0,
      message: 'private-kling-message',
      data: {
        task_id: 'private-kling-task',
        task_status: currentStatus,
        task_result: {
          images: [{ index: 0, url: 'https://cdn.kling.example/private-image?sig=private-sig' }],
        },
      },
      secret: 'synthetic-kling-secret',
    });
  });
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubEnv('MIO_LIVE_IMAGE_SCENARIO', 'kling-async');
  vi.stubGlobal('fetch', transport);
  writeFileSync(
    join(directory, 'allowed-task.json'),
    JSON.stringify({ upstreamTaskId: 'private-kling-task', deadline: Date.now() + 600_000 }),
    { mode: 0o600 },
  );
  try {
    await import('../../tests/compute/live-image-audit.ts');
    expect(() =>
      fetch('https://api.onelinkai.cloud/kling/v1/images/generations/other-kling-task'),
    ).toThrow('LIVE_QUERY_TASK_MISMATCH');
    const url = 'https://api.onelinkai.cloud/kling/v1/images/generations/private-kling-task';
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetch(url, { headers: { authorization: 'synthetic-kling-secret' } });
      expect(((await response.json()) as { data: { task_id: string } }).data.task_id).toBe(
        'private-kling-task',
      );
    }
    expect(() => fetch(url)).toThrow('LIVE_QUERY_LIMIT_BLOCKED');
    expect(transport).toHaveBeenCalledTimes(8);
    await vi.waitFor(() => {
      for (let attempt = 1; attempt <= 8; attempt++) {
        expect(existsSync(join(directory, `supplier-query-${attempt}-response.json`))).toBe(true);
        expect(existsSync(join(directory, `supplier-query-${attempt}-trace.json`))).toBe(true);
      }
    });
    const events = readFileSync(join(directory, 'supplier-http-events.jsonl'), 'utf8');
    expect(events).not.toContain('synthetic-kling-secret');
    expect(events).not.toContain('private-kling-task');
    expect(events).not.toContain('private-kling-message');
    expect(events).not.toContain('private-image');
    expect(events).not.toContain('private-sig');
    const facts = events
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .sort((a, b) => a.attempt - b.attempt);
    expect(facts.map((event) => event.state)).toEqual([
      'not_start',
      'queued',
      'in_progress',
      'submitted',
      'succeed',
      'success',
      'failure',
      'other',
    ]);
    expect(facts[4]).toMatchObject({
      status: 200,
      codeZero: true,
      state: 'succeed',
      stateType: 'string',
      creationsType: 'array',
      creationsCount: 1,
      firstUrlPresent: true,
      firstUrlSyntaxAllowed: true,
    });
    expect(facts[5]).toMatchObject({
      codeZero: false,
      state: 'success',
    });
    expect(existsSync(join(directory, 'supplier-query-mismatch-blocked.json'))).toBe(true);
    expect(existsSync(join(directory, 'supplier-query-limit-blocked.json'))).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});

it('rejects an invalid audit scenario before installing fetch hooks', async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), 'mio-live-audit-'));
  vi.stubEnv('MIO_LIVE_IMAGE_AUDIT_DIRECTORY', directory);
  vi.stubEnv('MIO_LIVE_IMAGE_SCENARIO', 'unknown-scenario');
  try {
    await expect(import('../../tests/compute/live-image-audit.ts')).rejects.toThrow(
      'LIVE_IMAGE_SCENARIO_INVALID',
    );
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true });
  }
});
