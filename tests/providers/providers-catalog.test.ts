import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { IMAGE_DRIVERS } from '../../src/generations/contracts.ts';
import { catalogView, legacyReference } from '../../src/providers/catalog.ts';
import {
  deriveImageCapabilityMetadata,
  deriveImageParameterView,
  resolveChatRoute,
  resolveImageRoute,
  validateModelRouteEntry,
  validateRouteImportPayload,
} from '../../src/providers/onelink/router.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import type { PlatformRouteRecord } from '../../src/providers/contracts.ts';
import {
  legacyPresets,
  legacySource,
  legacyCapabilityProfileById,
  legacyCapabilityProfiles,
} from './fixtures/onelink-legacy-snapshot.ts';
import {
  findFixtureImageRouteConfig,
  findFixtureRoute,
} from './fixtures/onelink-routes-fixture.ts';

it('retains the original 92-entry snapshot only as a migration/test reference', () => {
  expect(legacySource.presetsSha256).toBe(
    '63662a9942d978fba9d1dad025be84078e966441b9e1fcb0782e17b0977041df',
  );
  expect(legacyPresets).toHaveLength(92);
  const digest = createHash('sha256')
    .update(legacyPresets.map((m) => `${m.category}:${m.model_id}`).join('\n'))
    .digest('hex');
  expect(digest).toBe('ef821351cebad6fed67bee93f33bad501416e45add5b6044bd3360be9539b5a5');
  expect(
    Object.fromEntries(
      ['chat', 'image', 'video', 'voice', 'music'].map((category) => [
        category,
        legacyPresets.filter((m) => m.category === category).length,
      ]),
    ),
  ).toEqual({ chat: 55, image: 11, video: 22, voice: 2, music: 2 });
  expect(Object.keys(legacyCapabilityProfileById)).toHaveLength(33);
  expect(
    Object.values(legacyCapabilityProfileById).every((key) => legacyCapabilityProfiles[key]),
  ).toBe(true);
  expect(catalogView(null).items).toEqual([]);
});

it('parses old references without changing case, punctuation or route suffixes', () => {
  expect(legacyReference('onelink:chat:GLM-5.1:route-Q')).toEqual({
    usage: 'chat',
    id: 'GLM-5.1:route-Q',
  });
  expect(legacyReference('onelink:video:future-id')).toEqual({ usage: 'video', id: 'future-id' });
  expect(legacyReference('onelink:unknown:id')).toBeNull();
  expect(legacyReference('onelink:chat:')).toBeNull();
});

it('limits route imports to sourced, implemented vendor drivers and rejects endpoints, pricing or legacy profiles', () => {
  const entry = {
    providerType: 'onelink',
    rawModelId: 'custom-chat-model',
    operation: 'chat',
    vendor: 'openai',
    driver: 'openai-chat',
    classification: 'chat',
    submitPath: '/v1/chat/completions',
    sourceKind: 'protocol-reference',
    source: 'fixture',
    sourceVersion: 'v1',
  };
  expect(validateModelRouteEntry(entry)).toMatchObject({
    providerType: 'onelink',
    rawModelId: 'custom-chat-model',
    operation: 'chat',
    vendor: 'openai',
    driver: 'openai-chat',
    submitPath: '/v1/chat/completions',
  });
  expect(validateRouteImportPayload({ routes: [entry] })).toHaveLength(1);
  for (const cacheRetention of ['none', 'short', 'long'])
    expect(
      validateModelRouteEntry({ ...entry, capabilityMetadata: { cacheRetention } }),
    ).toMatchObject({
      capabilityMetadata: { cacheRetention },
    });
  for (const patch of [
    { driver: 'unknown' },
    { driver: 'gpt-images-v1' },
    { driver: ['openai-chat'] },
    { driver: null },
    { vendor: '' },
    { vendor: 'Invalid Vendor!' },
    { operation: 'image' },
    { submitPath: 'https://other.test/v1/chat/completions' },
    { submitPath: '/v1/../secret' },
    { source: '' },
    { verified: true },
    { endpoint: 'https://other.test' },
    { capabilityMetadata: { price: 0 } },
    { capabilityMetadata: { contextWindow: 0 } },
    { capabilityMetadata: { cacheRetention: '24h' } },
    { capabilityMetadata: { cacheRetention: null } },
    { capabilityMetadata: { cacheRetention: 60 } },
    { classification: 'unknown' },
  ])
    expect(() => validateModelRouteEntry({ ...entry, ...patch })).toThrow('ROUTE_INVALID');
});

