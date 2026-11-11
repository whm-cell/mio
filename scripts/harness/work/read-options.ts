import { Buffer } from 'node:buffer';
import type { ReadOptions } from './output.ts';

/** These options change a view, never the stored record or the execution assessment. */
export function readOptions(args: string[], extraFlags: string[] = []) {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) {
      if (Buffer.byteLength(arg) > 1024) throw new Error('WORK_READ_ARGUMENT: argument too long');
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!['offset', 'limit', 'hash', 'select', ...extraFlags].includes(name))
      throw new Error('WORK_READ_OPTIONS: unsupported option');
    const value = args[++index];
    if (value === undefined || value.startsWith('--') || Object.hasOwn(flags, name))
      throw new Error('WORK_READ_OPTIONS: provide each option once with a value');
    if (Buffer.byteLength(value) > 1024) throw new Error('WORK_READ_ARGUMENT: argument too long');
    flags[name] = value;
  }
  for (const name of ['offset', 'limit']) {
    if (flags[name] !== undefined && !/^(?:0|[1-9]\d{0,8})$/.test(flags[name]!))
      throw new Error('WORK_READ_OPTIONS: offset/limit must be bounded nonnegative integers');
  }
  if (flags.hash !== undefined && !/^[a-f0-9]{64}$/.test(flags.hash))
    throw new Error('WORK_READ_OPTIONS: hash must be a SHA-256 digest');
  const options: ReadOptions = { offset: Number(flags.offset ?? 0), select: flags.select ?? '' };
  if (flags.limit !== undefined) options.limit = Number(flags.limit);
  if (flags.hash !== undefined) options.hash = flags.hash;
  return { positionals, options, flags };
}
