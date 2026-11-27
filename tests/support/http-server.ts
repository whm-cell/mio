import { once } from 'node:events';
import type { Server } from 'node:net';

export async function listenLoopback(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS');
  return address;
}
