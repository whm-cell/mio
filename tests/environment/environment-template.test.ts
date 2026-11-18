import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, it, onTestFinished } from 'vitest';
import {
  createLocalEnvironment,
  readLocalEnvironment,
} from '../../scripts/service/local-environment.ts';
import type { LocalEnvironment } from '../../scripts/service/local-environment.ts';
import { readAssetConfig } from '../../src/assets/config.ts';
import { readAuthConfig } from '../../src/auth/config.ts';
import { readComputeConfig } from '../../src/compute/config.ts';
import { readConversationConfig } from '../../src/conversations/config.ts';
import { readGenerationConfig } from '../../src/generations/config.ts';
import { readProviderConfig } from '../../src/providers/config.ts';

const templatePath = resolve(import.meta.dirname, '../../.env.example');
const assignmentPrefix = /^[ \t]*(#[ \t]*)?(?:export[ \t]+)?([A-Za-z_]\w*)[ \t]*=/gm;

const smsSettings = {
  MIO_TENCENT_SMS_SECRET_ID: 'fixture-id',
  MIO_TENCENT_SMS_SECRET_KEY: 'fixture-key',
  MIO_TENCENT_SMS_APP_ID: '1400000000',
  MIO_TENCENT_SMS_SIGN_NAME: 'fixture-sign',
  MIO_TENCENT_SMS_TEMPLATE_ID: '1000',
  MIO_TENCENT_SMS_REGION: 'ap-guangzhou',
  MIO_AUTH_SMS_PHONE_HOUR_LIMIT: '4',
  MIO_AUTH_SMS_PHONE_DAY_LIMIT: '9',
  MIO_AUTH_SMS_IP_HOUR_LIMIT: '19',
  MIO_AUTH_SMS_IP_DAY_LIMIT: '90',
  MIO_AUTH_SMS_GLOBAL_DAY_LIMIT: '900',
};
const wechatSettings = {
  MIO_AUTH_WECHAT_APP_ID: 'fixture-app',
  MIO_AUTH_WECHAT_APP_SECRET: 'fixture-secret',
};
const providerSettings = {
  MIO_PROVIDERS_DATABASE_URL: 'postgresql://fixture.invalid/providers',
  MIO_PROVIDERS_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
  MIO_PROVIDERS_MASTER_KEY_ID: 'fixture-v1',
};
const conversationSettings = {
  MIO_CONVERSATIONS_DATABASE_URL: 'postgresql://fixture.invalid/conversations',
};
const fixedRoute = { MIO_MODEL_PROVIDER: 'deepseek-official', MIO_MODEL: 'fixture-model' };
const officialKey = { MIO_MODEL_API_KEY: 'fixture-api-key' };
const assetSettings = {
  MIO_ASSETS_DATABASE_URL: 'postgresql://fixture.invalid/assets',
  MIO_COS_BUCKET: 'fixture-bucket-1234',
  MIO_COS_REGION: 'ap-guangzhou',
  MIO_COS_SECRET_ID: 'fixture-id',
  MIO_COS_SECRET_KEY: 'fixture-key',
  MIO_COS_SESSION_TOKEN: 'fixture-token',
};
const enableSwitches = {
  MIO_AUTH_SMS_ENABLED: 'true',
  MIO_AUTH_WECHAT_ENABLED: 'true',
  MIO_COMPUTE_ENABLED: 'true',
  MIO_GENERATIONS_ENABLED: 'true',
};

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'mio-env-template-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function initialize(name: LocalEnvironment) {
  const root = await temporaryDirectory();
  expect(await createLocalEnvironment(name, root)).toBe('created');
  return readLocalEnvironment(name, root, {});
}

async function readTemplate(path: string) {
  if (!(await lstat(path)).isFile()) throw new Error('.env.example must be a regular file');
  return readFile(path, 'utf8');
}

function assignmentKeys(contents: string) {
  const active: string[] = [];
  const optional: string[] = [];
  for (const [, comment, key] of contents.matchAll(assignmentPrefix)) {
    (comment ? optional : active).push(key!);
  }
  return { active: active.sort(), optional: optional.sort() };
}

it.each(['dev', 'test'] as const)('matches the keys from fresh %s initialization', async (name) => {
  const template = await readTemplate(templatePath);
  const { active } = assignmentKeys(template);
  const initialized = await initialize(name);
  expect(active).toEqual(Object.keys(initialized.values).sort());
  expect(Object.keys(parseEnv(template)).sort()).toEqual(active);
  expect(assignmentKeys(await readFile(initialized.file, 'utf8')).active).toEqual(active);
});

it('refuses a symbolic link before reading the public template', async () => {
  const root = await temporaryDirectory();
  const target = join(root, '.env');
  const link = join(root, '.env.example');
  await writeFile(target, 'PRIVATE=synthetic\n', { mode: 0o600 });
  await symlink(target, link);
  await expect(readTemplate(link)).rejects.toThrow('.env.example must be a regular file');
});

