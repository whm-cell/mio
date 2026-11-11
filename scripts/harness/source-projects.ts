import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { beneath } from './source-config.ts';
import type { HarnessConfig, SourceProject } from './source-config.ts';

export interface CheckedProject {
  id: string;
  declaration: SourceProject;
  packageName: string;
  packagePath: string;
  typecheck: ts.ParsedCommandLine;
  build: ts.ParsedCommandLine;
  output: string;
  publicTargets: Set<string>;
}

function projectPath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

function configFile(root: string, file: string): ts.ParsedCommandLine {
  const path = resolve(root, file);
  const config = ts.readConfigFile(path, ts.sys.readFile);
  if (config.error)
    throw new Error(
      `PROJECT_TSCONFIG ${file}: ${ts.flattenDiagnosticMessageText(config.error.messageText, '\n')}`,
    );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(path),
    undefined,
    path,
  );
  if (parsed.errors.length)
    throw new Error(
      `PROJECT_TSCONFIG ${file}: ${parsed.errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('; ')}`,
    );
  return parsed;
}

function exportTargets(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (value === null) return [];
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value).some((key) => !['types', 'node', 'import', 'default'].includes(key)))
      return undefined;
    const values = Object.values(value).map(exportTargets);
    return values.some((item) => item === undefined) ? undefined : values.flatMap((item) => item!);
  }
  return undefined;
}

