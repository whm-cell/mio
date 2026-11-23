import {
  AUDIO_COMMAND_QUEUE,
  AUDIO_COMMAND_ROUTING_KEY,
  AUDIO_RESULT_QUEUE,
  AUDIO_RESULT_ROUTING_KEY,
  COMMAND_EXCHANGE,
  COMMAND_QUEUE,
  COMMAND_ROUTING_KEY,
  RESULT_EXCHANGE,
  RESULT_QUEUE,
  RESULT_ROUTING_KEY,
} from '@mio/compute-contracts';

const commandDlx = 'mio.compute.commands.dlx.v1';
const resultDlx = 'mio.compute.results.dlx.v1';
const commandDlq = 'mio.compute.commands.dlq.v1';
const resultDlq = 'mio.compute.results.dlq.v1';
const audioDlq = 'mio.compute.audio.commands.dlq.v1';
export const computeExchanges = [COMMAND_EXCHANGE, RESULT_EXCHANGE, commandDlx, resultDlx] as const;
export const computeDeadLetters = new Map([
  [COMMAND_QUEUE, { exchange: commandDlx, queue: commandDlq, routingKey: 'transcode.dead.v1' }],
  [RESULT_QUEUE, { exchange: resultDlx, queue: resultDlq, routingKey: 'transcode.result.dead.v1' }],
  [
    AUDIO_COMMAND_QUEUE,
    { exchange: commandDlx, queue: audioDlq, routingKey: 'audio.inspect.dead.v1' },
  ],
]);
export const computeQueues = [
  ...computeDeadLetters.keys(),
  commandDlq,
  resultDlq,
  audioDlq,
  AUDIO_RESULT_QUEUE,
];
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

export function computePermissions(role: 'a' | 'b') {
  const a = role === 'a';
  const readable = a ? [RESULT_QUEUE, AUDIO_RESULT_QUEUE] : [COMMAND_QUEUE, AUDIO_COMMAND_QUEUE];
  return {
    configure: '^$',
    write: `^${escape(a ? COMMAND_EXCHANGE : RESULT_EXCHANGE)}$`,
    read: `^(?:${readable.map(escape).join('|')})$`,
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
  for (const queue of computeQueues) {
    const deadLetter = computeDeadLetters.get(queue);
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
    [RESULT_EXCHANGE, RESULT_QUEUE, RESULT_ROUTING_KEY],
    [COMMAND_EXCHANGE, AUDIO_COMMAND_QUEUE, AUDIO_COMMAND_ROUTING_KEY],
    [RESULT_EXCHANGE, AUDIO_RESULT_QUEUE, AUDIO_RESULT_ROUTING_KEY],
  ];
  for (const deadLetter of computeDeadLetters.values())
    bindings.push([deadLetter.exchange, deadLetter.queue, deadLetter.routingKey]);
  for (const [exchange, queue, routingKey] of bindings)
    resources.push({
      method: 'POST',
      path: `bindings/${scope}/e/${exchange}/q/${queue}`,
      body: { routing_key: routingKey, arguments: {} },
    });
  return resources;
}
