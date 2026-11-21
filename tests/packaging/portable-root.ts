import { readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function portableRoot(argument: string | undefined): string {
  if (!argument) throw new Error('PORTABLE_ARTIFACT_ROOT_REQUIRED');
  const root = realpathSync(argument);
  const workspace = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  if (root === workspace || root.startsWith(`${workspace}${sep}`))
    throw new Error('PORTABLE_ROOT_MUST_BE_OUTSIDE_WORKSPACE');
  return root;
}

export function portableComponent(root: string, name: 'a' | 'b' | 'host'): string {
  const component = realpathSync(join(root, name));
  if (!component.startsWith(`${root}${sep}`)) throw new Error(`ARTIFACT_EXTERNAL_LINK: ${name}`);

  const pending = [component];
  let links = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        if (target !== component && !target.startsWith(`${component}${sep}`))
          throw new Error(`ARTIFACT_EXTERNAL_LINK: ${path}`);
        links++;
      }
    }
  }
  console.log(`PORTABLE_ARTIFACT_LINKS_OK ${name} count=${links}`);
  return component;
}
