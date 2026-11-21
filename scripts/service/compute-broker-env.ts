import { parseEnv } from 'node:util';

/** Parses the same private file used to start the Compose broker. */
export function readComputeBrokerEnvironment(text: string) {
  const env = parseEnv(text);
  const user = env.RABBITMQ_DEFAULT_USER;
  const password = env.RABBITMQ_DEFAULT_PASS;
  const vhost = env.RABBITMQ_DEFAULT_VHOST;
  if (!user || !password || !vhost) throw new Error('BROKER_ENV_MISSING');

  let address = env.RABBITMQ_MANAGEMENT_URL;
  if (address === undefined) {
    const port = env.RABBITMQ_MANAGEMENT_PORT;
    if (!port || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error('BROKER_MANAGEMENT_PORT_INVALID');
    address = `http://127.0.0.1:${port}`;
  }
  let management: URL;
  try {
    management = new URL(address);
  } catch {
    throw new Error('BROKER_LOCAL_MANAGEMENT_REQUIRED');
  }
  if (
    management.protocol !== 'http:' ||
    management.hostname !== '127.0.0.1' ||
    management.username ||
    management.password ||
    management.pathname !== '/' ||
    management.search ||
    management.hash
  )
    throw new Error('BROKER_LOCAL_MANAGEMENT_REQUIRED');
  return { management, user, password, vhost, amqpPort: env.RABBITMQ_AMQP_PORT };
}
