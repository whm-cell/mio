import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';

const decodeZstd = promisify(zstdDecompress);

/** Read physical fixture records, retaining every frame of a compressed JSONL artifact. */
export async function readSessionArtifact(path: string): Promise<string> {
  const bytes = await readFile(path);
  return (path.endsWith('.jsonl.zstd') ? await decodeZstd(bytes) : bytes).toString('utf8');
}
