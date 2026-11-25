import type { Context } from '@deepseek-ai/cordis';
import SessionTitleService from '@deepseek-ai/dsh-session-title';
import { MAX_CONVERSATION_TITLE_BYTES } from '../conversations/contracts.ts';

class ConversationTitles extends SessionTitleService {
  // The conversation fiber retains the service's dependencies through its drain.
  static override inject = [];
}

export function installConversationTitles(ctx: Context) {
  return ctx.plugin(ConversationTitles, {
    fallbackMaxWords: 12,
    fallbackMaxBytes: 96,
    maxTitleBytes: MAX_CONVERSATION_TITLE_BYTES,
  });
}
