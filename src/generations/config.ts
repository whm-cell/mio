import { isAbsolute } from 'node:path';

export interface GenerationConfig {
  dataDirectory: string;
  videoEnabled?: boolean;
}

/** Generation admission and its recovery directory are explicit, independent of B and MQ. */
export function readGenerationConfig(
  env: NodeJS.ProcessEnv = process.env,
): GenerationConfig | undefined {
  if (env.MIO_GENERATIONS_ENABLED === undefined) return;
  if (env.MIO_GENERATIONS_ENABLED !== 'true')
    throw new Error('GENERATION_CONFIG: enabled must be true');
  const dataDirectory = env.MIO_GENERATIONS_DATA_DIR;
  if (!dataDirectory || !isAbsolute(dataDirectory))
    throw new Error('GENERATION_CONFIG: an absolute persistent directory is required');
  if (
    env.MIO_VIDEO_GENERATIONS_ENABLED !== undefined &&
    env.MIO_VIDEO_GENERATIONS_ENABLED !== 'true'
  )
    throw new Error('GENERATION_CONFIG: video enabled must be true');
  return { dataDirectory, videoEnabled: env.MIO_VIDEO_GENERATIONS_ENABLED === 'true' };
}
