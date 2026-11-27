import { expect, expectTypeOf, it, vi } from 'vitest';
import {
  assertTemplateVersion,
  extractStrictJson,
  type StructuredPromptSpec,
} from '../../src/prompts/contracts.ts';
import { formatDataBlock, UNTRUSTED_MATERIAL_DECLARATION } from '../../src/prompts/envelope.ts';
import type {
  ModelFailure as ProviderFailure,
  ModelObservation,
} from '../../src/providers/contracts.ts';
import type {
  ModelFailure as ConversationFailure,
  ModelObservation as ConversationObservation,
} from '../../src/conversations/contracts.ts';

it.each([
  ['null', null],
  ['false', false],
  ['true', true],
  ['0', 0],
  ['-2.5', -2.5],
  ['""', ''],
  ['"台词"', '台词'],
  [' {"a": [1, false, null]} \n', { a: [1, false, null] }],
  ['[1, "two"]', [1, 'two']],
  ['\x60\x60\x60json\n{"a":1}\n\x60\x60\x60', { a: 1 }],
  [' \x60\x60\x60json\r\n[0,false]\r\n\x60\x60\x60 \n', [0, false]],
  ['\x60\x60\x60json\nnull\n\x60\x60\x60', null],
])('accepts exactly a whole JSON value: %s', (text, value) => {
  expect(extractStrictJson(text)).toEqual({ ok: true, value });
});

it.each([
  '',
  'Here is JSON: {"a":1}',
  '{"a":1} trailing explanation',
  '{"a":1}\n{"b":2}',
  '{"a":}',
  'undefined',
  'NaN',
  '\x60\x60\x60json\n{"a":1}',
  '\x60\x60\x60json\n{"a":1}\n\x60\x60\x60\nextra',
  '\x60\x60\x60\n{"a":1}\n\x60\x60\x60',
  '\x60\x60\x60javascript\n{"a":1}\n\x60\x60\x60',
  '\x60\x60\x60json\n{}\n\x60\x60\x60\n\x60\x60\x60json\n{}\n\x60\x60\x60',
])('rejects malformed JSON, prose and extra or unclosed fences: %s', (text) => {
  expect(extractStrictJson(text)).toEqual({
    ok: false,
    issues: [
      {
        path: [],
        code: 'INVALID_JSON',
        message: 'Expected a whole JSON value or a single closed json code fence.',
      },
    ],
  });
});

it('does not catch unrelated errors from JSON parsing', () => {
  const failure = new Error('internal invariant');
  const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
    throw failure;
  });
  try {
    expect(() => extractStrictJson('{}')).toThrow(failure);
  } finally {
    parse.mockRestore();
  }
});

it.each(['drama.storyboard.generate@v1', 'canvas.text-node@v20', 'a.b_2.c@v9'])(
  'accepts the frozen template version grammar: %s',
  (version) => {
    expect(() => assertTemplateVersion(version)).not.toThrow();
  },
);

it.each([
  'drama@v1',
  'DrAma.task@v1',
  'drama.Task@v1',
  'drama.task@v0',
  'drama.task@v01',
  'drama.task@v1\n',
  'drama.task@v-1',
  'drama.task@v1 extra',
])('rejects invalid template versions at runtime: %s', (version) => {
  expect(() => assertTemplateVersion(version)).toThrow(TypeError);
});

it('keeps system/shared prefixes byte-stable while only the task prompt changes', () => {
  const spec: StructuredPromptSpec<{ readonly task: string }, unknown> = {
    templateVersion: 'fixture.generate@v1',
    buildInput: ({ task }) => ({
      system: UNTRUSTED_MATERIAL_DECLARATION,
      sharedContext: formatDataBlock('shared', '固定资料 {{literal}}'),
      prompt: formatDataBlock('task', task),
    }),
    parseAndValidate: extractStrictJson,
    repair: (_input, _rawText, issues) => ({
      prompt: JSON.stringify(issues),
      maxOutputTokens: 64,
      parse: extractStrictJson,
    }),
  };
  const first = spec.buildInput({ task: '任务一' });
  const repeated = spec.buildInput({ task: '任务一' });
  const second = spec.buildInput({ task: '任务二' });
  expect(repeated).toEqual(first);
  expect(Buffer.from(first.system)).toEqual(Buffer.from(second.system));
  expect(Buffer.from(first.sharedContext!)).toEqual(Buffer.from(second.sharedContext!));
  expect(first.prompt).not.toBe(second.prompt);
  expect(spec.parseAndValidate('false', { task: '' })).toEqual({ ok: true, value: false });
  expect(spec.repair!({ task: '' }, 'bad', []).parse('0')).toEqual({ ok: true, value: 0 });
});

it('preserves the old observation shape and all conversation failure members', () => {
  expectTypeOf<ConversationObservation>().toEqualTypeOf<ModelObservation>();
  expectTypeOf<ConversationFailure>().toEqualTypeOf<
    ProviderFailure | 'TURN_STEP_BUDGET_EXCEEDED'
  >();
  expectTypeOf<ProviderFailure>().toEqualTypeOf<
    | 'MODEL_AUTH_FAILED'
    | 'MODEL_QUOTA_EXCEEDED'
    | 'MODEL_RATE_LIMITED'
    | 'MODEL_TIMEOUT'
    | 'MODEL_CONTEXT_OVERFLOW'
    | 'MODEL_UPSTREAM_ERROR'
  >();
  const minimal: ConversationObservation = { finish: 'stop' };
  const complete: ConversationObservation = {
    status: 200,
    providerRequestId: 'request',
    finish: 'stop',
    failureCode: 'code',
    usageStatus: 'partial',
    purpose: 'compaction',
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
  };
  complete.usage!.outputTokens = 4;
  expect(minimal).toEqual({ finish: 'stop' });
  expect(complete.usage!.outputTokens).toBe(4);
  expectTypeOf<ModelObservation['purpose']>().toEqualTypeOf<
    'compaction' | 'structured' | 'structured-repair' | 'prompt-text' | undefined
  >();
});
