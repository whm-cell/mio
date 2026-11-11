export interface ComputeConfig {
  brokerURL: string;
  brokerUser: string;
  expectedResultUser: string;
}

/** Opt in explicitly so an unrelated RabbitMQ setting cannot enable the service. */
export function readComputeConfig(env: NodeJS.ProcessEnv = process.env): ComputeConfig | undefined {
  if (env.MIO_COMPUTE_ENABLED === undefined) return;
  if (env.MIO_COMPUTE_ENABLED !== 'true') throw new Error('COMPUTE_CONFIG: enabled must be true');
  const brokerURL = env.RABBITMQ_URL,
    brokerUser = env.MIO_COMPUTE_BROKER_USER;
  const expectedResultUser = env.MIO_COMPUTE_EXPECTED_RESULT_USER;
  try {
    if (
      !brokerURL ||
      !brokerUser ||
      !expectedResultUser ||
      brokerUser === expectedResultUser ||
      /[\x00-\x20\x7f]/.test(brokerUser + expectedResultUser) ||
      brokerUser.length > 128 ||
      expectedResultUser.length > 128
    )
      throw new Error();
    const parsed = new URL(brokerURL);
    if (decodeURIComponent(parsed.username) !== brokerUser || !parsed.password) throw new Error();
    if (
      parsed.protocol !== 'amqps:' &&
      !(
        parsed.protocol === 'amqp:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      )
    )
      throw new Error();
    return { brokerURL, brokerUser, expectedResultUser };
  } catch {
    throw new Error('COMPUTE_CONFIG: explicit separate broker identities required');
  }
}
