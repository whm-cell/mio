import { HTTP_STATUS } from '@mio/foundation/http-status';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ProviderConfig } from '../providers/config.ts';
import { AdminError } from './contracts.ts';

export interface ProbeKeyEnvelope {
  readonly cipher_format: number;
  readonly master_key_id: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly auth_tag: Buffer;
}

function probeKeyAAD(keyVersion: number, masterKeyId: string): Buffer {
  return Buffer.from(
    JSON.stringify(['mio:admin:probe-credential:1', 'onelink', keyVersion, masterKeyId]),
  );
}

export function maskProbeKeyHint(apiKey: string): string {
  return apiKey.length >= 12 ? `********${apiKey.slice(-4)}` : '********';
}

export function encryptProbeKey(
  apiKey: string,
  keyVersion: number,
  config: ProviderConfig,
): ProbeKeyEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.masterKey, nonce);
  cipher.setAAD(probeKeyAAD(keyVersion, config.masterKeyId));
  return {
    cipher_format: 1,
    master_key_id: config.masterKeyId,
    nonce,
    ciphertext: Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]),
    auth_tag: cipher.getAuthTag(),
  };
}

export function decryptProbeKey(
  envelope: ProbeKeyEnvelope,
  keyVersion: number,
  config: ProviderConfig,
): string {
  try {
    if (envelope.cipher_format !== 1 || envelope.master_key_id !== config.masterKeyId)
      throw new Error();
    if (envelope.nonce.length !== 12 || envelope.auth_tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', config.masterKey, envelope.nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(probeKeyAAD(keyVersion, envelope.master_key_id));
    decipher.setAuthTag(envelope.auth_tag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new AdminError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'PROBE_CREDENTIAL_UNAVAILABLE');
  }
}
