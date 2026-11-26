import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {
  imageOutputIndex,
  isValidImageAssetObjectKey,
} from '../../src/generations/image/contracts.ts';
import type { ImageAssetRef } from '../../src/generations/image/contracts.ts';
import type { GenerationRequest } from '../../src/generations/image/execution.ts';
import { launcher, prepareProfile } from '../../scripts/service/profile.ts';
import { createImageDecoder } from '../../src/generations/image/decode.ts';
import { inspectGenerationCutover } from '../../scripts/service/generation-cutover.ts';
import sharp from 'sharp';
import { readAssetConfig } from '../../src/assets/config.ts';
import { createCosStorage } from '../../src/integrations/cos.ts';
import { findFixtureRoute } from '../providers/fixtures/onelink-routes-fixture.ts';
import {
  authenticateOrCreateRetainedDevOwner,
  parseLiveAuthInput,
  preparePersistentDevEnvironment,
} from '../support/local-dev-live.ts';

// Explicit, retained-data acceptance of A generation. No B process or image MQ is started.
// Usage: MIO_RUN_LIVE_IMAGE=yes node tests/compute/live-image-loop.ts [--scenario <name>]
//   dev <new-.runtime-run-dir> <login-or-key-file> <task-id>
// Legacy prepare/execute phases are retired; use isolated generation tests for destructive recovery.

const SCENARIOS = [
  'vidu-async',
  'kling-async',
  'seedream-sync',
  'gpt-sync',
  'gpt-edit',
  'seedream-45-sync',
  'seedream-50-lite-sync',
  'kling-omni-async',
] as const;
type Scenario = (typeof SCENARIOS)[number];
function parseCliArguments(argv: string[], envScenario: string | undefined) {
  let cliScenario: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--scenario') {
      assert(cliScenario === undefined && i + 1 < argv.length, 'LIVE_ARGUMENTS');
      cliScenario = argv[++i];
    } else if (arg.startsWith('--scenario=')) {
      assert(cliScenario === undefined, 'LIVE_ARGUMENTS');
      cliScenario = arg.slice('--scenario='.length);
    } else {
      positional.push(arg);
    }
  }
  assert(!cliScenario || !envScenario || cliScenario === envScenario, 'LIVE_ARGUMENTS');
  const raw = cliScenario ?? (envScenario && envScenario.length ? envScenario : undefined);
  const selected = raw ?? 'vidu-async';
  assert((SCENARIOS as readonly string[]).includes(selected), 'LIVE_SCENARIO');
  return {
    scenario: selected as Scenario,
    explicitScenario: raw !== undefined,
    positional,
  };
}
export function parseLiveInvocation(
  argv: string[],
  optIn: string | undefined,
  envScenario: string | undefined,
) {
  assert.equal(optIn, 'yes', 'LIVE_OPT_IN');
  const { scenario, explicitScenario, positional } = parseCliArguments(argv, envScenario);
  const phase = positional[0];
  let runArgument: string;
  let first: string;
  let second = '';
  let taskId: string;
  if (phase === 'dev') {
    const [, run, auth, task, ...extra] = positional;
    assert(run && auth && task && !extra.length, 'LIVE_ARGUMENTS');
    runArgument = run;
    first = auth;
    taskId = task;
  } else {
    const [, run, a, b, task, ...extra] = positional;
    assert(
      ['prepare', 'execute'].includes(phase ?? '') && run && a && b && task && !extra.length,
      'LIVE_ARGUMENTS',
    );
    runArgument = run;
    first = a;
    second = b;
    taskId = task;
  }
  assert.match(taskId, /^[a-z0-9][a-z0-9_-]{0,79}$/, 'LIVE_TASK');
  const directory = resolve(runArgument);
  assert(directory.startsWith(`${resolve('.runtime')}${sep}`), 'LIVE_PRIVATE_DIRECTORY');
  return {
    scenario,
    explicitScenario,
    phase: phase!,
    runArgument,
    first,
    second,
    taskId,
    directory,
  };
}

export function assertLivePhase(phase: string) {
  if (phase !== 'dev') throw new Error('LIVE_LEGACY_PHASE_RETIRED');
}

