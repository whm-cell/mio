import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const entry = resolve('scripts/harness/validation-entry.ts');
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mio-validation-entry-'));
  directories.push(root);
  await Promise.all(
    ['tests/auth', 'tests/auth-extra', 'tests/empty', 'compute/tests', 'scripts/harness'].map(
      (path) => mkdir(join(root, path), { recursive: true }),
    ),
  );
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  await symlink(entry, join(root, 'scripts/harness/validation-entry.ts'));
  await writeFile(
    join(root, 'vitest.config.ts'),
    "export default { test: { include: ['tests/**/*.test.ts', 'compute/tests/**/*.test.ts'] } };\n",
  );
  const body = (name: string) =>
    `import { appendFileSync } from 'node:fs';\nimport { test } from 'vitest';\ntest('${name}', () => appendFileSync(process.env.MARKER, '${name}\\n'));\n`;
  await Promise.all(
    [
      ['tests/auth/main.test.ts', body('main')],
      ['tests/auth/prefix-main.test.ts', body('prefix')],
      ['tests/auth-extra/extra.test.ts', body('extra')],
      ['compute/tests/worker.test.ts', body('worker')],
      ['tests/auth/not-test.ts', 'export {};\n'],
    ].map(([path, content]) => writeFile(join(root, path!), content!)),
  );
  return root;
}

