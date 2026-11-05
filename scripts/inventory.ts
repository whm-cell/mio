import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface HarnessConfig {
  sourceRoots: Record<string, 'production' | 'test' | 'development'>;
  documentRoots: string[];
  privateRoots: string[];
  generatedRoots: string[];
  configurationFiles: string[];
}

export const beneath = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

export async function loadConfig(root: string): Promise<HarnessConfig> {
  return JSON.parse(await readFile(join(root, 'harness.config.json'), 'utf8')) as HarnessConfig;
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
      if (/^\.env(?:\.|$)/.test(entry.name)) continue;
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
    if (sourceRoot && !file.endsWith('.ts')) {
      errors.push(`SOURCE_UNSUPPORTED ${file}: source roots currently support TypeScript only`);
    } else if (document && !file.endsWith('.md')) {
      errors.push(`DOCUMENT_UNCLASSIFIED ${file}: declare the asset's purpose`);
    } else if (!sourceRoot && !document && !configuration) {
      errors.push(`FILE_UNCLASSIFIED ${file}: declare its source/configuration/document role`);
    }
  }
  return { files, errors };
}
