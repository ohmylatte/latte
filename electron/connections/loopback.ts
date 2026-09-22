/**
 * El listener de loopback que recibe el redirect del login.
 *
 * `http://127.0.0.1:<puerto>/callback`, **efímero por defecto**: el sistema
 * operativo elige el puerto y el `redirect_uri` se arma DESPUÉS de saberlo, así
 * que el registro dinámico lo registra ya correcto. El riesgo 2 del brief
 * ("los puertos de redirect son fijos por conexión y pueden estar ocupados")
 * desaparece por construcción para el camino con DCR, que es el único en
 * alcance.
 *
 * `preferredPort` existe para el otro camino, el del `clientId` de una app
 * propia: ahí el redirect está anotado a mano en la config del proveedor y
 * tiene que coincidir byte a byte. Si ese puerto está ocupado **no se cae a uno
 * efímero en silencio**: un redirect que no coincide con el registrado da un
 * error del proveedor a mitad del login, mucho más confuso que fallar acá.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackCallback {
  /** El `redirect_uri` exacto, con el puerto ya resuelto. */
  readonly redirectUri: string;
  readonly port: number;
  /** Resuelve cuando el navegador vuelve. Nunca rechaza: quien espera decide qué es un error. */
  readonly received: Promise<LoopbackResult>;
  close(): void;
}

export interface LoopbackResult {
  code: string | null;
  state: string | null;
  /** El `error` del proveedor cuando la persona dijo que no, o cuando el pedido estaba mal. */
  error: string | null;
  errorDescription: string | null;
}

export interface LoopbackOptions {
  /** Puerto obligatorio (app propia con redirect pre-registrado). Sin esto, el sistema elige. */
  preferredPort?: number;
  /** El HTML que ve la persona al volver. Se le pasa si salió bien. */
  page?: (ok: boolean) => string;
  log?: (line: string) => void;
}

const defaultPage = (ok: boolean): string => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Latte</title></head><body style="font-family:system-ui,sans-serif;padding:3rem;text-align:center"><p>${ok ? 'Listo. Ya podés volver a Latte y cerrar esta ventana.' : 'El login no se completó. Volvé a Latte y probá de nuevo.'}</p></body></html>`;

export async function startLoopbackCallback(options: LoopbackOptions = {}): Promise<LoopbackCallback> {
  const page = options.page ?? defaultPage;
  let settle: (result: LoopbackResult) => void = () => {};
  const received = new Promise<LoopbackResult>((resolve) => { settle = resolve; });
  let answered = false;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const result: LoopbackResult = {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
      errorDescription: url.searchParams.get('error_description'),
    };
    const ok = result.code != null && result.error == null;
    const body = page(ok);
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    // Sólo el PRIMER redirect cuenta. Un segundo pedido al mismo puerto (un
    // recargar, o alguien probando) no puede pisar el código ya recibido.
    if (answered) return;
    answered = true;
    settle(result);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(options.preferredPort ?? 0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      // Después del bind, un error del socket sin manejador es una excepción no
      // capturada que se lleva puesto el proceso principal de Electron. Igual
      // que en `coordination/mcpTransport.ts`: se loguea y se traga.
      server.on('error', (error) => options.log?.(`[connections-loopback] error del servidor: ${error instanceof Error ? error.message : String(error)}`));
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    port,
    received,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
