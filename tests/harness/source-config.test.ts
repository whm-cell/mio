import { expect, it } from 'vitest';
import { parseHarnessConfig } from '../../scripts/harness/source-config.ts';
import { legacyHarness } from './fixtures/guardrail-fixture.ts';

it('accepts a valid config and decoded property names without changing its values', () => {
  const config = legacyHarness();
  const text = JSON.stringify(config).replace('"src"', String.raw`"s\u0072c"`);
  expect(parseHarnessConfig(text)).toEqual(config);
});

it.each<[string, string[]]>([
  ['{"a":{"x":1,"x":2},"a":{"y":1,"y":2}}', ['a', 'x', 'y']],
  ['{"x":1,"x":2,"x":3}', ['x', 'x']],
  [String.raw`{"src":1,"s\u0072c":2}`, ['src']],
  ['[{"x":1,"x":2},[{"y":1,"y":2}]]', ['x', 'y']],
  [
    '{"__proto__":1,"__proto__":2,"constructor":1,"constructor":2,"":1,"":2}',
    ['__proto__', 'constructor', ''],
  ],
  ['[{"x":1},{"x":2}]', []],
  [String.raw`{"text":"{\"x\":1,\"x\":2}"}`, []],
])('reports all duplicate keys in object-first order for %s', (probe, keys) => {
  const text = `${JSON.stringify(legacyHarness()).slice(0, -1)},"probe":${probe}}`;
  expect(() => parseHarnessConfig(text)).toThrowError(
    new Error(
      [...keys.map((key) => `HARNESS_DUPLICATE_KEY ${key}`), 'HARNESS_FIELD: unknown probe'].join(
        '\n',
      ),
    ),
  );
});

it.each(['{"a":1,}', '{"a":/* comment */1}', String.raw`{"a":"\x61"}`, '{"a":NaN}', '{} trailing'])(
  'rejects invalid JSON before configuration validation: %s',
  (text) => {
    expect(() => parseHarnessConfig(text)).toThrowError(SyntaxError);
  },
);

it.each(['null', '[]', '[{"x":1,"x":2}]'])(
  'requires an object before checking keys: %s',
  (text) => {
    expect(() => parseHarnessConfig(text)).toThrowError(
      new Error('HARNESS_CONFIG: expected an object'),
    );
  },
);
