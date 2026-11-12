import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const selector = resolve('scripts/harness/ci-scope.ts');
let directory: string;
let base: string;
const ref = 'refs/heads/topic';

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

function write(path: string, text = 'fixture\n') {
  const target = join(directory, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function commit() {
  git('add', '.');
  git('commit', '-qm', 'fixture');
  return git('rev-parse', 'HEAD');
}

function select(overrides: Record<string, unknown> = {}, environment: NodeJS.ProcessEnv = {}) {
  const sha = git('rev-parse', 'HEAD');
  const event = join(directory, '.git/event.json');
  const output = join(directory, '.git/output');
  writeFileSync(
    event,
    JSON.stringify({
      before: base,
      after: sha,
      ref,
      repository: { default_branch: 'main' },
      ...overrides,
    }),
  );
  writeFileSync(output, '');
  const result = spawnSync(process.execPath, [selector], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
      GITHUB_REF: ref,
      GITHUB_SHA: sha,
      ...environment,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const selection = JSON.parse(result.stdout) as { mode: string; base?: string; head?: string };
  expect(readFileSync(output, 'utf8')).toBe(`mode=${selection.mode}\n`);
  return selection;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mio-ci-scope-'));
  git('init', '-q', '-b', 'topic');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  write('README.md');
  base = commit();
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('selects all reviewed harness paths and their coordination documents', () => {
  for (const path of [
    'scripts/harness/work/reader.ts',
    'tests/harness/reader.test.ts',
    'docs/coordination.md',
    'docs/work-records.md',
    'docs/engineering/testing.md',
  ])
    write(path);
  const head = commit();
  expect(select()).toMatchObject({ mode: 'harness', base, head });
});

it.each([
  'src/plugin.ts',
  'compute/src/worker.ts',
  'packages/foundation/src/time.ts',
  'contracts/compute/src/index.ts',
  'scripts/service/local.ts',
  'tests/providers-setup.ts',
  'tests/environment/local-environment.test.ts',
  'tests/support/fixture.ts',
  'package.json',
  'pnpm-lock.yaml',
  'harness.config.json',
  'vitest.config.ts',
  '.github/workflows/check.yml',
  'scripts/harness/ci-scope.ts',
  'scripts/harness/validation-entry.ts',
  'docs/api.md',
  'unclassified.ts',
  'scripts/harness/package.json',
  'scripts/harness/eslint.config.ts',
  'tests/harness/vitest.config.ts',
])('keeps full checks when a harness change is mixed with %s', (path) => {
  write('scripts/harness/reader.ts');
  write(path);
  commit();
  expect(select().mode).toBe('full');
});

it('keeps both sides of a rename across the boundary, including unusual filenames', () => {
  write('src/space tab\tquote".ts');
  base = commit();
  mkdirSync(join(directory, 'scripts/harness'), { recursive: true });
  git('mv', 'src/space tab\tquote".ts', 'scripts/harness/reader.ts');
  commit();
  expect(select().mode).toBe('full');
});

it('allows deletion and rename within the harness boundary', () => {
  write('scripts/harness/deleted.ts');
  write('tests/harness/old.test.ts');
  base = commit();
  git('rm', '-q', 'scripts/harness/deleted.ts');
  git('mv', 'tests/harness/old.test.ts', 'tests/harness/new.test.ts');
  commit();
  expect(select().mode).toBe('harness');
});

it('keeps full checks for an empty difference', () => {
  expect(select().mode).toBe('full');
});

it.each(['0'.repeat(40), '1'.repeat(40), '--bad-revision', undefined])(
  'falls back to full without a usable comparison commit: %s',
  (before) => {
    write('scripts/harness/reader.ts');
    commit();
    expect(select({ before }).mode).toBe('full');
  },
);

it('keeps main, default branches, manual, tag and forced pushes on full checks', () => {
  write('scripts/harness/reader.ts');
  commit();
  expect(select({ ref: 'refs/heads/main' }, { GITHUB_REF: 'refs/heads/main' }).mode).toBe('full');
  expect(select({ repository: { default_branch: 'topic' } }).mode).toBe('full');
  expect(select({}, { GITHUB_EVENT_NAME: 'workflow_dispatch' }).mode).toBe('full');
  expect(select({ ref: 'refs/tags/v1' }, { GITHUB_REF: 'refs/tags/v1' }).mode).toBe('full');
  expect(select({ forced: true }).mode).toBe('full');
});

it('falls back when the event, checkout or PR merge candidate cannot be established', () => {
  write('scripts/harness/reader.ts');
  commit();
  expect(select({}, { GITHUB_SHA: base }).mode).toBe('full');
  expect(select({ after: base }).mode).toBe('full');
  expect(select({ ref: 'refs/heads/another' }).mode).toBe('full');
  expect(select({}, { GITHUB_EVENT_PATH: join(directory, 'missing.json') }).mode).toBe('full');
  expect(
    select({}, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' }).mode,
  ).toBe('full');
});

it.each([
  ['scripts/harness/reader.ts', 'harness'],
  ['src/plugin.ts', 'full'],
])('compares a real PR merge against its current target for %s', (path, mode) => {
  write(path);
  write('tests/harness/reader.test.ts');
  const head = commit();
  git('checkout', '-qb', 'main', base);
  write('src/target-advance.ts');
  const target = commit();
  git('merge', '--no-ff', '-qm', 'PR merge', 'topic');
  const merged = git('rev-parse', 'HEAD');
  const event = { pull_request: { base: { sha: target }, head: { sha: head } } };
  const environment = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' };
  expect(select(event, environment)).toMatchObject({ mode, base: target, head: merged });
  // Neither an older target nor a later PR head describes this immutable merge candidate.
  expect(
    select({ pull_request: { base: { sha: base }, head: { sha: head } } }, environment).mode,
  ).toBe('full');
  expect(
    select({ pull_request: { base: { sha: target }, head: { sha: merged } } }, environment).mode,
  ).toBe('full');
});
