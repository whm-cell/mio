import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import type { AssetObjectStore, AssetPrincipal } from '../../src/assets/contracts.ts';
import { startAssetDerivatives } from '../../src/assets/derivatives.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { createAssetService } from '../../src/assets/service.ts';
import { AssetStore } from '../../src/assets/store.ts';
import { MediaStore } from '../../src/compute/media/store.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { authDatabase } from '../support/auth-database.ts';

const actor = { userId: 'derivatives-owner', sessionId: 'session' };
const sources = new Map<string, string>();
const objects: AssetObjectStore = {
  uploadUrl: (key) => key,
  downloadUrl: (key) => 'https://private.example/' + key,
  async head(key) {
    const etag = sources.get(key);
    if (!etag) throw Object.assign(new Error('MISSING'), { statusCode: 404 });
    return { size: 12, etag };
  },
  async copy(source, target, etag) {
    if (sources.get(source) !== etag) throw new Error('ETAG_MISMATCH');
    sources.set(target, 'raw-' + etag);
  },
  async delete(key) {
    sources.delete(key);
  },
};

async function stage(service: ReturnType<typeof createAssetService>, owner: AssetPrincipal) {
  const { assetId, uploadUrl } = await service.create(owner, 'clip.mp4', 'VIDEO/MP4', 12);
  sources.set(uploadUrl, 'staging-fixture');
  return assetId;
}

it('commits one ordinary intent atomically and resumes quota-pending admission with the same request identity', async () => {
  const db = await authDatabase();
  const pool = new Pool({ connectionString: db.url });
  const store = new AssetStore(new Pool({ connectionString: db.url }), true);
  const service = createAssetService(store, objects);
  const media = new MediaStore(new Pool({ connectionString: db.url }));
  let scheduler: ReturnType<typeof startAssetDerivatives> | undefined;
  try {
    await pool.query(assetSchemaSQL);
    await pool.query(computeSchemaSQL);
    const id = await stage(service, actor);
    expect(await service.complete(actor, id)).toMatchObject({
      status: 'ready',
      downloadUrl: expect.stringContaining(id),
      derivatives: {
        enabled: true,
        status: 'enabled',
        profiles: [{ profile: 'ordinary', status: 'pending' }],
      },
    });
    expect(await service.complete(actor, id)).toMatchObject({ status: 'ready' });
    const { rows } = await pool.query<{ request_id: string }>(
      'SELECT request_id FROM mio_asset_derivative_intents WHERE asset_id=$1',
      [id],
    );
    expect(rows).toHaveLength(1);
    const snapshot = async (assetId: string) => {
      const raw = (await store.owned(assetId, actor.userId)).raw_key!;
      return { assetId, key: raw, sizeBytes: 12, etag: sources.get(raw)! };
    };
    const frozen = await snapshot(id);
    const create = vi.fn(
      async (
        principal: AssetPrincipal,
        request: {
          requestId: string;
          operation: 'video.derivatives';
          inputs: [{ assetId: string }];
          parameters: { profile: 'ordinary' };
        },
      ) => {
        const result = await media.create(principal.userId, request, [frozen]);
        return { job: { jobId: result.job.id } };
      },
    );
    for (let index = 0; index < 10; index++)
      await media.create(
        actor.userId,
        {
          requestId: randomUUID(),
          operation: 'media.probe',
          inputs: [{ assetId: id }],
          parameters: {},
        },
        [frozen],
      );

    scheduler = startAssetDerivatives(store, { create });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await scheduler.close();
    expect(await service.get(actor, id)).toMatchObject({
      status: 'ready',
      downloadUrl: expect.stringContaining(id),
      derivatives: { profiles: [{ jobId: null, status: 'pending' }] },
    });
    expect(await media.request(actor.userId, rows[0]!.request_id)).toBeUndefined();

    const makeDue = () =>
      pool.query(
        'UPDATE mio_asset_derivative_intents SET next_attempt_at=now() WHERE asset_id=$1',
        [id],
      );
    await pool.query("UPDATE mio_media_jobs SET state='cancelled' WHERE operation='media.probe'");
    await makeDue();
    scheduler = startAssetDerivatives(store, { create });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await scheduler.close();
    const first = await media.request(actor.userId, rows[0]!.request_id);
    expect(first?.id).toBeTruthy();
    expect(await service.get(actor, id)).toMatchObject({
      derivatives: { profiles: [{ jobId: first?.id, status: 'scheduled' }] },
    });

    // Recreate the visible effect of a crash after admission committed but before linking ran.
    await pool.query('UPDATE mio_asset_derivative_intents SET job_id=NULL WHERE asset_id=$1', [id]);
    await makeDue();
    scheduler = startAssetDerivatives(store, { create });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    await scheduler.close();
    expect(create.mock.calls.map(([, body]) => body.requestId)).toEqual(
      Array(3).fill(rows[0]!.request_id),
    );
    for (const errorCode of ['INPUT_INVALID', 'CAPABILITY_UNAVAILABLE']) {
      await pool.query("UPDATE mio_media_jobs SET state='failed',error_code=$2 WHERE id=$1", [
        first?.id,
        errorCode,
      ]);
      expect(await service.get(actor, id)).toMatchObject({
        status: 'ready',
        downloadUrl: expect.stringContaining(id),
        derivatives: { profiles: [{ jobId: first?.id, status: 'failed', errorCode }] },
      });
    }
    const jobs = await pool.query(
      "SELECT id FROM mio_media_jobs WHERE operation='video.derivatives'",
    );
    expect(jobs.rows).toEqual([{ id: first?.id }]);
    await expect(service.get({ ...actor, userId: 'different-owner' }, id)).rejects.toMatchObject({
      status: 404,
      code: 'ASSET_NOT_FOUND',
    });
  } finally {
    await scheduler?.close();
    await Promise.all([service.close(), media.close(), pool.end()]);
    await db.close();
    sources.clear();
  }
});

