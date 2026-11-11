import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { beneath } from './inventory.ts';
import type { HarnessConfig } from './inventory.ts';
import {
  allowsCapability,
  allowsPackageAdapter,
  directBuiltinAccess,
  restrictedCapability,
} from './source-boundaries.ts';
import {
  inspectProjects,
  projectForFile,
  projectForSource,
  projectForTarget,
} from './source-projects.ts';

// Aliases can lack packageId; file symlinks can retain a different packageId.
async function owningPackageName(file: string): Promise<string | undefined> {
  let directory = dirname(await realpath(file));
  for (;;) {
    // Anonymous format metadata inherits ownership, but dependencies do not inherit their host's.
    if (basename(directory) === 'node_modules') return undefined;
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (typeof manifest.name === 'string' && manifest.name.length > 0) return manifest.name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** TypeScript syntax and module resolution, including type-only exports and literal dynamic imports. */
export async function checkSource(root: string, files: readonly string[], harness: HarnessConfig) {
  const errors: string[] = [];
  const metrics: string[] = [];
  const graph = new Map<string, string[]>();
  const checked = await inspectProjects(root, files, harness);
  errors.push(...checked.errors);
  const membership = new Map<ts.ParsedCommandLine, Set<string>>();
  const targetOwners = new Map<string, ReturnType<typeof projectForTarget>>();
  const includes = (config: ts.ParsedCommandLine, file: string) => {
    let set = membership.get(config);
    if (!set) {
      set = new Set(config.fileNames.map((path) => resolve(path)));
      membership.set(config, set);
    }
    return set.has(resolve(root, file));
  };

  const roleOf = (path: string) =>
    Object.entries(harness.sourceRoots).find(([base]) => beneath(path, base))?.[1];
  for (const [base, role] of Object.entries(harness.sourceRoots)) {
    if (role === 'development' && !Array.isArray(harness.developmentDependencies?.[base]))
      errors.push(`DEVELOPMENT_RULE_MISSING ${base}: declare allowed development dependencies`);
  }
  for (const file of files.filter((path) => roleOf(path) !== undefined && path.endsWith('.ts'))) {
    const production = roleOf(file) === 'production';
    const project = production
      ? projectForSource(file, checked.projects)
      : projectForFile(file, checked.projects);
    const parsed = project?.typecheck ?? checked.rootTypecheck;
    const build = project?.build ?? checked.rootBuild;
    const developmentRoot = Object.keys(harness.sourceRoots).find(
      (base) => beneath(file, base) && harness.sourceRoots[base] === 'development',
    );
    if (!includes(parsed, file)) {
      errors.push(
        `SOURCE_NOT_TYPECHECKED ${file}: include it in its project's typecheck configuration`,
      );
    }
    const buildRelative =
      build.options.rootDir &&
      relative(build.options.rootDir, resolve(root, file)).replaceAll('\\', '/');
    if (
      production &&
      (!includes(build, file) ||
        (buildRelative && (buildRelative.startsWith('../') || isAbsolute(buildRelative))))
    ) {
      errors.push(`SOURCE_NOT_BUILT ${file}: include it in its project's build configuration`);
    }
    if (production && project)
      for (const other of checked.projects) {
        if (other.id === project.id) continue;
        if (includes(other.typecheck, file))
          errors.push(`PROJECT_TYPECHECK_FOREIGN ${other.id}: ${file} belongs to ${project.id}`);
        if (includes(other.build, file))
          errors.push(`PROJECT_BUILD_FOREIGN ${other.id}: ${file} belongs to ${project.id}`);
      }
    const text = await readFile(join(root, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    source.impliedNodeFormat = ts.getImpliedNodeFormatForFile(
      join(root, file),
      undefined,
      ts.sys,
      parsed.options,
    );
    const imports: { specifier: string; mode: ts.ResolutionMode }[] = [];
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
        imports.push({
          specifier: node.moduleSpecifier.text,
          mode: ts.getModeForUsageLocation(source, node.moduleSpecifier, parsed.options),
        });
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        imports.push({
          specifier: node.argument.literal.text,
          mode: ts.getModeForUsageLocation(source, node.argument.literal, parsed.options),
        });
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        imports.push({
          specifier: node.moduleReference.expression.text,
          mode: ts.ModuleKind.CommonJS,
        });
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg))
          imports.push({
            specifier: arg.text,
            mode:
              node.expression.kind === ts.SyntaxKind.ImportKeyword
                ? ts.getModeForUsageLocation(source, arg, parsed.options)
                : ts.ModuleKind.CommonJS,
          });
        else if (production || developmentRoot)
          errors.push(`DYNAMIC_IMPORT ${file}: checked module target must be explicit`);
      }
      if (production && directBuiltinAccess(node)) {
        if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
          const arg = node.parent.arguments[0];
          if (arg && ts.isStringLiteralLike(arg))
            imports.push({ specifier: arg.text, mode: undefined });
          else
            errors.push(
              `DYNAMIC_BUILTIN ${file}: process.getBuiltinModule target must be explicit`,
            );
        } else errors.push(`DYNAMIC_BUILTIN ${file}: process.getBuiltinModule cannot be detached`);
      }
      ts.forEachChild(node, (child) => visit(child, nextDepth));
    };
    visit(source);
    const edges: string[] = [];
    const resolutions = imports.flatMap(({ specifier, mode }) => {
      const variants = (production ? [parsed, build] : [parsed]).map(
        (config) =>
          ts.resolveModuleName(
            specifier,
            join(root, file),
            config.options,
            ts.sys,
            undefined,
            undefined,
            mode,
          ).resolvedModule,
      );
      const seenVariants = new Set<string>();
      return variants
        .filter((resolved) => {
          const key = JSON.stringify([
            resolved?.resolvedFileName,
            resolved?.packageId?.name,
            resolved?.isExternalLibraryImport,
          ]);
          if (seenVariants.has(key)) return false;
          seenVariants.add(key);
          return true;
        })
        .map((resolved) => ({ specifier, resolved }));
    });
    for (const { specifier, resolved } of resolutions) {
      const target = resolved && relative(root, resolved.resolvedFileName).replaceAll('\\', '/');
      if (
        (!specifier.startsWith('.') &&
          (specifier.includes('/src/') || specifier.includes('/lib/'))) ||
        isAbsolute(specifier)
      ) {
        errors.push(`PUBLIC_IMPORT ${file}: ${specifier}`);
      }
      const packageName = resolved && (await owningPackageName(resolved.resolvedFileName));
      const ownerKey =
        resolved &&
        JSON.stringify([resolved.resolvedFileName, resolved.packageId?.name, packageName]);
      if (ownerKey && resolved && checked.projects.length && !targetOwners.has(ownerKey))
        targetOwners.set(
          ownerKey,
          projectForTarget(
            root,
            resolved.resolvedFileName,
            [resolved.packageId?.name, packageName],
            checked.projects,
          ),
        );
      const ownedTarget = ownerKey ? await targetOwners.get(ownerKey) : undefined;
      if (developmentRoot) {
        const localTarget =
          ownedTarget?.path ?? (!resolved?.isExternalLibraryImport ? target : undefined);
        if (localTarget) {
          const allowed = harness.developmentDependencies?.[developmentRoot] ?? [];
          if (!allowed.some((base) => beneath(localTarget, base)))
            errors.push(
              `DEVELOPMENT_DEPENDENCY ${file}: ${localTarget} is outside ${developmentRoot}'s allowed dependencies`,
            );
          else edges.push(localTarget);
        }
        if (specifier.startsWith('.') && (!target || !resolve(root, target).startsWith(`${root}/`)))
          errors.push(`IMPORT_UNRESOLVED ${file}: ${specifier}`);
      }
      const redisPackage = [
        specifier === 'redis' || specifier.startsWith('redis/')
          ? 'redis'
          : specifier.split('/').slice(0, 2).join('/'),
        resolved?.packageId?.name,
        packageName,
      ].some((name) => name === 'redis' || name?.startsWith('@redis/'));
      if ((production || developmentRoot) && redisPackage && file !== 'src/integrations/redis.ts')
        errors.push(`REDIS_ADAPTER ${file}: Redis packages belong in src/integrations/redis.ts`);
      const cosPackage = [specifier.split('/')[0], resolved?.packageId?.name, packageName].some(
        (name) => name === 'cos-nodejs-sdk-v5',
      );
      if (
        (production || developmentRoot) &&
        cosPackage &&
        file !== 'src/integrations/cos.ts' &&
        !allowsPackageAdapter(project, file, 'cos-nodejs-sdk-v5')
      )
        errors.push(`COS_ADAPTER ${file}: COS package belongs in a reviewed adapter`);
      const amqpPackage = [specifier.split('/')[0], resolved?.packageId?.name, packageName].some(
        (name) => name === 'amqplib' || name === '@types/amqplib',
      );
      if (
        (production || developmentRoot) &&
        amqpPackage &&
        !allowsPackageAdapter(project, file, 'amqplib')
      )
        errors.push(`AMQP_ADAPTER ${file}: AMQP package belongs in a reviewed adapter`);
      if (
        (production || developmentRoot) &&
        !resolved &&
        checked.projects.some(
          (owner) =>
            specifier === owner.packageName || specifier.startsWith(`${owner.packageName}/`),
        )
      )
        errors.push(`PROJECT_IMPORT_UNRESOLVED ${file}: ${specifier}`);
      if (!production) continue;
      if (
        file === 'src/http-response.ts' &&
        !(
          (!resolved && ['node:crypto', 'node:http'].includes(specifier)) ||
          (target === 'src/contracts.ts' && !resolved?.isExternalLibraryImport)
        )
      )
        errors.push(
          `HTTP_RESPONSE_DEPENDENCY ${file}: ${specifier} is outside Node HTTP/UUID and contracts`,
        );
      if (
        file === 'src/integrations/redis.ts' &&
        target &&
        !resolved?.isExternalLibraryImport &&
        target !== 'src/contracts.ts'
      )
        errors.push(
          `REDIS_DIRECTION ${file}: public Redis must not depend on consumers or tooling`,
        );
      const authPackage = [specifier.split('/')[0], resolved?.packageId?.name, packageName].some(
        (name) => name === 'better-auth' || name?.startsWith('@better-auth/'),
      );
      const databasePackage = [
        specifier.split('/')[0],
        resolved?.packageId?.name,
        packageName,
      ].some((name) => name === 'pg' || name === '@types/pg');
      const businessDatabase = [
        'src/conversations/store.ts',
        'src/conversations/schema.ts',
        'src/providers/store.ts',
        'src/providers/schema.ts',
        'src/assets/store.ts',
        'src/assets/schema.ts',
        'src/compute/store.ts',
        'src/compute/schema.ts',
      ].includes(file);
      if (
        ((authPackage || specifier.startsWith('@better-auth/')) && !beneath(file, 'src/auth')) ||
        (databasePackage && !beneath(file, 'src/auth') && !businessDatabase)
      )
        errors.push(
          `AUTH_ADAPTER ${file}: authentication belongs in src/auth; PostgreSQL also permits reviewed conversation/provider/asset store/schema`,
        );
      if (file !== 'src/plugin.ts' && !beneath(file, 'src/dsh')) {
        if (
          specifier.startsWith('@deepseek-ai/') ||
          specifier === '@earendil-works/pi-ai' ||
          specifier.startsWith('@earendil-works/pi-ai/') ||
          resolved?.packageId?.name.startsWith('@deepseek-ai/') ||
          packageName?.startsWith('@deepseek-ai/') ||
          resolved?.packageId?.name === '@earendil-works/pi-ai' ||
          packageName === '@earendil-works/pi-ai'
        )
          errors.push(`DSH_BOUNDARY ${file}: framework access belongs in src/plugin.ts or src/dsh`);
      }
      const capability = restrictedCapability(specifier);
      if (capability && !allowsCapability(project, file, capability)) {
        errors.push(`RUNTIME_CAPABILITY ${file}: ${specifier} needs an explicit reviewed boundary`);
      }
      const publicContract =
        ownedTarget?.project.declaration.kind === 'contract' &&
        ownedTarget.project.publicTargets.has(ownedTarget.path);
      const allowedContract = project?.declaration.kind === 'service' && publicContract;
      if (project && ownedTarget && project.id !== ownedTarget.project.id && !allowedContract)
        errors.push(
          `PROJECT_DEPENDENCY ${file}: ${specifier} crosses into ${ownedTarget.project.id} private code`,
        );
      const localTarget = ownedTarget?.path ?? target;
      if (localTarget && (!resolved?.isExternalLibraryImport || ownedTarget)) {
        if (roleOf(localTarget) !== 'production' && !publicContract)
          errors.push(`RUNTIME_DEPENDENCY ${file}: ${localTarget}`);
        else {
          edges.push(localTarget);
          if (
            (beneath(file, 'src/providers') || beneath(file, 'src/conversations')) &&
            beneath(localTarget, 'src/dsh')
          )
            errors.push(`DSH_BOUNDARY ${file}: business modules must not import src/dsh`);
          if (localTarget === 'src/plugin.ts' && file !== localTarget)
            errors.push(`ADAPTER_DIRECTION ${file}: ${localTarget}`);
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
