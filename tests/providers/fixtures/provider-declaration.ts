import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import type { ChatProfile } from '../../../src/providers/contracts.ts';

async function resolveRawModelId(env: NodeJS.ProcessEnv, modelRef: string): Promise<string> {
  const legacyMatch = /^onelink:(?:chat|image|video|voice|music):(.+)$/.exec(modelRef);
  if (legacyMatch) return legacyMatch[1]!;
  if (modelRef.startsWith('onelink:model:')) {
    const modelKey = modelRef.slice('onelink:model:'.length);
    const connectionString = env.MIO_PROVIDERS_DATABASE_URL ?? env.MIO_DATABASE_URL;
    if (!connectionString) throw new Error('DEPLOYMENT_DECLARATION_DB_MISSING');
    const pool = new Pool({ connectionString, max: 1 });
    try {
      const { rows } = await pool.query<{ raw_model_id: string }>(
        'SELECT raw_model_id FROM mio_provider_models WHERE model_key = $1',
        [modelKey],
      );
      if (!rows[0]?.raw_model_id) throw new Error('DEPLOYMENT_DECLARATION_MODEL_NOT_FOUND');
      return rows[0].raw_model_id;
    } finally {
      await pool.end();
    }
  }
  return modelRef;
}

/** Exercises the CLI route import with a temporary data file and no private values in output. */
export async function importDeclaration(
  env: NodeJS.ProcessEnv,
  owner: string,
  revision: number,
  modelRef: string,
  profile: ChatProfile,
  source = 'deterministic protocol fixture',
) {
  const rawModelId = await resolveRawModelId(env, modelRef);
  const directory = await mkdtemp(join(tmpdir(), 'mio-route-'));
  try {
    const path = join(directory, 'routes.json');
    await writeFile(
      path,
      JSON.stringify({
        providerType: 'onelink',
        rawModelId,
        operation: 'chat',
        vendor: profile === 'anthropic-messages' ? 'anthropic' : 'openai',
        driver: profile,
        classification: 'chat',
        submitPath: profile === 'anthropic-messages' ? '/v1/messages' : '/v1/chat/completions',
        sourceKind: 'protocol-reference',
        source,
        sourceVersion: '2026-11-09',
      }),
    );
    const result = spawnSync(process.execPath, ['scripts/service/import-provider-route.ts', path], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    if (result.status !== 0) throw new Error('DEPLOYMENT_DECLARATION_FAILED');
    return { providerConfigId: owner, revision };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
