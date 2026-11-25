import {
  AUDIO_COMMAND_QUEUE,
  AUDIO_COMMAND_ROUTING_KEY,
  AUDIO_RESULT_QUEUE,
  AUDIO_RESULT_ROUTING_KEY,
  COMMAND_EXCHANGE,
  COMMAND_QUEUE,
  COMMAND_ROUTING_KEY,
  MEDIA_CONTROL_QUEUE,
  MEDIA_CONTROL_ROUTING_KEY,
  MEDIA_ENCODE_QUEUE,
  MEDIA_ENCODE_ROUTING_KEY,
  MEDIA_PROBE_QUEUE,
  MEDIA_PROBE_ROUTING_KEY,
  MEDIA_RESULT_QUEUE,
  MEDIA_RESULT_ROUTING_KEY,
  RESULT_EXCHANGE,
  RESULT_QUEUE,
  RESULT_ROUTING_KEY,
  VIDEO_PROBE_COMMAND_ROUTING_KEY,
  VIDEO_PROBE_RESULT_ROUTING_KEY,
  WORKER_TELEMETRY_QUEUE,
  WORKER_TELEMETRY_ROUTING_KEY,
  workerControlQueue,
  workerControlRoutingKey,
} from '@mio/compute-contracts';

const commandDlx = 'mio.compute.commands.dlx.v1';
const resultDlx = 'mio.compute.results.dlx.v1';
const commandDlq = 'mio.compute.commands.dlq.v1';
const resultDlq = 'mio.compute.results.dlq.v1';
const audioDlq = 'mio.compute.audio.commands.dlq.v1';
export const computeExchanges = [COMMAND_EXCHANGE, RESULT_EXCHANGE, commandDlx, resultDlx] as const;
const sharedDeadLetters = new Map([
  [COMMAND_QUEUE, { exchange: commandDlx, queue: commandDlq, routingKey: 'transcode.dead.v1' }],
  [RESULT_QUEUE, { exchange: resultDlx, queue: resultDlq, routingKey: 'transcode.result.dead.v1' }],
  [
    AUDIO_COMMAND_QUEUE,
    { exchange: commandDlx, queue: audioDlq, routingKey: 'audio.inspect.dead.v1' },
  ],
  ...(
    [
      [MEDIA_ENCODE_QUEUE, commandDlx, 'media.encode.dead'],
      [MEDIA_PROBE_QUEUE, commandDlx, 'media.probe.dead'],
      [MEDIA_CONTROL_QUEUE, commandDlx, 'media.control.dead'],
      [MEDIA_RESULT_QUEUE, resultDlx, 'media.result.dead'],
      [WORKER_TELEMETRY_QUEUE, resultDlx, 'worker.telemetry.dead'],
    ] as const
  ).map(
    ([queue, exchange, routingKey]) =>
      [queue, { exchange, queue: `${queue}.dlq`, routingKey }] as const,
  ),
]);

export function computeDeadLetters(workerInstanceIds: readonly string[] = []) {
  const deadLetters = new Map(sharedDeadLetters);
  for (const id of workerInstanceIds) {
    deadLetters.set(workerControlQueue(id), {
      exchange: commandDlx,
      queue: `mio.compute.worker.control-dlq.${id}`,
      routingKey: `worker.limits.dead.${id}`,
    });
  }
  return deadLetters;
}

export function computeQueues(deadLetters = sharedDeadLetters): string[] {
  return [
    ...deadLetters.keys(),
    ...Array.from(deadLetters.values(), (route) => route.queue),
    AUDIO_RESULT_QUEUE,
  ];
}

export const computeCapacity = { 'max-length-bytes': 1073741824, overflow: 'reject-publish' };

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const audioResultBytes = 64 * 1024 ** 2;
export const audioResultPolicy = {
  name: 'mio-audio-result-retention',
  definition: {
    pattern: `^${escape(AUDIO_RESULT_QUEUE)}$`,
    definition: { 'max-length-bytes': audioResultBytes },
    priority: 1,
    'apply-to': 'streams',
  },
};