function start(root: string, args: string[], env: NodeJS.ProcessEnv = {}, detached = false) {
  return spawn(process.execPath, [entry, ...args], {
    cwd: root,
    env: { ...process.env, GITHUB_ACTIONS: '', MARKER: join(root, 'marker'), ...env },
    detached,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function finish(child: ChildProcessWithoutNullStreams) {
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const [code, signal] = await once(child, 'close');
  return { code, signal, output };
}

async function marker(root: string) {
  try {
    return (await readFile(join(root, 'marker'), 'utf8')).trim().split('\n').sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

it('rejects missing, broad, invalid and discovery-changing scopes before running tests', async () => {
  const root = await fixture();
  await writeFile(join(root, 'outside.test.ts'), 'export {};\n');
  await symlink(join(root, 'outside.test.ts'), join(root, 'tests/auth/escape.test.ts'));
  for (const args of [
    [],
    ['--reporter', 'tests/auth'],
    ['-t', 'tests/auth'],
    ['--dir', 'tests/auth'],
    ['.'],
    ['tests'],
    ['./tests/'],
    ['tests/auth/..'],
    ['../outside'],
    ['tests/auth/not-test.ts'],
    ['tests/auth/escape.test.ts'],
    ['tests/auth', 'tests/empty'],
    ['tests/auth', '--config', 'vitest.config.ts'],
    ['tests/auth', '--root', '.'],
    ['tests/auth', '--include', 'tests/**'],
    ['tests/auth', '--exclude', 'tests/**'],
    ['tests/auth', '--passWithNoTests'],
  ]) {
    const result = await finish(start(root, ['test', ...args]));
    expect(result.code, `${args.join(' ')}: ${result.output}`).not.toBe(0);
    expect(await marker(root)).toEqual([]);
  }
}, 30000);

it('runs exact files and directory boundaries, including multiple scopes and Vitest options', async () => {
  const root = await fixture();
  await symlink(
    join(root, 'tests/auth/main.test.ts'),
    join(root, 'tests/auth-extra/alias.test.ts'),
  );
  const file = await finish(
    start(root, ['test', 'tests/auth/main.test.ts', '-t', 'main', '--reporter', 'dot']),
  );
  expect(file.code, file.output).toBe(0);
  expect(await marker(root)).toEqual(['main']);
  await rm(join(root, 'marker'));
  const directories = await finish(start(root, ['test', 'tests/auth', 'compute/tests']));
  expect(directories.code, directories.output).toBe(0);
  expect(await marker(root)).toEqual(['main', 'prefix', 'worker']);
});

it('propagates a failing test', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'tests/auth/fail.test.ts'),
    "import { test, expect } from 'vitest'; test('fails', () => expect(1).toBe(2));\n",
  );
  const failed = await finish(start(root, ['test', 'tests/auth/fail.test.ts']));
  expect(failed.code, failed.output).not.toBe(0);
});

it('returns failure when interrupted and cleans its fixture group', async () => {
  const root = await fixture();
  await writeFile(
    join(root, 'tests/auth/wait.test.ts'),
    "import { test } from 'vitest'; test('waits', async () => { console.log('WAIT_READY'); await new Promise(resolve => setTimeout(resolve, 10000)); });\n",
  );
  const child = start(root, ['test', 'tests/auth/wait.test.ts'], {}, true);
  const finished = finish(child);
  try {
    let stdout = '';
    const signal = AbortSignal.timeout(10000);
    while (!stdout.includes('WAIT_READY'))
      stdout += (await once(child.stdout, 'data', { signal }))[0].toString();
    const exited = once(child, 'close', { signal: AbortSignal.timeout(10000) });
    child.kill('SIGTERM');
    await exited;
    const cancelled = await finished;
    expect(cancelled.code === 0 && cancelled.signal === null, cancelled.output).toBe(false);
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await finished;
      await expect
        .poll(() => {
          try {
            process.kill(-child.pid!, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            return true;
          }
        })
        .toBe(true);
    }
  }
}, 30000);

it('allows an unscoped test run only in Actions while still enforcing explicit scopes there', async () => {
  const root = await fixture();
  const full = await finish(start(root, ['test'], { GITHUB_ACTIONS: 'true' }));
  expect(full.code, full.output).toBe(0);
  expect(await marker(root)).toEqual(['extra', 'main', 'prefix', 'worker']);
  await rm(join(root, 'marker'));
  const scoped = await finish(
    start(root, ['test', 'tests/auth/main.test.ts'], { GITHUB_ACTIONS: 'true' }),
  );
  expect(scoped.code, scoped.output).toBe(0);
  expect(await marker(root)).toEqual(['main']);
  await rm(join(root, 'marker'));
  const invalid = await finish(start(root, ['test', 'tests'], { GITHUB_ACTIONS: 'true' }));
  expect(invalid.code, invalid.output).not.toBe(0);
  expect(await marker(root)).toEqual([]);
});

it('runs the static sequence locally and gates the full sequence to Actions', async () => {
  const root = await fixture();
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
    scripts: { check: string; 'check:static': string };
  };
  await writeFile(
    join(root, 'pnpm'),
    `#!${process.execPath}
const step = process.argv[2];
require('node:fs').appendFileSync(process.env.MARKER, step + '\\n');
if (process.env.FAIL_AT === step) process.exit(9);
if (step === 'check:static') {
  const result = require('node:child_process').spawnSync(
    '/bin/sh', ['-c', ${JSON.stringify(pkg.scripts['check:static'])}],
    { stdio: 'inherit', env: process.env },
  );
  process.exit(result.status ?? 1);
}
`,
    { mode: 0o700 },
  );
  const command = (script: string, env: NodeJS.ProcessEnv) =>
    spawn('/bin/sh', ['-c', script], {
      cwd: root,
      env: {
        ...process.env,
        MARKER: join(root, 'marker'),
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_ACTIONS: '',
        FAIL_AT: '',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const staticLocal = await finish(command(pkg.scripts['check:static'], {}));
  expect(staticLocal.code, staticLocal.output).toBe(0);
  expect(await readFile(join(root, 'marker'), 'utf8')).toBe(
    'format:check\ntypecheck\nlint\nguard\nbuild\n',
  );
  await rm(join(root, 'marker'));
  const staticFailure = await finish(command(pkg.scripts['check:static'], { FAIL_AT: 'lint' }));
  expect(staticFailure.code, staticFailure.output).not.toBe(0);
  expect(await readFile(join(root, 'marker'), 'utf8')).toBe('format:check\ntypecheck\nlint\n');
  await rm(join(root, 'marker'));
  const local = await finish(command(pkg.scripts.check, { CI: 'true' }));
  expect(local.code, local.output).not.toBe(0);
  expect(await marker(root)).toEqual([]);
  const actions = await finish(command(pkg.scripts.check, { GITHUB_ACTIONS: 'true' }));
  expect(actions.code, actions.output).toBe(0);
  expect(await readFile(join(root, 'marker'), 'utf8')).toBe(
    'check:static\nformat:check\ntypecheck\nlint\nguard\nbuild\ntest\ntest:smoke\n',
  );
  await rm(join(root, 'marker'));
  const fullStaticFailure = await finish(
    command(pkg.scripts.check, { GITHUB_ACTIONS: 'true', FAIL_AT: 'guard' }),
  );
  expect(fullStaticFailure.code, fullStaticFailure.output).not.toBe(0);
  expect(await readFile(join(root, 'marker'), 'utf8')).toBe(
    'check:static\nformat:check\ntypecheck\nlint\nguard\n',
  );
  await rm(join(root, 'marker'));
  const testFailure = await finish(
    command(pkg.scripts.check, { GITHUB_ACTIONS: 'true', FAIL_AT: 'test' }),
  );
  expect(testFailure.code, testFailure.output).not.toBe(0);
  expect(await readFile(join(root, 'marker'), 'utf8')).toBe(
    'check:static\nformat:check\ntypecheck\nlint\nguard\nbuild\ntest\n',
  );
}, 20000);
