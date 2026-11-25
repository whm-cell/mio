import { HTTP_STATUS } from '@mio/foundation/http-status';
import { audioText, AudioError } from '../audio/contracts.ts';
import { VoiceError } from '../audio/voices/contracts.ts';
import { AssetError } from '../assets/contracts.ts';
import { ProviderError } from '../providers/contracts.ts';
import { ConversationError } from './contracts.ts';
import type { AudioSelection, ConversationAudioTools, Principal } from './contracts.ts';

function inputObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !fields.includes(key)))
    throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
  return object;
}

/** Stable ownership input for replay, before any lookup of current provider or sample state. */
export function canonicalAudioContext(value: unknown) {
  const raw = inputObject(value, ['modelRef', 'voiceRef', 'parameters', 'sample']);
  for (const key of ['modelRef', 'voiceRef']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string')
      throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
  }
  const ordered: Record<string, unknown> = {};
  for (const key of ['modelRef', 'voiceRef']) if (raw[key] !== undefined) ordered[key] = raw[key];
  for (const [key, fields] of [
    ['parameters', ['speed', 'volume', 'pitch', 'format']],
    ['sample', ['assetId', 'authorized', 'name', 'auditionText']],
  ] as const) {
    if (raw[key] === undefined) continue;
    const item = inputObject(raw[key], fields);
    if (Object.values(item).some((entry) => entry !== null && typeof entry === 'object'))
      throw new ConversationError(HTTP_STATUS.BAD_REQUEST, 'BODY_INVALID');
    ordered[key] = Object.fromEntries(
      fields.filter((field) => Object.hasOwn(item, field)).map((field) => [field, item[field]]),
    );
  }
  return ordered;
}

export async function audioAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ConversationError) throw error;
    if (
      error instanceof AudioError ||
      error instanceof VoiceError ||
      error instanceof ProviderError ||
      error instanceof AssetError
    )
      throw new ConversationError(error.status, error.code);
    throw new ConversationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'AUDIO_UNAVAILABLE');
  }
}

export function freezeConversationAudio(
  audio: ConversationAudioTools,
  actor: Principal,
  text: string,
  selection: AudioSelection | null,
  context: Readonly<Record<string, unknown>>,
) {
  return audioAction(async () => {
    audioText(text);
    const voiceRef = context.sample === undefined ? selection?.voiceRef : null;
    if (context.voiceRef !== undefined && (!voiceRef || context.voiceRef !== voiceRef))
      throw new ConversationError(HTTP_STATUS.CONFLICT, 'AUDIO_SELECTION_CONFLICT');
    return audio.freezeContext(actor, {
      ...context,
      ...(voiceRef && context.modelRef ? { voiceRef } : {}),
    });
  });
}
