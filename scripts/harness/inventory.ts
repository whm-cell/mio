import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordsFile } from './work/compact-store.ts';
import { beneath, parseHarnessConfig } from './source-config.ts';
import type { HarnessConfig } from './source-config.ts';

export { beneath } from './source-config.ts';
export type { HarnessConfig } from './source-config.ts';

export interface TaskDocument {
  identity: string;
  kind: 'prd' | 'design' | 'proposal' | 'change';
  path: string;
  aliases?: string[];
}

const taskRegistryFile = (path: string) =>
  /^docs\/tasks\/[a-z0-9][a-z0-9_-]*\/documents\.json$/.test(path);

export async function loadConfig(root: string): Promise<HarnessConfig> {
  return parseHarnessConfig(await readFile(join(root, 'harness.config.json'), 'utf8'));
}

/** Inspect every file before classifying extensions; never follow directory symlinks. */
export async function inventory(root: string, config: HarnessConfig) {
  const files: string[] = [];
  const errors: string[] = [];
  const excluded = [...config.generatedRoots, ...config.privateRoots];
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (excluded.some((base) => beneath(path, base))) continue;
      if (entry.name === '.DS_Store' || entry.name.endsWith('.tgz')) continue;
      if (/^\.env(?:\.|$)/.test(entry.name) && path !== '.env.example') continue;
      if (entry.isSymbolicLink()) errors.push(`INVENTORY_SYMLINK ${path}: classify a real file`);
      else if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else errors.push(`INVENTORY_UNSUPPORTED ${path}`);
    }
  };
  await visit('');
  for (const file of files) {
    const sourceRoot = Object.keys(config.sourceRoots).find((base) => beneath(file, base));
    const document = config.documentRoots.some((base) => beneath(file, base));
    const configuration =
      config.configurationFiles.includes(file) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file);
    if (sourceRoot && !file.endsWith('.ts') && !(document && file.endsWith('.md'))) {
      errors.push(
        `SOURCE_UNSUPPORTED ${file}: source roots support TypeScript and explicitly declared Markdown only`,
      );
    } else if (document && !file.endsWith('.md') && !recordsFile(file) && !taskRegistryFile(file)) {
      errors.push(`DOCUMENT_UNCLASSIFIED ${file}: declare the asset's purpose`);
    } else if (!sourceRoot && !document && !configuration) {
      errors.push(`FILE_UNCLASSIFIED ${file}: declare its source/configuration/document role`);
    }
  }
  return { files, errors };
}
