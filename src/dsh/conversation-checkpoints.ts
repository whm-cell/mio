import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session';
import type { Session } from '@deepseek-ai/dsh-session';
import * as CheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import * as RepeatToolReminder from '@deepseek-ai/dsh-repeat-tool-reminder';
import * as ToolTimeout from '@deepseek-ai/dsh-tool-call-timeout-policy';
import type { ConversationEvent } from '../conversations/contracts.ts';
import { ConversationCompaction } from './conversation-compaction.ts';
import { parseImageJobPresentationMeta } from './image-tools.ts';
import type {} from './kernel.ts';

export const CHECKPOINT_INTERRUPTED = 'MIO_CHECKPOINT_INTERRUPTED';

const failedCheckpoints = new WeakSet<Session>();

export function hasCheckpointFailure(session: Session): boolean {
  return failedCheckpoints.has(session);
}

async function checkpoint(kernel: Context['mioKernel'], session: Session): Promise<boolean> {
  if (!failedCheckpoints.has(session)) {
    try {
      await kernel.flush(session);
    } catch {
      failedCheckpoints.add(session);
    }
  }
  // The tool pipeline converts dispatch exceptions into results. Latch this
  // failure so subsequent native boundaries still refuse to dispatch.
  if (failedCheckpoints.has(session)) throw new Error(CHECKPOINT_INTERRUPTED);
  return true;
}

export function applyConversationPolicies(ctx: Context): void {
  const kernel = ctx.mioKernel;
  // The pinned native policy uses SessionStore.get and flush. Supply Mio's
  // strict flush (including no durability listener) only to this policy.
  const sessions = new Proxy(ctx.sessions, {
    get(store, property) {
      if (property === 'flush') return (session: Session) => checkpoint(kernel, session);
      return Reflect.get(store, property, store);
    },
  });
  CheckpointPolicy.apply(ctx.extend({ sessions }));
  new ConversationCompaction(ctx, (session) => checkpoint(kernel, session));
  ToolTimeout.apply(ctx);
  RepeatToolReminder.apply(ctx, RepeatToolReminder.Config({ thresholds: [2, 4] }));
}

/** Join durable tool cards to the current turn's native checkpoint boundaries. */
export function trackConversationToolCheckpoints(
  ctx: Context,
  agent: Agent,
  kernel: Context['mioKernel'],
  requestId: string,
  emit: (event: ConversationEvent) => void,
): () => Promise<void> {
  let cards = Promise.resolve();

  ctx.on(
    'agent/pre-step',
    async (_payload, next) => {
      await cards;
      return next();
    },
    { prepend: true },
  );
  ctx.on('session/event', (session, event) => {
    if (
      session !== agent.session ||
      event.type !== 'tool/result' ||
      !isAppendSurfaceEvent(event) ||
      event.data.message.isError
    )
      return;
    const card = parseImageJobPresentationMeta(event.data.meta);
    if (!card) return;
    // Session event observers are synchronous. Start the write after native
    // routing has enqueued the result, then wait at the next step.
    cards = cards.then(async () => {
      try {
        await checkpoint(kernel, session);
      } catch {
        return;
      }
      try {
        emit({ type: 'tool', requestId, tool: card.tool, job: card.job });
      } catch {
        // Delivery is independent of the committed result.
      }
    });
  });

  return () => cards;
}
