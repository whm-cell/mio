export interface ConversationConfig {
  databaseURL: string;
  provider?: string;
  model?: string;
  byok?: boolean;
}

/** Metadata opt-in is independent of authentication's internal pool. No ambient fallback DB. */
export function readConversationConfig(
  env: NodeJS.ProcessEnv = process.env,
  byok = false,
): ConversationConfig | undefined {
  if (env.MIO_CONVERSATIONS_DATABASE_URL === undefined) {
    if (!byok && (env.MIO_MODEL_PROVIDER || env.MIO_MODEL))
      throw new Error('CONVERSATION_CONFIG: database URL required');
    return undefined;
  }
  const databaseURL = env.MIO_CONVERSATIONS_DATABASE_URL;
  let database: URL;
  try {
    database = new URL(databaseURL);
  } catch {
    throw new Error('CONVERSATION_CONFIG: PostgreSQL URL required');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol))
    throw new Error('CONVERSATION_CONFIG: PostgreSQL URL required');
  const provider = byok ? undefined : env.MIO_MODEL_PROVIDER;
  const model = byok ? undefined : env.MIO_MODEL;
  if (Boolean(provider) !== Boolean(model))
    throw new Error('CONVERSATION_CONFIG: provider and model must be set together');
  if (provider === 'deepseek-official' && !env.MIO_MODEL_API_KEY)
    throw new Error('CONVERSATION_CONFIG: MIO_MODEL_API_KEY required for DeepSeek');
  return {
    databaseURL,
    ...(byok ? { byok: true } : {}),
    ...(provider && model ? { provider, model } : {}),
  };
}
