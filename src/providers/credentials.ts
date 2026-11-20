import { HTTP_STATUS } from '@mio/foundation/http-status';
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
    throw new ProviderError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'PROVIDER_CREDENTIAL_UNAVAILABLE');
  }
}

/** Same deployment key/envelope, a distinct purpose binding. Credential AAD above is unchanged. */
export function encryptMaterialAuth(
  payload: { launchUrl: string; token: string },
  ownerId: string,
  sessionId: string,
  config: ProviderConfig,
): CredentialEnvelope {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', config.masterKey, nonce);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify(['mio:materials:auth-session:1', ownerId, sessionId, config.masterKeyId]),
    ),
  );
  return {
    cipher_format: 1,
    master_key_id: config.masterKeyId,
    nonce,
    ciphertext: Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]),
    auth_tag: cipher.getAuthTag(),
  };
}
export function decryptMaterialAuth(
  envelope: CredentialEnvelope,
  ownerId: string,
  sessionId: string,
  config: ProviderConfig,
): { launchUrl: string; token: string } {
  try {
    if (
      envelope.cipher_format !== 1 ||
      envelope.master_key_id !== config.masterKeyId ||
      envelope.nonce.length !== 12 ||
      envelope.auth_tag.length !== 16 ||
      envelope.ciphertext.length > 8192
    )
      throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', config.masterKey, envelope.nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(
      Buffer.from(
        JSON.stringify(['mio:materials:auth-session:1', ownerId, sessionId, config.masterKeyId]),
      ),
    );
    decipher.setAuthTag(envelope.auth_tag);
    const payload: unknown = JSON.parse(
      Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8'),
    );
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('launchUrl' in payload) ||
      !('token' in payload) ||
      typeof payload.launchUrl !== 'string' ||
      typeof payload.token !== 'string'
    )
      throw new Error();
    return { launchUrl: payload.launchUrl, token: payload.token };
  } catch {
    throw new ProviderError(503, 'MATERIAL_AUTH_SECRET_UNAVAILABLE');
  }
}
