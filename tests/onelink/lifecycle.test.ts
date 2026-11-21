import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { expect, it, vi } from 'vitest';
import * as Mio from '../../src/plugin.ts';
import * as Engines from '../../src/dsh/conversations.ts';
import { ComputeStore } from '../../src/compute/store.ts';
import { ProviderStore } from '../../src/providers/store.ts';
import { ConversationStore } from '../../src/conversations/store.ts';
import { authDatabase } from '../support/auth-database.ts';
import { kernelRuntime, ScriptedModel } from '../support/kernel-runtime.ts';

it.each([false, true])(
  'releases the conversation and provider pools after plugin teardown (startup failure=%s)',
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
      const startupError = new Error('synthetic conversation startup failure');
      if (startup)
        vi.spyOn(Engines, 'createDshConversationEngine').mockImplementation(() => {
          throw startupError;
        });
      const plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
      if (startup) await expect(Promise.resolve(plugin)).rejects.toBe(startupError);
      else {
        await plugin;
        expect(conversationClosed).not.toHaveBeenCalled();
        expect(providerClosed).not.toHaveBeenCalled();
      }
      await plugin.dispose();
      expect(conversationClosed).toHaveBeenCalled();
      expect(providerClosed).toHaveBeenCalledTimes(1);
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

it('drains the conversation before closing compute and reports both failures in order', async () => {
  const database = await authDatabase();
  const root = await mkdtemp(join(tmpdir(), 'mio-compute-cleanup-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  const events: string[] = [];
  const drainStarted = Promise.withResolvers<void>();
  const releaseDrain = Promise.withResolvers<void>();
  const conversationError = new Error('synthetic conversation close failure');
  const computeError = new Error('synthetic compute close failure');
  const originalComputeClose = ComputeStore.prototype.close;
  const computeClosed = vi
    .spyOn(ComputeStore.prototype, 'close')
    .mockImplementation(async function (this: ComputeStore) {
      events.push('compute-close');
      await originalComputeClose.call(this);
      throw computeError;
    });
  const report = vi.spyOn(ctx.logger, 'error');
  try {
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    const env = {
      PATH: process.env.PATH ?? '',
      MIO_API_TOKEN: randomBytes(32).toString('hex'),
      MIO_AUTH_DATABASE_URL: database.url,
      MIO_AUTH_BASE_URL: ctx.webServer.getOrigin(),
      MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
      MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
      MIO_ASSETS_DATABASE_URL: database.url,
      MIO_COS_BUCKET: 'mio-test-1234567890',
      MIO_COS_REGION: 'ap-shanghai',
      MIO_COS_SECRET_ID: 'synthetic-id',
      MIO_COS_SECRET_KEY: 'synthetic-secret',
      MIO_COMPUTE_ENABLED: 'true',
      RABBITMQ_URL: 'amqp://unused-a:unused@127.0.0.1:1/unused',
      MIO_COMPUTE_BROKER_USER: 'unused-a',
      MIO_COMPUTE_EXPECTED_RESULT_USER: 'unused-b',
      MIO_CONVERSATIONS_DATABASE_URL: database.url,
      MIO_PROVIDERS_DATABASE_URL: database.url,
      MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
      MIO_PROVIDERS_MASTER_KEY_ID: 'cleanup-compute-test',
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    for (const domain of ['auth', 'assets', 'compute', 'providers', 'conversations']) {
      const result = spawnSync(
        process.execPath,
        [`scripts/service/migrate-${domain}.ts`, '--apply'],
        { env, encoding: 'utf8', timeout: 30000 },
      );
      expect(result.status, result.stderr).toBe(0);
    }
    const original = Engines.createDshConversationEngine;
    vi.spyOn(Engines, 'createDshConversationEngine').mockImplementation((...args) => {
      const engine = original(...args);
      return {
        ...engine,
        close: async () => {
          drainStarted.resolve();
          await releaseDrain.promise;
          await engine.close();
          events.push('conversation-close');
          throw conversationError;
        },
      };
    });
    const plugin = ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
    await plugin;
    expect(events).toEqual([]);
    const disposed = plugin.dispose();
    try {
      await drainStarted.promise;
      expect(computeClosed).not.toHaveBeenCalled();
    } finally {
      releaseDrain.resolve();
      await disposed;
    }
    expect(computeClosed).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['conversation-close', 'compute-close']);
    const cleanupError = report.mock.calls
      .map(([error]) => error)
      .find(
        (error): error is AggregateError =>
          error instanceof AggregateError && error.errors.includes(computeError),
      );
    expect(cleanupError?.message).toBe('Mio resource cleanup failed');
    expect(cleanupError?.errors).toEqual([conversationError, computeError]);
  } finally {
    releaseDrain.resolve();
    await ctx.fiber.dispose().catch(() => {});
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
