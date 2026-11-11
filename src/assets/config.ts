export interface AssetConfig {
  databaseURL: string;
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
}

export function readAssetDatabaseURL(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const databaseURL = env.MIO_ASSETS_DATABASE_URL;
  if (databaseURL === undefined) return;
  try {
    if (!['postgres:', 'postgresql:'].includes(new URL(databaseURL).protocol)) throw new Error();
    return databaseURL;
  } catch {
    throw new Error('ASSET_CONFIG: explicit PostgreSQL URL required');
  }
}

/** A separate opt-in and pool; never inherit authentication or legacy storage settings. */
export function readAssetConfig(env: NodeJS.ProcessEnv = process.env): AssetConfig | undefined {
  const databaseURL = readAssetDatabaseURL(env);
  const bucket = env.MIO_COS_BUCKET;
  const region = env.MIO_COS_REGION;
  const secretId = env.MIO_COS_SECRET_ID;
  const secretKey = env.MIO_COS_SECRET_KEY;
  if ([databaseURL, bucket, region, secretId, secretKey].every((value) => value === undefined))
    return;
  try {
    if (!databaseURL) throw new Error();
    if (!bucket || bucket.length > 63 || !/^[a-z0-9][a-z0-9-]{0,48}-[0-9]{4,20}$/.test(bucket))
      throw new Error();
    if (!region || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region)) throw new Error();
    if (!secretId || !secretKey || /\s/.test(secretId + secretKey)) throw new Error();
    return { databaseURL, bucket, region, secretId, secretKey };
  } catch {
    throw new Error('ASSET_CONFIG: explicit PostgreSQL and private COS settings required');
  }
}
