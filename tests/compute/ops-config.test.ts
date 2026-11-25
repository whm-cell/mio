import { expect, it } from 'vitest';
import { readComputeConfig } from '../../src/compute/config.ts';

const base = {
  MIO_COMPUTE_ENABLED: 'true',
  RABBITMQ_URL: 'amqp://app:test-fixture@127.0.0.1/mio-test',
  MIO_COMPUTE_BROKER_USER: 'app',
  MIO_COMPUTE_EXPECTED_RESULT_USER: 'worker-default',
};

it('keeps existing single B behavior and reads workerInstances/workerUsers without legacy ops switches', () => {
  expect(readComputeConfig(base)).toEqual({
    brokerURL: base.RABBITMQ_URL,
    brokerUser: 'app',
    expectedResultUser: 'worker-default',
  });
  const observed = readComputeConfig({ ...base, MIO_COMPUTE_WORKER_INSTANCE_IDS: 'worker-a' });
  expect(observed).toEqual({
    brokerURL: base.RABBITMQ_URL,
    brokerUser: 'app',
    expectedResultUser: 'worker-default',
    workerInstances: ['worker-a'],
    workerUsers: new Map([['worker-a', 'worker-default']]),
  });
  expect(() =>
    readComputeConfig({
      ...base,
      MIO_COMPUTE_WORKER_RESULT_USERS: '{"worker-a":"worker-default"}',
    }),
  ).toThrow('COMPUTE_CONFIG');
});

it('requires a complete one-to-one Worker user mapping when multiple control queues are deployed', () => {
  const observed = { ...base, MIO_COMPUTE_WORKER_INSTANCE_IDS: 'worker-a,worker-b' };
  expect(() => readComputeConfig(observed)).toThrow('COMPUTE_CONFIG');
  for (const mapping of [
    { 'worker-a': 'peer', 'worker-b': 'peer' },
    { 'worker-a': 'peer', 'worker-b': 'app' },
    { 'worker-a': 'peer', 'incorrect-b': 'second' },
    { 'worker-a': 'peer' },
  ])
    expect(() =>
      readComputeConfig({ ...observed, MIO_COMPUTE_WORKER_RESULT_USERS: JSON.stringify(mapping) }),
    ).toThrow('COMPUTE_CONFIG');
  const config = readComputeConfig({
    ...observed,
    MIO_COMPUTE_WORKER_RESULT_USERS: '{"worker-a":"peer-a","worker-b":"peer-b"}',
  });
  expect(config?.workerUsers).toEqual(
    new Map([
      ['worker-a', 'peer-a'],
      ['worker-b', 'peer-b'],
    ]),
  );
});