export function computePermissions(role: 'a' | 'b', workerInstanceId?: string) {
  const a = role === 'a';
  const readable = a
    ? [RESULT_QUEUE, AUDIO_RESULT_QUEUE, MEDIA_RESULT_QUEUE, WORKER_TELEMETRY_QUEUE]
    : [
        COMMAND_QUEUE,
        AUDIO_COMMAND_QUEUE,
        MEDIA_ENCODE_QUEUE,
        MEDIA_PROBE_QUEUE,
        MEDIA_CONTROL_QUEUE,
      ];
  if (!a && workerInstanceId !== undefined) readable.push(workerControlQueue(workerInstanceId));
  return {
    configure: '^$',
    write: `^${escape(a ? COMMAND_EXCHANGE : RESULT_EXCHANGE)}$`,
    read: `^(?:${readable.map(escape).join('|')})$`,
  };
}

/** Shared by one-time isolated probes and persistent local environments. No runtime declarations. */
export function computeTopology(vhost: string, workerInstanceIds: readonly string[] = []) {
  const deadLetters = computeDeadLetters(workerInstanceIds);
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
  for (const queue of computeQueues(deadLetters)) {
    const deadLetter = deadLetters.get(queue);
    const args =
      queue === AUDIO_RESULT_QUEUE
        ? {
            'x-queue-type': 'stream',
            'x-max-length-bytes': audioResultBytes,
            'x-max-age': '1h',
            'x-stream-max-segment-size-bytes': 8 * 1024 ** 2,
          }
        : {
            'x-queue-type': 'quorum',
            'x-delivery-limit': -1,
            'x-overflow': 'reject-publish',
            ...(deadLetter
              ? {
                  'x-dead-letter-exchange': deadLetter.exchange,
                  'x-dead-letter-routing-key': deadLetter.routingKey,
                  'x-dead-letter-strategy': 'at-least-once',
                }
              : {}),
          };
    resources.push({
      method: 'PUT',
      path: `queues/${scope}/${queue}`,
      body: { durable: true, auto_delete: false, arguments: args },
    });
  }
  const bindings: [string, string, string][] = [
    [COMMAND_EXCHANGE, COMMAND_QUEUE, COMMAND_ROUTING_KEY],
    [COMMAND_EXCHANGE, COMMAND_QUEUE, VIDEO_PROBE_COMMAND_ROUTING_KEY],
    [RESULT_EXCHANGE, RESULT_QUEUE, RESULT_ROUTING_KEY],
    [RESULT_EXCHANGE, RESULT_QUEUE, VIDEO_PROBE_RESULT_ROUTING_KEY],
    [COMMAND_EXCHANGE, AUDIO_COMMAND_QUEUE, AUDIO_COMMAND_ROUTING_KEY],
    [RESULT_EXCHANGE, AUDIO_RESULT_QUEUE, AUDIO_RESULT_ROUTING_KEY],
    [COMMAND_EXCHANGE, MEDIA_ENCODE_QUEUE, MEDIA_ENCODE_ROUTING_KEY],
    [COMMAND_EXCHANGE, MEDIA_PROBE_QUEUE, MEDIA_PROBE_ROUTING_KEY],
    [COMMAND_EXCHANGE, MEDIA_CONTROL_QUEUE, MEDIA_CONTROL_ROUTING_KEY],
    [RESULT_EXCHANGE, MEDIA_RESULT_QUEUE, MEDIA_RESULT_ROUTING_KEY],
    [RESULT_EXCHANGE, WORKER_TELEMETRY_QUEUE, WORKER_TELEMETRY_ROUTING_KEY],
  ];
  for (const id of workerInstanceIds)
    bindings.push([COMMAND_EXCHANGE, workerControlQueue(id), workerControlRoutingKey(id)]);
  for (const deadLetter of deadLetters.values())
    bindings.push([deadLetter.exchange, deadLetter.queue, deadLetter.routingKey]);
  for (const [exchange, queue, routingKey] of bindings)
    resources.push({
      method: 'POST',
      path: `bindings/${scope}/e/${exchange}/q/${queue}`,
      body: { routing_key: routingKey, arguments: {} },
    });
  return resources;
}