it('requires an explicit visual chat route for bounded image budgets', () => {
  const entry = {
    rawModelId: 'vision-fixture',
    operation: 'chat',
    vendor: 'openai',
    driver: 'openai-chat',
    classification: 'chat',
    submitPath: '/v1/chat/completions',
    sourceKind: 'protocol-reference',
    source: 'fixture',
    sourceVersion: 'v1',
  };
  for (const [key, maximum] of [
    ['maxRequestImages', 16],
    ['maxRequestImageBytes', 20 * 1024 * 1024],
    ['requestImagePixelBudget', 16_777_216],
    ['requestImageMaxBytes', 10 * 1024 * 1024],
  ] as const) {
    for (const inputModalities of [undefined, ['text']])
      expect(() =>
        validateModelRouteEntry({
          ...entry,
          capabilityMetadata: { ...(inputModalities ? { inputModalities } : {}), [key]: 1 },
        }),
      ).toThrow('ROUTE_INVALID');
    for (const value of [0, maximum + 1, 1.5, '1'])
      expect(() =>
        validateModelRouteEntry({
          ...entry,
          capabilityMetadata: { inputModalities: ['text', 'image'], [key]: value },
        }),
      ).toThrow('ROUTE_INVALID');
    expect(
      validateModelRouteEntry({
        ...entry,
        capabilityMetadata: { inputModalities: ['image', 'text'], [key]: maximum },
      }).capabilityMetadata,
    ).toMatchObject({ inputModalities: ['text', 'image'], [key]: maximum });
  }
  for (const modalities of [[], ['image'], ['text', 'image', 'image'], ['text', 'audio']])
    expect(() =>
      validateModelRouteEntry({ ...entry, capabilityMetadata: { inputModalities: modalities } }),
    ).toThrow('ROUTE_INVALID');

  const row: PlatformRouteRecord = {
    provider_type: 'onelink',
    raw_model_id: 'vision-fixture',
    operation: 'chat',
    vendor: 'openai',
    driver: 'openai-chat',
    classification: 'chat',
    submit_path: '/v1/chat/completions',
    edit_path: null,
    query_path_template: null,
    param_spec: {},
    request_defaults: {},
    output_spec: {},
    capability_metadata: {},
    source_kind: 'protocol-reference',
    source: 'fixture',
    source_version: 'v1',
    declaration_version: 1,
    enabled: true,
  };
  expect(resolveChatRoute(row)).toMatchObject({
    inputModalities: ['text'],
    imageBudget: {
      maxRequestImages: 4,
      maxRequestImageBytes: 10 * 1024 * 1024,
      requestImagePixelBudget: 4_194_304,
      requestImageMaxBytes: 5 * 1024 * 1024,
    },
  });
  expect(
    resolveChatRoute({ ...row, capability_metadata: { maxRequestImages: 4 } }),
  ).toBeUndefined();
});

it('validates explicit image route paramSpec, edit/mask/outpaint gates, and derives capability metadata', () => {
  const gptFixture = findFixtureRoute('gpt-image-2', 'image.generate');
  const gptRouteConfig = findFixtureImageRouteConfig('gpt-image-2');
  const validated = validateModelRouteEntry(gptFixture);
  expect(validated.driver).toBe('openai-images');
  expect(deriveImageCapabilityMetadata(gptRouteConfig.paramSpec)).toEqual({
    modes: ['generate', 'edit'],
    references: { maxImages: 16 },
    mask: { format: 'png' },
  });
  expect(validated.capabilityMetadata).toEqual({
    image: {
      modes: ['generate', 'edit'],
      references: { maxImages: 16 },
      mask: { format: 'png' },
    },
  });

  const withOutpaint = validateModelRouteEntry({
    ...gptFixture,
    paramSpec: {
      ...gptFixture.paramSpec!,
      supportedOperations: ['generate', 'edit', 'outpaint'],
      allowOutpaintGeometry: true,
    },
  });
  expect(withOutpaint.capabilityMetadata).toMatchObject({
    image: {
      modes: ['generate', 'edit', 'outpaint'],
      geometry: { unit: 'pixels', edges: ['left', 'top', 'right', 'bottom'] },
    },
  });

  for (const bad of [
    { ...gptFixture, capabilityMetadata: { cacheRetention: 'long' } },
    // edit without editPath
    { ...gptFixture, editPath: null },
    // edit with 0 maxReferenceImages
    {
      ...gptFixture,
      paramSpec: { ...gptFixture.paramSpec!, maxReferenceImages: 0 },
    },
    // outpaint without allowOutpaintGeometry
    {
      ...gptFixture,
      paramSpec: {
        ...gptFixture.paramSpec!,
        supportedOperations: ['generate', 'outpaint'],
        allowOutpaintGeometry: false,
      },
    },
    // async without queryPathTemplate
    {
      ...gptFixture,
      paramSpec: {
        ...gptFixture.paramSpec!,
        requiresAsync: true,
        async: { operations: ['generate'], maxQueries: 8, maxAgeSeconds: 600 },
      },
    },
    // legacy profile rejected
    { ...gptFixture, driver: 'gpt-images-v1' },
    { ...gptFixture, driver: 'seedream-4-images-v1' },
    { ...gptFixture, driver: 'vidu-image-v1' },
    { ...gptFixture, driver: 'kling-image-v1' },
  ])
    expect(() => validateModelRouteEntry(bad)).toThrow('ROUTE_INVALID');
});

