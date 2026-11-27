import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { afterEach, expect, it, vi } from 'vitest';
import { kernelRuntime, ScriptedModel } from '../support/kernel-runtime.ts';
import * as Mio from '../../src/plugin.ts';

const fixture = vi.hoisted(() => ({
  createStore: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
  closeService: vi.fn(async () => {}),
  closeHttp: vi.fn(() => {}),
}));
vi.mock('../../src/account-deletion/runtime.ts', () => ({
  createAccountDeletionRuntime: async () => ({
    domains: ['auth', 'archive'],
    wake: () => {},
    close: async () => {},
    round: async () => {},
    monitor: async () => {},
  }),
}));
vi.mock('../../src/auth/config.ts', () => ({
  AUTH_BASE_PATH: '/api/auth',
  readAuthConfig: () => ({ origins: [] }),
  readAuthRateLimitBackend: () => 'database',
}));
vi.mock('../../src/auth/service.ts', () => ({
  createAuthentication: async () => ({
    identity: async () => null,
    setDeletionDomains: () => {},
    close: async () => {},
  }),
}));
vi.mock('../../src/auth/http.ts', () => ({ createAuthHandler: () => () => {} }));
vi.mock('../../src/assets/config.ts', () => ({ readAssetConfig: () => undefined }));
vi.mock('../../src/compute/config.ts', () => ({ readComputeConfig: () => undefined }));
vi.mock('../../src/providers/config.ts', () => ({ readProviderConfig: () => undefined }));
vi.mock('../../src/conversations/config.ts', () => ({
  readConversationConfig: () => ({ databaseURL: 'unused' }),
}));
vi.mock('../../src/conversations/store.ts', () => ({
  createConversationStore: fixture.createStore,
}));
vi.mock('../../src/conversations/service.ts', () => ({
  createConversationService: () => ({ close: fixture.closeService }),
}));
vi.mock('../../src/conversations/http.ts', () => ({
  createConversationHandler: () => ({ handler: () => {}, close: fixture.closeHttp }),
}));
vi.mock('../../src/dsh/conversations.ts', () => ({ createDshConversationEngine: () => ({}) }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it('drains the service and releases conversation plugins even when both close paths fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-vision-close-fail-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  vi.stubEnv('MIO_FIXTURE_TOKEN', 'synthetic-token-for-vision-tests-only');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.closeHttp.mockImplementation(() => {
    throw new Error('synthetic http close failure');
  });
  fixture.closeService.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    throw new Error('synthetic service close failure');
  });
  try {
    expect(ctx.get('sessionTitle')).toBeUndefined();
    const fiber = await ctx.plugin(Mio, { tokenEnv: 'MIO_FIXTURE_TOKEN', allowedOrigins: [] });
    const titleService = ctx.sessionTitle;
    expect(titleService).toBeDefined();
    expect(ctx.sessions.messageProjections.some((item) => item.type === 'image/offload')).toBe(
      true,
    );
    const disposing = fiber.dispose();
    await entered.promise;
    expect(ctx.get('sessionTitle')).toBeDefined();
    expect(ctx.sessions.messageProjections.some((item) => item.type === 'image/offload')).toBe(
      true,
    );
    release.resolve();
    await disposing;
    expect(fixture.closeHttp).toHaveBeenCalledOnce();
    expect(fixture.closeService).toHaveBeenCalledOnce();
    expect(ctx.get('sessionTitle')).toBeUndefined();
    expect(ctx.sessions.messageProjections.some((item) => item.type === 'image/offload')).toBe(
      false,
    );
  } finally {
    release.resolve();
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it('releases conversation plugins when conversation store startup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mio-vision-start-fail-'));
  const ctx = await kernelRuntime(root, new ScriptedModel([]));
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  vi.stubEnv('MIO_FIXTURE_TOKEN', 'synthetic-token-for-vision-tests-only');
  fixture.createStore.mockRejectedValueOnce(new Error('synthetic store startup failure'));
  try {
    await expect(
      ctx.plugin(Mio, { tokenEnv: 'MIO_FIXTURE_TOKEN', allowedOrigins: [] }).await(),
    ).rejects.toThrow('synthetic store startup failure');
    expect(ctx.get('sessionTitle')).toBeUndefined();
    expect(ctx.sessions.messageProjections.some((item) => item.type === 'image/offload')).toBe(
      false,
    );
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
