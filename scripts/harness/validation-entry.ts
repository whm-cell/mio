import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const [action, ...args] = process.argv.slice(2);
const allowedOptions = new Set([
  '--',
  'run',
  'color',
  'testNamePattern',
  't',
  'reporter',
  'outputFile',
  'silent',
  'hideSkippedTests',
  'maxWorkers',
  'maxConcurrency',
  'fileParallelism',
  'testTimeout',
  'hookTimeout',
  'bail',
  'retry',
]);

async function run(binary: string, argv: string[]) {
  const child = spawn(binary, argv, { stdio: 'inherit' });
  let cancelled = false;
  const interrupt = () => {
    cancelled = true;
    child.kill('SIGINT');
  };
  const terminate = () => {
    cancelled = true;
    child.kill('SIGTERM');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    const code = await new Promise<number | null>((ok, fail) => {
      child.once('error', fail);
      child.once('exit', ok);
    });
    if (cancelled || code !== 0) process.exitCode = code || 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

function within(path: string, root: string) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function main() {
  if (action === 'check') {
    if (process.env.GITHUB_ACTIONS !== 'true')
      throw new Error('CHECK_CI_ONLY: full pnpm check runs in GitHub Actions');
    return;
  }
  if (action !== 'test' && action !== 'local') throw new Error('VALIDATION_ACTION');
  if (action === 'test' && args.length === 0 && process.env.GITHUB_ACTIONS === 'true') {
    const vitest = fileURLToPath(
      new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')),
    );
    await run(process.execPath, [vitest, 'run']);
    return;
  }
  if (!args.length) throw new Error('TEST_SCOPE: provide a test file or directory');

  const { createVitest, parseCLI } = await import('vitest/node');
  const { filter, options } = parseCLI(['vitest', 'run', ...args]);
  if (!filter.length) throw new Error('TEST_SCOPE: provide a test file or directory');
  const trailing = (options as { '--'?: string[] })['--'];
  if (Object.keys(options).some((key) => !allowedOptions.has(key)) || trailing?.length)
    throw new Error('TEST_OPTION: option changes discovery or is not supported by this entry');

  if (action === 'local') {
    await run(process.execPath, ['scripts/service/local.ts', 'test', 'check', ...args]);
    return;
  }

  const testsRoot = resolve('tests');
  const computeRoot = resolve('compute/tests');
  const scopes = await Promise.all(
    filter.map(async (scope) => {
      const path = resolve(scope);
      const root = within(path, testsRoot) && path !== testsRoot ? testsRoot : computeRoot;
      if (!within(path, root)) throw new Error(`TEST_SCOPE: outside test directories: ${scope}`);
      const [target, canonicalRoot] = await Promise.all([realpath(path), realpath(root)]);
      if (!within(target, canonicalRoot) || (root === testsRoot && target === canonicalRoot))
        throw new Error(`TEST_SCOPE: outside test directories: ${scope}`);
      const metadata = await stat(target);
      if (!metadata.isDirectory() && !metadata.isFile())
        throw new Error(`TEST_SCOPE: expected a file or directory: ${scope}`);
      return { scope, path, target, directory: metadata.isDirectory() };
    }),
  );
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  const vitest = await createVitest('test', { ...options, watch: false });
  try {
    const specifications = await vitest.globTestSpecifications();
    const discovered = await Promise.all(
      specifications
        .filter((specification) =>
          scopes.some((scope) =>
            scope.directory
              ? within(resolve(specification.moduleId), scope.path)
              : resolve(specification.moduleId) === scope.path,
          ),
        )
        .map(async (specification) => ({
          specification,
          path: await realpath(specification.moduleId),
        })),
    );
    const selected = new Set<(typeof specifications)[number]>();
    for (const scope of scopes) {
      const matches = discovered.filter(({ specification, path }) => {
        const declared = resolve(specification.moduleId);
        return scope.directory
          ? within(declared, scope.path) && within(path, scope.target)
          : declared === scope.path && path === scope.target;
      });
      if (!matches.length) throw new Error(`TEST_SCOPE: no tests found for ${scope.scope}`);
      for (const match of matches) selected.add(match.specification);
    }
    await vitest.standalone();
    await vitest.runTestSpecifications([...selected]);
  } finally {
    await vitest.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
