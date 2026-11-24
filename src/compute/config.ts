import { parseWorkerInstanceIds } from '@mio/compute-contracts';

export interface ComputeConfig {
  brokerURL: string;
  brokerUser: string;
  expectedResultUser: string;
  workerUsers?: ReadonlyMap<string, string>;
  workerInstances?: readonly string[];
  opsUserIds?: readonly string[];
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
    const workerInstances = parseWorkerInstanceIds(env.MIO_COMPUTE_WORKER_INSTANCE_IDS);
    const settings: ComputeConfig = { brokerURL, brokerUser, expectedResultUser };
    if (workerInstances.length) {
      settings.workerInstances = workerInstances;
      settings.workerUsers = workerUserMapping(
        env.MIO_COMPUTE_WORKER_RESULT_USERS,
        workerInstances,
        brokerUser,
        expectedResultUser,
      );
    } else if (env.MIO_COMPUTE_WORKER_RESULT_USERS !== undefined) throw new Error();
    const enabled = env.MIO_COMPUTE_OPS_ENABLED;
    if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') throw new Error();
    if (enabled === 'true') {
      const users = env.MIO_COMPUTE_OPS_USER_IDS?.split(',').map((id) => id.trim()) ?? [];
      if (
        !workerInstances.length ||
        !users.length ||
        users.length > 64 ||
        users.some((id) => !id || id.length > 128 || /[\x00-\x20\x7f]/.test(id)) ||
        new Set(users).size !== users.length
      )
        throw new Error();
      settings.opsUserIds = users;
    }
    return settings;
  } catch {
    throw new Error(
      'COMPUTE_CONFIG: explicit broker identities and valid Worker/ops settings required',
    );
  }
}

function workerUserMapping(
  input: string | undefined,
  instances: readonly string[],
  app: string,
  legacy: string,
) {
  if (input === undefined && instances.length === 1) return new Map([[instances[0]!, legacy]]);
  if (input === undefined || input.length > 20_000) throw new Error();
  const value: unknown = JSON.parse(input);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== instances.length
  )
    throw new Error();
  const record = value as Record<string, unknown>;
  const used = new Set<string>();
  return new Map(
    instances.map((id) => {
      const peer = Object.hasOwn(record, id) ? record[id] : undefined;
      if (
        typeof peer !== 'string' ||
        !peer ||
        peer.length > 128 ||
        peer === app ||
        used.has(peer) ||
        /[\x00-\x20\x7f]/.test(peer)
      )
        throw new Error();
      used.add(peer);
      return [id, peer] as const;
    }),
  );
}
