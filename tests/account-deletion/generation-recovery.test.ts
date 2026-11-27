import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { AccountDomainStore } from '../../src/account-deletion/domain-store.ts';
import { createAssetGc } from '../../src/assets/gc.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import {
  deleteGenerationFiles,
  deleteGenerationRows,
} from '../../src/generations/account-deletion.ts';
import { GenerationFiles } from '../../src/generations/image/files.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { authDatabase } from '../support/auth-database.ts';

async function fixture() {
  const database = await authDatabase();
  const pool = new Pool({ connectionString: database.url });
  await pool.query(assetSchemaSQL + generationSchemaSQL);
  const directory = await mkdtemp(join(tmpdir(), 'mio-u3-image-retry-'));
  const files = new GenerationFiles(directory);
  await files.initialize();
  const keys = new Set<string>();
  const objects: AssetObjectStore = {
    uploadUrl: () => '',
    downloadUrl: () => '',
    copy: async () => {},
    hasPendingWrites: () => false,
    head: async (key) => {
      if (!keys.has(key)) throw Object.assign(new Error('absent'), { statusCode: 404 });
      return { size: 1, etag: 'fixture' };
    },
    delete: async (key) => {
      keys.delete(key);
    },
  };
  return {
    database,
    pool,
    directory,
    files,
    keys,
    objects,
    async image(owner: string, id = randomUUID(), execution = true) {
      const command = { messageId: randomUUID(), input: { n: 1 } };
      const key = `mio/derived/${id}/images/0-${randomUUID()}.png`;
      keys.add(key);
      await pool.query(
        "INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state) VALUES($1,$2,$3,'hash',$4,'completed')",
        [id, owner, randomUUID(), command],
      );
      const checkpoint = {
        version: 1 as const,
        revision: 0,
        jobId: id,
        commandId: command.messageId,
        expectedCount: 1,
        receivedAll: true,
        images: [],
        invalidIndices: [],
        outputs: {},
        attemptedKeys: { '0': [key] },
        attempts: 1,
        lastRecoverySequence: 0,
      };
      const ref = await files.save(checkpoint);
      await writeFile(join(directory, id, 'private.png'), 'private bytes');
      if (execution)
        await pool.query(
          "INSERT INTO mio_image_executions(job_id,phase,checkpoint) VALUES($1,'done',$2)",
          [id, ref],
        );
      return { id, key, checkpoint };
    },
    async close() {
      await pool.end();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it.each(['interruption', 'metadata rollback', 'later file item failure'])(
  'resumes the same image batch after %s without losing GC keys or another owner',
  async (fault) => {
    const f = await fixture();
    let store = new AccountDomainStore(new Pool({ connectionString: f.database.url }));
    try {
      const ids = [randomUUID(), randomUUID()].sort();
      const first = await f.image('old', ids[0]);
      const second = await f.image('old', ids[1]);
      const unrelated = await f.image('other');
      await store.closeAccount('old', new Date());
      let gc = createAssetGc(store, f.objects, true);
      const clean = () =>
        deleteGenerationFiles(
          store,
          gc,
          'old',
          f.directory,
          AbortSignal.timeout(5000),
          async () => {},
        );
      if (fault === 'later file item failure') {
        await writeFile(join(f.directory, second.id, 'receipt.json'), '{broken');
        await expect(clean()).rejects.toThrow();
        await f.files.save(second.checkpoint);
      } else {
        const batch = await clean();
        if (fault === 'metadata rollback') {
          await f.pool
            .query(`CREATE FUNCTION reject_image_delete() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'INTERRUPTED_METADATA_DELETE'; END $$;
            CREATE TRIGGER reject_image_delete BEFORE DELETE ON mio_image_jobs
            FOR EACH ROW EXECUTE FUNCTION reject_image_delete()`);
          await expect(deleteGenerationRows(store, 'old', batch)).rejects.toThrow(
            'INTERRUPTED_METADATA_DELETE',
          );
          await f.pool.query('DROP TRIGGER reject_image_delete ON mio_image_jobs');
        }
        // Simulate process exit after rm, before the metadata transaction can commit.
      }
      await expect(readFile(join(f.directory, first.id, 'receipt.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(
        (await f.pool.query("SELECT id FROM mio_image_jobs WHERE owner_id='old'")).rowCount,
      ).toBe(2);
      expect(
        (
          await f.pool.query('SELECT object_key FROM mio_asset_gc_requests WHERE object_key=$1', [
            first.key,
          ])
        ).rowCount,
      ).toBe(1);
      await store.close();
      store = new AccountDomainStore(new Pool({ connectionString: f.database.url }));
      gc = createAssetGc(store, f.objects, true);
      await expect(deleteGenerationRows(store, 'old', await clean())).resolves.toEqual({
        done: true,
        remaining: 0,
      });
      await expect(gc.collect('old', AbortSignal.timeout(5000))).resolves.toEqual({
        done: true,
        remaining: 0,
      });
      expect(f.keys).toEqual(new Set([unrelated.key]));
      expect((await f.pool.query('SELECT id FROM mio_image_jobs')).rows).toEqual([
        { id: unrelated.id },
      ]);
      expect(
        (
          await f.pool.query(
            "SELECT remaining,completed_at FROM mio_account_cleanup_receipts WHERE user_id='old' AND domain='generations'",
          )
        ).rows[0],
      ).toMatchObject({ remaining: 0, completed_at: expect.any(Date) });
      expect(await readFile(join(f.directory, unrelated.id, 'private.png'), 'utf8')).toBe(
        'private bytes',
      );
    } finally {
      await store.close();
      await f.close();
    }
  },
);

it('keeps a genuinely missing image checkpoint pending rather than accepting it as a completed handoff', async () => {
  const f = await fixture();
  const store = new AccountDomainStore(new Pool({ connectionString: f.database.url }));
  try {
    const image = await f.image('old');
    await store.closeAccount('old', new Date());
    await rm(join(f.directory, image.id), { recursive: true });
    await expect(
      deleteGenerationFiles(
        store,
        createAssetGc(store, f.objects, true),
        'old',
        f.directory,
        AbortSignal.timeout(5000),
        async () => {},
      ),
    ).rejects.toThrow('IMAGE_CHECKPOINT_MISSING');
    expect((await f.pool.query('SELECT id FROM mio_image_jobs')).rowCount).toBe(1);
    expect((await f.pool.query('SELECT object_key FROM mio_asset_gc_requests')).rowCount).toBe(0);
  } finally {
    await store.close();
    await f.close();
  }
});

it('persists the file handoff when a recovery receipt predates its execution row', async () => {
  const f = await fixture();
  const store = new AccountDomainStore(new Pool({ connectionString: f.database.url }));
  try {
    const image = await f.image('old', randomUUID(), false);
    await store.closeAccount('old', new Date());
    const gc = createAssetGc(store, f.objects, true);
    const clean = () =>
      deleteGenerationFiles(
        store,
        gc,
        'old',
        f.directory,
        AbortSignal.timeout(5000),
        async () => {},
      );
    await clean();
    await expect(deleteGenerationRows(store, 'old', await clean())).resolves.toEqual({
      done: true,
      remaining: 0,
    });
    await gc.collect('old', AbortSignal.timeout(5000));
    expect(f.keys.has(image.key)).toBe(false);
  } finally {
    await store.close();
    await f.close();
  }
});
