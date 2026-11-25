import { parseArgs } from 'node:util';
import { readProviderConfig } from '../../src/providers/config.ts';
import { ProviderError } from '../../src/providers/contracts.ts';
import { createProviderStore } from '../../src/providers/store.ts';
import { VoiceError } from '../../src/audio/voices/contracts.ts';

const usage =
  'Usage: audio:voices:import --owner-id <id> --model-ref <ref> --voice-id <id> --name <label> --evidence <reference> [--apply]';
try {
  const { values } = parseArgs({
    options: {
      'owner-id': { type: 'string' },
      'model-ref': { type: 'string' },
      'voice-id': { type: 'string' },
      name: { type: 'string' },
      evidence: { type: 'string' },
      apply: { type: 'boolean' },
    },
  });
  const {
    'owner-id': ownerId,
    'model-ref': modelRef,
    'voice-id': upstreamId,
    name,
    evidence,
    apply,
  } = values;
  if (!ownerId || !modelRef || !upstreamId || !name || !evidence)
    throw new VoiceError(400, 'VOICE_REGISTRATION_INPUT_REQUIRED');
  const config = readProviderConfig();
  if (!config) throw new ProviderError(400, 'PROVIDER_CONFIG_REQUIRED');
  const store = await createProviderStore(config);
  try {
    const result = await store.registerSystemVoice(
      { ownerId, modelRef, upstreamId, name, evidence },
      apply === true,
    );
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', ...result }));
  } finally {
    await store.close();
  }
} catch (error) {
  console.error(error instanceof ProviderError || error instanceof VoiceError ? error.code : usage);
  process.exitCode = 1;
}
