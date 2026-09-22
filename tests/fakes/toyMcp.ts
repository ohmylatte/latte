/**
 * El servidor MCP upstream de juguete: streamable-http, con bearer, sesión y
 * notificaciones. Es contra esto que se prueba la fidelidad del proxy (riesgo
 * 4 del brief `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`: "si se
 * come notificaciones, progreso o el session id, las tools van a fallar de
 * maneras raras").
 *
 * Hermético y sin dependencias, como el resto de los fakes del repo. Lo que
 * modela está medido, no supuesto:
 *
 * - `initialize` devuelve `Mcp-Session-Id`, y todo pedido posterior tiene que
 *   traerlo de vuelta o el servidor lo rechaza con 404 (que es lo que hace un
 *   servidor streamable-http de verdad);
 * - `tools/call` puede contestar `application/json` o `text/event-stream` con
 *   una notificación de progreso ANTES del resultado;
 * - un token invalidado a mitad de camino devuelve 401, que es el caso que el
 *   gateway tiene que resolver solo.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ToyMcpOptions {
  /** Los tokens del proveedor que este servidor acepta. Mutable: un test los saca para provocar el 401. */
  validTokens?: Set<string>;
  /**
   * En vez del set: pregunta si el token sirve. Es lo que permite atar este
   * upstream al AS de juguete y compartir un solo universo de tokens, que es la
   * única forma honesta de probar "refresca y reintenta" de punta a punta.
   */
  isValid?: (token: string) => boolean;
  /** `tools/call` contesta en SSE, con una notificación de progreso antes del resultado. */
  sse?: boolean;
  /** Exigir el `Mcp-Session-Id` que devolvió `initialize`. */
  requireSession?: boolean;
  /**
   * Retiene un pedido antes de contestarlo. Recibe el pedido ya registrado en
   * `calls`, así que el test puede decidir por índice o por método.
   *
   * Es lo que hace reproducible al REZAGADO: un pedido cuyo 401 llega después
   * de que un refresh ya terminó. Sin una forma de retenerlo, ese orden depende
   * del scheduler y no se puede afirmar nada sobre él.
   */
  holdCall?: (call: ToyMcpServer['calls'][number], index: number) => Promise<void> | void;
}

export interface ToyMcpServer {
  url: string;
  close(): Promise<void>;
  readonly validTokens: Set<string>;
  /** Todo lo que llegó: método JSON-RPC, el bearer que vino y el session id. */
  readonly calls: Array<{ method: string; rpcMethod: string | null; bearer: string | null; sessionId: string | null; accept: string | null }>;
  /** Las sesiones que abrió `initialize`. */
  readonly sessions: Set<string>;
}

export async function startToyMcp(options: ToyMcpOptions = {}): Promise<ToyMcpServer> {
  const validTokens = options.validTokens ?? new Set<string>();
  const sessions = new Set<string>();
  const calls: ToyMcpServer['calls'] = [];

  const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
      const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? null;
      const accept = (req.headers.accept as string | undefined) ?? null;
      const raw = req.method === 'POST' ? await readBody(req) : '';
      let parsed: { id?: unknown; method?: unknown } = {};
      try { parsed = raw ? (JSON.parse(raw) as typeof parsed) : {}; } catch { /* un cuerpo roto es un cuerpo roto */ }
      const rpcMethod = typeof parsed.method === 'string' ? parsed.method : null;
      const call = { method: req.method ?? '', rpcMethod, bearer, sessionId, accept };
      calls.push(call);
      await options.holdCall?.(call, calls.length - 1);

      const accepted = options.isValid ?? ((token: string) => validTokens.has(token));
      if (!bearer || !accepted(bearer)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }

      if (req.method === 'DELETE') {
        if (sessionId) sessions.delete(sessionId);
        res.writeHead(204); res.end();
        return;
      }

      if (req.method === 'GET') {
        // El canal server→cliente: una notificación y se queda abierto.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hola' } })}\n\n`);
        return;
      }

      if (rpcMethod === 'initialize') {
        const id = randomUUID();
        sessions.add(id);
        json(res, 200, {
          jsonrpc: '2.0',
          id: parsed.id ?? null,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'toy-upstream', version: '1.0.0' } },
        }, { 'Mcp-Session-Id': id });
        return;
      }

      if (options.requireSession && (!sessionId || !sessions.has(sessionId))) {
        json(res, 404, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32001, message: 'Session not found' } });
        return;
      }

      // Una notificación (sin `id`) se responde 202 sin cuerpo.
      if (!('id' in parsed)) { res.writeHead(202); res.end(); return; }

      if (rpcMethod === 'tools/list') {
        json(res, 200, {
          jsonrpc: '2.0',
          id: parsed.id ?? null,
          result: { tools: [{ name: 'eco', description: 'Devuelve lo que le mandan.', inputSchema: { type: 'object', properties: { texto: { type: 'string' } } } }] },
        });
        return;
      }

      if (rpcMethod === 'tools/call') {
        const result = { jsonrpc: '2.0', id: parsed.id ?? null, result: { content: [{ type: 'text', text: 'eco: hola' }], isError: false } };
        if (options.sse) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 50 } })}\n\n`);
          res.write(`data: ${JSON.stringify(result)}\n\n`);
          res.end();
          return;
        }
        json(res, 200, result);
        return;
      }

      json(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32601, message: `Method not found: ${rpcMethod ?? ''}` } });
    })().catch(() => { try { res.writeHead(500); res.end(); } catch { /* ya cerrado */ } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    validTokens,
    calls,
    sessions,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
