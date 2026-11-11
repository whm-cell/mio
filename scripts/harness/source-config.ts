import { isAbsolute } from 'node:path';
import ts from 'typescript';

export type SourceRole = 'production' | 'test' | 'development';
export interface SourceProject {
  kind: 'service' | 'contract';
  packageRoot: string;
  sources: string[];
  typecheck: string;
  build: string;
  publicEntries?: { source: string; export: string }[];
  capabilities?: Partial<Record<'fs' | 'child_process' | 'sqlite', string[]>>;
  packageAdapters?: Partial<Record<'cos-nodejs-sdk-v5' | 'amqplib', string[]>>;
}

export interface HarnessConfig {
  sourceRoots: Record<string, SourceRole>;
  developmentDependencies: Record<string, string[]>;
  documentRoots: string[];
  privateRoots: string[];
  generatedRoots: string[];
  configurationFiles: string[];
  projects?: Record<string, SourceProject>;
}

export const beneath = (path: string, root: string): boolean =>
  root === '.' || path === root || path.startsWith(`${root}/`);

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validPath(path: unknown, root = false): path is string {
  return (
    typeof path === 'string' &&
    ((root && path === '.') ||
      (!!path &&
        !isAbsolute(path) &&
        !path.includes('\\') &&
        !path.includes('\0') &&
        !/^[A-Za-z]:/.test(path) &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')))
  );
}

function duplicateKeys(text: string): string[] {
  const duplicates: string[] = [];
  const source = ts.parseJsonText('harness.config.json', text);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set<string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue;
        const key = property.name.text;
        if (seen.has(key)) duplicates.push(`HARNESS_DUPLICATE_KEY ${key}`);
        seen.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return duplicates;
}

function paths(value: unknown, label: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.some((entry: unknown) => !validPath(entry))) {
    errors.push(`HARNESS_PATHS ${label}: expected relative paths without traversal`);
    return [];
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) errors.push(`HARNESS_DUPLICATE_PATH ${label}`);
  return result;
}

function overlaps(left: string, right: string): boolean {
  return beneath(left, right) || beneath(right, left);
}

function validateProjects(
  config: Record<string, unknown>,
  roots: Record<string, unknown>,
  errors: string[],
) {
  const production = Object.entries(roots)
    .filter(([, role]) => role === 'production')
    .map(([root]) => root);
  if (config.projects === undefined) {
    if (production.length !== 1 || production[0] !== 'src')
      errors.push('PROJECTS_REQUIRED: legacy mode supports only the src production root');
    return;
  }
  if (!object(config.projects) || Object.keys(config.projects).length === 0) {
    errors.push('PROJECTS_INVALID: declare one or more named projects');
    return;
  }
  const assigned = new Map<string, string>();
  const packageRoots = new Map<string, string>();
  const configurations = new Map<string, string>();
  const projects: { id: string; root: string; sources: string[] }[] = [];
  for (const [id, value] of Object.entries(config.projects)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || !object(value)) {
      errors.push(`PROJECT_INVALID ${id}: invalid project name or object`);
      continue;
    }
    const fields = [
      'kind',
      'packageRoot',
      'sources',
      'typecheck',
      'build',
      'publicEntries',
      'capabilities',
      'packageAdapters',
    ];
    for (const key of Object.keys(value))
      if (!fields.includes(key)) errors.push(`PROJECT_FIELD ${id}: unknown ${key}`);
    if (value.kind !== 'service' && value.kind !== 'contract')
      errors.push(`PROJECT_KIND ${id}: choose service or contract`);
    if (!validPath(value.packageRoot, true)) {
      errors.push(`PROJECT_PACKAGE_ROOT ${id}: invalid packageRoot`);
      continue;
    }
    const root = value.packageRoot;
    if (packageRoots.has(root)) errors.push(`PROJECT_PACKAGE_ROOT ${id}: duplicate ${root}`);
    packageRoots.set(root, id);
    const sources = paths(value.sources, `${id}.sources`, errors);
    if (!sources.length) errors.push(`PROJECT_SOURCES ${id}: declare production roots`);
    for (const source of sources) {
      if (roots[source] !== 'production' || !beneath(source, root))
        errors.push(
          `PROJECT_SOURCE ${id}: ${source} must be its production root beneath packageRoot`,
        );
      if (assigned.has(source)) errors.push(`PROJECT_SOURCE_DUPLICATE ${source}: ${id}`);
      assigned.set(source, id);
    }
    projects.push({ id, root, sources });
    for (const key of ['typecheck', 'build'] as const) {
      const target = value[key];
      if (!validPath(target) || !target.endsWith('.json') || !beneath(target, root)) {
        errors.push(`PROJECT_TSCONFIG ${id}: invalid ${key} configuration`);
        continue;
      }
      if (configurations.has(target))
        errors.push(`PROJECT_TSCONFIG ${id}: ${target} is already assigned`);
      configurations.set(target, `${id}.${key}`);
    }
    if (value.kind === 'contract') {
      if (!Array.isArray(value.publicEntries) || !value.publicEntries.length)
        errors.push(`PROJECT_EXPORTS ${id}: contract requires publicEntries`);
      else {
        const exports = new Set<string>();
        for (const entry of value.publicEntries as unknown[]) {
          if (
            !object(entry) ||
            Object.keys(entry).some((key) => key !== 'source' && key !== 'export') ||
            !validPath(entry.source) ||
            !entry.source.endsWith('.ts') ||
            !sources.some((base) => beneath(entry.source as string, base)) ||
            typeof entry.export !== 'string' ||
            !(
              entry.export === '.' ||
              (entry.export.startsWith('./') && validPath(entry.export.slice(2)))
            ) ||
            entry.export.includes('*')
          ) {
            errors.push(`PROJECT_EXPORTS ${id}: invalid source/export mapping`);
            continue;
          }
          if (exports.has(entry.export))
            errors.push(`PROJECT_EXPORTS ${id}: duplicate ${entry.export}`);
          exports.add(entry.export);
        }
      }
    } else if (value.publicEntries !== undefined)
      errors.push(`PROJECT_EXPORTS ${id}: service cannot declare publicEntries`);
    for (const [field, supported] of [
      ['capabilities', ['fs', 'child_process', 'sqlite']],
      ['packageAdapters', ['cos-nodejs-sdk-v5', 'amqplib']],
    ] as const) {
      const rules = value[field];
      if (rules === undefined) continue;
      if (
        !object(rules) ||
        value.kind !== 'service' ||
        (field === 'capabilities' && root === '.')
      ) {
        errors.push(`PROJECT_ADAPTERS ${id}: ${field} has an invalid owner`);
        continue;
      }
      for (const [name, entries] of Object.entries(rules)) {
        if (!(supported as readonly string[]).includes(name))
          errors.push(`PROJECT_ADAPTERS ${id}: unsupported ${name}`);
        if (field === 'packageAdapters' && root === '.' && name === 'cos-nodejs-sdk-v5')
          errors.push(
            `PROJECT_ADAPTERS ${id}: root COS access remains fixed to its reviewed adapter`,
          );
        const targets = paths(entries, `${id}.${field}.${name}`, errors);
        if (!targets.length) errors.push(`PROJECT_ADAPTERS ${id}: ${name} requires exact files`);
        for (const target of targets)
          if (!target.endsWith('.ts') || !sources.some((base) => beneath(target, base)))
            errors.push(`PROJECT_ADAPTERS ${id}: ${target} must be an exact source file`);
      }
    }
  }
  for (const source of production)
    if (!assigned.has(source)) errors.push(`PROJECT_SOURCE_UNASSIGNED ${source}`);
  if (
    roots.src !== 'production' ||
    !packageRoots.has('.') ||
    assigned.get('src') !== packageRoots.get('.')
  )
    errors.push('PROJECT_ROOT_SOURCE: src must belong to the root service');
  for (const project of projects) {
    for (const source of project.sources) {
      const nearest = projects
        .filter((candidate) => beneath(source, candidate.root))
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (nearest && nearest.id !== project.id)
        errors.push(`PROJECT_SOURCE_OWNER ${source}: belongs to ${nearest.id}, not ${project.id}`);
    }
  }
}

