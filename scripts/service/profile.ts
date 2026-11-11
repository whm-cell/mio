import { access, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

/** Resolve the installed official launcher; this module never mounts an application tree itself. */
export function launcher(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
}

/** Prepare an isolated named profile. Existing manifests and manual patches are preserved. */
export async function prepareProfile(home: string, plugin: string): Promise<void> {
  const profile = join(home, 'profiles', 'mio');
  await access(join(plugin, 'dist/plugin.js'));
  await mkdir(join(profile, 'node_modules/@mio'), { recursive: true });
  const manifest = {
    name: 'mio-runtime-profile',
    private: true,
    dependencies: { '@mio/plugin': `file:${plugin}` },
    dsh: { profile: { bundles: ['@mio/plugin'] } },
  };
  const manifestPath = join(profile, 'package.json');
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest;
    if (
      existing.dsh?.profile?.bundles?.length !== 1 ||
      existing.dsh.profile.bundles[0] !== '@mio/plugin'
    ) {
      throw new Error('Existing mio profile has another composition; inspect it before continuing');
    }
  }
  const target = join(profile, 'node_modules/@mio/plugin');
  try {
    await symlink(plugin, target, 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await realpath(target)) !== (await realpath(plugin)))
      throw new Error('Existing plugin link points elsewhere; preserved');
  }
  try {
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export const localHome = (): string => resolve(process.env.DSH_HOME ?? '.runtime/dsh');
