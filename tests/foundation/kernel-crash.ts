import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { kernelRuntime, modelOptions, ScriptedModel } from '../support/kernel-runtime.ts';

const root = process.argv[2];
if (!root || !process.send) throw new Error('isolated root and IPC are required');
// Keep the existing IPC channel alive until the parent sends SIGKILL.
process.channel?.ref();
const ctx = await kernelRuntime(root, new ScriptedModel(['hold']));
const chunk = Promise.withResolvers<void>();
const handle = await ctx.mioKernel.create('hard-stop', modelOptions, (agentCtx) => {
  agentCtx.on('agent/assistant-stream', ({ frame }) => {
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') chunk.resolve();
  });
});
const input = (text: string) =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
handle.agent.followup(input('interrupted input'));
await chunk.promise;
handle.agent.followup(input('pending must not replay'));
await ctx.mioKernel.flush(handle.agent.session);
process.send({ ready: true });
// Deliberately no graceful cleanup: the parent verifies a real SIGKILL boundary.
await new Promise(() => {});
