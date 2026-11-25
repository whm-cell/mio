import { HTTP_STATUS } from '@mio/foundation/http-status';
import { ConversationError } from './contracts.ts';

const MAX_PROJECT_CONTEXT_BYTES = 64 * 1024;

export interface ConversationProjectSnapshot {
  readonly scriptSummary?: string;
  readonly worldbuilding?: string;
  readonly characters?: readonly string[];
}

interface ProjectContextLookup {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly signal: AbortSignal;
}

/** The business domain owns the lookup and can return null for an unlinked conversation. */
export type ConversationProjectContextResolver = (lookup: ProjectContextLookup) => Promise<{
  readonly ownerId: string;
  readonly conversationId: string;
  readonly snapshot: ConversationProjectSnapshot;
} | null>;

export async function loadConversationProjectContext(
  resolve: ConversationProjectContextResolver,
  { ownerId, conversationId, signal }: ProjectContextLookup,
): Promise<string | undefined> {
  let serialized: string;
  try {
    const context = await resolve({ ownerId, conversationId, signal });
    if (context === null) return;
    if (context.ownerId !== ownerId || context.conversationId !== conversationId)
      throw new Error('Project context ownership mismatch');
    const { snapshot } = context;
    if (
      typeof snapshot !== 'object' ||
      !snapshot ||
      Array.isArray(snapshot) ||
      Object.keys(snapshot).some(
        (key) => !['scriptSummary', 'worldbuilding', 'characters'].includes(key),
      )
    )
      throw new Error('Invalid project snapshot');
    const { scriptSummary, worldbuilding, characters } = snapshot;
    if (
      (scriptSummary !== undefined && typeof scriptSummary !== 'string') ||
      (worldbuilding !== undefined && typeof worldbuilding !== 'string') ||
      (characters !== undefined && !Array.isArray(characters))
    )
      throw new Error('Invalid project snapshot fields');
    const characterNotes = characters === undefined ? undefined : Array.from(characters);
    if (characterNotes?.some((note) => typeof note !== 'string'))
      throw new Error('Invalid project character notes');
    serialized = JSON.stringify({ scriptSummary, worldbuilding, characters: characterNotes });
  } catch {
    throw new ConversationError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      'CONVERSATION_CONTEXT_UNAVAILABLE',
    );
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROJECT_CONTEXT_BYTES)
    throw new ConversationError(HTTP_STATUS.PAYLOAD_TOO_LARGE, 'CONVERSATION_CONTEXT_TOO_LARGE');
  return serialized;
}
