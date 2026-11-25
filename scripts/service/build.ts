import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Removed production modules must not survive in the next package as stale build output.
await rm('dist', { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
if (result.status === 0) {
  const migrations = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve('typescript/bin/tsc')),
      '-p',
      'tsconfig.portable-tools.json',
    ],
    { stdio: 'inherit' },
  );
  process.exitCode = migrations.status ?? 1;
}