function selectedExport(
  value: unknown,
  conditions: ReadonlySet<string>,
): string | null | undefined {
  if (typeof value === 'string' || value === null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const [condition, target] of Object.entries(value)) {
    if (condition !== 'default' && !conditions.has(condition)) continue;
    const selected = selectedExport(target, conditions);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function exportEntry(value: unknown, subpath: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return subpath === '.' ? value : undefined;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).some((key) => key.startsWith('.'))
    ? fields[subpath]
    : subpath === '.'
      ? value
      : undefined;
}

/** Parse each project's own TS configs and check the declared package exports against its emit. */
export async function inspectProjects(
  root: string,
  files: readonly string[],
  harness: HarnessConfig,
) {
  const errors: string[] = [];
  const cache = new Map<string, ts.ParsedCommandLine>();
  const config = (path: string) => {
    let parsed = cache.get(path);
    if (!parsed) {
      parsed = configFile(root, path);
      cache.set(path, parsed);
    }
    return parsed;
  };
  const rootTypecheck = config('tsconfig.json');
  const rootBuild = config('tsconfig.build.json');
  if (!harness.projects && (rootBuild.options.noEmit || rootBuild.options.emitDeclarationOnly))
    errors.push('PROJECT_BUILD_EMIT root: build must emit executable TypeScript output');
  const projects: CheckedProject[] = [];
  const names = new Set<string>();
  for (const [id, declaration] of Object.entries(harness.projects ?? {})) {
    const typecheck = config(declaration.typecheck);
    const build = config(declaration.build);
    if (build.options.noEmit || build.options.emitDeclarationOnly)
      errors.push(`PROJECT_BUILD_EMIT ${id}: build must emit executable TypeScript output`);
    const output = build.options.outDir ? projectPath(root, resolve(build.options.outDir)) : '';
    if (
      !output ||
      output.startsWith('../') ||
      isAbsolute(output) ||
      !beneath(output, declaration.packageRoot)
    )
      errors.push(`PROJECT_BUILD_OUTDIR ${id}: output must be inside its packageRoot`);
    else if (!harness.generatedRoots.includes(output))
      errors.push(`PROJECT_BUILD_OUTDIR ${id}: ${output} must be declared as generated`);
    let manifest: { name?: unknown; exports?: unknown };
    try {
      manifest = JSON.parse(
        await readFile(join(root, declaration.packageRoot, 'package.json'), 'utf8'),
      ) as typeof manifest;
    } catch (error) {
      throw new Error(`PROJECT_PACKAGE ${id}: cannot read package.json`, { cause: error });
    }
    if (typeof manifest.name !== 'string' || !manifest.name.trim())
      throw new Error(`PROJECT_PACKAGE ${id}: package.json requires a name`);
    if (names.has(manifest.name))
      errors.push(`PROJECT_PACKAGE ${id}: duplicate name ${manifest.name}`);
    names.add(manifest.name);
    const packagePath = await realpath(join(root, declaration.packageRoot));
    const publicTargets = new Set<string>();
    for (const entry of declaration.publicEntries ?? []) {
      const absoluteSource = resolve(root, entry.source);
      if (!files.includes(entry.source))
        errors.push(`PROJECT_EXPORT_SOURCE ${id}: missing ${entry.source}`);
      if (!build.fileNames.map((file) => resolve(file)).includes(absoluteSource)) {
        errors.push(`PROJECT_EXPORT_BUILD ${id}: ${entry.source} is not a build input`);
        continue;
      }
      const emitted = ts
        .getOutputFileNames(build, absoluteSource, false)
        .map((file) => projectPath(root, resolve(file)));
      const mapping = exportEntry(manifest.exports, entry.export);
      const targets = exportTargets(mapping);
      if (!targets?.length) {
        errors.push(
          `PROJECT_EXPORTS ${id}: ${entry.export} is absent or uses unsupported conditions or arrays`,
        );
        continue;
      }
      publicTargets.add(entry.source);
      const runtime = selectedExport(mapping, new Set(['node', 'import']));
      const types = selectedExport(mapping, new Set(['types', 'node', 'import']));
      const runtimePath =
        typeof runtime === 'string'
          ? projectPath(root, resolve(root, declaration.packageRoot, runtime))
          : '';
      const typesPath =
        typeof types === 'string'
          ? projectPath(root, resolve(root, declaration.packageRoot, types))
          : '';
      if (!runtimePath.endsWith('.js') || !emitted.includes(runtimePath))
        errors.push(`PROJECT_EXPORT_RUNTIME ${id}: ${entry.export} must select emitted JavaScript`);
      if (!typesPath.endsWith('.d.ts') || !emitted.includes(typesPath))
        errors.push(`PROJECT_EXPORT_TYPES ${id}: ${entry.export} must select emitted declarations`);
      for (const target of targets) {
        if (
          !target.startsWith('./') ||
          target.includes('*') ||
          target.split('/').some((part) => part === '..')
        ) {
          errors.push(`PROJECT_EXPORTS ${id}: unsupported target ${target}`);
          continue;
        }
        const path = projectPath(root, resolve(root, declaration.packageRoot, target));
        if (!emitted.includes(path))
          errors.push(`PROJECT_EXPORT_BUILD ${id}: ${target} is not emitted from ${entry.source}`);
        else publicTargets.add(path);
      }
    }
    for (const rules of [declaration.capabilities, declaration.packageAdapters])
      for (const targets of Object.values(rules ?? {}))
        for (const target of targets ?? [])
          if (!files.includes(target)) errors.push(`PROJECT_ADAPTER_MISSING ${id}: ${target}`);
    projects.push({
      id,
      declaration,
      packageName: manifest.name,
      packagePath,
      typecheck,
      build,
      output,
      publicTargets,
    });
  }
  if (
    harness.projects &&
    !projects.some(
      (project) =>
        project.declaration.kind === 'service' && project.declaration.packageRoot === '.',
    )
  )
    errors.push('PROJECT_ROOT_SERVICE: projects must include the root service');
  const outputs = new Set(projects.map((project) => project.output));
  if (outputs.size !== projects.length)
    errors.push('PROJECT_BUILD_OUTDIR: projects must not share output directories');
  const rootOutput = rootBuild.options.outDir
    ? projectPath(root, resolve(rootBuild.options.outDir))
    : '';
  for (const path of harness.generatedRoots) {
    const conventional =
      path === '.git' ||
      path === 'coverage' ||
      path === 'node_modules' ||
      projects.some(
        (project) =>
          path === `${project.declaration.packageRoot}/node_modules` ||
          path === `${project.declaration.packageRoot}/coverage`,
      );
    if (!conventional && path !== rootOutput && !outputs.has(path))
      errors.push(`EXCLUSION_GENERATED ${path}: not a declared build output or tool directory`);
  }
  return { rootTypecheck, rootBuild, projects, errors };
}

export const projectForSource = (file: string, projects: readonly CheckedProject[]) =>
  projects.find((project) => project.declaration.sources.some((source) => beneath(file, source)));

export const projectForFile = (file: string, projects: readonly CheckedProject[]) =>
  projects
    .filter((project) => beneath(file, project.declaration.packageRoot))
    .sort((left, right) => right.packagePath.length - left.packagePath.length)[0];

/** Follow workspace symlinks and never treat installed third-party packages as part of root A. */
export async function projectForTarget(
  root: string,
  file: string,
  packageNames: readonly (string | undefined)[],
  projects: readonly CheckedProject[],
): Promise<{ project: CheckedProject; path: string } | undefined> {
  const actual = await realpath(file);
  const local = projectPath(await realpath(root), actual);
  const inside = !!local && !local.startsWith('../') && !isAbsolute(local);
  const installed = local.split('/').includes('node_modules');
  if (inside && !installed) {
    const matches = projects
      .filter((project) => beneath(local, project.declaration.packageRoot))
      .sort((left, right) => right.packagePath.length - left.packagePath.length);
    if (matches[0]) return { project: matches[0], path: local };
  }
  const named = projects.find((project) => packageNames.includes(project.packageName));
  return named ? { project: named, path: local } : undefined;
}
