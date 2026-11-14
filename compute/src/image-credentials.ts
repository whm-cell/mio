import { createDecipheriv, privateDecrypt, constants } from 'node:crypto';
import type { ImageEnvelope } from '@mio/compute-contracts';

export type ImageCredentialEnvelope = ImageEnvelope;

export function openImageCredential(
  envelope: ImageCredentialEnvelope,
  binding: string,
  keyId: string,
  privateKey: string,
): string {
  let key: Buffer | undefined;
  try {
    if (envelope.version !== 1 || envelope.keyId !== keyId) throw new Error();
    key = privateDecrypt(
      { key: privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(envelope.wrappedKey, 'base64'),
    );
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'), {
      authTagLength: 16,
    });
    cipher.setAAD(Buffer.from(binding));
    cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      cipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('IMAGE_CREDENTIAL_INVALID');
  } finally {
    key?.fill(0);
  }
}
