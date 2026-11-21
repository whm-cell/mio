import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const scratch: string[] = [];
afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'mio-portable-'));
  scratch.push(directory);
  return directory;
}

function run(probe: 'artifact' | 'migrations', directory: string, root: string, preload?: string) {
  const entry = fileURLToPath(new URL(`./portable-${probe}-probe.ts`, import.meta.url));
  return spawnSync(process.execPath, [...(preload ? ['--import', preload] : []), entry, root], {
    cwd: directory,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      MIO_TEST_DATABASE_URL: 'never-reach-the-database',
    },
    encoding: 'utf8',
    timeout: 6000,
  });
}

it.each([
  { probe: 'artifact', component: 'b', topLevel: true },
  { probe: 'artifact', component: 'host', topLevel: false },
  { probe: 'migrations', component: 'a', topLevel: true },
  { probe: 'migrations', component: 'a', topLevel: false },
] as const)(
  '$probe probe checks external links before executing a package or opening a database',
  async ({ probe, component, topLevel }) => {
    const temporary = await temporaryDirectory();
    const root = join(temporary, 'delivery');
    const outside = join(temporary, 'outside');
    await mkdir(root);
    await mkdir(outside);
    for (const name of ['a', 'b', 'host']) {
      if (name === component && topLevel) await symlink(outside, join(root, name), 'dir');
      else await mkdir(join(root, name));
    }
    if (!topLevel) await symlink('../a-peer', join(root, component, 'external'), 'dir');
    await mkdir(join(root, 'a-peer'));

    const result = run(probe, temporary, root);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('ARTIFACT_EXTERNAL_LINK');
    expect(result.stderr).not.toContain('PORTABLE_FOUNDATION_LOAD_FAILED');
    expect(result.stderr).not.toContain('Invalid URL');
  },
);

it('both probes reject the source workspace when invoked from outside it', async () => {
  const temporary = await temporaryDirectory();
  const workspace = fileURLToPath(new URL('../../', import.meta.url));
  for (const probe of ['artifact', 'migrations'] as const) {
    const result = run(probe, temporary, workspace);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('PORTABLE_ROOT_MUST_BE_OUTSIDE_WORKSPACE');
  }
});

const immovableLinks = [
  {
    name: 'an absolute component alias still valid at the staging path',
    links: [{ path: 'delivery/a', target: 'delivery/package', absolute: true }],
  },
  {
    name: 'an absolute link within a component',
    links: [
      { path: 'delivery/a', target: 'package' },
      { path: 'delivery/package/entry', target: 'delivery/package/library', absolute: true },
    ],
  },
  {
    name: 'a relative component alias through an absolute directory link',
    links: [
      { path: 'delivery/a', target: 'aliases/current/package' },
      { path: 'delivery/aliases/current', target: 'delivery', absolute: true },
    ],
  },
  {
    name: 'a component alias that leaves the delivery and returns',
    links: [
      { path: 'delivery/a', target: 'bridge/package' },
      { path: 'delivery/bridge', target: '../outside' },
      { path: 'outside/package', target: '../delivery/package' },
    ],
  },
  {
    name: 'an internal link that relies on a sibling directory',
    links: [
      { path: 'delivery/a', target: 'package' },
      { path: 'delivery/package/entry', target: '../sibling' },
      { path: 'delivery/sibling', target: 'package/library' },
    ],
  },
];

it.each(immovableLinks)('both probes reject $name before side effects', async ({ links }) => {
  const temporary = await temporaryDirectory();
  const root = join(temporary, 'delivery');
  for (const path of [
    'delivery/package/library',
    'delivery/aliases',
    'delivery/b',
    'delivery/host',
    'outside',
  ])
    await mkdir(join(temporary, path), { recursive: true });
  for (const { path, target, absolute } of links)
    await symlink(absolute ? join(temporary, target) : target, join(temporary, path), 'dir');

  for (const probe of ['artifact', 'migrations'] as const) {
    const result = run(probe, temporary, root);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('ARTIFACT_EXTERNAL_LINK');
    expect(result.stderr).not.toContain('PORTABLE_FOUNDATION_LOAD_FAILED');
    expect(result.stderr).not.toContain('Invalid URL');
  }
});

