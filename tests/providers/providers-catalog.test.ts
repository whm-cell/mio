import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { catalogView, legacyReference, validateDeclaration } from '../../src/providers/catalog.ts';
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
