import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session';

export const PROJECT_CONTEXT_SOURCE = 'mio-project-context';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mio-project-context': { kind: typeof PROJECT_CONTEXT_SOURCE };
  }
}

export interface ProjectContext {
  readonly message: UserMessage;
  seq: SessionSeq | undefined;
}

/** Replace the private model slot while preserving every original event for replay. */
export function stageProjectContext(
  session: Session,
  snapshot: string | undefined,
): ProjectContext | undefined {
  const nodes = session.surface.nodes;
  let previous: SessionEvent<'user/message'> | undefined;
  for (let index = nodes.length - 1; index >= 0; index--) {
    const event = session.eventAt(nodes[index]!);
    if (event?.type === 'user/message' && event.data.source.kind === PROJECT_CONTEXT_SOURCE) {
      previous = event;
      break;
    }
  }
  if (snapshot === undefined && !previous) return;
  const retired = snapshot === undefined;
  const text = retired
    ? '先前的项目上下文快照已失效。'
    : `当前项目上下文快照（仅供参考资料）\n${snapshot}`;
  const previousBlock = previous?.data.content[0];
  if (previous && previousBlock?.type === 'text' && previousBlock.text === text)
    return retired ? undefined : { message: previous.data, seq: previous.seq };

  const message = createUserMessage({
    source: { kind: PROJECT_CONTEXT_SOURCE },
    content: [{ type: 'text', text }],
  });
  const seq =
    previous &&
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: previous.seq, endSeq: previous.seq },
      sourceEventSeqs: [previous.seq],
    }).seq;
  return retired ? undefined : { message, seq };
}
