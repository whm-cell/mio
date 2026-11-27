import type { AccountDomainStore } from '../account-deletion/domain-store.ts';
import type { AssetGc } from '../assets/gc.ts';

/** Revoke reusable credentials before any bulk cleanup; encrypted job snapshots are also destroyed. */
export async function revokeDeletedAccount(
  store: AccountDomainStore,
  userId: string,
  finalizedAt: Date,
) {
  await store.closeAccount(userId, finalizedAt);
  await store.transaction(userId, async (client) => {
    await client.query(
      `UPDATE mio_provider_configs SET enabled=false,ciphertext=''::bytea,
      nonce=decode(repeat('00',12),'hex'),auth_tag=decode(repeat('00',16),'hex'),
      credential_version=credential_version+1,updated_at=clock_timestamp()
      WHERE owner_id=$1 AND octet_length(ciphertext)>0`,
      [userId],
    );
    await client.query(
      `UPDATE mio_audio_jobs SET admission='{}' WHERE id IN
      (SELECT id FROM mio_audio_jobs WHERE owner_id=$1 AND admission<>'{}'::jsonb ORDER BY id LIMIT 100)`,
      [userId],
    );
  });
  const remaining = Number(
    (
      await store.read<{ count: string }>(
        "SELECT count(*) FROM mio_audio_jobs WHERE owner_id=$1 AND admission<>'{}'::jsonb",
        [userId],
      )
    )[0]!.count,
  );
  return { done: remaining === 0, remaining };
}

export async function deleteProviderAccount(
  store: AccountDomainStore,
  userId: string,
  gc: AssetGc | undefined,
  drain: () => Promise<void>,
) {
  await drain();
  const jobs = await store.read<{ id: string; output_key: string }>(
    'SELECT id,output_key FROM mio_audio_jobs WHERE owner_id=$1 ORDER BY id LIMIT 25',
    [userId],
  );
  if (jobs.length && !gc) throw new Error('ASSET_GC_NOT_READY');
  // Durable media receipt precedes removal of provider-local resource locators. Replaying is idempotent.
  if (jobs.length)
    await gc!.enqueue(
      userId,
      jobs.map((row) => row.output_key),
    );
  return store.batch(userId, 'providers', async (client) => {
    const ids = jobs.map((row) => row.id);
    await client.query('DELETE FROM mio_audio_records WHERE job_id=ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM mio_audio_jobs WHERE owner_id=$1 AND id=ANY($2::uuid[])', [
      userId,
      ids,
    ]);
    const models = (
      await client.query<{ model_key: string }>(
        `SELECT model_key FROM mio_provider_models
      WHERE provider_id IN (SELECT id FROM mio_provider_configs WHERE owner_id=$1) ORDER BY model_key LIMIT 100`,
        [userId],
      )
    ).rows.map((row) => row.model_key);
    await client.query(
      'DELETE FROM mio_provider_model_preferences WHERE model_key=ANY($1::uuid[])',
      [models],
    );
    await client.query(
      'DELETE FROM mio_provider_model_verifications WHERE model_key=ANY($1::uuid[])',
      [models],
    );
    await client.query('DELETE FROM mio_provider_models WHERE model_key=ANY($1::uuid[])', [models]);
    await client.query(
      `DELETE FROM mio_provider_voices WHERE id IN (SELECT v.id FROM mio_provider_voices v
      JOIN mio_provider_configs p ON p.id=v.provider_id WHERE p.owner_id=$1 ORDER BY v.id LIMIT 100)`,
      [userId],
    );
    await client.query(
      `DELETE FROM mio_provider_voice_catalogs WHERE provider_id IN
      (SELECT id FROM mio_provider_configs WHERE owner_id=$1)`,
      [userId],
    );
    await client.query(
      `DELETE FROM mio_provider_configs p WHERE p.owner_id=$1
      AND NOT EXISTS(SELECT 1 FROM mio_provider_models m WHERE m.provider_id=p.id)
      AND NOT EXISTS(SELECT 1 FROM mio_provider_voices v WHERE v.provider_id=p.id)`,
      [userId],
    );
    return (
      await client.query<{ remaining: number }>(
        `SELECT (
      (SELECT count(*) FROM mio_audio_jobs WHERE owner_id=$1)+
      (SELECT count(*) FROM mio_provider_configs WHERE owner_id=$1))::integer AS remaining`,
        [userId],
      )
    ).rows[0]!.remaining;
  });
}
