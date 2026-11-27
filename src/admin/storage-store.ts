import type { Pool, PoolClient } from 'pg';
import { createId } from '@mio/foundation/identifiers';
import { AdminError } from './contracts.ts';
import type { StorageSettings } from './storage.ts';

interface StorageSettingsUpdate {
  expectedRevision: number;
  quotaBytes?: number;
  warningAvailableBytes?: number;
}

interface StorageSettingsRow {
  revision: number;
  value: Record<string, unknown>;
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function settings(row?: StorageSettingsRow): StorageSettings {
  if (!row)
    return Object.freeze({
      revision: 0,
      quotaBytes: 5_368_709_120,
      warningAvailableBytes: 1_073_741_824,
    });
  const { quotaBytes, warningAvailableBytes } = row.value;
  if (
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !isByteCount(quotaBytes) ||
    !isByteCount(warningAvailableBytes) ||
    warningAvailableBytes >= quotaBytes
  )
    throw new Error('ADMIN_SCHEMA: invalid storage settings');
  return Object.freeze({ revision: row.revision, quotaBytes, warningAvailableBytes });
}

export function validateStorageSettingsUpdate(
  input: Record<string, unknown>,
): StorageSettingsUpdate {
  const keys = Object.keys(input);
  const { expectedRevision, quotaBytes, warningAvailableBytes } = input;
  if (
    keys.some(
      (key) => !['expectedRevision', 'quotaBytes', 'warningAvailableBytes'].includes(key),
    ) ||
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision > 2_147_483_647 ||
    (!keys.includes('quotaBytes') && !keys.includes('warningAvailableBytes')) ||
    (keys.includes('quotaBytes') && !isByteCount(quotaBytes)) ||
    (keys.includes('warningAvailableBytes') && !isByteCount(warningAvailableBytes))
  )
    throw new AdminError(400, 'ADMIN_INPUT_INVALID');
  return {
    expectedRevision,
    ...(quotaBytes !== undefined ? { quotaBytes: quotaBytes as number } : {}),
    ...(warningAvailableBytes !== undefined
      ? { warningAvailableBytes: warningAvailableBytes as number }
      : {}),
  };
}

export async function readStorageSettings(pool: Pick<Pool, 'query'>): Promise<StorageSettings> {
  const { rows } = await pool.query<StorageSettingsRow>(
    "SELECT revision,value FROM mio_admin_global_settings WHERE setting_key='storage'",
  );
  return settings(rows[0]);
}

/** Called inside the admin transaction: merge under the row lock, then audit before commit. */
export async function saveStorageSettings(
  client: PoolClient,
  actor: { id: string; username: string },
  input: StorageSettingsUpdate,
): Promise<StorageSettings> {
  const before = settings(
    (
      await client.query<StorageSettingsRow>(
        "SELECT revision,value FROM mio_admin_global_settings WHERE setting_key='storage' FOR UPDATE",
      )
    ).rows[0],
  );
  if (before.revision !== input.expectedRevision) throw new AdminError(409, 'SETTINGS_CONFLICT');
  const quotaBytes = input.quotaBytes ?? before.quotaBytes;
  const warningAvailableBytes = input.warningAvailableBytes ?? before.warningAvailableBytes;
  if (warningAvailableBytes >= quotaBytes) throw new AdminError(400, 'ADMIN_INPUT_INVALID');
  if (quotaBytes === before.quotaBytes && warningAvailableBytes === before.warningAvailableBytes)
    return before;
  const value = JSON.stringify({ quotaBytes, warningAvailableBytes });
  const { rows } =
    before.revision === 0
      ? await client.query<StorageSettingsRow>(
          `INSERT INTO mio_admin_global_settings(setting_key,value,revision,updated_by)
           VALUES('storage',$1::jsonb,1,$2) ON CONFLICT(setting_key) DO NOTHING RETURNING revision,value`,
          [value, actor.username],
        )
      : await client.query<StorageSettingsRow>(
          `UPDATE mio_admin_global_settings SET value=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=now()
           WHERE setting_key='storage' AND revision=$3 RETURNING revision,value`,
          [value, actor.username, input.expectedRevision],
        );
  if (!rows[0]) throw new AdminError(409, 'SETTINGS_CONFLICT');
  const saved = settings(rows[0]);
  await client.query(
    `INSERT INTO mio_admin_audit_logs(id,actor_id,actor_name,action,target_id,summary,before_state,after_state)
     VALUES($1,$2,$3,'settings.storage.update','storage',$4,$5::jsonb,$6::jsonb)`,
    [
      createId(),
      actor.id,
      actor.username,
      `Updated storage settings (rev=${saved.revision})`,
      JSON.stringify(before),
      JSON.stringify(saved),
    ],
  );
  return saved;
}
