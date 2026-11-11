import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { inventory } from '../scripts/harness/inventory.ts';
import { legacyHarness } from './guardrail-fixture.ts';

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
