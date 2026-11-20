import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { once } from 'node:events';

function commandFrom(buffer: Buffer): { args: string[]; bytes: number } | undefined {
  const end = buffer.indexOf('\r\n');
  if (end < 0) return;
  if (buffer[0] !== 42) throw new Error('REDIS_PROXY_COMMAND: expected an array');
  const count = Number(buffer.toString('utf8', 1, end));
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error('REDIS_PROXY_COMMAND: invalid array length');
  const args: string[] = [];
  let offset = end + 2;
  for (let index = 0; index < count; index++) {
    const headerEnd = buffer.indexOf('\r\n', offset);
    if (headerEnd < 0) return;
    if (buffer[offset] !== 36) throw new Error('REDIS_PROXY_COMMAND: expected a bulk string');
    const length = Number(buffer.toString('utf8', offset + 1, headerEnd));
    if (!Number.isSafeInteger(length) || length < 0)
      throw new Error('REDIS_PROXY_COMMAND: invalid argument length');
    const valueStart = headerEnd + 2;
    if (buffer.length < valueStart + length + 2) return;
    if (buffer.toString('utf8', valueStart + length, valueStart + length + 2) !== '\r\n')
      throw new Error('REDIS_PROXY_COMMAND: invalid argument terminator');
    args.push(buffer.toString('utf8', valueStart, valueStart + length));
    offset = valueStart + length + 2;
  }
  return { args, bytes: offset };
}

/** A real TCP relay: writes reach Redis while selected responses are retained in this fixture. */
export async function redisProxy(
  port: number,
  observe?: (args: readonly string[]) => void,
  host = '127.0.0.1',
) {
  let holding = false;
  let received = '';
  let heldBytes = 0;
  const sockets = new Set<Socket>();
  const clients = new Set<Socket>();
  const replies: { socket: Socket; bytes: Buffer }[] = [];
  const server = createServer((downstream) => {
    const upstream = createConnection({ host, port });
    clients.add(downstream);
    downstream.on('close', () => clients.delete(downstream));
    let pending = Buffer.alloc(0);
    sockets.add(downstream);
    sockets.add(upstream);
    for (const socket of [downstream, upstream]) {
      socket.on('error', () => {});
      socket.on('close', () => {
        sockets.delete(socket);
        downstream.destroy();
        upstream.destroy();
      });
    }
    downstream.on('data', (data: Buffer) => {
      received += data.toString();
      if (observe) {
        pending = Buffer.concat([pending, data]);
        let command;
        while ((command = commandFrom(pending))) {
          observe(command.args);
          pending = pending.subarray(command.bytes);
        }
      }
      upstream.write(data);
    });
    upstream.on('data', (bytes: Buffer) => {
      if (holding) {
        heldBytes += bytes.length;
        replies.push({ socket: downstream, bytes });
      } else downstream.write(bytes);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy port missing');
  return {
    url: `redis://127.0.0.1:${address.port}`,
    get received() {
      return received;
    },
    get heldBytes() {
      return heldBytes;
    },
    get connections() {
      return sockets.size;
    },
    get clientConnections() {
      return clients.size;
    },
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      for (const { socket, bytes } of replies.splice(0)) if (!socket.destroyed) socket.write(bytes);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
