import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import type { ImageEnvelope } from '@mio/compute-contracts';

/** A seals only the admitted request's key for the dedicated B public key. */
export function sealImageKey(
  apiKey: string,
  binding: string,
  keyId: string,
  publicKey: string,
): ImageEnvelope {
  const key = randomBytes(32);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(binding));
    return {
      version: 1,
      keyId,
      wrappedKey: publicEncrypt(
        { key: publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
        key,
      ).toString('base64'),
      nonce: nonce.toString('base64'),
      ciphertext: Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]).toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  } finally {
    key.fill(0);
  }
}
