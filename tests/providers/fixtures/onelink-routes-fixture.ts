import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ImageRouteConfig } from '../../../src/generations/image/contracts.ts';
import type { ModelRouteInput } from '../../../src/providers/contracts.ts';
import {
  resolveImageRoute,
  validateModelRouteEntry,
} from '../../../src/providers/onelink/router.ts';

const execFileAsync = promisify(execFile);

export function makeChatRouteFixture(
  rawModelId: string,
  vendor: string,
  options?: {
    driver?: 'openai-chat' | 'anthropic-messages';
    submitPath?: string;
    maxOutputTokens?: number;
    contextWindow?: number;
    sourceKind?: 'protocol-reference' | 'runtime-observation';
    source?: string;
    sourceVersion?: string;
    enabled?: boolean;
  },
): ModelRouteInput {
  const driver = options?.driver ?? 'openai-chat';
  return {
    providerType: 'onelink',
    rawModelId,
    operation: 'chat',
    vendor,
    driver,
    classification: 'chat',
    submitPath:
      options?.submitPath ??
      (driver === 'anthropic-messages' ? '/v1/messages' : '/v1/chat/completions'),
    capabilityMetadata: {
      ...(options?.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
      ...(options?.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
    },
    sourceKind: options?.sourceKind ?? 'protocol-reference',
    source: options?.source ?? 'https://docs.onelinkai.cloud/8882610m0',
    sourceVersion: options?.sourceVersion ?? '2026-11-09',
    ...(options?.enabled !== undefined ? { enabled: options.enabled } : {}),
  };
}

/**
 * Test-only route fixtures covering documented OneLink chat and image models.
 * Production code in src/ and dist/ bundles zero model tables; routes enter only via PostgreSQL.
 */
export const ONELINK_FIXTURE_ROUTES: readonly ModelRouteInput[] = [
  makeChatRouteFixture('deepseek-v4.1-flash', 'deepseek', {
    sourceKind: 'runtime-observation',
    source: 'docs/tasks/onelink-integration/complete/report.md#onelink-user-chat',
    sourceVersion: '2026-11-12',
    maxOutputTokens: 4096,
  }),
  makeChatRouteFixture('deepseek-chat', 'deepseek', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('deepseek-v3', 'deepseek', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('deepseek-v4-flash', 'deepseek', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('deepseek-v4-pro', 'deepseek', { maxOutputTokens: 8192 }),
  makeChatRouteFixture('doubao-seed-2.0-lite-260215', 'volcengine', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('doubao-seed-2.0-pro-260215', 'volcengine', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('doubao-seed-2.1-pro-260628', 'volcengine', { maxOutputTokens: 8192 }),
  makeChatRouteFixture('qwen3.7-max', 'alibaba', { maxOutputTokens: 8192 }),
  makeChatRouteFixture('qwen3.7-plus', 'alibaba', { maxOutputTokens: 8192 }),
  makeChatRouteFixture('qwen-long', 'alibaba', { maxOutputTokens: 8192 }),
  makeChatRouteFixture('WL-Qwen2.5-72B-Instruct', 'alibaba', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('glm-4.7', 'zhipu', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('glm-5', 'zhipu', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('glm-5-turbo', 'zhipu', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('glm-5.1', 'zhipu', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('GLM-5.1', 'zhipu', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('glm-5.2', 'zhipu', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('glm-5.3', 'zhipu', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('glm-5.3-flash', 'zhipu', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('kimi-k2.5', 'moonshot', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('kimi-k2.6', 'moonshot', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('kimi-k2.7-code', 'moonshot', { maxOutputTokens: 8192 }),
  makeChatRouteFixture('kimi-k3', 'moonshot', { maxOutputTokens: 8192 }),
  makeChatRouteFixture('kimi-k3-1103', 'moonshot', { maxOutputTokens: 8192 }),
  makeChatRouteFixture('kimi-k3.1-pro', 'moonshot', { maxOutputTokens: 8192 }),
  makeChatRouteFixture('kimi-k3.1-pro-highspeed', 'moonshot', { maxOutputTokens: 8192 }),
  makeChatRouteFixture('minimax-m2.7', 'minimax', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('minimax-m3', 'minimax', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('hunyuan-3.0', 'tencent', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('hy4', 'tencent', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('mimo-v2.6-flash', 'xiaomi', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('mimo-v2.6-pro', 'xiaomi', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('mimo-v2.6-pro-ultraspeed', 'xiaomi', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('step-3.5-flash', 'stepfun', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('gpt-4o', 'openai', { maxOutputTokens: 4096 }),
  makeChatRouteFixture('claude-sonnet-4-6', 'anthropic', {
    driver: 'anthropic-messages',
    submitPath: '/v1/messages',
    maxOutputTokens: 4096,
  }),
  {
    providerType: 'onelink',
    rawModelId: 'doubao-seedream-4.0',
    operation: 'image.generate',
    vendor: 'volcengine',
    driver: 'volcengine-ark-images',
    classification: 'image',
    submitPath: '/volc/api/v3/images/generations',
    paramSpec: {
      supportedOperations: ['generate'],
      requiresAsync: false,
      maxN: 1,
      allowExplicitN: true,
      allowedSizes: ['1024x1024'],
      allowCustomDimensions: false,
      maxReferenceImages: 0,
      allowGenerateReferences: false,
      allowMaskPng: false,
      allowOutpaintGeometry: false,
      allowedQualities: [],
      allowedBackgrounds: [],
      allowedModerations: [],
      allowedOutputFormats: [],
      allowOutputCompression: false,
      allowUserField: false,
      allowedAspectRatios: [],
      allowWatermarkOverride: false,
      async: null,
    },
    requestDefaults: {
      watermark: true,
      sequentialImageGeneration: 'disabled',
      responseFormat: 'b64_json',
      stream: false,
      defaultSize: '1024x1024',
    },
    outputSpec: { fixedOutputFormat: 'jpeg' },
    sourceKind: 'runtime-observation',
    source: 'docs/tasks/onelink-image-generation/complete/report.md#seedream-sync-slice',
    sourceVersion: '2026-11-15',
  },
  {
    providerType: 'onelink',
    rawModelId: 'doubao-seedream-4.5',
    operation: 'image.generate',
    vendor: 'volcengine',
    driver: 'volcengine-ark-images',
    classification: 'image',
    submitPath: '/volc/api/v3/images/generations',
    paramSpec: {
      supportedOperations: ['generate'],
      requiresAsync: false,
      maxN: 15,
      allowExplicitN: true,
      allowedSizes: ['1024x1024', '2K', '4K'],
      allowCustomDimensions: false,
      maxReferenceImages: 14,
      allowGenerateReferences: true,
      allowMaskPng: false,
      allowOutpaintGeometry: false,
      allowedQualities: [],
      allowedBackgrounds: [],
      allowedModerations: [],
      allowedOutputFormats: [],
      allowOutputCompression: false,
      allowUserField: false,
      allowedAspectRatios: [],
      allowWatermarkOverride: true,
      async: null,
    },
    requestDefaults: {
      watermark: false,
      sequentialImageGeneration: 'disabled',
      responseFormat: 'b64_json',
      stream: false,
      defaultSize: '2K',
    },
    outputSpec: { fixedOutputFormat: 'jpeg' },
    sourceKind: 'runtime-observation',
    source: 'docs/tasks/onelink-image-generation/complete/report.md',
    sourceVersion: '2026-11-15',
  },
  {
    providerType: 'onelink',
    rawModelId: 'doubao-seedream-5.0-lite',
    operation: 'image.generate',
    vendor: 'volcengine',
    driver: 'volcengine-ark-images',
    classification: 'image',
    submitPath: '/volc/api/v3/images/generations',
    paramSpec: {
      supportedOperations: ['generate'],
      requiresAsync: false,
      maxN: 15,
      allowExplicitN: true,
      allowedSizes: ['1024x1024', '2K', '3K', '4K'],
      allowCustomDimensions: false,
      maxReferenceImages: 14,
      allowGenerateReferences: true,
      allowMaskPng: false,
      allowOutpaintGeometry: false,
      allowedQualities: [],
      allowedBackgrounds: [],
      allowedModerations: [],
      allowedOutputFormats: ['jpeg', 'png'],
      allowOutputCompression: false,
      allowUserField: false,
      allowedAspectRatios: [],
      allowWatermarkOverride: true,
      async: null,
    },
    requestDefaults: {
      watermark: false,
      sequentialImageGeneration: 'disabled',
      responseFormat: 'b64_json',
      stream: false,
      defaultSize: '2K',
    },
    outputSpec: { fixedOutputFormat: null },
    sourceKind: 'protocol-reference',
    source: 'https://docs.onelinkai.cloud/8655248m0',
    sourceVersion: '2026-11-15',
  },
  {
    providerType: 'onelink',
    rawModelId: 'doubao-seedream-5-0-pro-260628',
    operation: 'image.generate',
    vendor: 'volcengine',
    driver: 'volcengine-ark-images',
    classification: 'image',
    submitPath: '/volc/api/v3/images/generations',
    paramSpec: {
      supportedOperations: ['generate'],
      requiresAsync: false,
      maxN: 15,
      allowExplicitN: true,
      allowedSizes: ['1024x1024', '2K', '3K', '4K'],
      allowCustomDimensions: false,
      maxReferenceImages: 14,
      allowGenerateReferences: true,
      allowMaskPng: false,
      allowOutpaintGeometry: false,
      allowedQualities: [],
      allowedBackgrounds: [],
      allowedModerations: [],
      allowedOutputFormats: ['jpeg', 'png'],
      allowOutputCompression: false,
      allowUserField: false,
      allowedAspectRatios: [],
      allowWatermarkOverride: true,
      async: null,
    },
    requestDefaults: {
      watermark: false,
      sequentialImageGeneration: 'disabled',
      responseFormat: 'b64_json',
      stream: false,
      defaultSize: '2K',
    },
    outputSpec: { fixedOutputFormat: null },
    sourceKind: 'protocol-reference',
    source: 'https://docs.onelinkai.cloud/8655248m0',
    sourceVersion: '2026-11-15',
  },
  {
    providerType: 'onelink',
    rawModelId: 'image-vidu-q2',
    operation: 'image.generate',
    vendor: 'vidu',
    driver: 'vidu-images',
    classification: 'image',
    submitPath: '/vidu/ent/v2/reference2image',
    queryPathTemplate: '/vidu/ent/v2/tasks/{task_id}/creations',
    paramSpec: {
      supportedOperations: ['generate'],
      requiresAsync: true,
      maxN: 1,
      allowExplicitN: false,
      allowedSizes: ['1080p', '2K', '4K'],
      allowCustomDimensions: false,
      maxReferenceImages: 7,
      allowGenerateReferences: true,
      allowMaskPng: false,
      allowOutpaintGeometry: false,
      allowedQualities: [],
      allowedBackgrounds: [],
      allowedModerations: [],
      allowedOutputFormats: [],
      allowOutputCompression: false,
      allowUserField: false,
      allowedAspectRatios: [],
      allowWatermarkOverride: false,
      async: { operations: ['generate'], maxQueries: 16, maxAgeSeconds: 3600 },
    },
    requestDefaults: {},
    outputSpec: { fixedOutputFormat: null },
    sourceKind: 'runtime-observation',
    source: 'docs/tasks/onelink-image-generation/complete/report.md#async-image-slice',
    sourceVersion: '2026-11-15',
  },
  {
    providerType: 'onelink',
    rawModelId: 'image-kling-v3',
    operation: 'image.generate',
    vendor: 'kling',
    driver: 'kling-images',
    classification: 'image',
    submitPath: '/kling/v1/images/generations',
    queryPathTemplate: '/kling/v1/images/generations/{task_id}',
    paramSpec: {
      supportedOperations: ['generate'],
      requiresAsync: true,
      maxN: 4,
      allowExplicitN: true,
      allowedSizes: null,
      allowCustomDimensions: false,
      maxReferenceImages: 1,
      allowGenerateReferences: true,
      allowMaskPng: false,
      allowOutpaintGeometry: false,
      allowedQualities: [],
      allowedBackgrounds: [],
      allowedModerations: [],
      allowedOutputFormats: [],
      allowOutputCompression: false,
      allowUserField: false,
      allowedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
      allowWatermarkOverride: false,
      async: { operations: ['generate'], maxQueries: 16, maxAgeSeconds: 3600 },
    },
    requestDefaults: { referenceFormat: 'image' },
    outputSpec: { fixedOutputFormat: null },
    sourceKind: 'protocol-reference',
    source: 'https://docs.onelinkai.cloud/8653497m0',
    sourceVersion: '2026-09-08',
  },
  {
    providerType: 'onelink',
    rawModelId: 'image-kling-v3-omni',
    operation: 'image.generate',
    vendor: 'kling',
    driver: 'kling-images',
    classification: 'image',
    submitPath: '/kling/v1/images/omni-image',
    queryPathTemplate: '/kling/v1/images/omni-image/{task_id}',
    paramSpec: {
      supportedOperations: ['generate'],
      requiresAsync: true,
      maxN: 1,
      allowExplicitN: true,
      allowedSizes: null,
      allowCustomDimensions: false,
      maxReferenceImages: 1,
      allowGenerateReferences: true,
      allowMaskPng: false,
      allowOutpaintGeometry: false,
      allowedQualities: [],
      allowedBackgrounds: [],
      allowedModerations: [],
      allowedOutputFormats: [],
      allowOutputCompression: false,
      allowUserField: false,
      allowedAspectRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
      allowWatermarkOverride: false,
      async: { operations: ['generate'], maxQueries: 16, maxAgeSeconds: 3600 },
    },
    requestDefaults: { referenceFormat: 'image_list' },
    outputSpec: { fixedOutputFormat: null },
    sourceKind: 'protocol-reference',
    source: 'https://docs.onelinkai.cloud/8653497m0',
    sourceVersion: '2026-09-08',
  },
  {
    providerType: 'onelink',
    rawModelId: 'gpt-image-2',
    operation: 'image.generate',
    vendor: 'openai',
    driver: 'openai-images',
    classification: 'image',
    submitPath: '/v1/images/generations',
    editPath: '/v1/images/edits',
    paramSpec: {
      supportedOperations: ['generate', 'edit'],
      requiresAsync: false,
      maxN: 10,
      allowExplicitN: true,
      allowedSizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
      allowCustomDimensions: true,
      maxReferenceImages: 16,
      allowGenerateReferences: false,
      allowMaskPng: true,
      allowOutpaintGeometry: false,
      allowedQualities: ['high', 'medium', 'low', 'auto'],
      allowedBackgrounds: ['transparent', 'opaque', 'auto'],
      allowedModerations: ['low', 'auto'],
      allowedOutputFormats: ['png', 'jpeg', 'webp'],
      allowOutputCompression: true,
      allowUserField: true,
      allowedAspectRatios: [],
      allowWatermarkOverride: false,
      async: null,
    },
    requestDefaults: { responseFormat: 'b64_json' },
    outputSpec: { fixedOutputFormat: null },
    sourceKind: 'protocol-reference',
    source: 'https://platform.openai.com/docs/api-reference/images',
    sourceVersion: '2026-11-09',
  },
] as const;

export function findFixtureRoute(
  rawModelId: string,
  operation: 'chat' | 'image.generate',
): ModelRouteInput {
  const found = ONELINK_FIXTURE_ROUTES.find(
    (item) => item.rawModelId === rawModelId && item.operation === operation,
  );
  if (!found) throw new Error(`FIXTURE_ROUTE_NOT_FOUND:${operation}:${rawModelId}`);
  return found;
}

export function findFixtureImageRouteConfig(rawModelId: string): ImageRouteConfig {
  const entry = validateModelRouteEntry(findFixtureRoute(rawModelId, 'image.generate'));
  const resolved = resolveImageRoute({
    provider_type: entry.providerType,
    raw_model_id: entry.rawModelId,
    operation: entry.operation,
    vendor: entry.vendor,
    driver: entry.driver,
    classification: entry.classification,
    submit_path: entry.submitPath,
    edit_path: entry.editPath,
    query_path_template: entry.queryPathTemplate,
    param_spec: entry.paramSpec,
    request_defaults: entry.requestDefaults,
    output_spec: entry.outputSpec,
    capability_metadata: entry.capabilityMetadata,
    source_kind: entry.sourceKind,
    source: entry.source,
    source_version: entry.sourceVersion,
    declaration_version: 1,
    enabled: entry.enabled,
  });
  if (!resolved) throw new Error(`FIXTURE_IMAGE_ROUTE_INVALID:${rawModelId}`);
  return resolved.route;
}

export async function importRoutesViaCli(
  env: NodeJS.ProcessEnv,
  routes: readonly ModelRouteInput[] | ModelRouteInput = ONELINK_FIXTURE_ROUTES,
): Promise<{ total: number; inserted: number; updated: number; unchanged: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'mio-route-fixture-'));
  try {
    const file = join(dir, 'routes.json');
    const payload = Array.isArray(routes) ? { routes } : routes;
    await writeFile(file, JSON.stringify(payload));
    const { stdout } = await execFileAsync(
      process.execPath,
      ['scripts/service/import-provider-route.ts', file],
      { cwd: process.cwd(), env },
    );
    return JSON.parse(stdout.trim()) as {
      total: number;
      inserted: number;
      updated: number;
      unchanged: number;
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
