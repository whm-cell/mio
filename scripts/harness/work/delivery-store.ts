import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkedPath, digest, json } from './records.ts';
import { optionalText } from './report-format.ts';
import { loadPublicationExchange } from './publication-exchange.ts';
import type { ExchangeFiles } from './publication-exchange.ts';

const publicationDirectory = '.work/publication';

/** Serialize publication to a PRD, independently of the per-task lock. */
export async function withPublication<T>(root: string, records: string, action: () => Promise<T>) {
  const directory = await checkedPath(root, publicationDirectory);
  await mkdir(directory, { recursive: true });
  const path = await checkedPath(root, `${publicationDirectory}/${digest(records)}.lock`);
  let lock;
  try {
    lock = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(
      `WORK_PUBLISH_BUSY: inspect the active or interrupted publication lock ${path}`,
    );
  }
  try {
    await lock.writeFile(json({ pid: process.pid, records }));
    return await action();
  } finally {
    await lock.close();
    await rm(path, { force: true });
  }
}

interface PublicationFile {
  path: string;
  expected: string | null;
  content: string;
}

export async function publicationRecoveries(root: string, paths: readonly string[]) {
  const directory = await checkedPath(root, publicationDirectory);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const targets = new Map(paths.map((path) => [digest(path), path]));
  return names.flatMap((name) => {
    const match = /^([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{64})\.swap$/.exec(name);
    const path = match && targets.get(match[1]!);
    return path
      ? [
          {
            path,
            staged: join(directory, name),
            expected: match[2]!,
            replacement: match[3]!,
          },
        ]
      : [];
  });
}

async function regularFileDigest(path: string) {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  return stat?.isFile() ? digest(await readFile(path)) : null;
}

function publicationConflict(path: string, recovery?: string, cause?: unknown) {
  return new Error(
    `WORK_DELIVERY_CONFLICT: ${path}${recovery ? `\nReconcile the captured version at ${recovery}` : ''}`,
    { cause },
  );
}

async function restoreConflict(
  path: string,
  target: string,
  staged: string,
  replacement: string,
  exchange: ExchangeFiles,
) {
  let recovery: string | undefined = staged;
  try {
    exchange(staged, target);
    // A writer may also have saved before restoration. Keep that version if it is not ours.
    if ((await regularFileDigest(staged)) === replacement) {
      await rm(staged);
      recovery = undefined;
    }
  } catch (cause) {
    throw publicationConflict(path, staged, cause);
  }
  throw publicationConflict(path, recovery);
}

/** Resolve an interrupted exchange before a matching public result can prove a replay. */
export async function settlePublication(root: string, paths: readonly string[]) {
  for (const { path, staged, expected, replacement } of await publicationRecoveries(root, paths)) {
    const captured = await regularFileDigest(staged);
    if (captured === expected || captured === replacement) {
      await rm(staged);
      continue;
    }
    const target = await checkedPath(root, path);
    if ((await regularFileDigest(target)) !== replacement) throw publicationConflict(path, staged);
    await restoreConflict(path, target, staged, replacement, await loadPublicationExchange());
  }
}

async function prepareExchange(root: string, existing: PublicationFile[]) {
  if (existing.length === 0) return null;
  const exchange = await loadPublicationExchange();
  const directory = await checkedPath(root, publicationDirectory);
  const device = (await lstat(directory)).dev;
  for (const { path } of existing) {
    const target = await checkedPath(root, path);
    const stat = await lstat(target).catch((cause: unknown) => {
      throw publicationConflict(path, undefined, cause);
    });
    if (!stat.isFile()) throw publicationConflict(path);
    if (stat.dev !== device)
      throw new Error(
        `WORK_PUBLISH_ATOMIC: ${path} and its recovery directory must share a volume`,
      );
  }
  const probe = await mkdtemp(join(directory, 'exchange-'));
  try {
    const first = join(probe, 'first');
    const second = join(probe, 'second');
    await writeFile(first, '');
    await writeFile(second, '');
    exchange(first, second);
    return exchange;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

async function replacePublication(
  root: string,
  { path, expected, content }: PublicationFile,
  exchange: ExchangeFiles | null,
) {
  const target = await checkedPath(root, path);
  const current = await optionalText(root, path);
  if (current === content) return;
  if (current !== expected) throw publicationConflict(path);
  await mkdir(dirname(target), { recursive: true });
  const directory = await checkedPath(root, publicationDirectory);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const expectedDigest = expected !== null ? digest(expected) : null;
  const replacement = digest(content);
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    if (expectedDigest === null) {
      try {
        await link(temporary, target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        throw publicationConflict(path, undefined, cause);
      }
      return;
    }
    if (!exchange) throw new Error('WORK_PUBLISH_ATOMIC: file exchange was not prepared');
    const staged = join(directory, `${digest(path)}.${expectedDigest}.${replacement}.swap`);
    await link(temporary, staged);
    try {
      exchange(staged, target);
    } catch (error) {
      await rm(staged);
      throw error;
    }
    if ((await regularFileDigest(staged)) === expectedDigest) {
      await rm(staged);
      return;
    }
    await restoreConflict(path, target, staged, replacement, exchange);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function publishFiles(root: string, files: PublicationFile[]) {
  const exchange = await prepareExchange(
    root,
    files.filter(({ expected, content }) => expected !== null && expected !== content),
  );
  for (const file of files) await replacePublication(root, file, exchange);
}
