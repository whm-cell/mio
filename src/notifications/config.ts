export interface NotificationsConfig {
  readonly databaseURL: string;
}

export function readNotificationsConfig(
  env: NodeJS.ProcessEnv = process.env,
): NotificationsConfig | undefined {
  const databaseURL = env.MIO_NOTIFICATIONS_DATABASE_URL?.trim();
  if (!databaseURL) return undefined;
  return { databaseURL };
}
