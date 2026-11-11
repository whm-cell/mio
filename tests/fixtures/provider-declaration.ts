import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ChatProfile } from '../../src/providers/contracts.ts';

/** Exercises the deployment import, with a temporary data file and no private values in output. */
export async function importDeclaration(
  env: NodeJS.ProcessEnv,
  owner: string,
  revision: number,
  modelRef: string,
  profile: ChatProfile,
  source = 'deterministic protocol fixture',
) {
  const directory = await mkdtemp(join(tmpdir(), 'mio-declaration-'));
  try {
    const path = join(directory, 'declaration.json');
    await writeFile(
      path,
      JSON.stringify({
        modelRef,
        operation: 'chat',
        profile,
        classification: 'chat',
        source,
        sourceVersion: '2026-11-09',
      }),
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/service/import-provider-adaptation.ts', owner, String(revision), path],
      { env, encoding: 'utf8', timeout: 30000 },
    );
    if (result.status !== 0) throw new Error('DEPLOYMENT_DECLARATION_FAILED');
    return JSON.parse(result.stdout) as { providerConfigId: string; revision: number };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
