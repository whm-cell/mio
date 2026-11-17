import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['prepare', 'execute'])(
  'rejects retired %s before creating a run or opening legacy infrastructure',
  (phase) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mio-a-live-entry-')));
    roots.push(root);
    const run = join(root, '.runtime', 'untouched');
    const child = spawnSync(
      process.execPath,
      [
        resolve('tests/compute/live-image-loop.ts'),
        phase,
        run,
        'missing-infrastructure',
        'missing-credentials',
        'live-task',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH, MIO_RUN_LIVE_IMAGE: 'yes' },
      },
    );
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('LIVE_LEGACY_PHASE_RETIRED');
    expect(existsSync(run)).toBe(false);
  },
);

it('does not start the A live chain without explicit opt-in', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mio-a-live-entry-')));
  roots.push(root);
  const run = join(root, '.runtime', 'untouched');
  const child = spawnSync(
    process.execPath,
    [resolve('tests/compute/live-image-loop.ts'), 'dev', run, 'missing-auth', 'live-task'],
    { cwd: root, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH } },
  );
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain('LIVE_OPT_IN');
  expect(existsSync(run)).toBe(false);
});
