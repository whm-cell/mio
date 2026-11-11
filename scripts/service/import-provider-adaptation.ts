import { readFile } from 'node:fs/promises';
import { readProviderConfig } from '../../src/providers/config.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { ProviderError } from '../../src/providers/contracts.ts';

// Deployment-only data import. This program cannot create a directory member or mark it verified.
const [owner, expected, path] = process.argv.slice(2);
if (
  !owner ||
  !path ||
  process.argv.length !== 5 ||
  !/^\d+$/.test(expected ?? '') ||
  !Number.isSafeInteger(Number(expected))
)
  throw new Error('Usage: providers:adapt <owner-id> <expected-revision> <declaration.json>');
const config = readProviderConfig();
if (!config) throw new Error('PROVIDER_CONFIG: provider configuration required');
const store = await createProviderStore(config);
try {
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw) > 8192) throw new ProviderError(400, 'ADAPTATION_INVALID');
  const result = await store.declare(owner, Number(expected), JSON.parse(raw));
  console.log(
    JSON.stringify({
      providerConfigId: result.id,
      revision: result.revision,
      verification: 'unverified',
    }),
  );
} catch (error) {
  console.error(error instanceof ProviderError ? error.code : 'ADAPTATION_IMPORT_FAILED');
  process.exitCode = 1;
} finally {
  await store.close();
}
