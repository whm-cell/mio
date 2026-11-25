import { boundedJson } from './json-payload.ts';

export function mediaInvalid(): never {
  throw new Error('MEDIA_INPUT_INVALID');
}
export function mediaRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return mediaInvalid();
  return value as Record<string, unknown>;
}
export function mediaFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    mediaInvalid();
}
export function mediaNumber(value: unknown, min: number, max: number, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    return mediaInvalid();
  return value;
}
export function mediaString(value: unknown, max = 4096): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    return mediaInvalid();
  return value;
}
export function mediaUuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  )
    return mediaInvalid();
  return value;
}
export function mediaEnum<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return mediaInvalid();
  return value as T;
}
export function mediaArray(value: unknown, max: number, min = 0): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.length < min ||
    value.includes(undefined)
  )
    return mediaInvalid();
  return value;
}
export function mediaPayload(value: unknown, limit: number): unknown {
  return boundedJson(value, limit, mediaInvalid);
}