it('preserves pre-upgrade assets, exposes disabled video, and rolls back ready if the intent insert fails', async () => {
  const db = await authDatabase();
  const pool = new Pool({ connectionString: db.url });
  const enabledStore = new AssetStore(new Pool({ connectionString: db.url }), true);
  const enabled = createAssetService(enabledStore, objects);
  const disabled = createAssetService(
    new AssetStore(new Pool({ connectionString: db.url })),
    objects,
  );
  try {
    await pool.query(assetSchemaSQL);
    const id = await stage(disabled, actor);
    expect(await disabled.complete(actor, id)).toMatchObject({
      status: 'ready',
      derivatives: { enabled: false, status: 'disabled', profiles: [] },
    });
    expect((await pool.query('SELECT 1 FROM mio_asset_derivative_intents')).rowCount).toBe(0);

    await pool.query(assetSchemaSQL);
    await pool.query(computeSchemaSQL);
    expect(await enabled.get(actor, id)).toMatchObject({
      status: 'ready',
      derivatives: { enabled: true, status: 'not_applicable', profiles: [] },
    });
    const bad = { ...actor, userId: 'reject-intent' };
    const rejected = await stage(enabled, bad);
    await pool.query(
      "ALTER TABLE mio_asset_derivative_intents ADD CONSTRAINT reject_test_owner CHECK(owner_id <> 'reject-intent')",
    );
    await expect(enabled.complete(bad, rejected)).rejects.toMatchObject({ code: '23514' });
    expect(await enabledStore.owned(rejected, bad.userId)).toMatchObject({
      state: 'finalizing',
      raw_key: null,
    });
    expect((await pool.query('SELECT 1 FROM mio_asset_derivative_intents')).rowCount).toBe(0);
  } finally {
    await Promise.all([enabled.close(), disabled.close(), pool.end()]);
    await db.close();
    sources.clear();
  }
});
