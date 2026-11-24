import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';

const ALLOWED_CONVERSATION_TOOLS = [
  'list_image_models',
  'submit_image_job',
  'get_image_job',
  'inspect_image_asset',
  'list_video_models',
  'submit_video_job',
  'get_video_job',
  'recover_video_job',
] as const;

const MAX_TOOL_CALLS_PER_TURN = 12;
const MAX_IMAGE_SUBMITS_PER_TURN = 4;
const MAX_VIDEO_SUBMITS_PER_TURN = 1;

const allowedConversationToolSet = new Set<string>(ALLOWED_CONVERSATION_TOOLS);

interface TurnToolGrant {
  active: boolean;
  totalCalls: number;
  imageSubmits: number;
  videoSubmits: number;
  readonly allowed: ReadonlySet<string>;
  readonly countedTokens: WeakSet<object>;
}

const activeToolGrants = new WeakMap<Agent, TurnToolGrant>();

function isAuthorizedConversationToolCall(exec: Readonly<ToolExecution>): boolean {
  if (!exec.agent || exec.signal.aborted || !allowedConversationToolSet.has(exec.name)) return false;
  const grant = activeToolGrants.get(exec.agent);
  return grant?.active === true && grant.allowed.has(exec.name);
}

/** The foundation and kernel own the same monotonic deny policy for their respective lifetimes. */
export function denyModelTools(ctx: Context): void {
  ctx.tools.guard((exec) =>
    isAuthorizedConversationToolCall(exec)
      ? undefined
      : 'MIO_TOOL_DENIED: no model tool is authorized in the Mio profile',
  );
}

/**
 * Authorize selected creation tools on one live conversation Agent turn,
 * enforcing per-turn call and submission budgets before any tool body can run.
 */
export function authorizeConversationTools(
  agentCtx: Context,
  agent: Agent,
  options: {
    imageGeneration: boolean;
    imageInspection: boolean;
    videoGeneration: boolean;
  } = { imageGeneration: true, imageInspection: false, videoGeneration: false },
): () => void {
  const allowed = new Set<string>([
    ...(options.imageGeneration ? ['list_image_models', 'submit_image_job', 'get_image_job'] : []),
    ...(options.imageInspection ? ['inspect_image_asset'] : []),
    ...(options.videoGeneration ? ['list_video_models', 'submit_video_job', 'get_video_job', 'recover_video_job'] : []),
  ]);
  const grant: TurnToolGrant = {
    active: true,
    totalCalls: 0,
    imageSubmits: 0,
    videoSubmits: 0,
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
    if (exec.name === 'submit_video_job' && grant.videoSubmits >= MAX_VIDEO_SUBMITS_PER_TURN) {
      return `MIO_TOOL_BUDGET_EXCEEDED: max ${MAX_VIDEO_SUBMITS_PER_TURN} video submission per turn`;
    }
    grant.countedTokens.add(exec);
    grant.totalCalls++;
    if (exec.name === 'submit_image_job') grant.imageSubmits++;
    if (exec.name === 'submit_video_job') grant.videoSubmits++;
    return undefined;
  });
  return revoke;
}
