import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const eslint = new ESLint({ cwd: root });
const ruleId = 'foundation/consumer-primitives';
const require = createRequire(import.meta.url);

async function diagnostics(code: string, filePath = 'src/foundation-probe.ts') {
  const results = await eslint.lintText(code, { filePath });
  expect(results.flatMap((result) => result.messages.filter((message) => message.fatal))).toEqual(
    [],
  );
  return results.flatMap((result) =>
    result.messages.filter((message) => message.ruleId === ruleId),
  );
}

it.each([
  [
    'UUID named alias',
    "import { randomUUID as uuid } from 'node:crypto'; export const id = uuid();",
  ],
  ['UUID bare module', "import { randomUUID } from 'crypto'; export const id = randomUUID();"],
  [
    'UUID namespace',
    "import * as native from 'node:crypto'; export const id = native.randomUUID();",
  ],
  [
    'UUID default static member',
    "import native from 'crypto'; export const id = native['randomUUID']();",
  ],
  ['UUID global', 'export const id = crypto.randomUUID();'],
  ['UUID globalThis static member', "export const id = globalThis['crypto']['randomUUID']();"],
  ['epoch', 'export const now = Date.now();'],
  ['epoch globalThis', "export const now = globalThis.Date['now']();"],
  ['monotonic global', 'export const now = performance.now();'],
  ['monotonic globalThis', "export const now = globalThis['performance'].now();"],
  [
    'monotonic import alias',
    "import { performance as clock } from 'node:perf_hooks'; export const now = clock.now();",
  ],
  [
    'monotonic namespace',
    "import * as native from 'perf_hooks'; export const now = native.performance.now();",
  ],
  [
    'monotonic default static namespace',
    "import native from 'node:perf_hooks'; export const now = native['performance']['now']();",
  ],
  ['current Date constructor', 'export const now = new Date();'],
  ['current Date no parentheses', 'export const now = new Date;'],
  ['current Date globalThis', "export const now = new globalThis['Date']();"],
  ['TypeScript expression wrapper', 'export const now = (Date as DateConstructor).now();'],
  [
    'non-null expression wrapper',
    "import * as native from 'node:crypto'; export const id = native!.randomUUID();",
  ],
  [
    'default expression outside body var scope',
    'export function f(value = Date.now()) { var Date; return value; }',
  ],
  [
    'default constructor outside body var scope',
    'export function f(value = new Date()) { var Date; return value; }',
  ],
])('ESLint blocks %s in production services', async (_name, code) => {
  const messages = await diagnostics(code);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.message).toMatch(/FOUNDATION_(UUID|TIME)/);
});

it.each([
  [
    'parameters',
    'export function f(Date, performance, crypto) { return [Date.now(), performance.now(), crypto.randomUUID()]; }',
  ],
  [
    'local variables',
    'export function f() { const Date = vendor; const performance = vendor; const crypto = vendor; return [Date.now(), performance.now(), crypto.randomUUID()]; }',
  ],
  [
    'third-party imports',
    "import { Date, performance, crypto, randomUUID } from 'vendor'; export const value = [Date.now(), performance.now(), crypto.randomUUID(), randomUUID()];",
  ],
  [
    'third-party namespace',
    "import crypto from 'vendor'; export const value = crypto.randomUUID();",
  ],
  [
    'import alias parameter',
    "import { randomUUID as uuid } from 'node:crypto'; export function f(uuid) { return uuid(); }",
  ],
  [
    'namespace parameter',
    "import * as native from 'node:perf_hooks'; export function f(native) { return native.performance.now(); }",
  ],
  [
    'destructuring',
    'export function f({ Date, performance, crypto }) { return [Date.now(), performance.now(), crypto.randomUUID()]; }',
  ],
  [
    'destructured alias',
    "import { randomUUID as uuid } from 'node:crypto'; export function f({ uuid }) { return uuid(); }",
  ],
  [
    'var hoisting',
    'export function f() { const value = Date.now(); var Date = vendor; return value; }',
  ],
  [
    'block var hoisting',
    'export function f() { const value = Date.now(); { var Date = vendor; } return value; }',
  ],
  ['catch binding', 'try { throw vendor; } catch (Date) { Date.now(); }'],
  ['for binding', 'for (const Date of values) { Date.now(); }'],
  ['block binding', '{ const Date = vendor; Date.now(); }'],
  ['later block binding', '{ Date.now(); const Date = vendor; }'],
  ['function declaration', 'export function Date() {} export const value = Date.now();'],
  [
    'class binding',
    'export class Date { static now() { return 1; } } export const value = Date.now();',
  ],
  ['named function expression', 'export const value = function Date() { return Date.now(); };'],
  ['class static var scope', 'export class Local { static { Date.now(); var Date; } }'],
  [
    'shadowed globalThis',
    'export function f(globalThis) { return [globalThis.Date.now(), globalThis.crypto.randomUUID(), new globalThis.Date()]; }',
  ],
  ['local Date constructor', 'export function f(Date) { return new Date(); }'],
  [
    'Date parameter default',
    'export function f(Date = vendor, value = Date.now()) { return value; }',
  ],
  ['own Date parameter default', 'export function f(Date = Date.now()) { return Date; }'],
  [
    'Date body var with defaults',
    'export function f(value = 1) { Date.now(); var Date; return value; }',
  ],
  [
    'date conversion and parsing',
    "export const value = [new Date(123), new Date('2020-01-01'), Date.parse('2020-01-01'), Date.UTC(2020, 0)];",
  ],
  [
    'binary and streaming hashes',
    "import { createHash, createHmac, createCipheriv } from 'node:crypto'; export const value = [createHash('sha256').update(bytes).update(more).digest('hex'), createHmac('sha256', key), createCipheriv];",
  ],
  [
    'public APIs',
    "import { createId } from '@mio/foundation/identifiers'; import { epochMs, monotonicMs, utcISOString } from '@mio/foundation/time'; export const value = [createId(), epochMs(), monotonicMs(), utcISOString()];",
  ],
  // Policy A deliberately leaves HTTP wrappers and constructor semantics to quality-review reuse.
  [
    'HTTP numeric status',
    'export function reply(res) { res.writeHead(404); res.statusCode = 400; fail(400); writeApiError(res, 400); }',
  ],
  [
    'rewritten HTTP error constructor',
    "import { HttpError } from '@mio/foundation/errors'; class DomainError extends HttpError { constructor(code, status) { super(status, code); } } export const value = new DomainError('bad', 400);",
  ],
  ['ordinary error and number', 'export const value = [new Error("domain"), 404];'],
])('ESLint preserves %s', async (_name, code) => {
  expect(await diagnostics(code)).toEqual([]);
});

