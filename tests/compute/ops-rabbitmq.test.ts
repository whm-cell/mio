import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { WORKER_DEFAULT_LIMITS } from '@mio/compute-contracts';
import type { WorkerLimitsCommand, WorkerTelemetry } from '@mio/compute-contracts';
import { Broker } from '../../compute/src/adapters/rabbitmq.ts';
import { ComputeBroker } from '../../src/integrations/rabbitmq.ts';
import { withLocalTestBroker } from '../support/local-broker-fixture.ts';

const ids = ['observe-a', 'observe-b'];
const zero = { total: 0, encode: 0, probe: 0 };
function snapshot(instanceId: string): WorkerTelemetry {
  return {
    type: 'worker.telemetry',
    version: 1,
    messageId: randomUUID(),
    instanceId,
    bootId: randomUUID(),
    bootSequence: 1,
    sequence: 1,
    observedAt: Date.now(),
    limits: { hard: WORKER_DEFAULT_LIMITS, applied: WORKER_DEFAULT_LIMITS, revision: 0 },
    usage: zero,
    waiting: zero,
    holds: { encode: [], probe: [] },
    active: [],
    event: null,
  };
}

it('routes controls to distinct authenticated B identities and rejects an authenticated cross-instance claim', async () => {
  const [first, second] = ids;
  await withLocalTestBroker(
    async (fixture) => {
      const other = fixture.otherWorker!;
      const app = await ComputeBroker.connect(
        fixture.appBrokerUrl,
        fixture.userA,
        fixture.userB,
        undefined,
        new Map([
          [first!, fixture.userB],
          [second!, other.user],
        ]),
      );
      const primary = await Broker.connect(fixture.workerBrokerUrl, fixture.userB, fixture.userA);
      const secondary = await Broker.connect(other.url, other.user, fixture.userA);
      const misconfigured = await Broker.connect(other.url, other.user, fixture.userA);
      try {
        await expect(
          misconfigured.consumeWorkerControl(first!, async () => {}, vi.fn()),
        ).rejects.toThrow(/ACCESS_REFUSED/);
        const receive = vi.fn(async () => {});
        await app.consumeWorker(receive, vi.fn());
        await secondary.publishWorker(snapshot(first!));
        const a = snapshot(first!),
          b = snapshot(second!);
        await primary.publishWorker(a);
        await secondary.publishWorker(b);
        await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
        expect(receive.mock.calls).toEqual(expect.arrayContaining([[a], [b]]));
        const observed = vi.fn();
        await primary.consumeWorkerControl(
          first!,
          async (command, ack) => {
            observed('a', command);
            ack();
          },
          vi.fn(),
        );
        await secondary.consumeWorkerControl(
          second!,
          async (command, ack) => {
            observed('b', command);
            ack();
          },
          vi.fn(),
        );
        const control: WorkerLimitsCommand = {
          version: 1,
          type: 'worker.limits.command',
          messageId: randomUUID(),
          instanceId: second!,
          revision: 1,
          requestedBy: 'fixture',
          requestedAt: Date.now(),
          limits: zero,
        };
        await app.publishWorkerControl(control);
        await vi.waitFor(() => expect(observed).toHaveBeenCalledExactlyOnceWith('b', control));
      } finally {
        await Promise.allSettled([
          app.close(),
          primary.close(),
          secondary.close(),
          misconfigured.close(),
        ]);
      }
    },
    { instanceId: first!, instanceIds: ids, secondaryInstanceId: second! },
  );
}, 60_000);
