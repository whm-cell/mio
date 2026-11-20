import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { unpackPluginPackage } from '../support/auth-runtime.ts';

let directory: string;
let archive: string;
let database: Awaited<ReturnType<typeof authDatabase>>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mio-smoke-test-'));
  await unpackPluginPackage(directory);
  archive =
    process.env.MIO_TEST_PACKED_ARCHIVE?.trim() ||
    join(
      directory,
      (await readdir(directory)).find((name) => name.endsWith('.tgz'))!,
    );
  database = await authDatabase();
  const migrate = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
    env: {
      PATH: process.env.PATH,
      MIO_AUTH_DATABASE_URL: database.url,
      MIO_AUTH_BASE_URL: 'http://127.0.0.1:4310',
      MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(migrate.status, migrate.stderr).toBe(0);
}, 45000);
afterAll(async () => {
  await database?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it.each([
  ['/readyz', 'SIGTERM'],
  ['/api/v1/capabilities', 'SIGINT'],
  ['/api/auth/sign-up/email', 'SIGTERM'],
  ['/api/v1/capabilities', null],
] as const)(
  'reaps official DSH and releases its port when %s is interrupted by %s',
  async (stage, signal) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        resolve('tests/foundation/smoke-cancellation-preload.ts'),
        'scripts/service/smoke.ts',
        '--archive',
        archive,
      ],
      {
        env: {
          ...process.env,
          MIO_SMOKE_PROBE_STAGE: stage,
          ...database.smokeEnvironment,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    const finished = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let pid: number | undefined;
    try {
      await vi.waitFor(() => expect(output).toContain('SMOKE_FETCH_PENDING'), { timeout: 10000 });
      const port = Number(new URL(output.match(/SMOKE_FETCH_PENDING (\S+)/)![1]!).port);
      const processes = spawnSync('ps', ['-axo', 'pid=,ppid='], {
        encoding: 'utf8',
      });
      expect(processes.status, processes.stderr).toBe(0);
      const children = processes.stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([, parent]) => parent === child.pid)
        .map(([pid]) => pid!);
      expect(children).toHaveLength(1);
      pid = children[0]!;
      expect(() => process.kill(pid!, 0)).not.toThrow();
      const interruptedAt = performance.now();
      if (signal) child.kill(signal);
      await vi.waitFor(() => expect(child.exitCode ?? child.signalCode).not.toBeNull(), {
        timeout: 8000,
      });
      await finished;
      expect(child.exitCode).not.toBe(0);
      expect(() => process.kill(pid!, 0)).toThrow();
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      console.log(
        JSON.stringify({
          stage,
          cancellation: signal ?? 'request timeout',
          smokePid: child.pid,
          dshPid: pid,
          port,
          elapsedMs: Math.round(performance.now() - interruptedAt),
          exitCode: child.exitCode,
          descendantReaped: true,
          portRebound: true,
        }),
      );
    } finally {
      // The test owns this execution group, including descendants if an assertion exposed a leak.
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await finished;
    }
  },
  20000,
);

it.each(['missing', 'corrupt'])(
  'fails closed on an explicit %s archive without rebuilding or launching DSH',
  async (kind) => {
    const invalid = join(directory, `${kind}.tgz`);
    if (kind === 'corrupt') await writeFile(invalid, 'corrupt archive');
    const result = spawnSync(process.execPath, ['scripts/service/smoke.ts', '--archive', invalid], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tar:');
    expect(result.stdout).not.toContain('PASS:');
    const extraction = await mkdtemp(join(directory, 'invalid-extraction-'));
    vi.stubEnv('MIO_TEST_PACKED_ARCHIVE', invalid);
    try {
      await expect(unpackPluginPackage(extraction)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(extraction, { recursive: true, force: true });
    }
  },
);
