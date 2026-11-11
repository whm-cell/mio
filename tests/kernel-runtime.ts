import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import MioKernel from '../src/dsh/kernel.ts';

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

export function toolResponse(): StreamChunk[] {
  const id = ToolCallId('counted-call');
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'counted_fixture', argumentsDelta: '{}' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id, name: 'counted_fixture', arguments: '{}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

/** Test-only provider; never part of dist, the package files, or a production Profile. */
export class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  private readonly script: ModelScript[];

  constructor(script: ModelScript[]) {
    super();
    this.script = script;
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const next = this.script.shift();
    if (!next) throw new Error('TEST_MODEL_SCRIPT_EXHAUSTED');
    if (typeof next === 'function') {
      yield* next(options);
      return;
    }
    if (next !== 'hold') {
      yield* next;
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'unsettled chunk' };
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error('aborted'));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

export type ModelScript =
  StreamChunk[] | 'hold' | ((options: GenerateOptions) => AsyncIterable<StreamChunk>);

export const modelOptions = { provider: 'mio-test-only', model: 'scripted', maxTokens: 128 };

export async function kernelRuntime(root: string, adapter: ScriptedModel) {
  const ctx = new Context();
  try {
    await ctx.plugin(Llm);
    await ctx.plugin(Sessions);
    await ctx.plugin(Projections);
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(Tools);
    await ctx.plugin(NativeExecutor);
    await ctx.plugin(Agents);
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(Jsonl, { root, compression: 'none' });
    ctx.llm.registerAdapter(['mio-test-only'], adapter);
    await ctx.plugin(MioKernel);
    return ctx;
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
