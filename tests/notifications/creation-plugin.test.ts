import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import * as Mio from '../../src/plugin.ts';
import * as Auth from '../../src/auth/service.ts';
import type { Authentication } from '../../src/auth/service.ts';
import * as Cos from '../../src/integrations/cos.ts';
import * as Creation from '../../src/notifications/creation-store.ts';
import * as Admin from '../../src/admin/service.ts';
import type { AdminPrincipal } from '../../src/admin/contracts.ts';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import { adminSchemaSQL } from '../../src/admin/schema.ts';
import { assetSchemaSQL } from '../../src/assets/schema.ts';
import { generationSchemaSQL } from '../../src/generations/schema.ts';
import { computeSchemaSQL } from '../../src/compute/schema.ts';
import { writeCreationLog } from '../../src/notifications/creation-write.ts';
import { authDatabase } from '../support/auth-database.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.each(['full', 'no-admin', 'no-video'] as const)(
  'mounts all-media creation feed only with policy and every production path (%s)',
  async (mode) => {
    const providersDB = await authDatabase(),
      mediaDB = await authDatabase();
    const providers = new Pool({ connectionString: providersDB.url }),
      media = new Pool({ connectionString: mediaDB.url });
    const directory = await mkdtemp(join(tmpdir(), 'mio-u5-plugin-'));
    const ctx = new Context();
    const actor = { userId: randomUUID(), sessionId: 'u5-fixture' };
    let plugin: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
    try {
      await providers.query(providerSchemaSQL);
      await providers.query(adminSchemaSQL);
      await media.query(assetSchemaSQL);
      await media.query(generationSchemaSQL);
      await media.query(computeSchemaSQL);
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(Tools);
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
      const origin = ctx.webServer.getOrigin();
      const env = {
        MIO_API_TOKEN: randomBytes(32).toString('hex'),
        MIO_AUTH_DATABASE_URL: providersDB.url,
        MIO_AUTH_BASE_URL: origin,
        MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
        MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
        MIO_AUTH_ALLOWED_ORIGINS: JSON.stringify([origin]),
        MIO_PROVIDERS_DATABASE_URL: providersDB.url,
        MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
        MIO_PROVIDERS_MASTER_KEY_ID: 'u5-plugin',
        MIO_ASSETS_DATABASE_URL: mediaDB.url,
        MIO_COS_BUCKET: 'mio-fixture-1234567890',
        MIO_COS_REGION: 'ap-shanghai',
        MIO_COS_SECRET_ID: 'fixture',
        MIO_COS_SECRET_KEY: 'fixture',
        MIO_COMPUTE_ENABLED: 'true',
        RABBITMQ_URL: 'amqp://fixture-a:unused@127.0.0.1:1/unused',
        MIO_COMPUTE_BROKER_USER: 'fixture-a',
        MIO_COMPUTE_EXPECTED_RESULT_USER: 'fixture-b',
        MIO_GENERATIONS_ENABLED: 'true',
        MIO_GENERATIONS_DATA_DIR: directory,
        ...(mode !== 'no-video' ? { MIO_VIDEO_GENERATIONS_ENABLED: 'true' } : {}),
        ...(mode !== 'no-admin' ? { MIO_ADMIN_ENABLED: 'true' } : {}),
      };
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      vi.spyOn(Auth, 'createAuthentication').mockResolvedValue({
        identity: async (headers: Headers) =>
          headers.get('cookie') === 'session=fixture' ? actor : null,
        close: async () => {},
      } as Authentication);
      vi.spyOn(Cos, 'createCosStorage').mockReturnValue({
        head: vi.fn().mockRejectedValue(new Error('unexpected COS')),
        putImage: vi.fn().mockRejectedValue(new Error('unexpected COS')),
        readMedia: vi.fn().mockRejectedValue(new Error('unexpected COS')),
      } as unknown as ReturnType<typeof Cos.createCosStorage>);
      vi.spyOn(ComputeBroker, 'connect').mockImplementation(
        async () =>
          ({
            close: async () => {},
            consume: async () => {},
            consumeMedia: async () => {},
            onClose: () => {},
          }) as unknown as ComputeBroker,
      );
      const acquired = vi.spyOn(Creation, 'createCreationLogStore');
      const admin = vi.spyOn(Admin, 'createAdminService');
      plugin = await ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
      const url = `${origin}/api/v1/notifications?type=creation_log`;
      if (mode !== 'full') {
        expect(acquired).not.toHaveBeenCalled();
        expect((await fetch(url, { headers: { cookie: 'session=fixture' } })).status).toBe(404);
      } else {
        expect(acquired).toHaveBeenCalledOnce();
        expect(acquired.mock.calls[0]![0]).toBe(mediaDB.url);
        const store = await acquired.mock.results[0]!.value;
        const policy = admin.mock.results[0]!.value;
        for (const type of ['image', 'video', 'audio'] as const)
          await writeCreationLog(media.query.bind(media), {
            ownerId: actor.userId,
            mediaType: type,
            jobId: randomUUID(),
            eventKind: 'completed',
            title: type,
            summary: 'saved',
            occurredAt: new Date(Date.now() - 15 * 86400000).toISOString(),
          });
        expect(
          (await fetch(url, { headers: { authorization: 'Bearer service-token' } })).status,
        ).toBe(401);
        expect(
          (await (await fetch(url, { headers: { cookie: 'session=fixture' } })).json()).items,
        ).toHaveLength(3);
        await policy.updateCreationLogSettings(
          {
            admin: { id: randomUUID(), username: 'u5-admin' },
            sessionId: 'fixture',
          } as AdminPrincipal,
          { expectedRevision: 0, retentionDays: 14 },
        );
        expect(
          (await (await fetch(url, { headers: { cookie: 'session=fixture' } })).json()).items,
        ).toHaveLength(0);
        const close = vi.spyOn(store, 'close');
        await plugin.dispose();
        plugin = undefined;
        expect(close).toHaveBeenCalled();
        await expect(
          store.receiveAudio(randomUUID(), {
            ownerId: actor.userId,
            mediaType: 'audio',
            jobId: randomUUID(),
            eventKind: 'completed',
            title: 'a',
            summary: 'saved',
            occurredAt: new Date().toISOString(),
          }),
        ).rejects.toMatchObject({ status: 503 });
        expect((await fetch(url, { headers: { cookie: 'session=fixture' } })).status).toBe(404);
      }
    } finally {
      await plugin?.dispose();
      await ctx.fiber.dispose();
      await providers.end();
      await media.end();
      await providersDB.close();
      await mediaDB.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
