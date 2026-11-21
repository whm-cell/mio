import type { FileHandle } from 'node:fs/promises';
import { originalChunks, originalDigest, withArtifact } from './original.ts';
import type { Evidence } from './records.ts';

export const resultMarker = '\n--- mio-command-result ---\n';
const headerEnd = Buffer.from('\n}\n');
const resultStart = Buffer.from(resultMarker);

async function jsonRange(file: FileHandle, start: number, end: number) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '';
  for await (const bytes of originalChunks(file, start, end)) {
    const part = decoder.decode(bytes, { stream: true });
    if (text) {
      text += part;
      continue;
    }
    const first = part.search(/[^ \t\r\n]/);
    if (first < 0) continue;
    // Command output may contain a marker even when the real result was never written.
    if (!'{["tfn-0123456789'.includes(part[first]!)) throw new SyntaxError('Invalid JSON record');
    text = part.slice(first);
  }
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
      const header = await jsonRange(file, 0, endOfHeader);
      const outcome = await jsonRange(file, lastMarker + resultStart.length, stat.size);
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
