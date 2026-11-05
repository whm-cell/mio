import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { beneath } from './inventory.ts';
import type { HarnessConfig } from './inventory.ts';

/** TypeScript syntax and module resolution, including type-only exports and literal dynamic imports. */
export async function checkSource(root: string, files: readonly string[], harness: HarnessConfig) {
  const errors: string[] = [];
  const metrics: string[] = [];
  const graph = new Map<string, string[]>();
  const configPath = ts.findConfigFile(root, ts.sys.fileExists);
  if (!configPath) throw new Error('tsconfig.json missing');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const buildConfig = ts.readConfigFile(join(root, 'tsconfig.build.json'), ts.sys.readFile);
  if (config.error || buildConfig.error || parsed.errors.length) {
    throw new Error('Invalid or missing TypeScript configuration; run pnpm typecheck');
  }
  const build = ts.parseJsonConfigFileContent(buildConfig.config, ts.sys, root);
  if (build.errors.length) throw new Error('Invalid build configuration; run pnpm build');
  const typedFiles = new Set(parsed.fileNames.map((file) => resolve(file)));
  const builtFiles = new Set(build.fileNames.map((file) => resolve(file)));

  const roleOf = (path: string) =>
    Object.entries(harness.sourceRoots).find(([base]) => beneath(path, base))?.[1];
  for (const file of files.filter((path) => roleOf(path) !== undefined && path.endsWith('.ts'))) {
    const production = roleOf(file) === 'production';
    if (!typedFiles.has(resolve(root, file))) {
      errors.push(`SOURCE_NOT_TYPECHECKED ${file}: include it in tsconfig.json`);
    }
    if (production && !builtFiles.has(resolve(root, file))) {
      errors.push(`SOURCE_NOT_BUILT ${file}: include it in tsconfig.build.json`);
    }
    const text = await readFile(join(root, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    let functions = 0;
    let longestFunction = 0;
    let deepestBlock = 0;
    let branches = 0;
    const visit = (node: ts.Node, depth = 0): void => {
      const nextDepth = depth + (ts.isBlock(node) ? 1 : 0);
      deepestBlock = Math.max(deepestBlock, nextDepth);
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        functions++;
        const start = source.getLineAndCharacterOfPosition(node.getStart()).line;
        const end = source.getLineAndCharacterOfPosition(node.end).line;
        longestFunction = Math.max(longestFunction, end - start + 1);
      }
      if (
        ts.isIfStatement(node) ||
        ts.isConditionalExpression(node) ||
        ts.isCaseClause(node) ||
        ts.isCatchClause(node) ||
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node)
      )
        branches++;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        imports.push(node.argument.literal.text);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        imports.push(node.moduleReference.expression.text);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) imports.push(arg.text);
        else if (production) errors.push(`DYNAMIC_IMPORT ${file}: runtime target must be explicit`);
      }
      ts.forEachChild(node, (child) => visit(child, nextDepth));
    };
    visit(source);
    const edges: string[] = [];
    for (const specifier of imports) {
      const resolved = ts.resolveModuleName(
        specifier,
        join(root, file),
        parsed.options,
        ts.sys,
      ).resolvedModule;
      const target = resolved && relative(root, resolved.resolvedFileName).replaceAll('\\', '/');
      if (
        (!specifier.startsWith('.') &&
          (specifier.includes('/src/') || specifier.includes('/lib/'))) ||
        isAbsolute(specifier)
      ) {
        errors.push(`PUBLIC_IMPORT ${file}: ${specifier}`);
      }
      if (!production) continue;
      if (specifier.startsWith('@deepseek-ai/') && file !== 'src/plugin.ts') {
        errors.push(`DSH_BOUNDARY ${file}: framework access belongs in src/plugin.ts`);
      }
      if (/^(?:node:)?(?:child_process|fs|vm|worker_threads|module)(?:\/|$)/.test(specifier)) {
        errors.push(`RUNTIME_CAPABILITY ${file}: ${specifier} needs an explicit reviewed boundary`);
      }
      if (target && !resolved?.isExternalLibraryImport) {
        if (roleOf(target) !== 'production') errors.push(`RUNTIME_DEPENDENCY ${file}: ${target}`);
        else {
          edges.push(target);
          if (target === 'src/plugin.ts' && file !== target)
            errors.push(`ADAPTER_DIRECTION ${file}: ${target}`);
          if (file === 'src/contracts.ts')
            errors.push(`CONTRACT_DIRECTION ${file}: contracts must be runtime-independent`);
        }
      }
      if (specifier.startsWith('.') && (!target || !resolve(root, target).startsWith(`${root}/`))) {
        errors.push(`IMPORT_UNRESOLVED ${file}: ${specifier}`);
      }
    }
    graph.set(file, edges);
    metrics.push(
      `${file}: lines=${text.split('\n').length}, functions=${functions}, longestFunction=${longestFunction}, blockDepth=${deepestBlock}, decisionNodes=${branches}`,
    );
  }
  const seen = new Set<string>();
  const active = new Set<string>();
  const visit = (file: string): void => {
    if (active.has(file)) {
      errors.push(`IMPORT_CYCLE ${file}`);
      return;
    }
    if (seen.has(file)) return;
    active.add(file);
    for (const target of graph.get(file) ?? []) visit(target);
    active.delete(file);
    seen.add(file);
  };
  for (const file of graph.keys()) visit(file);
  return { errors, metrics };
}
