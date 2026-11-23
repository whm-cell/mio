import type { ModelRouteInput } from '../../../src/providers/contracts.ts';

export function makeAudioRouteFixture(
  rawModelId: string,
  operation: 'audio.voices.list' | 'audio.tts' | 'audio.clone' = 'audio.tts',
): ModelRouteInput {
  const routes = {
    'audio.voices.list': { driver: 'minimax-voices', submitPath: '/minimax/v1/get_voice' },
    'audio.tts': { driver: 'minimax-tts', submitPath: '/minimax/v1/t2a_v2' },
    'audio.clone': { driver: 'minimax-clone', submitPath: '/minimax/v1/t2a_pro/voice_clone' },
  } as const;
  return {
    rawModelId,
    operation,
    ...routes[operation],
    vendor: 'minimax',
    classification: 'voice',
    sourceKind: 'protocol-reference',
    source: 'deterministic protocol fixture',
    sourceVersion: 'v1',
    ...(operation === 'audio.voices.list'
      ? {}
      : {
          paramSpec: {
            speed: { min: 0.5, max: 2, default: 1 },
            volume: { min: 0.01, max: 10, default: 1 },
            pitch: { min: -12, max: 12, default: 0 },
            formats: ['wav', 'mp3'],
            defaultFormat: 'wav',
            textMaxCodePoints: 10000,
            textMaxBytes: 81920,
            sampleMaxBytes: 20971520,
            sampleMinSeconds: 10,
            sampleMaxSeconds: 300,
          },
        }),
  };
}
