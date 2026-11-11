import { afterAll } from 'vitest';

const keys = [
  'MIO_PROVIDERS_DATABASE_URL',
  'MIO_PROVIDERS_MASTER_KEY',
  'MIO_PROVIDERS_MASTER_KEY_ID',
] as const;
export const inheritedProviderVariableCount = keys.filter(
  (key) => process.env[key] !== undefined,
).length;
/** Ordinary suites must not activate a provider domain from the host's deployment configuration. */
export function isolateProviderEnvironment(env: NodeJS.ProcessEnv) {
  const previous = keys.map((key) => [key, env[key]] as const);
  for (const key of keys) delete env[key];
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}
const restore = isolateProviderEnvironment(process.env);
afterAll(restore);
