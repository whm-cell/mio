import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { readLocalEnvironment } from '../../scripts/service/local-environment.ts';
import { readProviderConfig } from '../../src/providers/config.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { createProviderService } from '../../src/providers/service.ts';
import { readAssetDatabaseURL } from '../../src/assets/config.ts';
import { materialSchemaSQL, checkMaterialSchema } from '../../src/materials/schema.ts';
import { createMaterialStore } from '../../src/materials/store.ts';
import { createMaterialService } from '../../src/materials/service.ts';
import { createMaterialUpstream } from '../../src/integrations/onelink/materials.ts';
import { HttpError } from '@mio/foundation/errors';

// Explicit live entry: ordinary Vitest does not discover this file and never loads dev credentials.
assert.equal(process.env.MIO_RUN_LIVE_MATERIALS, 'yes', 'MATERIAL_LIVE_OPT_IN_REQUIRED');
const taskId = process.argv[2];
assert(taskId && /^[a-z0-9_-]+$/.test(taskId), 'MATERIAL_LIVE_TASK_REQUIRED');
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain'), '', 'MATERIAL_LIVE_CLEAN_CANDIDATE_REQUIRED');
const commit = git('rev-parse', 'HEAD');
const task = JSON.parse(await readFile(resolve('.work/tasks', taskId, 'state.json'), 'utf8')) as {
  stage: string;
  checkpoint?: { candidate: { commit: string; contractRevision: number } };
};
assert.equal(task.stage, 'C1_EVIDENCE_PENDING');
assert.equal(task.checkpoint?.candidate.commit, commit);
const directory = resolve('.runtime/dev/materials-unit1-live', commit);
await mkdir(resolve('.runtime/dev/materials-unit1-live'), { recursive: true, mode: 0o700 });
await mkdir(directory, { mode: 0o700 }); // Existing audit is a stop: never repeat a possibly sent creation.
const report: {
  candidate: unknown;
  status: string;
  actions: Record<string, number>;
  observations: unknown[];
  errorCode?: string;
} = { candidate: task.checkpoint!.candidate, status: 'running', actions: {}, observations: [] };
const save = () =>
  writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
await save();
const environment = await readLocalEnvironment('dev');
const providerConfig = readProviderConfig(environment.runtime);
assert(providerConfig, 'MATERIAL_LIVE_PROVIDER_CONFIG_REQUIRED');
const databaseURL = readAssetDatabaseURL(environment.runtime);
assert(databaseURL, 'MATERIAL_LIVE_MEDIA_CONFIG_REQUIRED');
const pool = new Pool({
  connectionString: databaseURL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
  query_timeout: 5000,
});
let provider: ReturnType<typeof createProviderService> | undefined;
let service: ReturnType<typeof createMaterialService> | undefined;
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(materialSchemaSQL);
    await checkMaterialSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  report.observations.push({ migration: 'three tables checked; existing assets retained' });
  await save();
  const providerStore = await createProviderStore(providerConfig);
  provider = createProviderService(providerStore, providerConfig);
  const owners = new Pool({
    connectionString: providerConfig.databaseURL,
    connectionTimeoutMillis: 5000,
  });
  let owner: string;
  try {
    const row = (
      await owners.query<{ owner_id: string }>(
        "SELECT owner_id FROM mio_provider_configs WHERE enabled AND credential_auth_state<>'rejected' ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    assert(row, 'MATERIAL_LIVE_EXISTING_OWNER_REQUIRED');
    owner = row.owner_id;
  } finally {
    await owners.end();
  }
  const actor = { userId: owner, sessionId: 'authorized-material-unit1-live' };
  const max: Record<string, number> = {
    CreateAssetGroup: 1,
    UpdateAssetGroup: 1,
    DeleteAssetGroup: 1,
    GetAssetGroup: 3,
    ListAssets: 1,
  };
  const upstream = createMaterialUpstream(async (input, init) => {
    const action = new URL(String(input)).searchParams.get('Action')!;
    assert(
      max[action] && (report.actions[action] ?? 0) < max[action],
      'MATERIAL_LIVE_ACTION_BUDGET',
    );
    report.actions[action] = (report.actions[action] ?? 0) + 1;
    await save();
    return fetch(input, init);
  });
  service = createMaterialService(await createMaterialStore(databaseURL), provider, upstream);
  const created = await service.createGroup(
    actor,
    randomUUID(),
    `Mio Unit1 bounded check ${commit.slice(0, 8)}`,
  );
  report.observations.push({ create: created });
  await save();
  assert(
    created.group && created.operation.state === 'succeeded',
    'MATERIAL_LIVE_CREATE_UNCONFIRMED',
  );
  const group = created.group;
  const renamed = await service.rename(
    actor,
    group.groupId,
    group.revision,
    'Mio Unit1 bounded check renamed',
  );
  report.observations.push({ rename: renamed });
  await save();
  const sync = await service.sync(actor, group.groupId);
  report.observations.push({ sync });
  await save();
  assert.equal(sync.syncedCount, 0);
  const deleted = await service.remove(
    actor,
    'group',
    group.groupId,
    randomUUID(),
    renamed.revision,
    'upstream',
  );
  report.observations.push({ delete: deleted });
  await save();
  assert(
    'operation' in deleted && deleted.operation.state === 'succeeded',
    'MATERIAL_LIVE_DELETE_UNCONFIRMED',
  );
  report.status = 'pass';
  await save();
  console.log('MATERIAL_UNIT1_LIVE_MANAGEMENT_PASS');
} catch (error) {
  report.status = 'fail';
  report.errorCode = error instanceof HttpError ? error.code : 'MATERIAL_LIVE_CHECK_FAILED';
  await save();
  console.log(report.errorCode);
  process.exitCode = 1;
} finally {
  await service?.close();
  await provider?.close();
  await pool.end();
}
