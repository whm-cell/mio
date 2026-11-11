import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { launcher, localHome } from './profile.ts';

await access(join(localHome(), 'profiles/mio/package.json'));
const child = spawn(process.execPath, [launcher(), '--profile', 'mio'], {
  // DSH also reads cwd/.env: keep the selected runtime away from the repository's dev file.
  cwd: localHome(),
  stdio: 'inherit',
  env: { ...process.env, DSH_HOME: localHome(), DSH_TELEMETRY_DISABLED: '1' },
});
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
