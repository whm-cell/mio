import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, realpath: vi.fn(actual.realpath), readFile: vi.fn(actual.readFile) };
});
import { checkSource } from '../../scripts/harness/check-source.ts';
import { legacyBuild, legacyHarness, legacyTypecheck } from './fixtures/guardrail-fixture.ts';

it('walks package ownership once per target per invocation, keeps each policy check, and refreshes next invocation', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'mio-ownership-'));
  const target = join(root, 'node_modules/vendor/dist/index.d.ts');
  const manifest = join(root, 'node_modules/vendor/package.json');
  try {
    await fs.mkdir(join(root, 'src'), { recursive: true });
    await fs.mkdir(join(root, 'node_modules/vendor/dist'), { recursive: true });
    const config = legacyTypecheck();
    const paths = { 'runtime-alias': ['./node_modules/vendor/dist/index.d.ts'] };
    await fs.writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        ...config,
        compilerOptions: { ...config.compilerOptions, types: [], paths },
      }),
    );
    await fs.writeFile(join(root, 'tsconfig.build.json'), JSON.stringify(legacyBuild()));
    await fs.writeFile(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', name: '@example/app' }),
    );
    await fs.writeFile(target, 'export interface Context { id: string }');
    await fs.writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/cordis', type: 'module' }));
    for (const name of ['one', 'two'])
      await fs.writeFile(
        join(root, `src/${name}.ts`),
        "export type { Context } from 'runtime-alias';",
      );
    const files = ['src/one.ts', 'src/two.ts'];
    vi.mocked(fs.realpath).mockClear();
    vi.mocked(fs.readFile).mockClear();
    const first = await checkSource(root, files, legacyHarness());
    expect(first.errors.filter((error) => error.startsWith('DSH_BOUNDARY'))).toEqual([
      expect.stringContaining('src/one.ts'),
      expect.stringContaining('src/two.ts'),
    ]);
    expect(
      vi
        .mocked(fs.realpath)
        .mock.calls.filter(([file]) =>
          String(file).endsWith('/node_modules/vendor/dist/index.d.ts'),
        ),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(fs.readFile)
        .mock.calls.filter(([file]) => String(file).endsWith('/node_modules/vendor/package.json')),
    ).toHaveLength(1);
    await fs.writeFile(manifest, JSON.stringify({ name: '@example/ordinary', type: 'module' }));
    const second = await checkSource(root, files, legacyHarness());
    expect(second.errors).toEqual([]);
    expect(
      vi
        .mocked(fs.realpath)
        .mock.calls.filter(([file]) =>
          String(file).endsWith('/node_modules/vendor/dist/index.d.ts'),
        ),
    ).toHaveLength(2);
    expect(
      vi
        .mocked(fs.readFile)
        .mock.calls.filter(([file]) => String(file).endsWith('/node_modules/vendor/package.json')),
    ).toHaveLength(2);
    await fs.writeFile(manifest, '{invalid json');
    await expect(checkSource(root, files, legacyHarness())).rejects.toThrow(SyntaxError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
