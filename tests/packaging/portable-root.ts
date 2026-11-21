import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = realpathSync.native(fileURLToPath(new URL('../../', import.meta.url)));
const workspaceStat = lstatSync(workspace);

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function portableRoot(argument: string | undefined): string {
  if (!argument) throw new Error('PORTABLE_ARTIFACT_ROOT_REQUIRED');
  const root = realpathSync.native(argument);
  if (within(workspace, root)) throw new Error('PORTABLE_ROOT_MUST_BE_OUTSIDE_WORKSPACE');
  return root;
}

/** Final containment alone misses a link chain that leaves the package and returns. */
function resolvePortablePath(root: string, path: string): string {
  // Native resolution also rejects missing targets and link loops.
  const resolved = realpathSync.native(path);
  if (!within(root, resolved) || within(workspace, resolved))
    throw new Error(`ARTIFACT_EXTERNAL_LINK: ${path}`);

  let directory = dirname(path);
  const pending = [basename(path)];
  while (pending.length) {
    const part = pending.pop()!;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (directory === root) throw new Error(`ARTIFACT_EXTERNAL_LINK: ${path}`);
      directory = dirname(directory);
      continue;
    }

    const entry = join(directory, part);
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(entry);
      if (isAbsolute(target)) throw new Error(`ARTIFACT_EXTERNAL_LINK: absolute link ${entry}`);
      pending.push(...target.split(sep).reverse());
    } else {
      if (stat.dev === workspaceStat.dev && stat.ino === workspaceStat.ino)
        throw new Error(`ARTIFACT_EXTERNAL_LINK: ${entry}`);
      directory = entry;
    }
  }
  return resolved;
}

export function portableComponent(root: string, name: 'a' | 'b' | 'host'): string {
  const component = resolvePortablePath(root, join(root, name));
  if (component === root) throw new Error(`ARTIFACT_EXTERNAL_LINK: ${name}`);

  const pending = [component];
  let links = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (path === workspace) throw new Error(`ARTIFACT_EXTERNAL_LINK: ${path}`);
        pending.push(path);
      } else if (entry.isSymbolicLink()) {
        resolvePortablePath(component, path);
        links++;
      }
    }
  }
  console.log(`PORTABLE_ARTIFACT_LINKS_OK ${name} count=${links}`);
  return component;
}
