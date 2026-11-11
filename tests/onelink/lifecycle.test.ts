import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { expect, it, vi } from 'vitest';
import * as Mio from '../../src/plugin.ts';
import * as Engines from '../../src/dsh/conversations.ts';
import { ProviderStore } from '../../src/providers/store.ts';
import { ConversationStore } from '../../src/conversations/store.ts';
import { authDatabase } from '../support/auth-database.ts';
import { kernelRuntime, ScriptedModel } from '../support/kernel-runtime.ts';

it.each([false, true])(
  'closes the provider pool despite conversation teardown/startup failure (startup=%s)',
  async (startup) => {
    const database = await authDatabase();
    const root = await mkdtemp(join(tmpdir(), 'mio-w2-cleanup-'));
    const ctx = await kernelRuntime(root, new ScriptedModel([]));
    const providerClosed = vi.spyOn(ProviderStore.prototype, 'close');
    const conversationClosed = vi.spyOn(ConversationStore.prototype, 'close');
    try {
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
      const env = {
        PATH: process.env.PATH ?? '',
        MIO_API_TOKEN: randomBytes(32).toString('hex'),
        MIO_AUTH_DATABASE_URL: database.url,
        MIO_AUTH_BASE_URL: ctx.webServer.getOrigin(),
        MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
        MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
        MIO_CONVERSATIONS_DATABASE_URL: database.url,
        MIO_PROVIDERS_DATABASE_URL: database.url,
        MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
        MIO_PROVIDERS_MASTER_KEY_ID: 'cleanup-test',
      };
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      for (const domain of ['auth', 'providers', 'conversations']) {
        const result = spawnSync(
          process.execPath,
          [`scripts/service/migrate-${domain}.ts`, '--apply'],
          { env, encoding: 'utf8', timeout: 30000 },
        );
        expect(result.status, result.stderr).toBe(0);
      }
      if (startup) ctx.llm.registerAdapter(['onelink-openai'], new ScriptedModel([]));
      else {
        const original = Engines.createDshConversationEngine;
        vi.spyOn(Engines, 'createDshConversationEngine').mockImplementation((...args) => {
          const engine = original(...args);
          return {
            ...engine,
            close: async () => {
              await engine.close();
              throw new Error('synthetic close failure');
            },
          };
        });
      }
      const plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
      if (startup) await Promise.resolve(plugin).catch(() => {});
      else await plugin;
      await plugin.dispose().catch(() => {});
      expect(conversationClosed).toHaveBeenCalled();
      expect(providerClosed).toHaveBeenCalled();
      const provider = providerClosed.mock.contexts[0] as ProviderStore;
      await expect(provider.current('no-owner')).rejects.toThrow();
    } finally {
      await ctx.fiber.dispose().catch(() => {});
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
