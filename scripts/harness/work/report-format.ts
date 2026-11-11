import { readFile } from 'node:fs/promises';
import { parseMarkdown } from '../markdown.ts';
import { checkedPath } from './records.ts';

export function metadata(source: string, language: string): unknown {
  const blocks =
    parseMarkdown(source).children?.filter(
      (node) => node.type === 'code' && node.lang === language,
    ) ?? [];
  if (blocks.length !== 1) throw new Error(`WORK_REPORT_FORMAT: expected one ${language} block`);
  return JSON.parse(blocks[0]!.value!);
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('WORK_REPORT_FORMAT: expected object');
  return value as Record<string, unknown>;
}

export function fields(value: object, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('WORK_REPORT_FORMAT: unsupported field');
}

export function textField(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('WORK_REPORT_FORMAT: expected nonempty text');
  return value;
}

export function hashField(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('WORK_REPORT_FORMAT: expected SHA256');
  return value;
}

export function publicText(text: string) {
  if (/\/(?:Users|Volumes|home)\//.test(text) || /(?:^|[\s"'(/])\.work\//m.test(text))
    throw new Error('WORK_DELIVERY_PRIVATE: redact personal paths before sharing');
  return text;
}

export async function optionalText(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(await checkedPath(root, path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
