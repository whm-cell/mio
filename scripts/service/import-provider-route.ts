import { open } from 'node:fs/promises';
import { readProviderConfig } from '../../src/providers/config.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { ProviderError } from '../../src/providers/contracts.ts';

const MAX_ROUTE_BYTES = 65_536;

async function readStdinBounded(limit: number): Promise<string> {
  if (process.stdin.isTTY) throw new ProviderError(400, 'ROUTE_INVALID');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) throw new ProviderError(400, 'ROUTE_INVALID');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readFileBounded(path: string, limit: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new ProviderError(400, 'ROUTE_INVALID');
    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset <= limit) {
      const { bytesRead } = await handle.read(buffer, offset, limit + 1 - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new ProviderError(400, 'ROUTE_INVALID');
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

// Controlled deployment route import. Never creates user catalog members or sets verified.
const [target] = process.argv.slice(2);
if (!target || process.argv.length !== 3 || (target !== '--stdin' && target.startsWith('--'))) {
  console.error('Usage: providers:route <--stdin | routes.json>');
  process.exit(1);
}
const config = readProviderConfig();
if (!config) throw new Error('PROVIDER_CONFIG: provider configuration required');
const store = await createProviderStore(config);
try {
  const raw =
    target === '--stdin'
      ? await readStdinBounded(MAX_ROUTE_BYTES)
      : await readFileBounded(target, MAX_ROUTE_BYTES);
  const summary = await store.importRoutes(JSON.parse(raw));
  console.log(
    JSON.stringify({
      ...summary,
      verification: 'unverified',
    }),
  );
} catch (error) {
  console.error(error instanceof ProviderError ? error.code : 'ROUTE_IMPORT_FAILED');
  process.exitCode = 1;
} finally {
  await store.close();
}
