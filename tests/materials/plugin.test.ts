import { randomBytes } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import * as Mio from '../../src/plugin.ts';
import * as MaterialServices from '../../src/materials/service.ts';
import * as ProviderServices from '../../src/providers/service.ts';
import * as Upstream from '../../src/integrations/onelink/materials.ts';
import { materialFixture } from './fixture.ts';

it('registers material routes before Bearer fallback and closes providers even if the material consumer fails to close', async () => {
  const f = await materialFixture();
  const ctx = new Context();
  let owned: MaterialServices.MaterialService | undefined;
  let ownedProvider: ProviderServices.ProviderService | undefined;
  const materialFactory = MaterialServices.createMaterialService;
  const providerFactory = ProviderServices.createProviderService;
  vi.spyOn(MaterialServices, 'createMaterialService').mockImplementation(
    (...args) => (owned = materialFactory(...args)),
  );
  vi.spyOn(ProviderServices, 'createProviderService').mockImplementation(
    (...args) => (ownedProvider = providerFactory(...args)),
  );
  vi.spyOn(Upstream, 'createMaterialUpstream').mockReturnValue(
    Upstream.createMaterialUpstream(f.transport),
  );
  let closeOriginal: (() => Promise<void>) | undefined;
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    await ctx.plugin(NativeExecutor);
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    const origin = ctx.webServer.getOrigin();
    const secret = randomBytes(40).toString('hex');
    for (const [name, value] of Object.entries({
      MIO_API_TOKEN: secret,
      MIO_AUTH_DATABASE_URL: f.database.url,
      MIO_AUTH_BASE_URL: origin,
      MIO_AUTH_SECRET: secret,
      MIO_AUTH_RATE_LIMIT_BACKEND: 'database',
      MIO_AUTH_ALLOWED_ORIGINS: '[]',
      MIO_PROVIDERS_DATABASE_URL: f.database.url,
      MIO_PROVIDERS_MASTER_KEY: randomBytes(32).toString('base64'),
      MIO_PROVIDERS_MASTER_KEY_ID: 'plugin-material',
      MIO_ASSETS_DATABASE_URL: f.database.url,

      MIO_MATERIALS_ENABLED: 'true',
    }))
      vi.stubEnv(name, value);
    for (const name of [
      'MIO_COMPUTE_ENABLED',
      'MIO_GENERATIONS_ENABLED',
      'MIO_CONVERSATIONS_DATABASE_URL',
      'MIO_AUTH_SMS_ENABLED',
      'MIO_AUTH_WECHAT_ENABLED',
      'MIO_COS_BUCKET',
      'MIO_COS_REGION',
      'MIO_COS_SECRET_ID',
      'MIO_COS_SECRET_KEY',
      'MIO_COS_SESSION_TOKEN',
    ])
      vi.stubEnv(name, undefined);
    const migrated = spawnSync(process.execPath, ['scripts/service/migrate-auth.ts', '--apply'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(migrated.status, migrated.stderr).toBe(0);
    await ctx.plugin(Mio, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] });
    const anon = await fetch(`${origin}/api/v1/materials/groups`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ error: { message: 'UNAUTHORIZED' } });
    const login = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Material owner',
        email: 'materials-plugin@example.test',
        password: 'materials-plugin-password-strong',
      }),
    });
    expect(login.status, await login.clone().text()).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const list = await fetch(`${origin}/api/v1/materials/groups`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const assets = await fetch(`${origin}/api/v1/assets/${crypto.randomUUID()}`, {
      headers: { cookie },
    });
    expect(assets.status).toBe(404);
    expect(await list.json()).toEqual({ items: [], nextCursor: null });
    expect(owned).toBeDefined();
    expect(ownedProvider).toBeDefined();
    closeOriginal = owned!.close.bind(owned);
    vi.spyOn(owned!, 'close').mockRejectedValue(new Error('MATERIAL_CLOSE_FIXTURE'));
    const providerClose = vi.spyOn(ownedProvider!, 'close');
    await ctx.fiber.dispose().catch(() => {});
    expect(providerClose).toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await closeOriginal?.();
    await ctx.fiber.dispose().catch(() => {});
    vi.unstubAllEnvs();
    await f.close();
  }
}, 30_000);

it.each([false, true])(
  'preserves strict incomplete COS configuration when materials mode is %s',
  async (materials) => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(Tools);
      await ctx.plugin(NativeExecutor);
      vi.stubEnv('MIO_MATERIALS_ENABLED', materials ? 'true' : undefined);
      vi.stubEnv('MIO_ASSETS_DATABASE_URL', 'postgresql://fixture.invalid/media');
      vi.stubEnv('MIO_COS_BUCKET', materials ? 'partial-bucket-1234' : undefined);
      for (const key of [
        'MIO_COS_REGION',
        'MIO_COS_SECRET_ID',
        'MIO_COS_SECRET_KEY',
        'MIO_COS_SESSION_TOKEN',
      ])
        vi.stubEnv(key, undefined);
      await expect(
        Mio.apply(ctx, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] }),
      ).rejects.toThrow('ASSET_CONFIG');
    } finally {
      await ctx.fiber.dispose();
      vi.unstubAllEnvs();
    }
  },
);

it.each(['MIO_COMPUTE_ENABLED', 'MIO_GENERATIONS_ENABLED'])(
  'retains full asset prerequisites when materials and %s are both enabled',
  async (enabled) => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(Tools);
      await ctx.plugin(NativeExecutor);
      vi.stubEnv('MIO_MATERIALS_ENABLED', 'true');
      vi.stubEnv(enabled, 'true');
      vi.stubEnv('MIO_ASSETS_DATABASE_URL', 'postgresql://fixture.invalid/media');
      vi.stubEnv('RABBITMQ_URL', 'amqp://a:password@localhost:5672/fixture');
      vi.stubEnv('MIO_COMPUTE_BROKER_USER', 'a');
      vi.stubEnv('MIO_COMPUTE_EXPECTED_RESULT_USER', 'b');
      for (const key of [
        'MIO_COS_BUCKET',
        'MIO_COS_REGION',
        'MIO_COS_SECRET_ID',
        'MIO_COS_SECRET_KEY',
        'MIO_COS_SESSION_TOKEN',
      ])
        vi.stubEnv(key, undefined);
      await expect(
        Mio.apply(ctx, { tokenEnv: 'MIO_API_TOKEN', allowedOrigins: [] }),
      ).rejects.toThrow('ASSET_CONFIG');
    } finally {
      await ctx.fiber.dispose();
      vi.unstubAllEnvs();
    }
  },
);
