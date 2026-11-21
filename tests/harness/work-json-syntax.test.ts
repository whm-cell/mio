import { expect, it } from 'vitest';
import { JsonSyntax } from '../../scripts/harness/work/json-syntax.ts';

function nativeAccepts(source: string) {
  try {
    JSON.parse(source);
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function streamingAccepts(chunks: string[]) {
  const syntax = new JsonSyntax();
  try {
    for (const chunk of chunks) syntax.push(chunk);
    syntax.finish();
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

const complex =
  '{"escaped":"\\"\\\\\\/\\b\\f\\n\\r\\t\\uD800","literal":"𠮷汉\u2028","nested":[{},[],{"x":false}]}';

it('matches native JSON syntax across every split of legal and illegal values', () => {
  const samples = [
    ' \n{}\r\t',
    '{ "same": 1, "same": 2, "__proto__": null }',
    complex,
    '[null,0,-0,1,31,-20,0.25,2.0,-3.5,-42.5E+2,1e-400,1e400]',
    'false',
    '-31.0e-2',
    '"𠮷汉"',
    '',
    ' \r\n\t ',
    '{"unexpected":?',
    '{"x":0,}',
    '{"x":1 "y":2}',
    '{"x" 1}',
    '{x:1}',
    '[true,]',
    '[false null]',
    '[01]',
    '[-01]',
    '+1',
    '.1',
    '2.',
    '2e+',
    '2e+-1',
    '2e3.5',
    'true false',
    '{"x":"\\u12?"}',
    '"\\v"',
    '"\u0000"',
    '"unescaped\nline"',
    '\uFEFF{}',
    ' \u00A0{}',
    '[1]/* trailing comment */',
  ];
  for (const source of samples) {
    const expected = nativeAccepts(source);
    for (let split = 0; split <= source.length; split++) {
      const chunks = [source.slice(0, split), source.slice(split)];
      expect(streamingAccepts(chunks), JSON.stringify(chunks)).toBe(expected);
    }
  }
});

it('matches native JSON syntax at every truncation and rejects an impossible prefix immediately', () => {
  for (const source of [complex, '[null,3.14e-10,true]', '"escaped \\" and \\u0061"']) {
    for (let end = 0; end <= source.length; end++) {
      const prefix = source.slice(0, end);
      expect(streamingAccepts([...prefix]), JSON.stringify(prefix)).toBe(nativeAccepts(prefix));
    }
  }
  const syntax = new JsonSyntax();
  expect(() => syntax.push('{"unexpected":?')).toThrow(SyntaxError);
});
