export interface ProviderConfig {
  databaseURL: string;
  masterKey: Buffer;
  masterKeyId: string;
}

/** Explicit opt-in, with a dedicated key. There is no credential or database fallback. */
export function readProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProviderConfig | undefined {
  const databaseURL = env.MIO_PROVIDERS_DATABASE_URL;
  const encoded = env.MIO_PROVIDERS_MASTER_KEY;
  const masterKeyId = env.MIO_PROVIDERS_MASTER_KEY_ID;
  if (databaseURL === undefined && encoded === undefined && masterKeyId === undefined) return;
  try {
    if (!databaseURL || !['postgres:', 'postgresql:'].includes(new URL(databaseURL).protocol))
      throw new Error();
    if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error();
    const masterKey = Buffer.from(encoded, 'base64');
    if (masterKey.length !== 32 || masterKey.toString('base64') !== encoded) throw new Error();
    if (!masterKeyId || !/^[A-Za-z0-9_-]{1,64}$/.test(masterKeyId)) throw new Error();
    return { databaseURL, masterKey, masterKeyId };
  } catch {
    throw new Error(
      'PROVIDER_CONFIG: explicit PostgreSQL URL, 32-byte base64 master key and key ID required',
    );
  }
}
