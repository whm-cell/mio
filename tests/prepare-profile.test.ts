import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const entry = resolve('scripts/service/prepare-profile.ts');
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mio-profile-cli-'));
  directories.push(directory);
  const plugin = join(directory, 'plugin');
  await mkdir(join(plugin, 'dist'), { recursive: true });
  await writeFile(join(plugin, 'dist/plugin.js'), 'export {};\n');
  return { directory, plugin };
}
function run(cwd: string, args: string[] = [], env = process.env) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
}

it('uses the selected environment home instead of mixing profiles in the default directory', async () => {
  const { directory, plugin } = await fixture();
  const home = join(directory, 'test-home');
  expect(run(plugin, [], { ...process.env, DSH_HOME: home }).status).toBe(0);
  expect(await realpath(join(home, 'profiles/mio/node_modules/@mio/plugin'))).toBe(
    await realpath(plugin),
  );
  await expect(readFile(join(plugin, '.runtime/dsh/profiles/mio/package.json'))).rejects.toThrow();
});

it('retains the original no-argument profile location', async () => {
  const { plugin } = await fixture();
  const first = run(plugin);
  expect(first.status, first.stderr).toBe(0);
  const profile = join(plugin, '.runtime/dsh/profiles/mio');
  expect(await realpath(join(profile, 'node_modules/@mio/plugin'))).toBe(await realpath(plugin));
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as {
    dsh: { profile: { bundles: string[] } };
  };
  expect(manifest.dsh.profile.bundles).toEqual(['@mio/plugin']);
});

it('accepts explicit home and plugin together while preserving existing manual settings', async () => {
  const { directory, plugin } = await fixture();
  const home = join(directory, 'home');
  expect(run(directory, [home, plugin]).status).toBe(0);
  const patch = join(home, 'profiles/mio/cordis.patch.yml');
  await writeFile(patch, '# retained manual profile\n[]\n');
  expect(run(directory, [home, plugin]).status).toBe(0);
  expect(await readFile(patch, 'utf8')).toBe('# retained manual profile\n[]\n');
  expect(await realpath(join(home, 'profiles/mio/node_modules/@mio/plugin'))).toBe(
    await realpath(plugin),
  );
  expect(run(directory, [home]).status).not.toBe(0);
  expect(run(directory, ['', plugin]).status).not.toBe(0);
  expect(run(directory, [home, '']).status).not.toBe(0);
});
