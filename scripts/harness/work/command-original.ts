import type { FileHandle } from 'node:fs/promises';
import { originalChunks, originalDigest, withArtifact } from './original.ts';
import type { Evidence } from './records.ts';
import { JsonSyntax } from './json-syntax.ts';

export const resultMarker = '\n--- mio-command-result ---\n';
const headerEnd = Buffer.from('\n}\n');
const resultStart = Buffer.from(resultMarker);

function requireObjectPrefix(source: string) {
  if (!source.trimStart().startsWith('{')) throw new SyntaxError('Expected JSON object');
}

async function jsonRange(file: FileHandle, start: number, end: number, use: 'object' | 'syntax') {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const syntax = new JsonSyntax();
  let position = start;
  let contentStart: number | undefined;
  let contentEnd = start;
  const inspect = (part: string) => {
    if (use === 'object') {
      const tail = part.trimEnd();
      if (tail.length > 0) {
        if (contentStart === undefined) {
          requireObjectPrefix(tail);
          contentStart = position + tail.length - tail.trimStart().length;
        }
        contentEnd = position + Buffer.byteLength(tail);
      }
      position += Buffer.byteLength(part);
    }
    syntax.push(part);
  };

  for await (const bytes of originalChunks(file, start, end)) {
    if (use === 'object' && bytes.length === end - start) {
      const source = decoder.decode(bytes);
      requireObjectPrefix(source);
      return JSON.parse(source);
    }
    inspect(decoder.decode(bytes, { stream: true }));
  }
  inspect(decoder.decode());
  syntax.finish();
  if (use === 'syntax') return;

  // A false delimiter can make command output resemble a large metadata record. Materialize only
  // verified JSON, excluding leading and trailing whitespace. The same descriptor is used throughout.
  let text = '';
  for await (const bytes of originalChunks(file, contentStart ?? start, contentEnd))
    text += decoder.decode(bytes, { stream: true });
  return JSON.parse(text + decoder.decode());
}

export async function readCommandOriginal(root: string, id: string, entry: Evidence) {
  return withArtifact(root, id, entry.artifact, async (file, stat) => {
    if (entry.result === 'pending')
      return {
        result: (await originalDigest(file, stat.size)) === entry.sha256 ? 'pending' : 'corrupt',
      } as const;

    const overlap = resultStart.length - 1;
    let previous = Buffer.alloc(0);
    let endOfHeader = -1;
    let lastMarker = -1;
    const sha256 = await originalDigest(file, stat.size, (chunk, offset) => {
      const boundary = Buffer.concat([previous, chunk.subarray(0, overlap)]);
      if (endOfHeader < 0) {
        const crossing = boundary.indexOf(headerEnd);
        const within = chunk.indexOf(headerEnd);
        if (crossing >= 0) endOfHeader = offset - previous.length + crossing + headerEnd.length - 1;
        else if (within >= 0) endOfHeader = offset + within + headerEnd.length - 1;
      }
      const within = chunk.lastIndexOf(resultStart);
      const crossing = boundary.lastIndexOf(resultStart);
      if (within >= 0) lastMarker = offset + within;
      else if (crossing >= 0) lastMarker = offset - previous.length + crossing;
      previous = Buffer.from((chunk.length < overlap ? boundary : chunk).subarray(-overlap));
    });
    if (sha256 !== entry.sha256) return { result: 'corrupt' } as const;
    if (endOfHeader < 0 || lastMarker < endOfHeader) return { result: 'invalid' } as const;

    // Read only the two JSON records after checking the full original, including command output.
    try {
      const header = await jsonRange(file, 0, endOfHeader, 'object');
      const outcome = await jsonRange(
        file,
        lastMarker + resultStart.length,
        stat.size,
        entry.result === 'pass' ? 'object' : 'syntax',
      );
      const current = await file.stat();
      if (
        current.size !== stat.size ||
        current.mtimeMs !== stat.mtimeMs ||
        current.ctimeMs !== stat.ctimeMs ||
        current.nlink !== 1
      )
        return { result: 'corrupt' } as const;
      return { result: 'read', header, outcome } as const;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError)
        return { result: 'invalid' } as const;
      throw error;
    }
  });
}
