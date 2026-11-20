import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { materialFixture, envelope } from './fixture.ts';
import { materialAuthSchemaSQL } from '../../src/materials/auth-schema.ts';
import { createMaterialAuthService } from '../../src/materials/auth-service.ts';
import { createMaterialAuthUpstream } from '../../src/integrations/onelink/materials.ts';
import type { ModelTransport } from '../../src/integrations/onelink/models.ts';
export async function materialAuthFixture() {
  const f = await materialFixture();
  await f.pool.query(materialAuthSchemaSQL);
  const tokens = new Map<string, { group: string; callback: string; launchUrl: string }>();
  let override:
    ((action: string, body: Record<string, unknown>) => Promise<Response | undefined>) | undefined;
  let seq = 0;
  const transport = vi.fn<ModelTransport>(async (input, init) => {
    const action = new URL(String(input)).searchParams.get('Action')!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const special = await override?.(action, body);
    if (special) return special;
    if (action === 'CreateVisualValidateSession') {
      const token = `synthetic-byted-token-${randomUUID()}`,
        group = `group-${String(++seq).padStart(14, '0')}-authx`,
        callback = String(body.CallbackURL),
        launchUrl = `https://ark.volcengine.com/region:cn-beijing/mobile/livenees-face-manage/authorization?launch=${randomUUID()}`;
      tokens.set(token, { group, callback, launchUrl });
      return envelope(action, {
        BytedToken: token,
        H5Link: launchUrl,
        CallbackURL: `https://api.onelinkai.cloud/volc/callback?redirect_url=${encodeURIComponent(callback)}&supplier=fixture`,
      });
    }
    if (action === 'GetVisualValidateResult') {
      const value = tokens.get(String(body.BytedToken));
      return value
        ? envelope(action, { GroupId: value.group })
        : envelope(action, {}, 404, 'ResourceNotFound');
    }
    if (action === 'GetAssetGroup')
      return envelope(action, { Id: body.Id, GroupType: 'LivenessFace' });
    throw new Error('FORBIDDEN_AUTH_ACTION');
  });
  const origin = 'https://materials.example.test:8443';
  const authentication = await createMaterialAuthService(
    f.store.authentication,
    f.provider,
    createMaterialAuthUpstream(transport),
    origin,
  );
  return {
    ...f,
    authentication,
    tokens,
    authTransport: transport,
    origin,
    authOverride(value: typeof override) {
      override = value;
    },
    async close() {
      await authentication.close();
      await f.close();
    },
  };
}
export type MaterialAuthFixture = Awaited<ReturnType<typeof materialAuthFixture>>;
