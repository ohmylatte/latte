/**
 * The real `node:http` glue for `CoordinationMcpServer`'s injected `listen`
 * dependency (task 6.19/6.20 deliberately left this out of `mcpServer.ts`
 * itself, so it stays a pure `(body)->{status,body}` function with no
 * socket, no session, testable with zero network). Hub wiring (task 6.28)
 * is the caller that finally needs the real thing.
 *
 * Loopback-only, OS-assigned port (`listen(0, '127.0.0.1')`) -- the server
 * decides the port so several app launches never collide, and
 * `mcpServer.ts`'s own loopback allow-list is the actual security boundary,
 * not the bind address (a bind to `127.0.0.1` is already unreachable from
 * outside the machine either way).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ListenFn, RequestListener } from './mcpServer';

export function createHttpListen(): ListenFn {
  return (requestListener: RequestListener) => new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requestListener(req as unknown as Parameters<RequestListener>[0], res as unknown as Parameters<RequestListener>[1]);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}
