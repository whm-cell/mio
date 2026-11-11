import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { once } from 'node:events';

/** A real TCP relay: writes reach Redis while selected responses are retained in this fixture. */
export async function redisProxy(port: number) {
  let holding = false;
  let received = '';
  let heldBytes = 0;
  const sockets = new Set<Socket>();
  const replies: { socket: Socket; bytes: Buffer }[] = [];
  const server = createServer((downstream) => {
    const upstream = createConnection({ host: '127.0.0.1', port });
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
