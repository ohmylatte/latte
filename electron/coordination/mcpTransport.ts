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

/**
 * `log` is optional and defaults to a no-op so `createHttpListen()` -- called
 * with zero arguments from `electron/bootstrap.ts`, which this module may not
 * change to accommodate -- keeps compiling and working unchanged (task 12a).
 */
export function createHttpListen(log: (line: string) => void = () => {}): ListenFn {
  return (requestListener: RequestListener) => new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requestListener(req as unknown as Parameters<RequestListener>[0], res as unknown as Parameters<RequestListener>[1]);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      // `reject` was a ONE-SHOT listener for the pre-bind race only.
      // Removing it left NOTHING attached: any post-bind server error
      // (EMFILE on accept, an errored socket) would emit 'error' with no
      // listener, which is an uncaught exception that takes down the whole
      // Electron main process mid-run (task 12a). This handler is
      // permanent -- it logs and swallows instead.
      server.on('error', (error) => {
        log(`[coordination-mcp-transport] server error: ${error instanceof Error ? error.message : String(error)}`);
      });
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({
        port,
        close: () => {
          // `server.close()` alone stops accepting NEW connections but waits
          // forever for EXISTING ones (e.g. an idle keep-alive socket) to end
          // on their own -- `stopIfIdle` would then report not-listening
          // while the old port kept serving, and a later `ensureStarted`
          // would bind a second port with no record of the first (task
          // 12b). `closeAllConnections` exists on Node 18.2+; guarded for
          // whatever Electron's bundled Node actually ships.
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
