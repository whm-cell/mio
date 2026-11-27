import { vi } from 'vitest';
import type { ChatProfile, ChatRuntimeSnapshot } from '../../src/providers/contracts.ts';
import { callPromptModel } from '../../src/dsh/prompt-caller.ts';
import { createPromptRuntime } from '../../src/prompts/runner.ts';
import type { PromptExecution } from '../../src/prompts/runner.ts';
import { extractStrictJson } from '../../src/prompts/contracts.ts';
import type { ParseResult, StructuredPromptSpec } from '../../src/prompts/contracts.ts';
import { formatDataBlock } from '../../src/prompts/envelope.ts';
import { createRefTable } from '../../src/prompts/refs.ts';
import type { RefTable } from '../../src/prompts/refs.ts';
import { protocolResponse } from '../onelink/fixture.ts';

export const profiles = ['openai-chat', 'anthropic-messages'] as const;
export const validOutput = '{"character":"C01"}';
export const system = 'Return JSON for the requested character. Keep literal {{value}}.';
export function snapshot(
  profile: ChatProfile,
  changes: Partial<ChatRuntimeSnapshot> = {},
): ChatRuntimeSnapshot {
  return Object.freeze({
    providerConfigId: 'fixture-provider',
    providerRevision: 2,
    credentialVersion: 3,
    modelKey: 'fixture-model',
    catalogVersion: 5,
    adaptationVersion: 7,
    operation: 'chat',
    profile,
    protocol: profile,
    modelRef: 'onelink:model:fixture',
    modelId: profile === 'openai-chat' ? 'deepseek-fixture' : 'claude-fixture',
    vendor: profile === 'openai-chat' ? 'deepseek' : 'anthropic',
    capabilityVersion: 'fixture-v7',
    maxOutputTokens: 1024,
    reasoning: Object.freeze({ supported: true, efforts: Object.freeze(['low', 'high'] as const) }),
    apiKey: 'synthetic-prompt-owner-key',
    ...changes,
  });
}
export function execution(profile: ChatProfile): PromptExecution {
  return {
    ownerId: 'fixture-owner',
    snapshot: snapshot(profile),
    signal: new AbortController().signal,
    evidence: 'fixture-task:fixture-request',
    observe: vi.fn(async () => {}),
  };
}
export interface FixtureInput {
  readonly prompt: string;
  readonly refs: RefTable<string>;
}
export function input(): FixtureInput {
  const table = createRefTable('C', [{ id: 'business-character', label: 'Alice' }]);
  if (!table.ok) throw new Error('fixture ref table failed');
  return Object.freeze({ prompt: 'Pick Alice', refs: table.value });
}
function parseOutput(raw: string, input: FixtureInput): ParseResult<{ characterId: string }> {
  const parsed = extractStrictJson(raw);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('character' in value) ||
    typeof value.character !== 'string' ||
    Object.keys(value).length !== 1
  )
    return {
      ok: false,
      issues: [
        {
          path: ['character'],
          code: 'INVALID_FIELD',
          message: 'Expected only character as a string.',
        },
      ],
    };
  const resolved = input.refs.resolve(value.character);
  return resolved.ok ? { ok: true, value: { characterId: resolved.value } } : resolved;
}
export function spec(
  changes: Partial<StructuredPromptSpec<FixtureInput, { characterId: string }>> = {},
): StructuredPromptSpec<FixtureInput, { characterId: string }> {
  return {
    templateVersion: 'fixture.cast@v1',
    buildInput: (input) => ({ system, sharedContext: input.refs.dictionary, prompt: input.prompt }),
    parseAndValidate: parseOutput,
    repair: (input, raw, issues) => ({
      prompt:
        'Repair exactly these issues: ' +
        formatDataBlock('issues', JSON.stringify(issues)) +
        formatDataBlock('first-output', raw),
      maxOutputTokens: 512,
      parse: (text) => parseOutput(text, input),
    }),
    ...changes,
  };
}
export function fixture(
  profile: ChatProfile,
  respond: (request: Request, index: number) => Response | Promise<Response> = (request) =>
    protocolResponse(request, validOutput),
  maxInFlight?: number,
) {
  const requests: { request: Request; body: Record<string, unknown> }[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ request, body: (await request.clone().json()) as Record<string, unknown> });
    return respond(request, requests.length);
  });
  vi.stubGlobal('fetch', transport);
  const recordVerification = vi.fn(async () => {});
  const callModel = vi.fn(callPromptModel);
  const runtime = createPromptRuntime(
    { callModel, recordVerification },
    maxInFlight === undefined ? {} : { maxInFlight },
  );
  const request = execution(profile);
  return { runtime, request, requests, transport, recordVerification, callModel };
}

/** Extend the existing wire fixture with unsolicited thinking and explicit vendor usage. */
export async function thinkingResponse(
  request: Request,
  text: string,
  tokens: number,
): Promise<Response> {
  const response = protocolResponse(request, text);
  const anthropic = new URL(request.url).pathname === '/v1/messages';
  const lines = (await response.text()).split('\n');
  const output = lines
    .map((line) => {
      if (!line.startsWith('data: {')) return line;
      const data = JSON.parse(line.slice(6));
      if (anthropic) {
        if (data.type.startsWith('content_block_')) data.index = 1;
        if (data.type === 'message_delta')
          data.usage.output_tokens_details = { thinking_tokens: tokens };
      } else {
        const delta = data.choices?.[0]?.delta;
        if (delta?.content !== undefined) delta.reasoning_content = 'PRIVATE THINKING NEVER EXPOSE';
        if (data.usage) data.usage.completion_tokens_details = { reasoning_tokens: tokens };
      }
      return 'data: ' + JSON.stringify(data);
    })
    .join('\n');
  const thinking = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'PRIVATE THINKING NEVER EXPOSE' },
    },
    { type: 'content_block_stop', index: 0 },
  ]
    .map((data) => 'event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n')
    .join('');
  const body = anthropic
    ? output.replace('event: content_block_start', thinking + 'event: content_block_start')
    : output;
  return new Response(body, { headers: response.headers });
}
