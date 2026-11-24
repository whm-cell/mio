import { Buffer } from 'node:buffer';

// Measure the original payload before decoding. Re-serialization loses wire padding and escapes.
export function boundedJson(value: unknown, maxBytes: number, invalid: () => never): unknown {
  if (value instanceof Uint8Array) {
    if (value.byteLength > maxBytes) return invalid();
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as unknown;
    } catch {
      return invalid();
    }
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maxBytes) return invalid();
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return invalid();
    }
  }
  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined && Buffer.byteLength(encoded) <= maxBytes) return value;
  } catch {
    return invalid();
  }
  return invalid();
}
