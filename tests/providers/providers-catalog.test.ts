import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { IMAGE_PROFILES, IMAGE_PROFILE_RULES } from '@mio/compute-contracts';
import { catalogView, legacyReference, validateDeclaration } from '../../src/providers/catalog.ts';
import { providerSchemaSQL } from '../../src/providers/schema.ts';
import {
  legacyPresets,
  legacySource,
  legacyCapabilityProfileById,
  legacyCapabilityProfiles,
} from './fixtures/onelink-legacy-snapshot.ts';

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
it('limits deployment declarations to sourced, implemented profiles and cannot set verified or an endpoint', () => {
  const entry = {
    modelRef: 'onelink:model:some-key',
    operation: 'chat',
    profile: 'openai-chat',
    sourceKind: 'protocol-reference',
    source: 'fixture',
    sourceVersion: 'v1',
  };
  expect(validateDeclaration(entry)).toEqual(entry);
  for (const patch of [
    { profile: 'unknown' },
    { profile: ['openai-chat'] },
    { profile: null },
    { profile: { toString: () => 'openai-chat' } },
    { operation: 'image' },
    { source: '' },
    { verified: true },
    { endpoint: 'https://other.test' },
    { metadata: { price: 0 } },
    { metadata: { contextWindow: 0 } },
    { classification: 'unknown' },
  ])
    expect(() => validateDeclaration({ ...entry, ...patch })).toThrow('ADAPTATION_INVALID');
});

it('accepts only explicit image edit and PNG mask capability metadata', () => {
  const image = {
    modelRef: 'onelink:model:some-key',
    operation: 'image.generate',
    profile: 'gpt-images-v1',
    sourceKind: 'protocol-reference',
    source: 'fixture',
    sourceVersion: 'v1',
    metadata: {
      image: {
        modes: ['generate', 'edit'],
        mask: { format: 'png' },
        async: { operations: ['generate'], maxQueries: 4, maxAgeSeconds: 300 },
      },
    },
  };
  expect(validateDeclaration(image)).toEqual(image);
  expect(
    validateDeclaration({
      ...image,
      metadata: {
        image: {
          modes: ['generate', 'edit', 'outpaint'],
          mask: { format: 'png' },
          references: { maxImages: 4 },
          geometry: { unit: 'pixels', edges: ['left', 'top', 'right', 'bottom'] },
        },
      },
    }),
  ).toMatchObject({ metadata: { image: { modes: ['generate', 'edit', 'outpaint'] } } });
  for (const metadata of [
    { image: { modes: [] } },
    { image: { modes: ['edit'] } },
    { image: { modes: ['edit', 'edit'] } },
    { image: { modes: ['outpaint'] } },
    { image: { modes: ['edit'], mask: { format: 'jpeg' } } },
    { image: { modes: ['edit'], extra: true } },
    { image: { modes: ['outpaint'], geometry: { unit: 'pixels', edges: ['left'] } } },
    { image: { modes: ['edit'], references: { maxImages: 1 } } },
    {
      image: {
        modes: ['generate'],
        async: { operations: ['edit'], maxQueries: 4, maxAgeSeconds: 300 },
      },
    },
    {
      image: {
        modes: ['generate'],
        async: { operations: ['generate'], maxQueries: 0, maxAgeSeconds: 300 },
      },
    },
  ])
    expect(() => validateDeclaration({ ...image, metadata })).toThrow('ADAPTATION_INVALID');
  for (const declaration of [
    { ...image, profile: 'seedream-4-images-v1' },
    { ...image, operation: 'chat', profile: 'openai-chat' },
  ])
    expect(() => validateDeclaration(declaration)).toThrow('ADAPTATION_INVALID');
});

it('accepts the explicitly sourced Vidu image async capability without inferring it from the model id', () => {
  const declaration = {
    modelRef: 'onelink:model:vidu-key',
    operation: 'image.generate',
    profile: 'vidu-image-v1',
    sourceKind: 'protocol-reference',
    source: 'https://docs.onelinkai.cloud/8653257m0',
    sourceVersion: '2026-11-14',
    classification: 'image',
    metadata: {
      image: {
        modes: ['generate'],
        references: { maxImages: 7 },
        async: { operations: ['generate'], maxQueries: 8, maxAgeSeconds: 600 },
      },
    },
  };
  expect(validateDeclaration(declaration)).toEqual(declaration);
  expect(() => validateDeclaration({ ...declaration, profile: 'gpt-images-v1' })).not.toThrow();
  expect(() =>
    validateDeclaration({
      ...declaration,
      metadata: { image: { modes: ['generate', 'edit'] } },
    }),
  ).toThrow('ADAPTATION_INVALID');
});