it('allows a shared parent directory but rejects aliases that use the actual source checkout', async () => {
  const temporary = await temporaryDirectory();
  const source = join(temporary, 'checkout/tests/packaging/portable-root.ts');
  await mkdir(dirname(source), { recursive: true });
  await copyFile(fileURLToPath(new URL('./portable-root.ts', import.meta.url)), source);
  await mkdir(join(temporary, 'package'));
  const script = `import { portableRoot, portableComponent } from ${JSON.stringify(pathToFileURL(source).href)};
    portableComponent(portableRoot(process.argv[1]), 'a');`;
  const invoke = () =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script, temporary], {
      encoding: 'utf8',
      timeout: 3000,
    });
  const alias = join(temporary, 'a');
  await symlink('package', alias, 'dir');
  expect(invoke().status).toBe(0);
  for (const target of ['checkout', 'checkout/../package']) {
    await rm(alias);
    await symlink(target, alias, 'dir');
    const result = invoke();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('ARTIFACT_EXTERNAL_LINK');
  }
});

// Deadlines are shortened only in the probe process. HTTP and child signals remain real.
const quickDeadline =
  'data:text/javascript,' +
  encodeURIComponent(`
  import timers from 'node:timers/promises';
  import { syncBuiltinESMExports } from 'node:module';
  const delay = timers.setTimeout;
  timers.setTimeout = (ms, ...args) => delay(ms === 10000 ? 100 : ms, ...args);
  syncBuiltinESMExports();
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => timeout(ms === 3000 ? 150 : ms);
`);

it.each(['graceful', 'stuck', 'stuck-after-error', 'authenticated', 'unauthenticated'] as const)(
  'runs a moved delivery with relative aliases and reaps the host in the %s case',
  async (shutdown) => {
    const temporary = await temporaryDirectory();
    const staged = join(temporary, 'staged');
    const moved = join(temporary, 'moved');
    const foundation = JSON.stringify({ type: 'module', exports: { './*': './index.js' } });
    const files = {
      'inside-a/shared-package/package.json': foundation,
      'inside-a/shared-package/index.js': 'export const present = true;',
      'inside-a/dist/tools/scripts/service/prepare-profile.js': '',
      'b/node_modules/@mio/foundation/package.json': foundation,
      'b/node_modules/@mio/foundation/index.js': 'export const present = true;',
      'b/dist/main.js': '',
      'host/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({
        type: 'module',
        version: '0.2.2-rc.1',
      }),
      'host/node_modules/@deepseek-ai/dsh/lib/bin.js': `
        import { createServer } from 'node:http';
        import { appendFileSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const server = createServer((request, response) => {
          const check = request.url === '/readyz' ? 'ready'
            : request.headers.authorization ? 'authenticated' : 'unauthenticated';
          appendFileSync(join(process.env.HOME, 'requests'), check + String.fromCharCode(10));
          if (check === ${JSON.stringify(shutdown)}) return;
          response.writeHead(check === 'ready' ? 200
            : check === 'authenticated' ? ${shutdown === 'stuck-after-error' ? 502 : 200} : 401,
          { connection: 'close' }).end();
        });
        process.on('SIGTERM', () => {
          if (${shutdown === 'graceful'}) server.close(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 8000).unref();
        server.listen(Number(process.env.MIO_PORT), '127.0.0.1',
          () => writeFileSync(join(process.env.HOME, 'pid'), String(process.pid)));
      `,
    };
    for (const [name, content] of Object.entries(files)) {
      const path = join(staged, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    await mkdir(join(staged, 'inside-a/node_modules/@mio'), { recursive: true });
    await symlink(
      '../../shared-package',
      join(staged, 'inside-a/node_modules/@mio/foundation'),
      'dir',
    );
    await symlink('inside-a', join(staged, 'active-a'), 'dir');
    await symlink('active-a', join(staged, 'a'), 'dir');
    await rename(staged, moved);

    const result = run(
      'artifact',
      temporary,
      moved,
      shutdown === 'graceful' ? undefined : quickDeadline,
    );
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('PORTABLE_FOUNDATION_ENTRIES_OK');
    const pid = Number(await readFile(join(moved, 'smoke-state/pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    if (shutdown === 'graceful') {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('PORTABLE_DSH_PLUGIN_AND_WORKER_INIT_OK');
    } else {
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).not.toContain('PORTABLE_DSH_PLUGIN_AND_WORKER_INIT_OK');
      expect(result.stderr).toContain('PORTABLE_DSH_STILL_STOPPING');
      if (shutdown === 'stuck-after-error') expect(result.stderr).toContain('502 !== 200');
      if (shutdown === 'unauthenticated' || shutdown === 'authenticated') {
        const requests = (await readFile(join(moved, 'smoke-state/requests'), 'utf8'))
          .trim()
          .split('\n');
        expect(requests[0]).toBe('ready');
        expect(requests.filter((request) => request !== 'ready')).toEqual(
          shutdown === 'authenticated' ? ['authenticated'] : ['authenticated', 'unauthenticated'],
        );
        expect(result.stderr).toContain('TimeoutError');
      }
    }
  },
);
