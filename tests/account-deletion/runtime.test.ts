import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { authDatabase } from '../support/auth-database.ts';
import { deletionAuthFixture } from './fixture.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { notificationSchemaSQL } from '../../src/notifications/schema.ts';
import { conversationSchemaSQL } from '../../src/conversations/schema.ts';
import { materialSchemaSQL } from '../../src/materials/schema.ts';
import { materialAuthSchemaSQL } from '../../src/materials/auth-schema.ts';
import { AssetStore } from '../../src/assets/store.ts';
import { createAssetService } from '../../src/assets/service.ts';
import type { AssetObjectStore } from '../../src/assets/contracts.ts';
import { createAccountDeletionRuntime } from '../../src/account-deletion/runtime.ts';
import { replayAccountDeletion } from '../../src/auth/deletion.ts';
import { createConversationStore } from '../../src/conversations/store.ts';
import { createConversationService } from '../../src/conversations/service.ts';
import type { ConversationEngine } from '../../src/conversations/contracts.ts';
import { purgeNativeSession } from '../../src/dsh/account-deletion.ts';
import { GenerationFiles } from '../../src/generations/image/files.ts';

it('cleans actual independently pooled online domains and A files, keeps public/new-account data, and waits for the external archive', async () => {
  const f = await deletionAuthFixture(),
    others = await Promise.all(Array.from({ length: 4 }, () => authDatabase()));
  const [mediaDb, providerDb, noticeDb, conversationDb] = others;
  const pools = others.map((db) => new Pool({ connectionString: db.url })),
    [media, providers, notices, conversation] = pools as [Pool, Pool, Pool, Pool];
  const directory = await mkdtemp(join(tmpdir(), 'mio-u3-'));
  let runtime: Awaited<ReturnType<typeof createAccountDeletionRuntime>> | undefined;
  let assets: ReturnType<typeof createAssetService> | undefined,
    conversations: ReturnType<typeof createConversationService> | undefined;
  try {
    await media.query(
      assetSchemaSQL +
        generationSchemaSQL +
        computeSchemaSQL +
        materialSchemaSQL +
        materialAuthSchemaSQL,
    );
    await providers.query(providerSchemaSQL);
    await notices.query(notificationSchemaSQL);
    await conversation.query(conversationSchemaSQL);
    const actor = await f.register(),
      fresh = await f.register();
    const id = randomUUID(),
      raw = `mio/raw/${id}/${randomUUID()}`,
      newId = randomUUID(),
      newRaw = `mio/raw/${newId}/${randomUUID()}`;
    const imageJob = randomUUID(),
      imageKey = `mio/derived/${imageJob}/images/0-${randomUUID()}.png`,
      audioJob = randomUUID(),
      audioKey = `mio/raw/${randomUUID()}/${randomUUID()}`;
    const keys = new Set([raw, newRaw, imageKey, audioKey]),
      archived = new Map<string, unknown>();
    let archiveReady = false;
    const objects: AssetObjectStore = {
      uploadUrl: () => '',
      downloadUrl: () => '',
      copy: async () => {},
      hasPendingWrites: () => false,
      head: async (key) => {
        if (!keys.has(key)) throw Object.assign(new Error('absent'), { statusCode: 404 });
        return { size: 1, etag: 'e' };
      },
      delete: vi.fn(async (key) => {
        keys.delete(key);
      }),
      archiveAccountDeletion: vi.fn(async (value) => {
        if (!archiveReady) throw new Error('AUDIT_OFFLINE');
        archived.set(value.userId, value);
      }),
    };
    for (const [asset, owner, key] of [
      [id, actor.userId, raw],
      [newId, fresh.userId, newRaw],
    ])
      await media.query(
        `INSERT INTO mio_assets(id,owner_id,filename,content_type,size_bytes,staging_key,raw_key,state,expires_at,staging_deleted_at)
        VALUES($1,$2,'private.png','image/png',1,$3,$3,'ready',now(),now())`,
        [asset, owner, key],
      );
    // A write-ahead locator can outlive ownership; its GC request must retain the live owner's key.
    await media.query(
      "INSERT INTO mio_asset_gc_objects(object_key,owner_id,state) VALUES($1,$2,'held')",
      [newRaw, actor.userId],
    );
    await f.pool.query('UPDATE "user" SET "avatarAssetId"=$2 WHERE id=$1', [actor.userId, id]);
    await media.query(
      "INSERT INTO mio_asset_holders(owner_id,asset_id,holder_type,holder_id) VALUES($1,$2,'avatar',$1)",
      [actor.userId, id],
    );
    const provider = randomUUID();
    await providers.query(
      `INSERT INTO mio_provider_configs(id,owner_id,revision,credential_version,cipher_format,master_key_id,nonce,ciphertext,auth_tag)
      VALUES($1,$2,1,1,1,'test',$3,$4,$5)`,
      [provider, actor.userId, Buffer.alloc(12), Buffer.from('private-key'), Buffer.alloc(16)],
    );
    await providers.query(
      `INSERT INTO mio_audio_jobs(id,owner_id,request_id,digest,kind,status,input,admission,output_bytes,output_asset_id,output_key)
      VALUES($1,$2,$3,'digest','tts','failed','{"text":"private speech"}','{"credential":"private snapshot"}',$4,$5,$6)`,
      [audioJob, actor.userId, randomUUID(), Buffer.from('private audio'), randomUUID(), audioKey],
    );
    const group = randomUUID();
    await media.query(
      `INSERT INTO mio_material_groups(id,owner_id,provider_type,provider_config_id,upstream_scope,group_type,name,auth_status,state)
      VALUES($1,$2,'onelink',$3,'onelink-volc-ark','aigc','private group','not_applicable','ready')`,
      [group, actor.userId, provider],
    );
    await media.query(
      `INSERT INTO mio_materials(id,owner_id,provider_type,group_id,source_asset_id,asset_type,name,state,registration_credential_version)
      VALUES($1,$2,'onelink',$3,$4,'image','private material','active',1)`,
      [randomUUID(), actor.userId, group, id],
    );
    await media.query(
      `INSERT INTO mio_material_auth_sessions(id,owner_id,provider_type,provider_config_id,credential_version,request_id,input_hash,state,protocol_snapshot,return_target,group_id,expires_at)
      SELECT gen_random_uuid(),$1,'onelink',$2,1,gen_random_uuid(),repeat('a',64),'completed',
        '{"version":1}','materials',$3,now()+interval '20 minutes' FROM generate_series(1,101)`,
      [actor.userId, provider, group],
    );
    const message = randomUUID();
    await notices.query(
      "INSERT INTO mio_announcements(id,title,body) VALUES($1,'public','public body')",
      [message],
    );
    await notices.query(
      'INSERT INTO mio_announcement_reads(user_id,announcement_id) VALUES($1,$2),($3,$2)',
      [actor.userId, message, fresh.userId],
    );
    await media.query(
      `INSERT INTO mio_creation_logs(id,owner_id,media_type,job_id,event_kind,title,summary,occurred_at)
      VALUES($1,$2,'image',$3,'completed','private title','private summary',now())`,
      [randomUUID(), actor.userId, imageJob],
    );
    const command = { messageId: randomUUID(), input: { n: 1 } };
    await media.query(
      "INSERT INTO mio_image_jobs(id,owner_id,request_id,input_hash,command,state) VALUES($1,$2,$3,'hash',$4,'completed')",
      [imageJob, actor.userId, randomUUID(), command],
    );
    const files = new GenerationFiles(directory);
    await files.initialize();
    await mkdir(join(directory, imageJob));
    await writeFile(join(directory, imageJob, '0.png'), 'private image');
    const ref = await files.save({
      version: 1,
      revision: 0,
      jobId: imageJob,
      commandId: command.messageId,
      expectedCount: 1,
      receivedAll: true,
      images: [
        {
          index: 0,
          file: join(imageJob, '0.png'),
          format: 'png',
          sizeBytes: 13,
          sha256: 'a'.repeat(64),
        },
      ],
      invalidIndices: [],
      outputs: {},
      attemptedKeys: { '0': [imageKey] },
      attempts: 1,
      lastRecoverySequence: 0,
    });
    await media.query(
      "INSERT INTO mio_image_executions(job_id,phase,checkpoint) VALUES($1,'done',$2)",
      [imageJob, ref],
    );
    const conversationId = randomUUID(),
      native = 'u3-native-' + randomUUID();
    const roots = [join(directory, 'sessions'), join(directory, 'sessions-zstd')];
    for (const root of roots) {
      await mkdir(join(root, '_no-cwd', native), { recursive: true });
      await writeFile(join(root, '_no-cwd', native, '0.jsonl'), 'private messages');
    }
    const engine: ConversationEngine = {
      available: true,
      create: async () => {},
      rename: async () => '',
      history: async () => ({ items: [], hasMore: false, nextAfterSeq: 0 }),
      run: async () => 'completed' as const,
      cancel: vi.fn(async () => {}),
      purgeSession: (id, signal) => purgeNativeSession(roots, id, signal),
      close: async () => {},
    };
    await conversation.query(
      "INSERT INTO mio_conversations(id,owner_id,dsh_session_id,state,active_request) VALUES($1,$2,$3,'ready','request')",
      [conversationId, actor.userId, native],
    );
    conversations = createConversationService(
      await createConversationStore(conversationDb!.url),
      engine,
    );
    await conversation.query("UPDATE mio_conversations SET active_request='request' WHERE id=$1", [
      conversationId,
    ]);
    assets = createAssetService(
      new AssetStore(new Pool({ connectionString: mediaDb!.url })),
      objects,
    );
    const at = new Date(Date.now() - 301000);
    await replayAccountDeletion(f.pool, { userId: actor.userId, finalizedAt: at.toISOString() }, [
      'auth',
      'archive',
      'assets',
      'providers',
      'notifications',
      'conversations',
      'materials',
      'generations',
      'compute',
      'creation-logs',
    ]);
    runtime = await createAccountDeletionRuntime({
      auth: f.auth,
      authDatabaseURL: f.database.url,
      providers: { databaseURL: providerDb!.url, drain: async () => {} },
      notificationsDatabaseURL: noticeDb!.url,
      materialsDatabaseURL: mediaDb!.url,
      conversations: () => conversations,
      media: {
        databaseURL: mediaDb!.url,
        objects,
        deleteEnabled: true,
        generationDirectory: directory,
        cleanStaging: () => assets!.cleanup(),
        drainAssets: (owner) => assets!.drainAccount(owner),
        drainGenerations: async () => {},
      },
    });
    runtime.wake(actor.userId, at);
    await expect
      .poll(async () => {
        await runtime!.round();
        return (
          await f.pool.query('SELECT failed_step FROM mio_account_cleanup_jobs WHERE user_id=$1', [
            actor.userId,
          ])
        ).rows[0].failed_step;
      })
      .toBe('archive');
    expect((await providers.query('SELECT owner_id FROM mio_provider_configs')).rowCount).toBe(0);
    expect((await conversation.query('SELECT id FROM mio_conversations')).rowCount).toBe(0);
    expect((await media.query('SELECT id FROM mio_material_auth_sessions')).rowCount).toBe(0);
    expect(engine.cancel).toHaveBeenCalledWith(native, 'request');
    await expect(readFile(join(directory, imageJob, '0.png'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    for (const root of roots)
      await expect(readFile(join(root, '_no-cwd', native, '0.jsonl'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    expect(
      (await media.query('SELECT id FROM mio_assets WHERE owner_id=$1', [actor.userId])).rowCount,
    ).toBe(0);
    expect(
      (await notices.query('SELECT id FROM mio_announcements WHERE id=$1', [message])).rowCount,
    ).toBe(1);
    expect((await notices.query('SELECT user_id FROM mio_announcement_reads')).rows).toEqual([
      { user_id: fresh.userId },
    ]);
    expect(keys).toEqual(new Set([newRaw]));
    expect(await assets.get(fresh, newId)).toMatchObject({ assetId: newId, status: 'ready' });
    expect(
      (
        await media.query(
          'SELECT retained_refs,settled_at FROM mio_asset_gc_requests WHERE owner_id=$1 AND object_key=$2',
          [actor.userId, newRaw],
        )
      ).rows[0],
    ).toMatchObject({ retained_refs: 1, settled_at: expect.any(Date) });
    expect(
      (await f.pool.query('SELECT completed_at FROM mio_account_cleanup_jobs')).rows[0]
        .completed_at,
    ).toBeNull();
    archiveReady = true;
    await f.pool.query('UPDATE mio_account_cleanup_jobs SET next_attempt_at=now()');
    await expect
      .poll(async () => {
        await runtime!.round();
        return (await f.pool.query('SELECT completed_at FROM mio_account_cleanup_jobs')).rows[0]
          .completed_at;
      })
      .not.toBeNull();
    expect(archived.get(actor.userId)).toEqual({
      userId: actor.userId,
      finalizedAt: at.toISOString(),
    });
    expect(await f.auth.identity(new Headers({ cookie: fresh.cookie }))).not.toBeNull();
    await expect(
      media.query(
        `INSERT INTO mio_creation_logs(id,owner_id,media_type,job_id,event_kind,title,summary,occurred_at)
      VALUES($1,$2,'image',$3,'completed','late','late',now())`,
        [randomUUID(), actor.userId, randomUUID()],
      ),
    ).rejects.toThrow('ACCOUNT_DELETED');
  } finally {
    await runtime?.close();
    await conversations?.close();
    await assets?.close();
    await Promise.all(pools.map((pool) => pool.end()));
    await Promise.all(others.map((db) => db.close()));
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
