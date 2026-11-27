import type {
  ChatReasoningEffort,
  ChatRuntimeSnapshot,
  ModelFailure,
  ModelObservation,
} from '../providers/contracts.ts';

/** Stable prefixes precede the per-call prompt; builders must preserve their bytes. */
export interface PromptInput {
  readonly system: string;
  readonly sharedContext?: string;
  readonly prompt: string;
}

/** Paths are relative to the value being parsed; consumers can prepend their field path. */
export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
  readonly legalCandidates?: readonly string[];
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export interface StructuredPromptSpec<TInput, TOutput> {
  readonly templateVersion: string;
  readonly minOutputTokens?: number;
  readonly buildInput: (input: TInput) => PromptInput;
  readonly parseAndValidate: (rawText: string, input: TInput) => ParseResult<TOutput>;
  readonly repair?: (
    input: TInput,
    firstRawText: string,
    issues: readonly ValidationIssue[],
  ) => {
    readonly prompt: string;
    readonly maxOutputTokens?: number;
    readonly parse: (rawText: string) => ParseResult<TOutput>;
  };
}

export function assertTemplateVersion(templateVersion: string): void {
  const match = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9._-]*@v[1-9]\d*$/.exec(templateVersion);
  if (!match || match[0] !== templateVersion)
    throw new TypeError('Invalid prompt templateVersion: ' + templateVersion);
}

/** Accept a whole JSON value or one whole, closed json code fence. Never scan prose. */
export function extractStrictJson(rawText: string): ParseResult<unknown> {
  const text = rawText.trim();
  const fence = /^\x60{3}json[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}$/u.exec(text);
  const json = fence ? fence[1]! : text;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      ok: false,
      issues: [
        {
          path: [],
          code: 'INVALID_JSON',
          message: 'Expected a whole JSON value or a single closed json code fence.',
        },
      ],
    };
  }
  return { ok: true, value };
}

export interface PromptModelRequest {
  readonly ownerId: string;
  readonly snapshot: ChatRuntimeSnapshot;
  readonly input: PromptInput;
  readonly signal: AbortSignal;
  readonly purpose: 'structured' | 'structured-repair' | 'prompt-text';
  readonly reasoningEffort?: ChatReasoningEffort;
  readonly maxOutputTokens?: number;
  readonly observe: (observation: ModelObservation) => Promise<void>;
}

export type PromptModelResult =
  | { readonly status: 'succeeded'; readonly text: string; readonly observation: ModelObservation }
  | {
      readonly status: 'failed';
      readonly error: ModelFailure;
      readonly observation?: ModelObservation;
    }
  | { readonly status: 'cancelled'; readonly observation?: ModelObservation }
  | {
      readonly status: 'unknown';
      readonly error: 'MODEL_STREAM_INTERRUPTED' | 'OBSERVATION_UNAVAILABLE';
      readonly observation?: ModelObservation;
    };

/** One outbound attempt, with no session, tools, retry or credential lookup. */
export type PromptModelCaller = (request: PromptModelRequest) => Promise<PromptModelResult>;
