import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { authDatabase } from './auth-database.ts';
import { packedAuthRuntime } from './auth-runtime.ts';
import { importDeclaration } from './fixtures/provider-declaration.ts';
import type { ProviderView, Discovery } from '../src/providers/contracts.ts';

const diagnostic: { phase: string; httpStatus?: number; serviceCode?: string } = {
  phase: 'credential-input',
};
const knownDiscoveryErrors = new Set([
  'UPSTREAM_AUTH_REJECTED',
  'UPSTREAM_RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_RESPONSE_INVALID',
  'UPSTREAM_RESPONSE_TOO_LARGE',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_CANCELLED',
  'UPSTREAM_RESPONSE_OR_TRANSPORT_ERROR',
]);
/** Explicit opt-in entry; not matched by Vitest. No key contents or raw errors are printed. */
async function main() {
  const path = process.argv[2];
  assert(path && process.argv.length === 3, 'Provide exactly one authorized private key file');
  const raw = await readFile(path, 'utf8');
  assert(Buffer.byteLength(raw) <= 8192, 'Invalid credential file');
  const line = raw.trim();
  assert(line && !/[\r\n]/.test(line), 'Invalid credential file');
  const assignment = /^[A-Za-z_][A-Za-z0-9_]{0,47}=(.*)$/.exec(line);
  let apiKey = assignment ? assignment[1]! : line;
  if (
    (apiKey.startsWith('"') && apiKey.endsWith('"')) ||
    (apiKey.startsWith("'") && apiKey.endsWith("'"))
  )
    apiKey = apiKey.slice(1, -1);
  assert(
    apiKey && apiKey.length <= 4096 && !/[\s'"*•\u0000-\u001f\u007f]/.test(apiKey),
    'Invalid credential file',
  );
  diagnostic.phase = 'isolated-database';
  const database = await authDatabase();
  let runtime: Awaited<ReturnType<typeof packedAuthRuntime>> | undefined;
  try {
    const master = randomBytes(32).toString('base64');
    const env = {
      PATH: process.env.PATH ?? '',
      MIO_AUTH_BASE_URL: 'http://127.0.0.1:4311',
      MIO_AUTH_SECRET: randomBytes(40).toString('hex'),
      MIO_AUTH_DATABASE_URL: database.url,
      MIO_PROVIDERS_DATABASE_URL: database.url,
      MIO_PROVIDERS_MASTER_KEY: master,
      MIO_PROVIDERS_MASTER_KEY_ID: 'live-isolated-v1',
    };
    for (const file of [
      'scripts/service/migrate-auth.ts',
      'scripts/service/migrate-providers.ts',
    ]) {
      diagnostic.phase = file.includes('migrate-auth') ? 'auth-migration' : 'provider-migration';
      const result = spawnSync(process.execPath, [file, '--apply'], {
        env,
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(result.status, 0, 'Isolated migration failed');
    }
    diagnostic.phase = 'packed-profile-start';
    runtime = await packedAuthRuntime(database.url, '', 'unused', {
      providerMasterKey: master,
      providerKeyId: 'live-isolated-v1',
    });
    await runtime.start('database');
    const origin = runtime.origin;
    let cookie = '';
    const call = (path: string, method = 'GET', value?: unknown) =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          origin,
          cookie,
          ...(value === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    diagnostic.phase = 'signup';
    const signup = await call('/api/auth/sign-up/email', 'POST', {
      name: 'Isolated live discovery',
      email: 'onelink-live@example.test',
      password: randomBytes(24).toString('hex'),
    });
    diagnostic.httpStatus = signup.status;
    assert.equal(signup.status, 200, 'Isolated signup failed');
    cookie = signup.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    const owner = ((await signup.json()) as { user: { id: string } }).user.id;
    const base = '/api/v1/providers/onelink';
    diagnostic.phase = 'save-credential';
    const saved = await call(`${base}/credential`, 'PUT', { apiKey, expectedRevision: 0 });
    diagnostic.httpStatus = saved.status;
    assert.equal(saved.status, 200, 'Provider save failed');
    const provider = (await saved.json()) as ProviderView;
    assert.equal(provider.credentialVersion, 1);
    assert.equal(provider.discovery, null);
    diagnostic.phase = 'first-discovery';
    const tested = await call(`${base}/test`, 'POST', {});
    diagnostic.httpStatus = tested.status;
    assert.equal(tested.status, 200, 'Provider discovery request failed');
    const discovery = (await tested.json()) as Discovery;
    if (discovery.error && knownDiscoveryErrors.has(discovery.error))
      diagnostic.serviceCode = discovery.error;
    assert.equal(discovery.status, 'connected', 'Live models discovery failed');
    assert.equal(discovery.scope, 'models-only');
    assert(
      discovery.ids.includes('deepseek-v4.1-flash'),
      'Requested exact text model was not discovered',
    );
    diagnostic.phase = 'set-default';
    const declared = await importDeclaration(
      env,
      owner,
      ((await (await call(base)).json()) as ProviderView).revision,
      'onelink:chat:deepseek-v4.1-flash',
      'openai-chat',
      'OneLink text protocol documentation and prior authorized exact-model OpenAI observation',
    );
    const setDefault = await call(`${base}/models`, 'PATCH', {
      modelRef: 'onelink:chat:deepseek-v4.1-flash',
      isDefault: true,
      expectedRevision: declared.revision,
    });
    diagnostic.httpStatus = setDefault.status;
    assert.equal(setDefault.status, 200, 'Default selection failed');
    diagnostic.phase = 'profile-restart';
    await runtime.stop();
    await runtime.start('database');
    const restored = (await (await call(base)).json()) as ProviderView;
    assert.equal(restored.discovery?.status, 'connected');
    assert.equal(restored.discovery?.credentialVersion, 1);
    diagnostic.phase = 'restart-discovery';
    const afterRestart = await call(`${base}/test`, 'POST', {});
    diagnostic.httpStatus = afterRestart.status;
    assert.equal(afterRestart.status, 200, 'Post-restart discovery request failed');
    const rediscovered = (await afterRestart.json()) as Discovery;
    if (rediscovered.error && knownDiscoveryErrors.has(rediscovered.error))
      diagnostic.serviceCode = rediscovered.error;
    assert.equal(
      rediscovered.status,
      'connected',
      'Post-restart credential decryption/discovery failed',
    );
    assert.equal(rediscovered.credentialVersion, 1);
    assert(rediscovered.ids.includes('deepseek-v4.1-flash'));
    diagnostic.phase = 'complete';
    const found = new Set(discovery.ids);
    const dynamic = (await (await call(`${base}/models`)).json()) as {
      items: { modelId: string; modelKey: string }[];
    };
    assert.equal(dynamic.items.length, rediscovered.ids.length);
    console.log(
      JSON.stringify({
        kind: 'mio-profile-model-discovery',
        scope: 'models-only',
        credentialVersion: 1,
        configuredDefault: 'deepseek-v4.1-flash',
        count: found.size,
        dynamicMemberCount: dynamic.items.length,
        exactDefault: dynamic.items.find((item) => item.modelId === 'deepseek-v4.1-flash'),
        catalog: ((await (await call(base)).json()) as ProviderView).catalog,
        persistedAcrossRestart: true,
        restartDecryptionVerified: true,
        explicitDiscoveryRequests: 2,
        generationVerified: false,
      }),
    );
  } finally {
    try {
      await runtime?.close();
    } finally {
      await database.close();
    }
  }
}
try {
  await main();
} catch {
  console.error(JSON.stringify({ error: 'LIVE_DISCOVERY_FAILED', ...diagnostic }));
  process.exitCode = 1;
}
