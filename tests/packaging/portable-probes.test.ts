import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// This only shortens the shutdown deadline in the probe process. Child signals remain real.
const quickDeadline =
  'data:text/javascript,' +
  encodeURIComponent(`
  import timers from 'node:timers/promises';
  import { syncBuiltinESMExports } from 'node:module';
  const delay = timers.setTimeout;
  timers.setTimeout = (ms, ...args) => delay(ms === 10000 ? 100 : ms, ...args);
  syncBuiltinESMExports();
`);

it.each(['graceful', 'stuck', 'stuck-after-error'] as const)(
  'runs a moved delivery with relative aliases and reaps a %s host',
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
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const server = createServer((request, response) => {
          response.writeHead(request.url === '/readyz' ? 200
            : request.headers.authorization ? ${shutdown === 'stuck-after-error' ? 502 : 200} : 401,
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
    await symlink('inside-a', join(staged, 'a'), 'dir');
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
    }
  },
);