export function parseHarnessConfig(text: string): HarnessConfig {
  const data: unknown = JSON.parse(text);
  if (!object(data)) throw new Error('HARNESS_CONFIG: expected an object');
  const errors = duplicateKeys(text);
  for (const key of Object.keys(data))
    if (
      ![
        'sourceRoots',
        'developmentDependencies',
        'documentRoots',
        'privateRoots',
        'generatedRoots',
        'configurationFiles',
        'projects',
      ].includes(key)
    )
      errors.push(`HARNESS_FIELD: unknown ${key}`);
  const roots = object(data.sourceRoots) ? data.sourceRoots : {};
  if (!object(data.sourceRoots) || !Object.keys(roots).length)
    errors.push('SOURCE_ROOTS: declare source roots');
  for (const [root, role] of Object.entries(roots)) {
    if (!validPath(root)) errors.push(`SOURCE_ROOT_INVALID ${root}`);
    if (role !== 'production' && role !== 'test' && role !== 'development')
      errors.push(`SOURCE_ROLE_INVALID ${root}: ${String(role)}`);
  }
  const names = Object.keys(roots);
  for (let i = 0; i < names.length; i++)
    for (const other of names.slice(i + 1))
      if (overlaps(names[i]!, other)) errors.push(`SOURCE_ROOT_OVERLAP ${names[i]}: ${other}`);
  if (data.developmentDependencies !== undefined && !object(data.developmentDependencies))
    errors.push('DEVELOPMENT_RULE_INVALID: expected an object');
  if (object(data.developmentDependencies))
    for (const [root, allowed] of Object.entries(data.developmentDependencies)) {
      if (roots[root] !== 'development')
        errors.push(`DEVELOPMENT_RULE_INVALID ${root}: not a development root`);
      paths(allowed, `developmentDependencies.${root}`, errors);
    }
  const documents = paths(data.documentRoots, 'documentRoots', errors);
  const privateRoots = paths(data.privateRoots, 'privateRoots', errors);
  const generated = paths(data.generatedRoots, 'generatedRoots', errors);
  const configuration = paths(data.configurationFiles, 'configurationFiles', errors);
  const excluded = [...privateRoots, ...generated];
  for (let i = 0; i < excluded.length; i++)
    for (const other of excluded.slice(i + 1))
      if (overlaps(excluded[i]!, other)) errors.push(`EXCLUSION_OVERLAP ${excluded[i]}: ${other}`);
  for (const path of privateRoots)
    if (!path.split('/').at(-1)!.startsWith('.'))
      errors.push(`EXCLUSION_PRIVATE ${path}: use a hidden private directory`);
  for (const root of names)
    for (const path of excluded)
      if (overlaps(root, path)) errors.push(`EXCLUSION_SOURCE_OVERLAP ${path}: ${root}`);
  for (const path of configuration) {
    if (names.some((root) => beneath(path, root)) || excluded.some((root) => beneath(path, root)))
      errors.push(`CONFIGURATION_OVERLAP ${path}`);
    if (/\.(?:py|rs)$/.test(path)) errors.push(`CONFIGURATION_SOURCE_UNSUPPORTED ${path}`);
  }
  for (const document of documents)
    for (const path of excluded)
      if (overlaps(document, path)) errors.push(`EXCLUSION_DOCUMENT_OVERLAP ${path}: ${document}`);
  validateProjects(data, roots, errors);
  if (errors.length) throw new Error(errors.join('\n'));
  return data as unknown as HarnessConfig;
}
