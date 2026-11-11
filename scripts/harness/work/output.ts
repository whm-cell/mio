import { Buffer } from 'node:buffer';
import { digest, json } from './records.ts';

export interface ReadOptions {
  offset: number;
  limit?: number;
  hash?: string;
  select: string;
}
export interface ReadReference {
  argv: string[];
  sha256: string;
}
export const outputBytes = 24576;
const size = (value: unknown) => Buffer.byteLength(json(value));
const token = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

/** JSON Pointer selects data only: inherited properties and invalid escape sequences are rejected. */
export function selectValue(source: unknown, pointer: string): unknown {
  if (!pointer) return source;
  if (!pointer.startsWith('/') || /~(?:[^01]|$)/.test(pointer))
    throw new Error('WORK_READ_SELECT: use a JSON Pointer');
  let value = source;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key) ||
      (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(key))
    )
      throw new Error('WORK_READ_SELECT: field does not exist');
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Code point boundaries preserve UTF-8 text, including a single very long log line. */
function textSlice(source: string, offset: number, limit: number, bytes = Infinity) {
  let total = 0;
  let used = 0;
  let text = '';
  let full = false;
  for (const point of source) {
    if (total >= offset && total < offset + limit && !full) {
      const width = Buffer.byteLength(point);
      full = used + width > bytes;
      if (!full) {
        text += point;
        used += width;
      }
    }
    total++;
  }
  return { text, total };
}

/** Finite semantic projection. Each omitted subtree has an explicit read reference, never cut JSON. */
export function finiteOutput(
  source: unknown,
  reference: (pointer: string) => ReadReference,
  maxBytes = 8192,
) {
  let remaining = 120;
  const marker = (value: unknown, pointer: string) => {
    const ref = reference(pointer);
    // Do not reproduce an unbounded selector supplied by a malformed record or request.
    if (size(ref) > 3072) throw new Error('WORK_READ_REFERENCE: select a shorter parent field');
    const unit =
      typeof value === 'string' ? 'codepoints' : Array.isArray(value) ? 'items' : 'fields';
    const preview = typeof value === 'string' ? textSlice(value, 0, 240, 240) : undefined;
    return {
      $read: {
        argv: [...ref.argv, '--hash', ref.sha256, '--limit', unit === 'codepoints' ? '1024' : '1'],
      },
      unit,
      total: preview
        ? preview.total
        : Array.isArray(value)
          ? value.length
          : value && typeof value === 'object'
            ? Object.keys(value).length
            : 1,
      ...(preview ? { preview: preview.text } : {}),
    };
  };
  const visit = (value: unknown, pointer: string, depth: number): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (--remaining < 0 || depth > 6) return marker(value, pointer);
    if (typeof value === 'string') return size(value) <= 256 ? value : marker(value, pointer);
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value) && value.length > 5) return marker(value, pointer);
    const entries = Object.entries(value);
    if (entries.length > 32) return marker(value, pointer);
    if (entries.some(([key]) => Buffer.byteLength(key) > 256)) return marker(value, pointer);
    const view = Array.isArray(value)
      ? value.map((entry, index) => visit(entry, `${pointer}/${index}`, depth + 1))
      : Object.fromEntries(
          entries.map(([key, entry]) => [key, visit(entry, `${pointer}/${token(key)}`, depth + 1)]),
        );
    return size(view) <= maxBytes ? view : marker(value, pointer);
  };
  const view = visit(source, '', 0);
  if (size(view) > maxBytes) throw new Error('WORK_READ_BUDGET: select a smaller field');
  return view;
}

export function hasReadReference(value: unknown): boolean {
  return !!(
    value &&
    typeof value === 'object' &&
    (Object.hasOwn(value, '$read') || Object.values(value).some(hasReadReference))
  );
}

/** One shared page format for task fields, assessments, guides and public result readers. */
export function readPage(
  source: unknown,
  options: ReadOptions,
  command: string[],
  sha256 = digest(json(source)),
) {
  if (options.hash !== undefined && options.hash !== sha256)
    throw new Error('WORK_READ_STALE: content changed; restart from the first page');
  const selected = selectValue(source, options.select);
  const isText = typeof selected === 'string';
  const limit = options.limit ?? (isText ? 1024 : 10);
  if (
    !Number.isSafeInteger(options.offset) ||
    !Number.isSafeInteger(limit) ||
    options.offset < 0 ||
    limit < 1 ||
    limit > (isText ? 2048 : 20)
  )
    throw new Error('WORK_READ_OPTIONS: limit is 1..20 items or 1..2048 codepoints');
  const reference = (pointer: string): ReadReference => ({
    argv: [...command, '--select', pointer],
    sha256,
  });
  let total: number;
  let body: Record<string, unknown>;
  let count: number;
  const object = selected !== null && typeof selected === 'object';
  const unit = isText
    ? 'codepoints'
    : Array.isArray(selected)
      ? 'items'
      : object
        ? 'fields'
        : 'value';
  if (isText) {
    const slice = textSlice(selected, options.offset, limit);
    total = slice.total;
    count = Math.min(limit, Math.max(0, total - options.offset));
    body = { text: slice.text };
  } else if (object) {
    const keys = Array.isArray(selected) ? null : Object.keys(selected);
    total = keys?.length ?? (selected as unknown[]).length;
    const entries = keys
      ? keys
          .slice(options.offset, options.offset + limit)
          .map((key) => [key, (selected as Record<string, unknown>)[key]] as const)
      : (selected as unknown[])
          .slice(options.offset, options.offset + limit)
          .map((value, index) => [String(options.offset + index), value] as const);
    const values = entries.map(([key, value]) => {
      const pointer = `${options.select}/${token(key)}`;
      const view = finiteOutput(value, (child) => reference(`${pointer}${child}`));
      // Field names are identities, not values addressable through their parent's pointer.
      return Array.isArray(selected) ? view : { key, value: view };
    });
    // Shorten the structural page if large child references exhaust the response budget.
    while (values.length > 1 && size(values) > outputBytes - 4096) values.pop();
    count = values.length;
    body = Array.isArray(selected) ? { items: values } : { entries: values };
  } else {
    total = 1;
    count = options.offset === 0 ? 1 : 0;
    body = options.offset === 0 ? { value: selected } : {};
  }
  if (options.offset > total) throw new Error('WORK_READ_RANGE: offset exceeds the selected field');
  const next = options.offset + count;
  const result = {
    select: options.select,
    page: {
      unit,
      offset: options.offset,
      limit,
      count,
      total,
      sha256,
      next:
        next < total
          ? {
              argv: [
                ...command,
                '--select',
                options.select,
                '--offset',
                String(next),
                '--limit',
                String(limit),
                '--hash',
                sha256,
              ],
            }
          : null,
    },
    ...body,
  };
  if (size(result) > outputBytes) throw new Error('WORK_READ_BUDGET: select a smaller field');
  return result;
}
