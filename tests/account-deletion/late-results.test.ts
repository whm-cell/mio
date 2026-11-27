import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { mediaObjectPrefix, parseMediaResult } from '@mio/compute-contracts';
import type { MediaResult, ComputeResultV1 } from '@mio/compute-contracts';
import { authDatabase } from '../support/auth-database.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { AccountDomainStore } from '../../src/account-deletion/domain-store.ts';
import { ComputeStore } from '../../src/compute/transcode/store.ts';
import { MediaStore } from '../../src/compute/media/store.ts';
import { createAssetGc } from '../../src/assets/gc.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { deleteComputeAccount } from '../../src/compute/account-deletion.ts';
import {
  AccountResultClosed,
  reclaimDeletedMedia,
  reclaimDeletedTranscode,
} from '../../src/compute/deleted-results.ts';

it('offline Worker B does not block local deletion; A intercepts exact old attempts and reclaims validated output/manifest keys after metadata is gone', async () => {
  const database = await authDatabase(),
    pool = new Pool({ connectionString: database.url });
  const domain = new AccountDomainStore(pool);
  const transcodes = new ComputeStore(new Pool({ connectionString: database.url })),
    media = new MediaStore(new Pool({ connectionString: database.url }));
  try {
    await pool.query(assetSchemaSQL + computeSchemaSQL);
    const owner = 'old',
      id = randomUUID(),
      raw = `mio/raw/${id}/${randomUUID()}`;
    await pool.query(
      `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,staging_deleted_at)
      VALUES($1,$2,'private','video/mp4',1,$3,$3,'ready',now(),now())`,
      [id, owner, raw],
    );
    const tc = (await transcodes.create(owner, randomUUID(), id, raw, 1, 'input')).job;
    const m = (
      await media.create(
        owner,
        {
          operation: 'video.trim',
          requestId: randomUUID(),
          inputs: [{ assetId: id }],
          parameters: { startSeconds: 0, endSeconds: 1 },
        },
        [{ assetId: id, key: raw, sizeBytes: 1, etag: 'input' }],
      )
    ).job;
    const output = `mio/derived/${tc.id}/${tc.attempt_id}/result.mp4`;
    const tcResult: ComputeResultV1 = {
      version: 1,
      type: 'transcode.result',
      messageId: randomUUID(),
      jobId: tc.id,
      attemptId: tc.attempt_id,
      attempt: tc.attempt,
      commandId: tc.command_id,
      state: 'succeeded',
      output: { key: output, sizeBytes: 1, etag: 'output', sha256: 'a'.repeat(64) },
    };
    const prefix = mediaObjectPrefix(m.id, m.attempt_id),
      file = prefix + 'result.mp4',
      manifestKey = prefix + 'manifest.json';
    const manifest = Buffer.from(
      JSON.stringify({
        version: 1,
        jobId: m.id,
        attemptId: m.attempt_id,
        profile: 'standard-media',
        operation: m.operation,
        files: [
          {
            key: file,
            name: 'result.mp4',
            role: 'primary',
            contentType: 'video/mp4',
            sizeBytes: 1,
            etag: 'file',
            sha256: 'b'.repeat(64),
          },
        ],
        data: {},
      }),
    );
    const hash = createHash('sha256').update(manifest).digest('hex');
    const result: MediaResult = parseMediaResult({
      version: 1,
      type: 'media.result',
      messageId: randomUUID(),
      jobId: m.id,
      attemptId: m.attempt_id,
      attempt: m.attempt,
      commandId: m.command_id,
      state: 'succeeded',
      manifest: { key: manifestKey, sizeBytes: manifest.length, etag: 'manifest', sha256: hash },
    });
    const keys = new Set([output, file, manifestKey]);
    const objects: AssetObjectStore = {
      uploadUrl: () => '',
      downloadUrl: () => '',
      copy: async () => {},
      hasPendingWrites: () => false,
      delete: async (key) => {
        keys.delete(key);
      },
      readMedia: async (key) => {
        if (key !== manifestKey) throw new Error('KEY_OUTSIDE_ATTEMPT');
        return manifest;
      },
      head: async (key) => {
        if (!keys.has(key)) throw Object.assign(new Error('absent'), { statusCode: 404 });
        return key === manifestKey
          ? { size: manifest.length, etag: 'manifest', sha256: hash }
          : { size: 1, etag: 'file', sha256: 'b'.repeat(64) };
      },
    };
    const gc = createAssetGc(domain, objects, true);
    await pool.query('INSERT INTO mio_media_inbox(id,payload) VALUES($1,$2)', [
      result.messageId,
      { ...result, _verificationErrors: ['temporary'] },
    ]);
    await pool.query('INSERT INTO mio_compute_inbox(id,payload) VALUES($1,$2)', [
      tcResult.messageId,
      tcResult,
    ]);
    await domain.closeAccount(owner, new Date());
    await expect(transcodes.accept(tcResult)).rejects.toBeInstanceOf(AccountResultClosed);
    await expect(media.accept(result)).rejects.toBeInstanceOf(AccountResultClosed);
    expect(await transcodes.claim()).toBeUndefined();
    expect(await media.claim('encode')).toBeUndefined();
    expect(
      (await deleteComputeAccount(domain, gc, owner, objects, AbortSignal.timeout(5000))).done,
    ).toBe(false);
    expect(
      (
        await pool.query(
          'SELECT object_key FROM mio_asset_gc_requests WHERE owner_id=$1 AND object_key=$2',
          [owner, file],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (await deleteComputeAccount(domain, gc, owner, objects, AbortSignal.timeout(5000))).done,
    ).toBe(false);
    expect(
      (await deleteComputeAccount(domain, gc, owner, objects, AbortSignal.timeout(5000))).done,
    ).toBe(true);
    const tcAttempt = await transcodes.deletedAttempt(tcResult),
      mediaAttempt = await media.deletedAttempt(result);
    expect(tcAttempt?.owner_id).toBe(owner);
    expect(mediaAttempt?.owner_id).toBe(owner);
    expect(await media.deletedAttempt({ ...result, attemptId: randomUUID() })).toBeUndefined();
    await reclaimDeletedTranscode(tcAttempt!, tcResult, gc);
    await expect(
      reclaimDeletedMedia(
        mediaAttempt!,
        {
          ...result,
          state: 'succeeded',
          manifest: {
            ...(result.state === 'succeeded'
              ? result.manifest
              : { key: '', sizeBytes: 0, etag: '', sha256: '' }),
            key: `${prefix}../new-user/key`,
          },
        } as MediaResult,
        objects,
        gc,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow();
    await reclaimDeletedMedia(mediaAttempt!, result, objects, gc, AbortSignal.timeout(5000));
    expect((await gc.collect(owner, AbortSignal.timeout(5000))).done).toBe(true);
    expect(keys.size).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT id FROM mio_compute_inbox UNION ALL SELECT id FROM mio_media_inbox',
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query('SELECT id FROM mio_assets WHERE raw_key=ANY($1::text[])', [
          [output, file, manifestKey],
        ])
      ).rowCount,
    ).toBe(0);
    await reclaimDeletedMedia(mediaAttempt!, result, objects, gc, AbortSignal.timeout(5000));
    expect((await gc.collect(owner, AbortSignal.timeout(5000))).done).toBe(true);
    // A replay after completedAt can carry another physical upload at the same immutable key.
    keys.add(output);
    await reclaimDeletedTranscode(tcAttempt!, tcResult, gc);
    await gc.collect(owner, AbortSignal.timeout(5000));
    expect(keys.size).toBe(0);
  } finally {
    await transcodes.close();
    await media.close();
    await domain.close();
    await database.close();
  }
});
