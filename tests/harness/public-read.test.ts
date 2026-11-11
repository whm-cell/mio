import { taskIndex, taskIndexPath } from './fixtures/task-documents-fixture.ts';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { documentCatalog } from '../../scripts/harness/task-documents.ts';
import { outputBytes } from '../../scripts/harness/work/output.ts';
import { readPublicResult } from '../../scripts/harness/work/public-read.ts';
import { json } from '../../scripts/harness/work/records.ts';
import { bookPaths, readBook, renderBook } from '../../scripts/harness/work/reports.ts';

const project = resolve('.');
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-public-read-')));
  scratch.push(root);
  const catalog = await documentCatalog(project);
  const prd = catalog.documents.find((entry) => entry.kind === 'prd')!.identity;
  const book = structuredClone((await readBook(project, prd, catalog)).book);
  const paths = bookPaths(prd, catalog);
  book.results[0]!.verification = 'Synthetic pagination observation. '.repeat(200);
  const files: Record<string, string> = {
    'harness.config.json': json(catalog.config),
    'package.json': '{"type":"module"}\n',
    [paths.records]: json(book),
    [paths.report]: renderBook(book, paths.currentPath),
  };
  for (const entry of catalog.documents)
    for (const path of new Set([entry.path, ...(entry.aliases ?? [])]))
      files[path] = await readFile(join(project, path), 'utf8');
  files[taskIndexPath] = taskIndex;
  for (const registry of catalog.registries)
    files[registry] = await readFile(join(project, registry), 'utf8');
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  return { root, prd, book, paths };
}

it('reads and pages v5 facts without author records, and rejects retired evidence selectors', async () => {
  const { root, prd, book, paths } = await fixture();
  await expect(stat(join(root, '.work'))).rejects.toThrow();
  const listing = spawnSync(
    process.execPath,
    [join(project, 'scripts/harness/work/cli.ts'), 'read-result', prd],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  expect(listing.status, listing.stderr).toBe(0);
  expect(Buffer.byteLength(listing.stdout)).toBeLessThanOrEqual(outputBytes);
  expect(JSON.parse(listing.stdout).items.map((entry: { key: string }) => entry.key)).toEqual(
    book.results.map((result) => result.key),
  );
  const result = book.results[0]!;
  expect(
    await readPublicResult(root, [prd, result.key, '--select', '/result/acceptance']),
  ).toMatchObject({
    entries: expect.arrayContaining([{ key: 'candidate', value: result.acceptance.candidate }]),
  });
  expect(
    await readPublicResult(root, [paths.currentPath, result.key, '--select', '/result/acceptance']),
  ).toEqual(await readPublicResult(root, [prd, result.key, '--select', '/result/acceptance']));
  let args = [
    'read-result',
    prd,
    result.key,
    '--select',
    '/result/verification',
    '--limit',
    '2048',
  ];
  let recovered = '';
  let firstHash = '';
  for (;;) {
    const page = await readPublicResult(root, args.slice(1));
    expect(Buffer.byteLength(json(page))).toBeLessThanOrEqual(outputBytes);
    firstHash ||= page.page.sha256;
    if (!('text' in page) || typeof page.text !== 'string') throw new Error('Expected text page');
    recovered += page.text;
    if (!page.page.next) break;
    args = page.page.next.argv;
  }
  expect(recovered).toBe(result.verification);
  expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
  await expect(readPublicResult(root, [prd, result.key, '--hash', '0'.repeat(64)])).rejects.toThrow(
    'WORK_READ_STALE',
  );
  await expect(
    readPublicResult(root, [prd, result.key, '--select', '/artifacts/checks']),
  ).rejects.toThrow();
  await writeFile(join(root, paths.records), 'corrupted');
  await expect(readPublicResult(root, [prd, result.key])).rejects.toThrow();
  await expect(stat(join(root, '.work'))).rejects.toThrow();
});