it('requires a non-catalog route source kind and never treats catalog membership as protocol evidence', () => {
  const entry = {
    providerType: 'onelink',
    rawModelId: 'source-kind-model',
    operation: 'chat',
    vendor: 'openai',
    driver: 'openai-chat',
    classification: 'chat',
    submitPath: '/v1/chat/completions',
    sourceKind: 'protocol-reference',
    source: 'onelink-v1-models',
    sourceVersion: 'v1',
  };
  expect(() => validateModelRouteEntry(entry)).toThrow('ROUTE_INVALID');
  for (const sourceKind of [undefined, 'catalog-membership', 'catalog', 'protocol', 'runtime'])
    expect(() =>
      validateModelRouteEntry({ ...entry, sourceKind, source: 'operator-runbook' }),
    ).toThrow('ROUTE_INVALID');
  expect(
    validateModelRouteEntry({ ...entry, sourceKind: 'runtime-observation', source: 'test-run-42' }),
  ).toMatchObject({ sourceKind: 'runtime-observation' });
});

it('validates schema tables, image drivers, and keeps incomplete async routes ADAPTER_PENDING in catalogView', () => {
  expect(IMAGE_DRIVERS).toEqual([
    'openai-images',
    'volcengine-ark-images',
    'vidu-images',
    'kling-images',
  ]);
  expect(providerSchemaSQL).toContain('CREATE TABLE IF NOT EXISTS mio_provider_model_routes');
  expect(providerSchemaSQL).toContain(
    'CREATE TABLE IF NOT EXISTS mio_provider_model_verifications',
  );
  expect(providerSchemaSQL).toContain(
    'ALTER TABLE mio_provider_model_verifications DROP COLUMN IF EXISTS adaptation_origin',
  );

  const klingEntry = validateModelRouteEntry(findFixtureRoute('image-kling-v3', 'image.generate'));
  expect(
    resolveImageRoute({
      provider_type: klingEntry.providerType,
      raw_model_id: klingEntry.rawModelId,
      operation: klingEntry.operation,
      vendor: klingEntry.vendor,
      driver: klingEntry.driver,
      classification: klingEntry.classification,
      submit_path: klingEntry.submitPath,
      edit_path: klingEntry.editPath,
      query_path_template: klingEntry.queryPathTemplate,
      param_spec: klingEntry.paramSpec,
      request_defaults: klingEntry.requestDefaults,
      output_spec: klingEntry.outputSpec,
      capability_metadata: klingEntry.capabilityMetadata,
      source_kind: klingEntry.sourceKind,
      source: klingEntry.source,
      source_version: klingEntry.sourceVersion,
      declaration_version: 1,
      enabled: true,
    }),
  ).toMatchObject({
    vendor: 'kling',
    profile: 'kling-images',
    asyncReady: true,
  });

  const now = new Date('2026-11-15T00:00:00.000Z');
  const modelKey = '00000000-0000-4000-8000-000000000099';
  const baseState = {
    id: '00000000-0000-4000-8000-000000000001',
    owner_id: 'owner-1',
    enabled: true,
    default_image_watermark: false,
    default_video_watermark: false,
    revision: 1,
    credential_version: 1,
    cipher_format: 1,
    master_key_id: 'k1',
    nonce: Buffer.alloc(12),
    ciphertext: Buffer.alloc(16),
    auth_tag: Buffer.alloc(16),
    discovery: null,
    catalog_version: 1,
    catalog_credential_version: 1,
    catalog_succeeded_at: now,
    latest_refresh_seq: 1,
    last_attempt_seq: 1,
    last_attempt_credential_version: 1,
    last_attempt_started_at: now,
    last_attempt_finished_at: now,
    last_attempt_status: 'connected' as const,
    last_attempt_error_code: null,
    credential_auth_state: 'valid' as const,
    models: [
      {
        model_key: modelKey,
        raw_model_id: 'image-kling-v3',
        legacy_ref: null,
        unavailable_reason: null,
        supplier_metadata: {},
        metadata_source: 'onelink-v1-models',
        credential_version: 1,
        catalog_version: 1,
        first_seen_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        membership_state: 'current' as const,
        display_name: null,
        description_override: null,
      },
    ],
    preferences: [],
  };

  // Disabled or corrupted async route (missing query_path_template) stays ADAPTER_PENDING
  const incompleteView = catalogView({
    ...baseState,
    routes: [
      {
        provider_type: 'onelink',
        raw_model_id: 'image-kling-v3',
        operation: 'image.generate',
        vendor: 'kling',
        driver: 'kling-images',
        classification: 'image',
        submit_path: '/kling/v1/images/generations',
        edit_path: null,
        query_path_template: null,
        param_spec: klingEntry.paramSpec as unknown as Record<string, unknown>,
        request_defaults: klingEntry.requestDefaults,
        output_spec: klingEntry.outputSpec as unknown as Record<string, unknown>,
        capability_metadata: {},
        source_kind: klingEntry.sourceKind,
        source: klingEntry.source,
        source_version: klingEntry.sourceVersion,
        declaration_version: 1,
        enabled: true,
      },
    ],
  });
  expect(incompleteView.items[0]?.image).toMatchObject({
    parameters: null,
    runnable: false,
    unavailableReason: 'ADAPTER_PENDING',
  });
  expect(incompleteView.items[0]?.image.parameters).toBeNull();

  const completeView = catalogView({
    ...baseState,
    routes: [
      {
        provider_type: 'onelink',
        raw_model_id: 'image-kling-v3',
        operation: 'image.generate',
        vendor: 'kling',
        driver: 'kling-images',
        classification: 'image',
        submit_path: klingEntry.submitPath,
        edit_path: klingEntry.editPath,
        query_path_template: klingEntry.queryPathTemplate,
        param_spec: klingEntry.paramSpec as unknown as Record<string, unknown>,
        request_defaults: klingEntry.requestDefaults,
        output_spec: klingEntry.outputSpec as unknown as Record<string, unknown>,
        capability_metadata: klingEntry.capabilityMetadata,
        source_kind: klingEntry.sourceKind,
        source: klingEntry.source,
        source_version: klingEntry.sourceVersion,
        declaration_version: 2,
        enabled: true,
      },
    ],
    verifications: [
      {
        provider_id: baseState.id,
        model_key: modelKey,
        operation: 'image.generate',
        driver: 'kling-images',
        declaration_version: 2,
        verification_status: 'verified',
        verified_at: now.toISOString(),
        verification_evidence: JSON.stringify({ runId: 'run-1' }),
        tested_tuple: {
          modelId: 'image-kling-v3',
          modelKey,
          operation: 'image.generate',
          profile: 'kling-images',
          credentialVersion: 1,
          catalogVersion: 1,
          adaptationVersion: 2,
        },
      },
    ],
  });
  const klingRouteConfig = findFixtureImageRouteConfig('image-kling-v3');
  const expectedKlingParams = deriveImageParameterView(klingRouteConfig);
  expect(completeView.items[0]).toMatchObject({
    category: 'image',
    classificationSource: `route:${klingEntry.source}@${klingEntry.sourceVersion}`,
    image: {
      parameters: expectedKlingParams,
      runnable: true,
      unavailableReason: null,
      adaptation: {
        vendor: 'kling',
        profile: 'kling-images',
        declarationVersion: 2,
        verification: { status: 'verified' },
      },
    },
  });
  expect(completeView.items[0]?.image.parameters).toEqual(expectedKlingParams);
  // Mutating returned arrays must not affect subsequent derivations
  expectedKlingParams.allowedAspectRatios.push('99:1');
  expect(deriveImageParameterView(klingRouteConfig).allowedAspectRatios).not.toContain('99:1');
  expect('origin' in (completeView.items[0]?.image?.adaptation ?? {})).toBe(false);

  // Restricted image route exposes exact admin-configured parameter bounds; chat-only model returns parameters: null
  const seedreamBase = findFixtureRoute('doubao-seedream-4.5', 'image.generate');
  const restrictedEntry = validateModelRouteEntry({
    ...seedreamBase,
    paramSpec: {
      ...seedreamBase.paramSpec!,
      allowedSizes: ['2K'],
      allowCustomDimensions: false,
      allowedAspectRatios: ['16:9'],
      maxN: 2,
    },
    requestDefaults: {
      ...seedreamBase.requestDefaults!,
      defaultSize: '2K',
    },
  });
  const chatEntry = validateModelRouteEntry(findFixtureRoute('deepseek-v4.1-flash', 'chat'));
  const chatModelKey = '00000000-0000-4000-8000-000000000098';
  const restrictedModelKey = '00000000-0000-4000-8000-000000000097';
  const restrictedView = catalogView({
    ...baseState,
    models: [
      {
        ...baseState.models[0]!,
        model_key: restrictedModelKey,
        raw_model_id: 'doubao-seedream-4.5',
      },
      {
        ...baseState.models[0]!,
        model_key: chatModelKey,
        raw_model_id: 'deepseek-v4.1-flash',
      },
    ],
    routes: [
      {
        provider_type: 'onelink',
        raw_model_id: restrictedEntry.rawModelId,
        operation: restrictedEntry.operation,
        vendor: restrictedEntry.vendor,
        driver: restrictedEntry.driver,
        classification: restrictedEntry.classification,
        submit_path: restrictedEntry.submitPath,
        edit_path: restrictedEntry.editPath,
        query_path_template: restrictedEntry.queryPathTemplate,
        param_spec: restrictedEntry.paramSpec,
        request_defaults: restrictedEntry.requestDefaults,
        output_spec: restrictedEntry.outputSpec,
        capability_metadata: restrictedEntry.capabilityMetadata,
        source_kind: restrictedEntry.sourceKind,
        source: restrictedEntry.source,
        source_version: restrictedEntry.sourceVersion,
        declaration_version: 1,
        enabled: true,
      },
      {
        provider_type: 'onelink',
        raw_model_id: chatEntry.rawModelId,
        operation: chatEntry.operation,
        vendor: chatEntry.vendor,
        driver: chatEntry.driver,
        classification: chatEntry.classification,
        submit_path: chatEntry.submitPath,
        edit_path: chatEntry.editPath,
        query_path_template: chatEntry.queryPathTemplate,
        param_spec: chatEntry.paramSpec,
        request_defaults: chatEntry.requestDefaults,
        output_spec: chatEntry.outputSpec,
        capability_metadata: chatEntry.capabilityMetadata,
        source_kind: chatEntry.sourceKind,
        source: chatEntry.source,
        source_version: chatEntry.sourceVersion,
        declaration_version: 1,
        enabled: true,
      },
    ],
  });
  const restrictedItem = restrictedView.items.find((i) => i.modelId === 'doubao-seedream-4.5');
  const chatOnlyItem = restrictedView.items.find((i) => i.modelId === 'deepseek-v4.1-flash');
  expect(restrictedItem?.image.parameters).toEqual({
    supportedOperations: ['generate'],
    requiresAsync: false,
    maxN: 2,
    allowExplicitN: true,
    allowedSizes: ['2K'],
    defaultSize: '2K',
    allowCustomDimensions: false,
    allowedAspectRatios: ['16:9'],
    maxReferenceImages: 14,
    allowGenerateReferences: true,
    allowMaskPng: false,
    allowOutpaintGeometry: false,
    allowedQualities: [],
    allowedBackgrounds: [],
    allowedModerations: [],
    allowedOutputFormats: [],
    fixedOutputFormat: 'jpeg',
    allowOutputCompression: false,
    allowWatermarkOverride: true,
    defaultWatermark: false,
  });
  expect(chatOnlyItem?.image.parameters).toBeNull();
});