it.each(['src/future/clock.ts', 'compute/src/future/clock.ts'])(
  'activates the rule for registered service source %s',
  async (filePath) => {
    expect(await diagnostics('export const now = Date.now();', filePath)).toHaveLength(1);
  },
);

it.each([
  'packages/foundation/src/future.ts',
  'contracts/compute/src/future.ts',
  'tests/clock.test.ts',
  'compute/tests/clock.test.ts',
  'scripts/harness/clock.ts',
  'scripts/service/clock.ts',
])('preserves library, contract, test and development role %s', async (filePath) => {
  expect(
    await diagnostics(
      'export const now = [Date.now(), new Date(), crypto.randomUUID(), performance.now()];',
      filePath,
    ),
  ).toEqual([]);
});

it('distinguishes default expressions from body var references in the same function', async () => {
  const messages = await diagnostics(
    'export function f(value = Date.now()) { Date.now(); var Date; return value; }',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]?.column).toBe(27);
});

it('uses actual reference resolution after block, catch and loop scopes end', async () => {
  const code =
    '{ const Date = vendor; Date.now(); }\ntry {} catch (Date) { Date.now(); }\nfor (const Date of values) Date.now();\nexport const now = Date.now();';
  const messages = await diagnostics(code);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.line).toBe(4);
});

it('keeps type-space declarations from hiding the system value', async () => {
  expect(await diagnostics('type Date = number; export const now = Date.now();')).toHaveLength(1);
});

it('loads the effective repository config through the real ESLint CLI', () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(require.resolve('eslint/package.json'), '../bin/eslint.js'),
      '--stdin',
      '--stdin-filename',
      'compute/src/foundation-probe.ts',
      '--format',
      'json',
    ],
    {
      cwd: root,
      input:
        "import { randomUUID as uuid } from 'node:crypto'; export const value = [uuid(), Date.now(), performance.now(), new Date()];",
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(1);
  const results = JSON.parse(result.stdout) as ESLint.LintResult[];
  expect(results.flatMap((result) => result.messages.map((message) => message.ruleId))).toEqual([
    ruleId,
    ruleId,
    ruleId,
    ruleId,
  ]);
});

it('pins the real foundation public exports independently of minimal guard fixtures', async () => {
  const harness = JSON.parse(await readFile(resolve(root, 'harness.config.json'), 'utf8'));
  const manifest = JSON.parse(
    await readFile(resolve(root, 'packages/foundation/package.json'), 'utf8'),
  );
  expect(manifest.name).toBe('@mio/foundation');
  expect(harness.projects.foundation.kind).toBe('library');
  for (const entry of ['identifiers', 'time']) {
    expect(harness.projects.foundation.publicEntries).toContainEqual({
      source: `packages/foundation/src/${entry}.ts`,
      export: `./${entry}`,
    });
    expect(manifest.exports[`./${entry}`]).toEqual({
      types: `./dist/${entry}.d.ts`,
      default: `./dist/${entry}.js`,
    });
  }
  const identifiers = await import('../../packages/foundation/src/identifiers.ts');
  const time = await import('../../packages/foundation/src/time.ts');
  expect(identifiers.createId).toBeTypeOf('function');
  for (const name of ['epochMs', 'monotonicMs', 'utcISOString'] as const)
    expect(time[name]).toBeTypeOf('function');
});
