import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inventory } from '../../scripts/harness/inventory.ts';
import { legacyHarness } from './fixtures/guardrail-fixture.ts';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([
  ['README.md', true, null],
  ['README.md', false, 'SOURCE_UNSUPPORTED'],
  ['helper.py', true, 'SOURCE_UNSUPPORTED'],
  ['data.json', true, 'SOURCE_UNSUPPORTED'],
  ['helper.ts', true, 'DOCUMENT_UNCLASSIFIED'],
  ['helper.ts', false, null],
] as const)(
  'classifies source-root file %s with document declaration %s',
  async (name, declared, diagnostic) => {
    const root = await mkdtemp(join(tmpdir(), 'mio-inventory-documents-'));
    scratch.push(root);
    await mkdir(join(root, 'tests'));
    const file = `tests/${name}`;
    await writeFile(join(root, file), name.endsWith('.ts') ? 'export {};' : '# Test fixture');
    const config = legacyHarness();
    if (declared) config.documentRoots.push(file);
    const result = await inventory(root, config);
    expect(result.files).toEqual([file]);
    if (diagnostic) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(`${diagnostic} ${file}:`);
    } else {
      expect(result.errors).toEqual([]);
    }
  },
);

it('skips nested worktrees under the configured private root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-inventory-worktrees-'));
  scratch.push(root);
  await mkdir(join(root, '.claude', 'worktrees', 'agent', 'src'), { recursive: true });
  await writeFile(join(root, '.claude', 'worktrees', 'agent', 'src', 'private.ts'), 'export {};');

  const result = await inventory(root, legacyHarness());

  expect(result.files).toEqual([]);
  expect(result.errors).toEqual([]);
});
