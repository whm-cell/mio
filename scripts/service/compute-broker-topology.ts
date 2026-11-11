import {
  COMMAND_EXCHANGE,
  COMMAND_QUEUE,
  COMMAND_ROUTING_KEY,
  RESULT_EXCHANGE,
  RESULT_QUEUE,
  RESULT_ROUTING_KEY,
} from '@mio/compute-contracts';

export const computeExchanges = [
  COMMAND_EXCHANGE,
  RESULT_EXCHANGE,
  'mio.compute.commands.dlx.v1',
  'mio.compute.results.dlx.v1',
] as const;
export const computeQueues = [
  COMMAND_QUEUE,
  RESULT_QUEUE,
  'mio.compute.commands.dlq.v1',
  'mio.compute.results.dlq.v1',
] as const;
export const computeCapacity = { 'max-length-bytes': 1073741824, overflow: 'reject-publish' };

export function computePermissions(role: 'a' | 'b') {
  const exact = (value: string) => `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  return {
    configure: '^$',
    write: exact(role === 'a' ? COMMAND_EXCHANGE : RESULT_EXCHANGE),
    read: exact(role === 'a' ? RESULT_QUEUE : COMMAND_QUEUE),
  };
}

/** Shared by one-time isolated probes and persistent local environments. No runtime declarations. */
export function computeTopology(vhost: string) {
  const scope = encodeURIComponent(vhost);
  const resources: { method: 'PUT' | 'POST'; path: string; body: Record<string, unknown> }[] = [];
  for (const exchange of computeExchanges)
    resources.push({
      method: 'PUT',
      path: `exchanges/${scope}/${exchange}`,
      body: {
        type: 'direct',
        durable: true,
        auto_delete: false,
        internal: false,
        arguments: {},
      },
    });
  for (const [index, queue] of computeQueues.entries()) {
    const args: Record<string, unknown> = {
      'x-queue-type': 'quorum',
      'x-delivery-limit': -1,
      'x-overflow': 'reject-publish',
    };
    if (index < 2) {
      args['x-dead-letter-exchange'] = computeExchanges[index + 2];
      args['x-dead-letter-routing-key'] =
        index === 0 ? 'transcode.dead.v1' : 'transcode.result.dead.v1';
      args['x-dead-letter-strategy'] = 'at-least-once';
    }
    resources.push({
      method: 'PUT',
      path: `queues/${scope}/${queue}`,
      body: {
        durable: true,
        auto_delete: false,
        arguments: args,
      },
    });
  }
  const routing = [
    COMMAND_ROUTING_KEY,
    RESULT_ROUTING_KEY,
    'transcode.dead.v1',
    'transcode.result.dead.v1',
  ];
  for (const [index, queue] of computeQueues.entries())
    resources.push({
      method: 'POST',
      path: `bindings/${scope}/e/${computeExchanges[index]}/q/${queue}`,
      body: { routing_key: routing[index], arguments: {} },
    });
  return resources;
}
