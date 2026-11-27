import type { Pool, PoolClient } from 'pg';
import { epochMs } from '@mio/foundation/time';
import { createId } from '@mio/foundation/identifiers';
import { AdminError } from './contracts.ts';

export interface CreationLogSettings {
  revision: number;
  retentionDays: number | null;
}

function settings(row?: { revision: number; value: Record<string, unknown> }): CreationLogSettings {
  if (!row) return { revision: 0, retentionDays: null };
  const days = row.value.retentionDays;
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1)
    throw new Error('ADMIN_SCHEMA: invalid creation log retention');
  return { revision: row.revision, retentionDays: days };
}

export async function readCreationLogSettings(
  pool: Pick<Pool, 'query'>,
): Promise<CreationLogSettings> {
  const { rows } = await pool.query<{ revision: number; value: Record<string, unknown> }>(
    "SELECT revision,value FROM mio_admin_global_settings WHERE setting_key='creation_logs'",
  );
  return settings(rows[0]);
}

export async function saveCreationLogSettings(
  client: PoolClient,
  actor: { id: string; username: string },
  expectedRevision: number,
  retentionDays: number,
): Promise<CreationLogSettings> {
  const before =
    expectedRevision === 0
      ? undefined
      : (
          await client.query<{
            revision: number;
            value: Record<string, unknown>;
          }>(
            "SELECT revision,value FROM mio_admin_global_settings WHERE setting_key='creation_logs' FOR UPDATE",
          )
        ).rows[0];
  if (expectedRevision !== 0 && before?.revision !== expectedRevision)
    throw new AdminError(409, 'SETTINGS_CONFLICT');
  let saved: { revision: number; value: Record<string, unknown> } | undefined;
  if (expectedRevision === 0)
    saved = (
      await client.query<{ revision: number; value: Record<string, unknown> }>(
        `INSERT INTO mio_admin_global_settings(setting_key,value,revision,updated_by)
     VALUES('creation_logs',$1::jsonb,1,$2) ON CONFLICT(setting_key) DO NOTHING RETURNING revision,value`,
        [JSON.stringify({ retentionDays }), actor.username],
      )
    ).rows[0];
  else
    saved = (
      await client.query<{ revision: number; value: Record<string, unknown> }>(
        `UPDATE mio_admin_global_settings SET value=$1::jsonb,revision=revision+1,updated_by=$2,updated_at=now()
     WHERE setting_key='creation_logs' AND revision=$3 RETURNING revision,value`,
        [JSON.stringify({ retentionDays }), actor.username, expectedRevision],
      )
    ).rows[0];
  if (!saved) throw new AdminError(409, 'SETTINGS_CONFLICT');
  const result = settings(saved);
  await client.query(
    `INSERT INTO mio_admin_audit_logs(id,actor_id,actor_name,action,target_id,summary,before_state,after_state)
     VALUES($1,$2,$3,'settings.creation-logs.update','creation_logs',$4,$5::jsonb,$6::jsonb)`,
    [
      createId(),
      actor.id,
      actor.username,
      `Updated creation log retention (days=${retentionDays}, rev=${result.revision})`,
      JSON.stringify(settings(before)),
      JSON.stringify(result),
    ],
  );
  return result;
}

/** Only a fresh snapshot can authorize reads/deletion; loss of admin DB never means unlimited retention. */
export function createCreationRetentionSnapshot(store: {
  initialCreationLogSettings: CreationLogSettings;
  readCreationLogSettings(): Promise<CreationLogSettings>;
}) {
  let value = store.initialCreationLogSettings;
  let expires = epochMs() + 5000;
  let pending: Promise<CreationLogSettings> | undefined;
  let closed = false;
  const save = (next: CreationLogSettings, started = epochMs()) => {
    if (!closed && next.revision >= value.revision) {
      value = next;
      expires = started + 5000;
    }
    return value;
  };
  const refresh = () =>
    (pending ??= (async () => {
      const started = epochMs();
      return save(await store.readCreationLogSettings(), started);
    })().finally(() => {
      pending = undefined;
    }));
  const timer = setInterval(() => {
    void refresh().catch(() => {});
  }, 1000);
  timer.unref();
  return {
    save,
    refresh,
    get(): number | null {
      if (closed || epochMs() >= expires)
        throw new AdminError(503, 'CREATION_LOG_POLICY_UNAVAILABLE');
      return value.retentionDays;
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await pending?.catch(() => {});
    },
  };
}