it('requires a non-catalog adaptation source kind and never treats catalog membership as protocol evidence', () => {
  const entry = {
    modelRef: 'onelink:model:source-kind',
    operation: 'chat',
    profile: 'openai-chat',
    sourceKind: 'protocol-reference',
    source: 'onelink-v1-models',
    sourceVersion: 'v1',
  };
  expect(() => validateDeclaration(entry)).toThrow('ADAPTATION_INVALID');
  for (const sourceKind of [undefined, 'catalog-membership', 'catalog', 'protocol', 'runtime'])
    expect(() => validateDeclaration({ ...entry, sourceKind, source: 'operator-runbook' })).toThrow(
      'ADAPTATION_INVALID',
    );
  expect(
    validateDeclaration({ ...entry, sourceKind: 'runtime-observation', source: 'test-run-42' }),
  ).toMatchObject({ sourceKind: 'runtime-observation' });
});

it('derives provider adaptation profile constraints and mode gates from IMAGE_PROFILES and IMAGE_PROFILE_RULES', () => {
  const expectedSqlList = IMAGE_PROFILES.map((profile) => `'${profile}'`).join(',');
  expect(providerSchemaSQL).toContain(
    `(operation='image.generate' AND profile IN (${expectedSqlList}))`,
  );
  for (const profile of IMAGE_PROFILES) {
    const supported: readonly string[] = IMAGE_PROFILE_RULES[profile].supportedOperations;
    for (const mode of ['edit', 'outpaint'] as const) {
      const declaration = {
        modelRef: `onelink:model:${profile}`,
        operation: 'image.generate' as const,
        profile,
        sourceKind: 'protocol-reference' as const,
        source: 'fixture',
        sourceVersion: 'v1',
        metadata: {
          image: {
            modes: ['generate', mode],
            ...(mode === 'outpaint'
              ? { geometry: { unit: 'pixels', edges: ['left', 'top', 'right', 'bottom'] } }
              : {}),
          },
        },
      };
      if (supported.includes(mode)) {
        expect(validateDeclaration(declaration)).toMatchObject({ profile });
      } else {
        expect(() => validateDeclaration(declaration)).toThrow('ADAPTATION_INVALID');
      }
    }
  }
});

it('accepts explicitly sourced Kling async image capability and keeps incomplete adaptations ADAPTER_PENDING in catalogView', () => {
  const declaration = {
    modelRef: 'onelink:model:kling-key',
    operation: 'image.generate' as const,
    profile: 'kling-image-v1' as const,
    sourceKind: 'protocol-reference' as const,
    source: 'https://docs.onelinkai.cloud/8653497m0',
    sourceVersion: '2026-09-08',
    classification: 'image' as const,
    metadata: {
      image: {
        modes: ['generate' as const],
        async: { operations: ['generate' as const], maxQueries: 8, maxAgeSeconds: 600 },
      },
    },
  };
  expect(validateDeclaration(declaration)).toEqual(declaration);
  expect(() =>
    validateDeclaration({
      ...declaration,
      metadata: { image: { modes: ['generate', 'edit'] } },
    }),
  ).toThrow('ADAPTATION_INVALID');

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
        classification: 'image' as const,
        metadata_source: 'onelink-v1-models',
        classification_source: 'adaptation',
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

  const incompleteView = catalogView({
    ...baseState,
    adaptations: [
      {
        model_key: modelKey,
        operation: 'image.generate',
        profile: 'kling-image-v1',
        declaration_version: 1,
        source_kind: 'protocol-reference',
        source: declaration.source,
        source_version: declaration.sourceVersion,
        capability_metadata: { image: { modes: ['generate'] } },
        verification_status: 'unverified',
        verified_at: null,
        verification_evidence: null,
        tested_tuple: null,
      },
    ],
  });
  expect(incompleteView.items[0]?.image).toMatchObject({
    runnable: false,
    unavailableReason: 'ADAPTER_PENDING',
  });

  const completeView = catalogView({
    ...baseState,
    adaptations: [
      {
        model_key: modelKey,
        operation: 'image.generate',
        profile: 'kling-image-v1',
        declaration_version: 2,
        source_kind: 'protocol-reference',
        source: declaration.source,
        source_version: declaration.sourceVersion,
        capability_metadata: declaration.metadata,
        verification_status: 'unverified',
        verified_at: null,
        verification_evidence: null,
        tested_tuple: null,
      },
    ],
  });
  expect(completeView.items[0]?.image).toMatchObject({
    runnable: true,
    unavailableReason: null,
  });
});
