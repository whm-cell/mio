export interface AdminConfig {
  readonly databaseURL: string;
  readonly conversationsDatabaseURL?: string;
  readonly mediaDatabaseURL?: string;
  readonly allowedOrigins: readonly string[];
}

function parseOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ADMIN_CONFIG: MIO_ADMIN_ALLOWED_ORIGINS must be a JSON array');
  }
  if (!Array.isArray(parsed))
    throw new Error('ADMIN_CONFIG: MIO_ADMIN_ALLOWED_ORIGINS must be a JSON array');
  return parsed.map((item) => {
    if (typeof item !== 'string')
      throw new Error('ADMIN_CONFIG: MIO_ADMIN_ALLOWED_ORIGINS must contain origin strings');
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error('ADMIN_CONFIG: invalid origin in MIO_ADMIN_ALLOWED_ORIGINS');
    }
    if (url.origin !== item || !['http:', 'https:'].includes(url.protocol))
      throw new Error('ADMIN_CONFIG: invalid origin in MIO_ADMIN_ALLOWED_ORIGINS');
    return url.origin;
  });
}

export function readAdminConfig(
  env: NodeJS.ProcessEnv = process.env,
  authOrigins: readonly string[] = [],
): AdminConfig | undefined {
  const enabled = env.MIO_ADMIN_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false')
    throw new Error('ADMIN_CONFIG: MIO_ADMIN_ENABLED must be true or false');
  if (enabled === 'false') return undefined;
  const databaseURL = env.MIO_PROVIDERS_DATABASE_URL?.trim();
  if (!databaseURL)
    throw new Error('ADMIN_CONFIG: MIO_PROVIDERS_DATABASE_URL is required when admin is enabled');
  const extraOrigins = parseOrigins(env.MIO_ADMIN_ALLOWED_ORIGINS);
  const allowedOrigins = [...new Set([...authOrigins, ...extraOrigins])];
  const conversationsDatabaseURL = env.MIO_CONVERSATIONS_DATABASE_URL?.trim() || undefined;
  const mediaDatabaseURL =
    env.MIO_GENERATIONS_ENABLED === 'true' || env.MIO_COMPUTE_ENABLED === 'true'
      ? env.MIO_ASSETS_DATABASE_URL?.trim() || undefined
      : undefined;
  return {
    databaseURL,
    ...(conversationsDatabaseURL ? { conversationsDatabaseURL } : {}),
    ...(mediaDatabaseURL ? { mediaDatabaseURL } : {}),
    allowedOrigins,
  };
}
