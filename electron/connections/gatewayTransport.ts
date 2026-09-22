/**
 * El `node:http` de verdad del gateway, separado de `gateway.ts` por lo mismo
 * que `coordination/mcpTransport.ts` está separado de `mcpServer.ts`: el núcleo
 * queda una función `(pedido) -> respuesta`, sin socket y sin red, y toda la
 * fidelidad del proxy se prueba sin abrir un puerto de más.
 *
 * Loopback y puerto efímero (`listen(0, '127.0.0.1')`): el sistema elige, así
 * que dos instancias de Latte nunca chocan.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GatewayListenFn, GatewayRequestHandler } from './gateway';

/** Techo del cuerpo que se acumula antes de siquiera mirarlo: sin esto un cliente local hace crecer la memoria del main sin límite. */
const MAX_BODY_BYTES = 1_000_000;

export function createGatewayListen(log: (line: string) => void = () => {}): GatewayListenFn {
  return (handler: GatewayRequestHandler) => new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let closed = false;
      const writeText = (status: number, headers: Record<string, string>, body: string): void => {
        if (closed) return;
        closed = true;
        res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      };

      const run = async (): Promise<void> => {
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
        }
        const response = await handler({
          method: req.method ?? 'POST',
          path: req.url ?? '/',
          authorization: req.headers.authorization,
          remoteAddress: req.socket.remoteAddress,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (typeof response.body === 'string') {
          writeText(response.status, response.headers, response.body);
          return;
        }
        // Un cuerpo en stream (el SSE del upstream) sale a medida que llega,
        // sin `Content-Length`: juntarlo entero sería comerse el progreso, que
        // es el riesgo 4 del brief hecho realidad.
        if (closed) return;
        closed = true;
        res.writeHead(response.status, response.headers);
        try {
          for await (const chunk of response.body) res.write(Buffer.from(chunk));
        } catch (error) {
          log(`[connections-gateway] el stream del upstream se cortó: ${error instanceof Error ? error.message : String(error)}`);
        }
        res.end();
      };

      req.on('data', (chunk: Buffer) => {
        if (closed) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          writeText(413, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'payload_too_large' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (closed) return;
        void run().catch((error: unknown) => {
          log(`[connections-gateway] el pedido falló: ${error instanceof Error ? error.message : String(error)}`);
          writeText(500, { 'Content-Type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
        });
      });
      // Un cliente que resetea a mitad del cuerpo dispara 'error'/'aborted'; sin
      // manejador es una excepción no capturada que se lleva puesto el proceso
      // principal de Electron.
      req.on('error', () => { closed = true; });
      req.on('aborted', () => { closed = true; });
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', (error) => log(`[connections-gateway] error del servidor: ${error instanceof Error ? error.message : String(error)}`));
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => {
          // `close()` solo espera para siempre a las conexiones keep-alive ya
          // abiertas: el puerto seguiría sirviendo mientras `stopIfIdle` ya
          // reporta que no escucha. Mismo arreglo que en coordinación.
          server.closeAllConnections?.();
          server.close();
        },
      });
    });
  });
}