function failureCode(error: unknown): string {
  const first = error instanceof Error ? error.message.split('\n', 1)[0] : undefined;
  return first && /^[A-Z0-9_]+$/.test(first) ? first : 'LIVE_UNEXPECTED_FAILURE';
}
type Environment = Record<string, string>;
type State = { origin: string; a: Environment };
type Candidate = { commit: string; contractRevision: number };
function fileHash(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
const LIVE_ARTIFACT_PATHS = [
  'tests/compute/live-image-loop.ts',
  'tests/compute/live-image-audit.ts',
  'scripts/service/generation-cutover.ts',
  'scripts/service/migrate-generations.ts',
  'src/generations',
  'src/integrations/onelink',
  'src/providers/credentials.ts',
  'package.json',
  'pnpm-lock.yaml',
  'dist',
  'packages/foundation/dist',
] as const;
async function request(origin: string, path: string, method = 'GET', body?: unknown, cookie = '') {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
}
function session(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
  assert(cookie, 'LIVE_COOKIE');
  return cookie;
}
type LiveModel = {
  modelId: string;
  modelRef: string;
  discovered: boolean;
  credentialVersion: number;
  catalogVersion: number;
};
export function selectLiveModel(
  selectedScenario: Scenario,
  items: LiveModel[],
  credentialVersion: number,
  catalogVersion: number,
) {
  const selected = items.find((item) => {
    if (!item.discovered) return false;
    switch (selectedScenario) {
      case 'vidu-async':
        return item.modelId === 'image-vidu-q2';
      case 'kling-async':
        return item.modelId === 'image-kling-v3';
      case 'kling-omni-async':
        return item.modelId === 'image-kling-v3-omni';
      case 'seedream-sync':
        return item.modelId === 'doubao-seedream-4.0';
      case 'seedream-45-sync':
        return item.modelId === 'doubao-seedream-4.5';
      case 'seedream-50-lite-sync':
        return item.modelId === 'doubao-seedream-5.0-lite';
      case 'gpt-sync':
      case 'gpt-edit':
        return item.modelId === 'gpt-image-1' || item.modelId.startsWith('gpt-image-');
    }
  });
  assert(
    selected &&
      selected.credentialVersion === credentialVersion &&
      selected.catalogVersion === catalogVersion,
    'LIVE_MODEL_NOT_FOUND',
  );
  return selected;
}
function isAsyncScenario(selectedScenario: Scenario) {
  return ['vidu-async', 'kling-async', 'kling-omni-async'].includes(selectedScenario);
}
function profileForScenario(selectedScenario: Scenario) {
  if (selectedScenario === 'vidu-async') return 'vidu-images';
  if (selectedScenario === 'kling-async' || selectedScenario === 'kling-omni-async')
    return 'kling-images';
  if (selectedScenario.startsWith('seedream-')) return 'volcengine-ark-images';
  return 'openai-images';
}
export function liveRouteDeclaration(selectedScenario: Scenario, modelId: string) {
  if (selectedScenario === 'vidu-async') {
    const base = findFixtureRoute('image-vidu-q2', 'image.generate');
    return {
      ...base,
      rawModelId: modelId,
      sourceKind: 'protocol-reference',
      source: 'https://docs.onelinkai.cloud/8653257m0',
      sourceVersion: '2026-11-14',
      paramSpec: {
        ...base.paramSpec!,
        async: { operations: ['generate'], maxQueries: 8, maxAgeSeconds: 600 },
      },
    };
  }
  if (selectedScenario === 'kling-async' || selectedScenario === 'kling-omni-async') {
    const base = findFixtureRoute(
      selectedScenario === 'kling-async' ? 'image-kling-v3' : 'image-kling-v3-omni',
      'image.generate',
    );
    return {
      ...base,
      rawModelId: modelId,
      paramSpec: {
        ...base.paramSpec!,
        maxN: 1,
        ...(selectedScenario === 'kling-async'
          ? { maxReferenceImages: 0, allowGenerateReferences: false }
          : {}),
        async: { operations: ['generate'], maxQueries: 8, maxAgeSeconds: 600 },
      },
      ...(selectedScenario === 'kling-async' ? { requestDefaults: {} } : {}),
    };
  }
  if (selectedScenario.startsWith('seedream-')) {
    const base = findFixtureRoute(
      selectedScenario === 'seedream-45-sync'
        ? 'doubao-seedream-4.5'
        : selectedScenario === 'seedream-50-lite-sync'
          ? 'doubao-seedream-5.0-lite'
          : 'doubao-seedream-4.0',
      'image.generate',
    );
    return {
      ...base,
      rawModelId: modelId,
      sourceKind: 'protocol-reference',
      source: 'https://docs.onelinkai.cloud/8655248m0',
      sourceVersion: '2026-11-14',
    };
  }
  const base = findFixtureRoute('gpt-image-2', 'image.generate');
  return {
    ...base,
    rawModelId: modelId,
    sourceKind: 'protocol-reference',
    source: 'https://docs.onelinkai.cloud/8882392m0',
    sourceVersion: '2026-11-14',
    ...(selectedScenario === 'gpt-edit'
      ? { paramSpec: { ...base.paramSpec!, maxReferenceImages: 4 } }
      : {
          editPath: null,
          paramSpec: {
            ...base.paramSpec!,
            supportedOperations: ['generate'],
            maxReferenceImages: 0,
            allowMaskPng: false,
          },
        }),
  };
}
export function liveImageParameters(selectedScenario: Scenario, referenceAssetId?: string) {
  const prompt = 'A simple blue square on a white background.';
  if (selectedScenario === 'vidu-async') return { prompt, async: true, size: '1080p' };
  if (selectedScenario === 'kling-async') return { prompt, async: true };
  if (selectedScenario === 'seedream-45-sync' || selectedScenario === 'kling-omni-async') {
    assert(referenceAssetId, 'LIVE_REFERENCE_REQUIRED');
    return {
      prompt,
      operation: 'generate',
      imageAssetIds: [referenceAssetId],
      n: 1,
      ...(selectedScenario === 'seedream-45-sync' ? { size: '2K' } : { async: true }),
    };
  }
  if (selectedScenario === 'seedream-50-lite-sync')
    return {
      prompt:
        'Generate exactly two separate images: first a blue square on a white background; second a blue circle on a white background.',
      n: 2,
      size: '2K',
      output_format: 'png',
    };
  if (selectedScenario === 'gpt-edit') {
    assert(referenceAssetId, 'LIVE_REFERENCE_REQUIRED');
    return {
      prompt,
      operation: 'edit',
      imageAssetIds: [referenceAssetId],
      n: 1,
      size: '1024x1024',
    };
  }
  return { prompt, n: 1, size: '1024x1024' };
}
export function assertFrozenScenario(
  command: GenerationRequest,
  selectedScenario: Scenario,
  modelId: string,
  ownerId: string,
  jobId: string,
  referenceAsset?: ImageAssetRef,
) {
  const parameters = liveImageParameters(selectedScenario, referenceAsset?.assetId);
  const declaration = liveRouteDeclaration(selectedScenario, modelId);
  const input = command.input;
  const references = input.images ?? (input.image ? [input.image] : []);
  const expectedReferences = referenceAsset ? [referenceAsset] : [];
  assert(
    command.type === 'image.request' &&
      command.jobId === jobId &&
      command.ownerId === ownerId &&
      command.profile === profileForScenario(selectedScenario) &&
      command.route.driver === command.profile &&
      command.route.submitPath === declaration.submitPath &&
      (command.route.editPath ?? null) === (declaration.editPath ?? null) &&
      (command.route.queryPathTemplate ?? null) === (declaration.queryPathTemplate ?? null) &&
      command.route.requestDefaults.referenceFormat ===
        declaration.requestDefaults?.referenceFormat &&
      (!isAsyncScenario(selectedScenario) || command.route.paramSpec.async?.maxQueries === 8) &&
      input.model === modelId &&
      input.prompt === parameters.prompt &&
      input.operation === ('operation' in parameters ? parameters.operation : undefined) &&
      input.size === ('size' in parameters ? parameters.size : undefined) &&
      input.output_format ===
        ('output_format' in parameters ? parameters.output_format : undefined) &&
      input.async === ('async' in parameters ? parameters.async : undefined) &&
      (input.n ?? 1) === ('n' in parameters ? parameters.n : 1) &&
      !(input.image && input.images) &&
      references.length === expectedReferences.length &&
      references.every((reference, index) => {
        const expected = expectedReferences[index];
        return (
          expected?.assetId === reference.assetId &&
          expected.key === reference.key &&
          expected.sizeBytes === reference.sizeBytes &&
          expected.etag === reference.etag &&
          expected.contentType === reference.contentType
        );
      }),
    'LIVE_FROZEN_MISMATCH',
  );
}
export function captureLiveArtifacts(root: string, paths: readonly string[] = LIVE_ARTIFACT_PATHS) {
  const files: { path: string; sha256: string }[] = [];
  function visit(relative: string) {
    const full = resolve(root, relative);
    assert(full.startsWith(`${resolve(root)}${sep}`), 'LIVE_ARTIFACT_PATH');
    const stat = lstatSync(full);
    assert(!stat.isSymbolicLink(), 'LIVE_ARTIFACT_PATH');
    if (stat.isDirectory()) {
      const entries = readdirSync(full).sort();
      assert(entries.length > 0, 'LIVE_ARTIFACT_PATH');
      for (const name of entries) {
        assert(name !== 'node_modules', 'LIVE_ARTIFACT_PATH');
        visit(`${relative}/${name}`);
      }
    } else {
      assert(stat.isFile(), 'LIVE_ARTIFACT_PATH');
      files.push({ path: relative, sha256: fileHash(full) });
    }
  }
  for (const path of paths) visit(path);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    version: 1 as const,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  };
}
export function assertLiveArtifacts(
  expected: string,
  root: string,
  paths: readonly string[] = LIVE_ARTIFACT_PATHS,
) {
  try {
    assert(/^[a-f0-9]{64}$/.test(expected));
    assert.equal(captureLiveArtifacts(root, paths).sha256, expected);
  } catch {
    throw new Error('LIVE_ARTIFACT_CHANGED');
  }
}
type ImageView = {
  jobId: string;
  status: string;
  requestedCount: number;
  errorCode: string | null;
  assetIds: string[];
  outputs: { index: number; assetId: string }[];
};
type SavedOutput = { key: string; sizeBytes: number; sha256: string; contentType: string };
export function matchCompletedOutputs(
  image: ImageView,
  outputs: SavedOutput[],
  expectedCount: number,
  selectedScenario: Scenario,
) {
  assert(
    image.status === 'completed' &&
      image.requestedCount === expectedCount &&
      image.assetIds.length === expectedCount &&
      image.outputs.length === expectedCount &&
      outputs.length === expectedCount &&
      new Set(image.assetIds).size === expectedCount &&
      new Set(outputs.map((output) => output.key)).size === expectedCount,
    'LIVE_IMAGE_INCOMPLETE',
  );
  return image.outputs.map(({ index, assetId }, position) => {
    const matching = outputs.filter(
      (output) => imageOutputIndex(image.jobId, output.key, output.contentType) === index,
    );
    assert(
      index === position &&
        image.assetIds[position] === assetId &&
        matching.length === 1 &&
        matching[0]!.sizeBytes > 0 &&
        /^[a-f0-9]{64}$/.test(matching[0]!.sha256) &&
        (selectedScenario !== 'seedream-sync' || matching[0]!.contentType === 'image/jpeg') &&
        (selectedScenario !== 'seedream-50-lite-sync' || matching[0]!.contentType === 'image/png'),
      'LIVE_JOURNAL_OBJECT',
    );
    return { assetId, output: matching[0]! };
  });
}
export async function assetBytes(
  state: Pick<State, 'origin' | 'a'>,
  cookie: string,
  otherCookie: string,
  assetId: string,
  expected: Omit<SavedOutput, 'key'> & { key?: string },
) {
  const path = `/api/v1/assets/${assetId}`;
  assert.equal((await request(state.origin, path)).status, 401, 'LIVE_ASSET_UNAUTHENTICATED');
  assert.equal(
    (await request(state.origin, path, 'GET', undefined, otherCookie)).status,
    404,
    'LIVE_ASSET_OTHER_OWNER',
  );
  const response = await request(state.origin, path, 'GET', undefined, cookie);
  assert.equal(response.status, 200, 'LIVE_ASSET_GET');
  const asset = (await response.json()) as {
    status: string;
    contentType: string;
    size: number;
    downloadUrl: string;
  };
  assert(
    asset.status === 'ready' &&
      asset.contentType === expected.contentType &&
      asset.size === expected.sizeBytes,
    'LIVE_ASSET_METADATA',
  );
  const url = new URL(asset.downloadUrl);
  assert(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      url.hostname === `${state.a.MIO_COS_BUCKET}.cos.${state.a.MIO_COS_REGION}.myqcloud.com`,
    'LIVE_ASSET_HOST',
  );
  let objectKey: string;
  try {
    objectKey = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('LIVE_ASSET_OBJECT_KEY');
  }
  if (expected.key !== undefined) assert.equal(objectKey, expected.key, 'LIVE_ASSET_OBJECT_KEY');
  const securityToken = url.searchParams.get('x-cos-security-token');
  if (state.a.MIO_COS_SESSION_TOKEN) {
    assert.equal(securityToken, state.a.MIO_COS_SESSION_TOKEN, 'LIVE_ASSET_TOKEN_ENCODING');
  } else {
    assert.equal(securityToken, null, 'LIVE_ASSET_TOKEN_ABSENT_FOR_STATIC_CREDENTIAL');
  }
  const download = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.equal(download.status, 200, 'LIVE_ASSET_DOWNLOAD');
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.length, expected.sizeBytes, 'LIVE_ASSET_SIZE');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    expected.sha256,
    'LIVE_ASSET_HASH',
  );
  await createImageDecoder()(bytes, asset.contentType.slice('image/'.length));
  return {
    key: objectKey,
    sizeBytes: bytes.length,
    contentType: asset.contentType,
    etag: download.headers.get('etag'),
  };
}
export async function verifyReplayResult(
  state: Pick<State, 'origin' | 'a'>,
  cookie: string,
  otherCookie: string,
  observation: {
    response: Response;
    initial: ImageView;
    outputs: ReturnType<typeof matchCompletedOutputs>;
    expectedCount: number;
    queryAttempts: number;
    finalQueries: number;
  },
) {
  const finalImage = (await observation.response.json()) as ImageView;
  assert(
    observation.response.status === 200 &&
      finalImage.status === 'completed' &&
      finalImage.requestedCount === observation.expectedCount &&
      JSON.stringify(finalImage.assetIds) === JSON.stringify(observation.initial.assetIds) &&
      JSON.stringify(finalImage.outputs) === JSON.stringify(observation.initial.outputs) &&
      observation.finalQueries === observation.queryAttempts,
    'LIVE_REPLAY_RESULT',
  );
  for (const { assetId, output } of observation.outputs)
    await assetBytes(state, cookie, otherCookie, assetId, output);
}
export async function createReferenceAsset(
  state: Pick<State, 'origin' | 'a'>,
  cookie: string,
  otherCookie: string,
  bytes: Uint8Array,
) {
  const created = await request(
    state.origin,
    '/api/v1/assets/uploads',
    'POST',
    { filename: 'live-reference.png', contentType: 'image/png', size: bytes.byteLength },
    cookie,
  );
  assert.equal(created.status, 201, 'LIVE_REFERENCE_CREATE');
  const { assetId, uploadUrl } = (await created.json()) as { assetId: string; uploadUrl: string };
  const url = new URL(uploadUrl);
  assert(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.hostname === `${state.a.MIO_COS_BUCKET}.cos.${state.a.MIO_COS_REGION}.myqcloud.com`,
    'LIVE_REFERENCE_HOST',
  );
  const upload = await fetch(url, {
    method: 'PUT',
    body: Buffer.from(bytes),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  assert(upload.ok, 'LIVE_REFERENCE_UPLOAD');
  const completed = await request(
    state.origin,
    `/api/v1/assets/${assetId}/complete`,
    'POST',
    {},
    cookie,
  );
  assert.equal(completed.status, 200, 'LIVE_REFERENCE_COMPLETE');
  const expected = {
    contentType: 'image/png',
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const verified = await assetBytes(state, cookie, otherCookie, assetId, expected);
  const etag = verified.etag;
  assert(
    verified.key.startsWith(`mio/raw/${assetId}/`) &&
      isValidImageAssetObjectKey(assetId, verified.key, verified.contentType) &&
      verified.contentType === 'image/png' &&
      etag &&
      etag.length <= 256 &&
      !/[\x00-\x1f\x7f]/.test(etag),
    'LIVE_REFERENCE_OBJECT',
  );
  return { ...verified, assetId, contentType: 'image/png', etag } satisfies ImageAssetRef;
}

async function runPersistentDev(invocation: ReturnType<typeof parseLiveInvocation>) {
  assertLivePhase(invocation.phase);
  const { directory, taskId, first: authPath, scenario } = invocation;
  const project = realpathSync('.');
  const taskPath = join(project, '.work', 'tasks', taskId, 'state.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf8')) as {
    workspace: string;
    plan: { id: string };
    stage: string;
    contractRevision: number;
    checkpoint: { candidate: Candidate };
  };
  const candidate = task.checkpoint?.candidate;
  assert(task.workspace === project && task.plan.id === taskId, 'LIVE_TASK_OWNER');
  assert(
    task.stage === 'C1_EVIDENCE_PENDING' &&
      candidate &&
      candidate.contractRevision === task.contractRevision,
    'LIVE_CANDIDATE',
  );
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'utf8',
  });
  assert(head.status === 0 && head.stdout.trim() === candidate.commit, 'LIVE_CANDIDATE_CHANGED');
  assert(status.status === 0 && !status.stdout.length, 'LIVE_DIRTY');
  const artifact = captureLiveArtifacts(project);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const record = (event: string, data: Record<string, unknown> = {}) =>
    writeFileSync(
      join(directory, 'events.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`,
      { flag: 'a', mode: 0o600 },
    );
  const dev = await preparePersistentDevEnvironment(['auth', 'assets', 'generations', 'providers']);
  const env: NodeJS.ProcessEnv = {
    ...dev.runtimeEnv,
    MIO_GENERATIONS_ENABLED: 'true',
    MIO_GENERATIONS_DATA_DIR: dev.runtimeEnv.MIO_GENERATIONS_DATA_DIR,
    MIO_LIVE_IMAGE_AUDIT_DIRECTORY: directory,
    MIO_LIVE_IMAGE_SCENARIO: scenario,
    MIO_LIVE_IMAGE_AWAIT_TASK: isAsyncScenario(scenario) ? 'yes' : 'no',
    NODE_OPTIONS: `--import=${resolve('tests/compute/live-image-audit.ts')}`,
  };
  delete env.MIO_COMPUTE_ENABLED;
  delete env.RABBITMQ_URL;
  delete env.MIO_IMAGE_PUBLIC_KEY;
  delete env.MIO_IMAGE_PRIVATE_KEY;
  delete env.MIO_IMAGE_KEY_ID;
  assert(env.MIO_GENERATIONS_DATA_DIR && env.MIO_ASSETS_DATABASE_URL, 'LIVE_GENERATION_CONFIG');
  const pool = new Pool({ connectionString: env.MIO_ASSETS_DATABASE_URL });
  let app: ChildProcess | undefined;
  const stop = async () => {
    if (!app || app.exitCode !== null || app.signalCode !== null) return;
    const done = once(app, 'exit');
    app.kill('SIGTERM');
    const settled = await Promise.race([done, delay(10_000, null)]);
    if (!settled) {
      app.kill('SIGKILL');
      await done;
    }
  };
  const start = async () => {
    await prepareProfile(dev.runtimeEnv.DSH_HOME, project);
    app = spawn(process.execPath, [launcher(), '--profile', 'mio'], {
      cwd: dev.runtimeEnv.DSH_HOME,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout?.on('data', () => {});
    app.stderr?.on('data', () => {});
    for (let i = 0; i < 120; i++) {
      assert(app.exitCode === null && app.signalCode === null, 'LIVE_APP_EARLY_EXIT');
      try {
        const ready = await fetch(`${dev.origin}/readyz`, {
          redirect: 'error',
          signal: AbortSignal.timeout(1500),
        });
        if (ready.status === 200) return;
      } catch {}
      await delay(250);
    }
    throw new Error('LIVE_APP_NOT_READY');
  };
  try {
    const preflight = await inspectGenerationCutover(pool, {
      dataDirectory: env.MIO_GENERATIONS_DATA_DIR,
      journal: resolve(dev.values.MIO_LOCAL_COMPUTE_DIRECTORY!, 'journal.sqlite3'),
      env: dev.values,
      probeCos: true,
    });
    record('cutover-preflight', { ...preflight });
    assert(preflight.readyForCutover, 'LIVE_CUTOVER_PREFLIGHT');
    await start();
    const auth = await parseLiveAuthInput(authPath);
    const owner = await authenticateOrCreateRetainedDevOwner(dev.origin, auth, 'image-a');
    const otherRes = await request(dev.origin, '/api/auth/sign-up/email', 'POST', {
      name: 'Live other',
      email: `live-other-${randomUUID()}@mio.dev.local`,
      password: randomBytes(24).toString('hex'),
    });
    assert.equal(otherRes.status, 200, 'LIVE_OTHER_CREATE');
    const otherCookie = session(otherRes);
    if (owner.apiKey) {
      const metadata = await request(
        dev.origin,
        '/api/v1/providers/onelink',
        'GET',
        undefined,
        owner.cookie,
      );
      assert.equal(metadata.status, 200, 'LIVE_PROVIDER_GET');
      const provider = (await metadata.json()) as { revision?: number } | null;
      const saved = await request(
        dev.origin,
        '/api/v1/providers/onelink/credential',
        'PUT',
        { apiKey: owner.apiKey, expectedRevision: provider?.revision ?? 0 },
        owner.cookie,
      );
      assert.equal(saved.status, 200, 'LIVE_PROVIDER_SAVE');
    }
    const refresh = await request(
      dev.origin,
      '/api/v1/providers/onelink/test',
      'POST',
      {},
      owner.cookie,
    );
    assert.equal(refresh.status, 200, 'LIVE_MODELS_REFRESH');
    const discovery = (await refresh.json()) as { status: string };
    assert.equal(discovery.status, 'connected', 'LIVE_MODELS_DISCOVERY_FAILED');
    const models = await request(
      dev.origin,
      '/api/v1/providers/onelink/models',
      'GET',
      undefined,
      owner.cookie,
    );
    assert.equal(models.status, 200, 'LIVE_MODELS');
    const catalog = (await models.json()) as {
      items: LiveModel[];
      provider: { credentialVersion: number; catalog: { version: number } };
    };
    const model = selectLiveModel(
      scenario,
      catalog.items,
      catalog.provider.credentialVersion,
      catalog.provider.catalog.version,
    );
    const route = liveRouteDeclaration(scenario, model.modelId);
    const imported = spawnSync(
      process.execPath,
      ['scripts/service/import-provider-route.ts', '--stdin'],
      {
        env,
        encoding: 'utf8',
        input: JSON.stringify({ routes: [route] }),
      },
    );
    assert.equal(imported.status, 0, 'LIVE_ROUTE_IMPORT');
    let reference: ImageAssetRef | undefined;
    const state = { origin: dev.origin, a: env as Environment };
    if (['gpt-edit', 'kling-omni-async', 'seedream-45-sync'].includes(scenario)) {
      const bytes = await sharp({
        create: { width: 512, height: 512, channels: 3, background: '#2477ee' },
      })
        .png()
        .toBuffer();
      reference = await createReferenceAsset(state, owner.cookie, otherCookie, bytes);
    }
    const body = {
      requestId: randomUUID(),
      modelRef: model.modelRef,
      parameters: liveImageParameters(scenario, reference?.assetId),
    };
    const accepted = await request(
      dev.origin,
      '/api/v1/compute/images',
      'POST',
      body,
      owner.cookie,
    );
    assert.equal(accepted.status, 202, 'LIVE_IMAGE_ADMISSION');
    const admitted = (await accepted.json()) as ImageView;
    const stored = (
      await pool.query<{ command: GenerationRequest }>(
        'SELECT command FROM mio_image_jobs WHERE id=$1',
        [admitted.jobId],
      )
    ).rows[0]!;
    assertFrozenScenario(
      stored.command,
      scenario,
      model.modelId,
      owner.userId,
      admitted.jobId,
      reference,
    );
    record('image-accepted', {
      jobId: admitted.jobId,
      requestId: body.requestId,
      modelId: model.modelId,
      scenario,
      candidate,
    });
    if (isAsyncScenario(scenario)) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const persisted = (
          await pool.query<{ upstream_task_id: string | null; async_deadline: Date }>(
            'SELECT upstream_task_id,async_deadline FROM mio_image_jobs WHERE id=$1',
            [admitted.jobId],
          )
        ).rows[0];
        if (persisted?.upstream_task_id) {
          const temporary = join(directory, 'allowed-task.tmp');
          writeFileSync(
            temporary,
            JSON.stringify({
              upstreamTaskId: persisted.upstream_task_id,
              deadline: persisted.async_deadline.getTime(),
            }),
            { mode: 0o600, flag: 'wx' },
          );
          const handle = openSync(temporary, 'r');
          try {
            fsyncSync(handle);
          } finally {
            closeSync(handle);
          }
          renameSync(temporary, join(directory, 'allowed-task.json'));
          break;
        }
        await delay(100);
      }
      assert(existsSync(join(directory, 'allowed-task.json')), 'LIVE_UPSTREAM_ID_NOT_PERSISTED');
    }
    let image: ImageView = admitted;
    const deadline = stored.command.expiresAt + 60_000;
    while (Date.now() < deadline) {
      const response = await request(
        dev.origin,
        `/api/v1/compute/images/${admitted.jobId}`,
        'GET',
        undefined,
        owner.cookie,
      );
      assert.equal(response.status, 200, 'LIVE_IMAGE_GET');
      image = (await response.json()) as ImageView;
      if (
        [
          'completed',
          'partial',
          'failed',
          'rejected',
          'unknown',
          'materialization_failed',
        ].includes(image.status)
      )
        break;
      await delay(1000);
    }
    record('image-outcome', {
      jobId: image.jobId,
      status: image.status,
      errorCode: image.errorCode,
    });
    assert.equal(image.status, 'completed', 'LIVE_IMAGE_INCOMPLETE');
    const outputs = (
      await pool.query<{
        index: number;
        assetId: string;
        key: string;
        sizeBytes: number;
        contentType: string;
      }>(
        `SELECT o.output_index AS index,o.asset_id AS "assetId",a.raw_key AS key,
       a.size_bytes::float8 AS "sizeBytes",a.content_type AS "contentType" FROM mio_image_outputs o
       JOIN mio_assets a ON a.id=o.asset_id WHERE o.job_id=$1 ORDER BY o.output_index`,
        [image.jobId],
      )
    ).rows;
    const expected: SavedOutput[] = [];
    for (const output of outputs) {
      const config = readAssetConfig(env);
      assert(config, 'LIVE_COS_CONFIG');
      const object = await createCosStorage(config).head(output.key);
      assert(object.sha256, 'LIVE_ASSET_HASH_METADATA');
      expected.push({ ...output, sha256: object.sha256 });
    }
    const matched = matchCompletedOutputs(image, expected, image.requestedCount, scenario);
    for (const { assetId, output } of matched)
      await assetBytes(state, owner.cookie, otherCookie, assetId, output);
    assert.equal(
      (await request(dev.origin, `/api/v1/compute/images/${image.jobId}`)).status,
      401,
      'LIVE_JOB_UNAUTHENTICATED',
    );
    assert.equal(
      (
        await request(
          dev.origin,
          `/api/v1/compute/images/${image.jobId}`,
          'GET',
          undefined,
          otherCookie,
        )
      ).status,
      404,
      'LIVE_JOB_OTHER_OWNER',
    );
    assert.equal(
      (
        await request(
          dev.origin,
          `/api/v1/compute/images/${image.jobId}/recover`,
          'POST',
          {},
          otherCookie,
        )
      ).status,
      404,
      'LIVE_RECOVER_OTHER_OWNER',
    );
    const before = (
      await pool.query<{ query_attempt: number }>(
        'SELECT query_attempt FROM mio_image_jobs WHERE id=$1',
        [image.jobId],
      )
    ).rows[0]!.query_attempt;
    await stop();
    await start();
    const duplicate = await request(
      dev.origin,
      '/api/v1/compute/images',
      'POST',
      body,
      owner.cookie,
    );
    assert([200, 202].includes(duplicate.status), 'LIVE_IMAGE_DUPLICATE');
    assert.equal(((await duplicate.json()) as ImageView).jobId, image.jobId, 'LIVE_JOB_IDEMPOTENT');
    const final = await request(
      dev.origin,
      `/api/v1/compute/images/${image.jobId}`,
      'GET',
      undefined,
      owner.cookie,
    );
    const after = (
      await pool.query<{ query_attempt: number }>(
        'SELECT query_attempt FROM mio_image_jobs WHERE id=$1',
        [image.jobId],
      )
    ).rows[0]!.query_attempt;
    await verifyReplayResult(state, owner.cookie, otherCookie, {
      response: final,
      initial: image,
      outputs: matched,
      expectedCount: image.requestedCount,
      queryAttempts: before,
      finalQueries: after,
    });
    assert(existsSync(join(directory, 'supplier-post-started.json')), 'LIVE_POST_MISSING');
    assert(!existsSync(join(directory, 'supplier-post-repeat-blocked.json')), 'LIVE_REPEAT_POST');
    assertLiveArtifacts(artifact.sha256, project);
    record('pass', {
      candidate,
      jobId: image.jobId,
      assetIds: image.assetIds,
      generationPosts: 1,
      bStarted: false,
      imageMq: false,
    });
  } catch (error) {
    const code = failureCode(error);
    record('failed-or-unknown', { code });
    throw new Error(code);
  } finally {
    await stop();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const invocation = parseLiveInvocation(
      process.argv.slice(2),
      process.env.MIO_RUN_LIVE_IMAGE,
      process.env.MIO_LIVE_IMAGE_SCENARIO,
    );
    await runPersistentDev(invocation);
  } catch (error) {
    console.error(failureCode(error));
    process.exitCode = 1;
  }
}
