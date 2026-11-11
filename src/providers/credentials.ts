import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ProviderError } from './contracts.ts';
import type { ProviderConfig } from './config.ts';

export interface CredentialBinding {
  ownerId: string;
  providerId: string;
  credentialVersion: number;
}
export interface CredentialEnvelope {
  cipher_format: number;
  master_key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
}
const associated = (binding: CredentialBinding, keyId: string) =>
  Buffer.from(
    JSON.stringify([
      'mio:onelink:credential:1',
      binding.ownerId,
      binding.providerId,
      binding.credentialVersion,
      keyId,
    ]),
  );

export function encryptCredential(
  apiKey: string,
  binding: CredentialBinding,
  config: ProviderConfig,
): CredentialEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.masterKey, nonce);
  cipher.setAAD(associated(binding, config.masterKeyId));
  return {
    cipher_format: 1,
    master_key_id: config.masterKeyId,
    nonce,
    ciphertext: Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]),
    auth_tag: cipher.getAuthTag(),
  };
}

/** Used only by an explicit authorized outbound action; metadata reads never decrypt. */
export function decryptCredential(
  envelope: CredentialEnvelope,
  binding: CredentialBinding,
  config: ProviderConfig,
): string {
  try {
    if (envelope.cipher_format !== 1 || envelope.master_key_id !== config.masterKeyId)
      throw new Error();
    if (envelope.nonce.length !== 12 || envelope.auth_tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', config.masterKey, envelope.nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(associated(binding, envelope.master_key_id));
    cipher.setAuthTag(envelope.auth_tag);
    return Buffer.concat([cipher.update(envelope.ciphertext), cipher.final()]).toString('utf8');
  } catch {
    throw new ProviderError(503, 'PROVIDER_CREDENTIAL_UNAVAILABLE');
  }
}
