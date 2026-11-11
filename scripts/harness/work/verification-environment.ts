import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, json } from './records.ts';
import { nonempty, object } from './verification-format.ts';
import type { Conditions, EnvironmentSnapshot } from './verification-format.ts';

export const runtimeEnvironment = () =>
  `${process.platform}/${process.arch}; Node ${process.version}`;
export function conditions(value: unknown): Conditions {
  const item = object(value);
  for (const key of ['dependencies', 'configuration', 'external']) nonempty(item[key]);
  return item as unknown as Conditions;
}
export function environmentSnapshot(value: unknown): EnvironmentSnapshot {
  const item = object(value);
  nonempty(item.runtime);
  if (typeof item.variables !== 'string' || !/^[a-f0-9]{64}$/.test(item.variables))
    throw new Error('WORK_VERIFY_ENVIRONMENT: environment digest required');
  const files = object(item.files);
  if (
    Object.values(files).some(
      (hash) => hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)),
    )
  )
    throw new Error('WORK_VERIFY_ENVIRONMENT: invalid environment file digest');
  if (item.conditions !== null) conditions(item.conditions);
  return item as unknown as EnvironmentSnapshot;
}
/** No secret values are persisted. Remote state needs explicit, observed conditions from the operator. */
export async function captureEnvironment(
  root: string,
  declared: Conditions | null = null,
): Promise<EnvironmentSnapshot> {
  const names = [
    'package.json',
    'pnpm-lock.yaml',
    'node_modules/.modules.yaml',
    'node_modules/.pnpm/lock.yaml',
    ...(await readdir(root)).filter((name) => name === '.env' || name.startsWith('.env.')),
  ];
  const files: Record<string, string | null> = {};
  for (const name of names.sort()) {
    try {
      files[name] = digest(await readFile(join(root, name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      files[name] = null;
    }
  }
  const variables = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => /^(MIO_|NODE_OPTIONS$|NODE_ENV$|TZ$|LANG$|CI$)/.test(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    runtime: runtimeEnvironment(),
    files,
    variables: digest(json(variables)),
    conditions: declared,
  };
}

/** Detect restored bytes in recorded environment files without treating build outputs as inputs. */
export async function environmentStamp(root: string, snapshot: EnvironmentSnapshot) {
  const stamps: Record<string, string> = {};
  for (const [name, hash] of Object.entries(snapshot.files)) {
    if (hash === null) continue;
    const stat = await lstat(join(root, name), { bigint: true });
    stamps[name] = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  }
  return digest(json(stamps));
}
