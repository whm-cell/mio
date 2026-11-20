import { readAssetDatabaseURL } from '../assets/config.ts';

/** Existing installations opt in only after the explicit materials migration. */
export function readMaterialConfig(
  env: NodeJS.ProcessEnv = process.env,
): { databaseURL: string } | undefined {
  if (env.MIO_MATERIALS_ENABLED === undefined) return;
  if (env.MIO_MATERIALS_ENABLED !== 'true')
    throw new Error('MATERIAL_CONFIG: enabled must be true');
  const databaseURL = readAssetDatabaseURL(env);
  if (!databaseURL) throw new Error('MATERIAL_CONFIG: assets database URL required');
  return { databaseURL };
}

/** Public authentication is independently opt-in; never infer a callback from request Host. */
export function readMaterialAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): { publicOrigin: string } | undefined {
  const value = env.MIO_MATERIALS_PUBLIC_BASE_URL;
  if (value === undefined) return;
  try {
    const url = new URL(value);
    if (
      env.MIO_MATERIALS_ENABLED !== 'true' ||
      url.protocol !== 'https:' ||
      url.origin !== value ||
      url.username ||
      url.password ||
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost')
    )
      throw new Error();
    return { publicOrigin: url.origin };
  } catch {
    throw new Error('MATERIAL_AUTH_CONFIG: explicit HTTPS origin with materials enabled required');
  }
}
