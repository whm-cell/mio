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
