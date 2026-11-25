import { ApplicationError } from '@mio/foundation/errors';
import { sha256Utf8 } from '@mio/foundation/hash';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { isPlainJsonRecord, ToolArgsError } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ConversationRun } from '../conversations/contracts.ts';

type MediaKind = 'image' | 'video';

export function closedParametersTool(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    parameters: { ...definition.parameters, additionalProperties: false },
  };
}

function argumentIssue(args: unknown, allowedKeys: ReadonlySet<string>): string | null {
  if (!isPlainJsonRecord(args)) return 'arguments must be a JSON object';
  return Object.keys(args).some((key) => !allowedKeys.has(key)) ? 'unexpected parameter' : null;
}

export function hasAllowedArguments(args: unknown, allowedKeys: ReadonlySet<string>): boolean {
  return argumentIssue(args, allowedKeys) === null;
}

export function assertAllowedArguments(args: unknown, allowedKeys: ReadonlySet<string>): void {
  const issue = argumentIssue(args, allowedKeys);
  if (issue !== null) throw new ToolArgsError([issue]);
}

/** The domain and field order are part of persisted request identity. */
export function deriveMediaToolRequestId(
  kind: MediaKind,
  run: Pick<ConversationRun, 'userId' | 'conversationId' | 'requestId'>,
  operationKey: string,
): string {
  const hex = sha256Utf8(
    `mio:conv-${kind}:v1:${run.userId}:${run.conversationId}:${run.requestId}:${operationKey}`,
  );
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

export function sanitizedMediaToolError(error: unknown, kind: MediaKind): never {
  if (error instanceof HarnessError) throw error;
  const media = kind.toUpperCase();
  const code = error instanceof ApplicationError ? error.code : `${media}_UNAVAILABLE`;
  throw new HarnessError(`MIO_${media}_TOOL_ERROR: ${code}`, code);
}