it('lists exactly the documented opt-ins and accepts their complete configuration', async () => {
  const optIns = {
    ...smsSettings,
    ...wechatSettings,
    ...providerSettings,
    ...conversationSettings,
    ...fixedRoute,
    ...officialKey,
    ...assetSettings,
    ...enableSwitches,
  };
  const template = await readTemplate(templatePath);
  const { optional } = assignmentKeys(template);
  expect(optional).toEqual(Object.keys(optIns).sort());
  const examples = parseEnv(template.replace(assignmentPrefix, '$2='));
  const invalidSwitches = Object.entries(enableSwitches)
    .filter(([key, value]) => examples[key] !== value)
    .map(([key]) => key);
  expect(invalidSwitches, 'Unexpected template switches').toEqual([]);

  const runtime = (await initialize('test')).runtime;
  const configured = { ...runtime, ...optIns };
  const auth = readAuthConfig(configured);
  expect(auth?.sms !== undefined, 'MIO_AUTH_SMS_ENABLED').toBe(true);
  expect(auth?.wechat !== undefined, 'MIO_AUTH_WECHAT_ENABLED').toBe(true);
  expect(readProviderConfig(configured) !== undefined, 'MIO_PROVIDERS_DATABASE_URL').toBe(true);
  expect(
    readConversationConfig(configured, true) !== undefined,
    'MIO_CONVERSATIONS_DATABASE_URL',
  ).toBe(true);
  expect(readAssetConfig(configured)?.sessionToken !== undefined, 'MIO_COS_SESSION_TOKEN').toBe(
    true,
  );
  expect(readComputeConfig(configured) !== undefined, 'MIO_COMPUTE_ENABLED').toBe(true);
  expect(readGenerationConfig(configured) !== undefined, 'MIO_GENERATIONS_ENABLED').toBe(true);
});

it('keeps optional domains off after initialization and preserves switch semantics', async () => {
  const { runtime } = await initialize('test');
  expect(runtime.NODE_ENV === 'production', 'NODE_ENV').toBe(true);
  expect(readAuthConfig(runtime) !== undefined, 'MIO_AUTH_DATABASE_URL').toBe(true);
  expect(readProviderConfig(runtime) === undefined, 'MIO_PROVIDERS_DATABASE_URL').toBe(true);
  expect(readConversationConfig(runtime) === undefined, 'MIO_CONVERSATIONS_DATABASE_URL').toBe(
    true,
  );
  expect(readAssetConfig(runtime) === undefined, 'MIO_ASSETS_DATABASE_URL').toBe(true);
  expect(readComputeConfig(runtime) === undefined, 'MIO_COMPUTE_ENABLED').toBe(true);
  expect(readGenerationConfig(runtime) === undefined, 'MIO_GENERATIONS_ENABLED').toBe(true);

  for (const [key, field] of [
    ['MIO_AUTH_SMS_ENABLED', 'sms'],
    ['MIO_AUTH_WECHAT_ENABLED', 'wechat'],
  ] as const) {
    expect(readAuthConfig(runtime)?.[field] === undefined, key).toBe(true);
    expect(readAuthConfig({ ...runtime, [key]: 'false' })?.[field] === undefined, key).toBe(true);
    expect(() => readAuthConfig({ ...runtime, [key]: '' }), key).toThrow('AUTH_CONFIG');
  }
  for (const value of ['false', '']) {
    expect(() => readComputeConfig({ ...runtime, MIO_COMPUTE_ENABLED: value })).toThrow(
      'COMPUTE_CONFIG',
    );
    expect(() => readGenerationConfig({ ...runtime, MIO_GENERATIONS_ENABLED: value })).toThrow(
      'GENERATION_CONFIG',
    );
  }
});

it('requires a conversation database and a complete fixed route, with a key only for DeepSeek', () => {
  expect(() => readConversationConfig({ ...fixedRoute, ...officialKey })).toThrow(
    'database URL required',
  );
  for (const [key, value] of Object.entries(fixedRoute)) {
    expect(() => readConversationConfig({ ...conversationSettings, [key]: value }), key).toThrow(
      'provider and model must be set together',
    );
  }
  const legacy = { ...conversationSettings, ...fixedRoute };
  expect(() => readConversationConfig(legacy)).toThrow('MIO_MODEL_API_KEY');
  const official = readConversationConfig({ ...legacy, ...officialKey });
  expect(official?.provider === fixedRoute.MIO_MODEL_PROVIDER, 'MIO_MODEL_PROVIDER').toBe(true);
  expect(official?.model === fixedRoute.MIO_MODEL, 'MIO_MODEL').toBe(true);
  const scripted = readConversationConfig({
    ...conversationSettings,
    MIO_MODEL_PROVIDER: 'mio-test-only',
    MIO_MODEL: 'scripted',
  });
  expect(scripted?.provider === 'mio-test-only', 'MIO_MODEL_PROVIDER').toBe(true);
});

it('keeps fixed routes out of BYOK selection and validation', () => {
  for (const env of [
    { ...conversationSettings, ...fixedRoute, ...officialKey, ...providerSettings },
    {
      ...conversationSettings,
      MIO_MODEL_PROVIDER: fixedRoute.MIO_MODEL_PROVIDER,
      ...providerSettings,
    },
  ]) {
    const config = readConversationConfig(env, Boolean(readProviderConfig(env)));
    expect(config?.byok === true, 'MIO_PROVIDERS_DATABASE_URL').toBe(true);
    expect(config?.provider === undefined, 'MIO_MODEL_PROVIDER').toBe(true);
    expect(config?.model === undefined, 'MIO_MODEL').toBe(true);
  }
});
