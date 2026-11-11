import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { catalogView, legacyReference, validateDeclaration } from '../src/providers/catalog.ts';
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
