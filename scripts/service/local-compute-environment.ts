import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export function localComputeSettings(name: 'dev' | 'test') {
  const secret = () => randomBytes(32).toString('hex');
  const port = name === 'dev' ? '56720' : '56721';
  const password = secret();
  return {
    MIO_LOCAL_RABBITMQ_PORT: port,
    MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT: name === 'dev' ? '15680' : '15681',
    MIO_LOCAL_RABBITMQ_PASSWORD: secret(),
    MIO_LOCAL_RABBITMQ_A_PASSWORD: password,
    MIO_LOCAL_RABBITMQ_B_PASSWORD: secret(),
    RABBITMQ_URL: `amqp://mio-${name}-a:${password}@127.0.0.1:${port}/mio-${name}`,
    MIO_COMPUTE_BROKER_USER: `mio-${name}-a`,
    MIO_COMPUTE_EXPECTED_RESULT_USER: `mio-${name}-b`,
    MIO_LOCAL_COMPUTE_DIRECTORY: `.runtime/${name}/compute`,
    MIO_LOCAL_COMPUTE_INSTANCE_ID: `mio-${name}-${secret()}`,
  };
}

export function validateLocalComputeSettings(
  name: 'dev' | 'test',
  values: NodeJS.ProcessEnv,
  root: string,
) {
  for (const key of [
    'MIO_LOCAL_RABBITMQ_PASSWORD',
    'MIO_LOCAL_RABBITMQ_A_PASSWORD',
    'MIO_LOCAL_RABBITMQ_B_PASSWORD',
  ]) {
    if (!/^[a-f0-9]{64}$/.test(values[key] ?? ''))
      throw new Error(`LOCAL_BROKER_SECRET: ${key}; run pnpm env:init for older files`);
  }
  for (const key of ['MIO_LOCAL_RABBITMQ_PORT', 'MIO_LOCAL_RABBITMQ_MANAGEMENT_PORT']) {
    const port = Number(values[key]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error(`LOCAL_BROKER_PORT: ${key}`);
  }
  if (
    values.RABBITMQ_URL !==
      `amqp://mio-${name}-a:${values.MIO_LOCAL_RABBITMQ_A_PASSWORD}@127.0.0.1:${values.MIO_LOCAL_RABBITMQ_PORT}/mio-${name}` ||
    values.MIO_COMPUTE_BROKER_USER !== `mio-${name}-a` ||
    values.MIO_COMPUTE_EXPECTED_RESULT_USER !== `mio-${name}-b` ||
    !values.MIO_LOCAL_COMPUTE_DIRECTORY ||
    resolve(root, values.MIO_LOCAL_COMPUTE_DIRECTORY) !==
      resolve(root, `.runtime/${name}/compute`) ||
    !new RegExp(`^mio-${name}-[a-f0-9]{64}$`).test(values.MIO_LOCAL_COMPUTE_INSTANCE_ID ?? '')
  )
    throw new Error(
      'LOCAL_COMPUTE_IDENTITY: broker, roles and Worker directory must match the environment',
    );
}

/** B receives only its own MQ identity and explicitly configured COS credentials. */
export function localWorkerEnvironment(
  name: 'dev' | 'test',
  values: NodeJS.ProcessEnv,
  host: NodeJS.ProcessEnv,
  root = resolve('.'),
): NodeJS.ProcessEnv {
  return {
    ...host,
    NODE_ENV: values.NODE_ENV,
    RABBITMQ_URL: `amqp://mio-${name}-b:${values.MIO_LOCAL_RABBITMQ_B_PASSWORD}@127.0.0.1:${values.MIO_LOCAL_RABBITMQ_PORT}/mio-${name}`,
    MIO_COMPUTE_BROKER_USER: `mio-${name}-b`,
    MIO_COMPUTE_EXPECTED_COMMAND_USER: `mio-${name}-a`,
    MIO_COMPUTE_DIRECTORY: resolve(root, values.MIO_LOCAL_COMPUTE_DIRECTORY!),
    MIO_COMPUTE_INSTANCE_ID: values.MIO_LOCAL_COMPUTE_INSTANCE_ID,
    ...Object.fromEntries(
      ['MIO_COS_BUCKET', 'MIO_COS_REGION', 'MIO_COS_SECRET_ID', 'MIO_COS_SECRET_KEY']
        .filter((key) => values[key])
        .map((key) => [key, values[key]]),
    ),
  };
}
