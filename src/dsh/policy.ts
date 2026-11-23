import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools';
import type { ConversationEvent, ConversationToolName } from '../conversations/contracts.ts';

const ALLOWED_CONVERSATION_IMAGE_TOOLS = [
  'list_image_models',
  'submit_image_job',
  'get_image_job',
  'inspect_image_asset',
] as const satisfies readonly ConversationToolName[];

const ALLOWED_CONVERSATION_AUDIO_TOOLS = [
  'list_audio_models',
  'list_audio_voices',
  'select_audio_voice',
  'submit_audio_job',
  'clone_audio_voice',
  'get_audio_job',
] as const satisfies readonly ConversationToolName[];

const MAX_TOOL_CALLS_PER_TURN = 12;
const MAX_IMAGE_SUBMITS_PER_TURN = 4;

interface TurnToolGrant {
  active: boolean;
  totalCalls: number;
  imageSubmits: number;
  audioSubmits: number;
  readonly allowed: ReadonlyMap<string, ConversationToolName>;
  readonly countedTokens: WeakSet<object>;
}

const activeToolGrants = new WeakMap<Agent, TurnToolGrant>();

function isAuthorizedConversationCall(exec: Readonly<ToolExecution>): boolean {
  if (!exec.agent || exec.signal.aborted) return false;
  const grant = activeToolGrants.get(exec.agent);
  return grant?.active === true && grant.allowed.has(exec.name);
}

/** The foundation and kernel own the same monotonic deny policy for their respective lifetimes. */
export function denyModelTools(ctx: Context): void {
  ctx.tools.guard((exec) =>
    isAuthorizedConversationCall(exec)
      ? undefined
      : 'MIO_TOOL_DENIED: no model tool is authorized in the Mio profile',
  );
}

/**
 * Authorize only the selected image tools on one live conversation Agent turn,
 * enforcing per-turn call and submission budgets before any tool body can run.
 */
export function authorizeConversationImageTools(
  agentCtx: Context,
  agent: Agent,
  options: { generation: boolean; inspection: boolean } = { generation: true, inspection: false },
  progress?: (
    tool: ConversationToolName,
    status: Extract<ConversationEvent, { type: 'tool-status' }>['status'],
  ) => void,
): () => void {
  return authorizeTurnTools(
    agentCtx,
    agent,
    ALLOWED_CONVERSATION_IMAGE_TOOLS.filter((name) =>
      name === 'inspect_image_asset' ? options.inspection : options.generation,
    ),
    progress,
  );
}

type Progress = (
  tool: ConversationToolName,
  status: Extract<ConversationEvent, { type: 'tool-status' }>['status'],
) => void;

export function authorizeConversationAudioTools(
  agentCtx: Context,
  agent: Agent,
  progress?: Progress,
) {
  return authorizeTurnTools(agentCtx, agent, ALLOWED_CONVERSATION_AUDIO_TOOLS, progress);
}

function authorizeTurnTools(
  agentCtx: Context,
  agent: Agent,
  names: readonly ConversationToolName[],
  progress?: Progress,
) {
  const allowed = new Map(names.map((name) => [name as string, name]));
  const grant: TurnToolGrant = {
    active: true,
    totalCalls: 0,
    imageSubmits: 0,
    audioSubmits: 0,
    allowed,
    countedTokens: new WeakSet<object>(),
  };
  activeToolGrants.set(agent, grant);
  const revoke = () => {
    grant.active = false;
    if (activeToolGrants.get(agent) === grant) activeToolGrants.delete(agent);
  };
  agentCtx.effect(() => () => revoke());
  agentCtx.tools.guard((exec) => {
    if (
      exec.agent !== agent ||
      exec.signal.aborted ||
      !grant.active ||
      !grant.allowed.has(exec.name)
    ) {
      return 'MIO_TOOL_DENIED: no model tool is authorized in the Mio profile';
    }
    // ToolExecution instances are frozen per-call objects created by ToolExecutionPipeline.createExecution.
    if (grant.countedTokens.has(exec)) return undefined;
    if (grant.totalCalls >= MAX_TOOL_CALLS_PER_TURN) {
      return `MIO_TOOL_BUDGET_EXCEEDED: max ${MAX_TOOL_CALLS_PER_TURN} tool calls per turn`;
    }
    if (exec.name === 'submit_image_job' && grant.imageSubmits >= MAX_IMAGE_SUBMITS_PER_TURN) {
      return `MIO_TOOL_BUDGET_EXCEEDED: max ${MAX_IMAGE_SUBMITS_PER_TURN} image submissions per turn`;
    }
    const audioSubmit = exec.name === 'submit_audio_job' || exec.name === 'clone_audio_voice';
    if (audioSubmit && grant.audioSubmits > 0)
      return 'MIO_TOOL_BUDGET_EXCEEDED: one audio submission per turn';
    grant.countedTokens.add(exec);
    grant.totalCalls++;
    if (exec.name === 'submit_image_job') grant.imageSubmits++;
    if (audioSubmit) grant.audioSubmits++;
    return undefined;
  });
  if (progress) {
    // Pair the actual guarded dispatches by their private DSH invocation token.
    const executing = new Map<ToolExecutionToken, ConversationToolName>();
    agentCtx.on('tools/execute', (exec, next) => {
      const tool = grant.allowed.get(exec.name);
      if (tool && grant.active && !exec.signal.aborted && grant.countedTokens.has(exec)) {
        executing.set(exec.token, tool);
        progress(tool, 'running');
      }
      return next();
    });
    agentCtx.on('tools/result', (exec, result) => {
      const tool = executing.get(exec.token);
      if (tool) {
        executing.delete(exec.token);
        progress(tool, result.isError ? 'failed' : 'completed');
      }
    });
  }
  return revoke;
}
