import { spawnSync } from 'node:child_process';
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
import { afterEach, expect, it } from 'vitest';
import { captureLiveArtifacts } from './live-image-loop.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['prepare', 'execute'])(
  'rejects retired %s before creating a run or opening legacy infrastructure',
  (phase) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mio-a-live-entry-')));
    roots.push(root);
    const run = join(root, '.runtime', 'untouched');
    const child = spawnSync(
      process.execPath,
      [
        resolve('tests/compute/live-image-loop.ts'),
        phase,
        run,
        'missing-infrastructure',
        'missing-credentials',
        'live-task',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH, MIO_RUN_LIVE_IMAGE: 'yes' },
      },
    );
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('LIVE_LEGACY_PHASE_RETIRED');
    expect(existsSync(run)).toBe(false);
  },
);

it('does not start the A live chain without explicit opt-in', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mio-a-live-entry-')));
  roots.push(root);
  const run = join(root, '.runtime', 'untouched');
  const child = spawnSync(
    process.execPath,
    [resolve('tests/compute/live-image-loop.ts'), 'dev', run, 'missing-auth', 'live-task'],
    { cwd: root, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH } },
  );
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain('LIVE_OPT_IN');
  expect(existsSync(run)).toBe(false);
});

it('uses the real readiness policy and route-import contract before live admission', () => {
  mkdirSync(resolve('.runtime'), { recursive: true });
  const root = realpathSync(mkdtempSync(join(resolve('.runtime'), 'mio-live-setup-')));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  for (let remaining = 100; ; remaining--) {
    try {
      captureLiveArtifacts(project);
      break;
    } catch (error) {
      const missing = error as NodeJS.ErrnoException;
      if (!remaining || missing.code !== 'ENOENT' || !missing.path?.startsWith(project + sep))
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
  const taskId = 'dev-setup-contract';
  const taskDirectory = join(project, '.work', 'tasks', taskId);
  mkdirSync(taskDirectory, { recursive: true });
  writeFileSync(
    join(taskDirectory, 'state.json'),
    JSON.stringify({
      workspace: project,
      plan: { id: taskId },
      stage: 'C1_EVIDENCE_PENDING',
      contractRevision: 0,
      checkpoint: { candidate: { commit: git('rev-parse', 'HEAD'), contractRevision: 0 } },
    }),
  );
  const runtime = join(project, '.runtime');
  mkdirSync(runtime);
  const observations = join(runtime, 'observations.jsonl');
  const record = `import { appendFileSync } from 'node:fs';
const record = (event, data = {}) => appendFileSync(${JSON.stringify(observations)}, JSON.stringify({event, ...data}) + '\\n', {mode: 0o600});`;
  const setup = join(runtime, 'setup.mjs');
  const preflight = join(runtime, 'preflight.mjs');
  const profile = join(runtime, 'profile.mjs');
  const preload = join(runtime, 'preload.mjs');
  const origin = 'http://127.0.0.1:1';
  writeFileSync(
    setup,
    `export async function preparePersistentDevEnvironment() { return ${JSON.stringify({
      origin,
      values: { MIO_LOCAL_COMPUTE_DIRECTORY: join(runtime, 'compute') },
      runtimeEnv: {
        MIO_ASSETS_DATABASE_URL: 'postgresql://fixture.invalid/media',
        MIO_GENERATIONS_DATA_DIR: join(runtime, 'generations'),
        DSH_HOME: join(runtime, 'dsh'),
      },
    })}; }
export async function parseLiveAuthInput() { return {kind:'apiKey', apiKey:'synthetic-key'}; }
export async function authenticateOrCreateRetainedDevOwner() { return {userId:'owner', cookie:'owner=session', apiKey:'synthetic-key'}; }
`,
  );
  writeFileSync(
    preflight,
    `export async function inspectGenerationCutover() { return {readyForCutover:true}; }\n`,
  );
  writeFileSync(
    profile,
    `export async function prepareProfile() {}\nexport function launcher() { return '/fixture-launcher'; }\n`,
  );
  writeFileSync(
    preload,
    `${record}
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import { createHandler } from ${JSON.stringify(pathToFileURL(resolve('src/http.ts')).href)};
import { validateRouteImportPayload } from ${JSON.stringify(pathToFileURL(resolve('src/providers/onelink/router.ts')).href)};
const blocked = () => { record('external-operation-blocked'); throw new Error('EXTERNAL_OPERATION_BLOCKED'); };
net.Socket.prototype.connect = blocked;
pg.Pool.prototype.query = blocked;
pg.Pool.prototype.connect = blocked;
let app;
childProcess.spawn = () => { app = new EventEmitter(); app.exitCode = null; app.signalCode = null; return app; };
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (command === 'git' && ['rev-parse','status'].includes(args[0])) return originalSpawnSync(command, args, options);
  if (command === process.execPath && args[0] === 'scripts/service/import-provider-route.ts' && args[1] === '--stdin') {
    try {
      const routes = validateRouteImportPayload(JSON.parse(options.input));
      record('route-import-validated', {model:routes[0].rawModelId, count:routes.length});
      return {status:0};
    } catch (error) { app.exitCode = 1; record('route-import-invalid', {code:error.code}); return {status:1}; }
  }
  return blocked();
};
syncBuiltinESMExports();
const handler = createHandler({token:'x'.repeat(32),allowedOrigins:[],instanceId:'fixture'});
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== ${JSON.stringify(origin)}) return blocked();
  if (url.pathname === '/readyz') {
    const headers = Object.fromEntries(new Headers(init.headers));
    let status, body;
    handler({url:'/readyz',method:init.method ?? 'GET',headers}, {setHeader(){},writeHead(value){status=value;},end(value){body=value;}});
    record('ready-policy', {originPresent:headers.origin !== undefined,status});
    if (status !== 200) app.exitCode = 1;
    return new Response(body,{status});
  }
  if (url.pathname === '/api/auth/sign-up/email') return new Response('{}',{status:200,headers:{'set-cookie':'other=session'}});
  if (url.pathname === '/api/v1/providers/onelink') return Response.json(null);
  if (url.pathname === '/api/v1/providers/onelink/credential') return Response.json({});
  if (url.pathname === '/api/v1/providers/onelink/test') return Response.json({status:'connected'});
  if (url.pathname === '/api/v1/providers/onelink/models') return Response.json({items:[{modelId:'image-vidu-q2',modelRef:'fixture',discovered:true,credentialVersion:1,catalogVersion:1}],provider:{credentialVersion:1,catalog:{version:1}}});
  if (url.pathname === '/api/v1/compute/images') {
    app.exitCode = 0;
    record('stopped-before-generation');
    throw new Error('FIXTURE_STOP_BEFORE_GENERATION');
  }
  return blocked();
};
registerHooks({ resolve(specifier,context,nextResolve) {
  const result = nextResolve(specifier,context);
  const replacements = ${JSON.stringify({
    [pathToFileURL(resolve('tests/support/local-dev-live.ts')).href]: pathToFileURL(setup).href,
    [pathToFileURL(resolve('scripts/service/generation-cutover.ts')).href]:
      pathToFileURL(preflight).href,
    [pathToFileURL(resolve('scripts/service/profile.ts')).href]: pathToFileURL(profile).href,
  })};
  return replacements[result.url] ? {url:replacements[result.url],shortCircuit:true} : result;
}});
`,
  );
  const child = spawnSync(
    process.execPath,
    [resolve('tests/compute/live-image-loop.ts'), 'dev', join(runtime, 'run'), '/unused', taskId],
    {
      cwd: project,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        MIO_RUN_LIVE_IMAGE: 'yes',
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      },
    },
  );
  expect(child.status, child.stderr).toBe(1);
  expect(child.stderr.trim()).toBe('FIXTURE_STOP_BEFORE_GENERATION');
  const activity = readFileSync(observations, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(activity).toEqual([
    { event: 'ready-policy', originPresent: false, status: 200 },
    { event: 'route-import-validated', model: 'image-vidu-q2', count: 1 },
    { event: 'stopped-before-generation' },
  ]);
}, 15_000);
