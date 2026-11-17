import assert from 'node:assert/strict';
import { importDeclaration } from './fixtures/provider-declaration.ts';
import type { Discovery, ProviderView } from '../../src/providers/contracts.ts';
import {
  authenticateOrCreateRetainedDevOwner,
  createPersistentDevProfileController,
  parseLiveAuthInput,
  preparePersistentDevEnvironment,
} from '../support/local-dev-live.ts';

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

/** Explicit opt-in entry against persistent mio_dev; retains discovered catalog, routes and account data. */
async function main() {
  const path = process.argv[2];
  assert(
    path && process.argv.length === 3,
    'Provide one authorized login.json or private key file',
  );
  const authInput = await parseLiveAuthInput(path);
  diagnostic.phase = 'dev-environment-migration';
  const dev = await preparePersistentDevEnvironment(['auth', 'providers']);
  const runtime = await createPersistentDevProfileController(dev.runtimeEnv, dev.origin);
  try {
    diagnostic.phase = 'dev-profile-start';
    await runtime.start();
    const origin = runtime.origin;
    let cookie = '';
    const call = (targetPath: string, method = 'GET', value?: unknown) =>
      fetch(`${origin}${targetPath}`, {
        method,
        headers: {
          origin,
          cookie,
          ...(value === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });

    diagnostic.phase = 'dev-auth';
    const ownerAccount = await authenticateOrCreateRetainedDevOwner(origin, authInput, 'providers');
    cookie = ownerAccount.cookie;
    const base = '/api/v1/providers/onelink';

    const existing = (await (await call(base)).json()) as ProviderView;
    let expectedCredentialVersion = existing.credentialVersion;
    if (ownerAccount.apiKey || !existing.hasKey) {
      assert(ownerAccount.apiKey, 'LIVE_PROVIDER_KEY_REQUIRED');
      diagnostic.phase = 'save-credential';
      const saved = await call(`${base}/credential`, 'PUT', {
        apiKey: ownerAccount.apiKey,
        expectedRevision: existing.revision,
      });
      diagnostic.httpStatus = saved.status;
      assert.equal(saved.status, 200, 'Provider save failed');
      const updated = (await saved.json()) as ProviderView;
      expectedCredentialVersion = updated.credentialVersion;
    }

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

    const catalogBody = (await (await call(`${base}/models`)).json()) as {
      items: { modelId: string; modelRef: string; modelKey: string }[];
    };
    const targetModel = catalogBody.items.find((item) => item.modelId === 'deepseek-v4.1-flash');
    assert(targetModel, 'Discovered model missing from mio_dev catalog');

    diagnostic.phase = 'set-default';
    const declared = await importDeclaration(
      dev.runtimeEnv,
      ownerAccount.userId,
      ((await (await call(base)).json()) as ProviderView).revision,
      targetModel.modelRef,
      'openai-chat',
      'OneLink text protocol documentation and persistent mio_dev verification',
    );
    const setDefault = await call(`${base}/models`, 'PATCH', {
      modelRef: targetModel.modelRef,
      usage: 'chat',
      isDefault: true,
      expectedRevision: declared.revision,
    });
    diagnostic.httpStatus = setDefault.status;
    assert.equal(setDefault.status, 200, 'Default selection failed');

    diagnostic.phase = 'profile-restart';
    await runtime.stop();
    await runtime.start();
    const restored = (await (await call(base)).json()) as ProviderView;
    assert.equal(restored.discovery?.status, 'connected');
    assert.equal(restored.discovery?.credentialVersion, expectedCredentialVersion);

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
    assert.equal(rediscovered.credentialVersion, expectedCredentialVersion);
    assert(rediscovered.ids.includes('deepseek-v4.1-flash'));

    diagnostic.phase = 'complete';
    const dynamic = (await (await call(`${base}/models`)).json()) as {
      items: { modelId: string; modelKey: string; discovered: boolean }[];
    };
    const currentDiscovered = dynamic.items.filter((item) => item.discovered);
    assert.equal(currentDiscovered.length, rediscovered.ids.length);
    console.log(
      JSON.stringify({
        kind: 'mio-dev-model-discovery',
        environment: 'mio_dev',
        retainedInDatabase: true,
        scope: 'models-only',
        credentialVersion: expectedCredentialVersion,
        configuredDefault: 'deepseek-v4.1-flash',
        count: new Set(discovery.ids).size,
        dynamicMemberCount: currentDiscovered.length,
        exactDefault: dynamic.items.find((item) => item.modelId === 'deepseek-v4.1-flash'),
        catalog: ((await (await call(base)).json()) as ProviderView).catalog,
        persistedAcrossRestart: true,
        restartDecryptionVerified: true,
        explicitDiscoveryRequests: 2,
        generationVerified: false,
      }),
    );
  } finally {
    await runtime.close();
  }
}

try {
  await main();
} catch {
  console.error(JSON.stringify({ error: 'LIVE_DISCOVERY_FAILED', ...diagnostic }));
  process.exitCode = 1;
}
