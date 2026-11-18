import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { inventory } from '../../scripts/harness/inventory.ts';
import { legacyHarness } from '../harness/fixtures/guardrail-fixture.ts';

it('includes only the public root environment template and still rejects a template symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-env-inventory-'));
  try {
    await mkdir(join(root, 'tests'));
    for (const path of ['.env', '.env.test', '.env.example', 'tests/.env.example'])
      await writeFile(join(root, path), 'EXAMPLE=value\n');
    const config = legacyHarness();
    expect((await inventory(root, config)).errors).toEqual([
      'FILE_UNCLASSIFIED .env.example: declare its source/configuration/document role',
    ]);
    config.configurationFiles.push('.env.example');
    expect(await inventory(root, config)).toEqual({ files: ['.env.example'], errors: [] });
    await rm(join(root, '.env.example'));
    await symlink(join(root, '.env'), join(root, '.env.example'));
    expect((await inventory(root, config)).errors).toContain(
      'INVENTORY_SYMLINK .env.example: classify a real file',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('exempts only the root environment template from Git ignores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-env-ignore-'));
  try {
    await copyFile(resolve(import.meta.dirname, '../../.gitignore'), join(root, '.gitignore'));
    const gitOptions = {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    } as const;
    expect(spawnSync('git', ['init', '-q', '--template='], gitOptions).status).toBe(0);
    const privatePaths = [
      '.env',
      '.env.test',
      '.env.example.local',
      'tests/.env',
      'tests/.env.test',
      'tests/.env.example',
    ];
    const result = spawnSync(
      'git',
      ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'],
      { ...gitOptions, input: ['.env.example', ...privatePaths].join('\n') + '\n' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(privatePaths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
