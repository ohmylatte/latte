/**
 * El gateway MCP local: la pieza que hace que ningún runtime vea OAuth nunca.
 *
 * Un servidor http en `127.0.0.1` con una ruta por conexión (`/c/<id>`), un
 * bearer propio de Latte por miembro, y por detrás el token del proveedor —que
 * **nunca sale del proceso principal**—. Ante un 401 refresca, reintenta UNA
 * vez, y si no puede, marca la conexión `vencida` y devuelve un error de tool
 * legible en vez de un fallo mudo de transporte.
 *
 * Brief `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`, 4.2 y 4.3.
 *
 * Por qué esto y no inyectarle el token del proveedor a cada miembro: porque el
 * vencimiento a mitad de run es el único fallo que arruina un trabajo, y sólo
 * acá se puede arreglar. Medido en 1.6: con un header inválido el runtime
 * reporta `failed`, **no** `needs-auth`, y el `--mcp-config` se lee al
 * spawnear, así que un token nuevo no entra sin reiniciar al miembro.
 *
 * El núcleo es una función pura `(pedido) -> respuesta`: sin socket, sin
 * sesión, probable sin red del lado de adentro. El `node:http` de verdad vive
 * en `gatewayTransport.ts`.
 */
import type { ConnectionTokens } from '../storage/connectionsRepository';
import type { ConnectionRecord } from '../storage/connectionsRepository';
import { isExpired, refreshTokens, type FetchLike, type HttpResponseLike } from './oauth';
import type { GatewayTokenRegistry } from './gatewayTokens';

// --- El puerto HTTP hacia el upstream ---------------------------------------

/** Igual que `HttpResponseLike`, más el cuerpo como stream: el SSE del upstream se reenvía tal cual, no se junta. */
export interface UpstreamResponse extends HttpResponseLike {
  readonly body: AsyncIterable<Uint8Array> | null;
}

export type UpstreamFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<UpstreamResponse>;

// --- El pedido y la respuesta del gateway -----------------------------------

export interface GatewayRequest {
  method: string;
  /** El path completo tal como llegó, con la ruta de la conexión adentro. */
  path: string;
  authorization: string | undefined;
  remoteAddress: string | undefined;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  /** Texto cuando la respuesta se conoce entera; stream cuando el upstream contesta SSE. */
  body: string | AsyncIterable<Uint8Array>;
}

// --- El acceso a las conexiones ---------------------------------------------

/** La franja de `LatteRepository` que el gateway toca. Angosta a propósito: se prueba sin base. */
export interface GatewayConnectionsPort {
  get(id: string): ConnectionRecord | null;
  readTokens(id: string): ConnectionTokens | null;
  saveTokens(id: string, tokens: ConnectionTokens): void;
  setState(id: string, state: 'connected' | 'expired' | 'error', detail: string): void;
}

export interface ListenHandle {
  port: number;
  close: () => void;
}

export type GatewayRequestHandler = (request: GatewayRequest) => Promise<GatewayResponse>;
export type GatewayListenFn = (handler: GatewayRequestHandler) => Promise<ListenHandle>;

export interface ConnectionGatewayDeps {
  connections: GatewayConnectionsPort;
  tokens: GatewayTokenRegistry;
  listen: GatewayListenFn;
  fetchFn?: UpstreamFetch;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * Se llama UNA vez por conexión cuando pasa a vencida. Es el enganche del
   * aviso en el chat (G6): el gateway se entera antes que nadie, y el equipo
   * interrumpe con la pregunta en vez de con un toast.
   */
  onExpired?: (connection: ConnectionRecord, detail: string) => void;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Un `tools/call` real entra holgado; más que esto es un cliente roto. Mismo techo que el servidor de coordinación. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Las cabeceras que el gateway le pasa al upstream. Todo lo demás se descarta:
 * el `Authorization` del miembro (que es NUESTRO bearer, no el del proveedor),
 * `Host`, `Cookie` y cualquier cosa que identifique a la máquina no tienen por
 * qué cruzar.
 */
const FORWARDED_TO_UPSTREAM = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'] as const;

/** Y las que vuelven. El `Mcp-Session-Id` es la que hace que una sesión sobreviva al hop (riesgo 4). */
const FORWARDED_FROM_UPSTREAM = ['content-type', 'mcp-session-id', 'cache-control'] as const;

export function connectionRouteFor(connectionId: string): string {
  return `/c/${connectionId}`;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** `/c/<id>` y `/c/<id>/loquesea`: la conexión es el primer segmento después de `/c/`. */
export function connectionIdFromPath(path: string): string | null {
  const match = /^\/c\/([A-Za-z0-9_-]{1,64})(?:\/.*)?$/.exec(path.split('?')[0]);
  return match ? match[1] : null;
}

const jsonResponse = (status: number, body: unknown): GatewayResponse => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * El fallo que un miembro TIENE que poder leer. Para un `tools/call` sale como
 * un resultado con `isError`, que es lo que el modelo ve como texto; para
 * cualquier otro método, como un error de JSON-RPC. Nunca como un 500: un
 * cliente MCP lee un 500 como "el servidor está roto", no como "esta llamada
 * falló" — la misma distinción que `coordination/mcpServer.ts` ya defiende.
 */
function toolReadableFailure(rpcId: string | number | null, rpcMethod: string, message: string): GatewayResponse {
  if (rpcMethod === 'tools/call') {
    return jsonResponse(200, {
      jsonrpc: '2.0',
      id: rpcId,
      result: { content: [{ type: 'text', text: message }], isError: true },
    });
  }
  return jsonResponse(200, { jsonrpc: '2.0', id: rpcId, error: { code: -32002, message } });
}

interface ParsedRpc {
  id: string | number | null;
  method: string;
  isNotification: boolean;
}

function parseRpc(body: string): ParsedRpc {
  try {
    const parsed = JSON.parse(body) as { id?: string | number | null; method?: unknown };
    return {
      id: parsed.id ?? null,
      method: typeof parsed.method === 'string' ? parsed.method : '',
      isNotification: !('id' in parsed),
    };
  } catch {
    return { id: null, method: '', isNotification: false };
  }
}

export class ConnectionGateway {
  private handle: ListenHandle | null = null;
  private pendingListen: Promise<ListenHandle> | null = null;
  private readonly fetchFn: UpstreamFetch;
  private readonly now: () => number;
  /** Refrescos en vuelo por conexión: dos miembros que chocan el mismo 401 refrescan UNA vez, no dos. */
  private readonly refreshing = new Map<string, Promise<ConnectionTokens | null>>();

  constructor(private readonly deps: ConnectionGatewayDeps) {
    this.fetchFn = deps.fetchFn ?? ((url, init) => (globalThis as unknown as { fetch: UpstreamFetch }).fetch(url, init));
    this.now = deps.now ?? Date.now;
  }

  get listening(): boolean {
    return this.handle != null;
  }

  get boundPort(): number | null {
    return this.handle?.port ?? null;
  }

  /** La URL que se le inyecta a un miembro para esta conexión. Sólo vale con el gateway levantado. */
  urlFor(connectionId: string): string {
    if (!this.handle) throw new Error('El gateway de conexiones no está escuchando.');
    return `http://127.0.0.1:${this.handle.port}${connectionRouteFor(connectionId)}`;
  }

  /**
   * Memoizado igual que el servidor de coordinación: dos miembros abriendo a la
   * vez esperan el MISMO bind en vez de atar dos puertos y perder uno.
   */
  async ensureStarted(): Promise<void> {
    if (this.handle) return;
    if (!this.pendingListen) this.pendingListen = this.deps.listen((request) => this.handle_(request));
    const pending = this.pendingListen;
    try {
      this.handle = await pending;
    } finally {
      if (this.pendingListen === pending) this.pendingListen = null;
    }
  }

  /** Se para cuando no queda un solo bearer vivo. Un chat cerrado revoca los suyos, y el último apaga la luz. */
  stopIfIdle(): void {
    if (!this.handle) return;
    if (this.deps.tokens.size > 0) return;
    this.handle.close();
    this.handle = null;
  }

  stop(): void {
    this.handle?.close();
    this.handle = null;
  }

  /**
   * El núcleo. La autorización corre ENTERA antes de mirar el cuerpo, y
   * distingue tres cosas que no son la misma:
   *
   * - no es loopback, o el bearer no existe → **401**;
   * - el bearer existe pero es de OTRA conexión → **403**, porque el problema no
   *   es quién sos sino a dónde estás yendo;
   * - la conexión no existe → **404**.
   */
  private async handle_(request: GatewayRequest): Promise<GatewayResponse> {
    if (!LOOPBACK.has(request.remoteAddress ?? '')) {
      this.deps.log?.('[connections-gateway] pedido rechazado: no es loopback');
      return jsonResponse(401, { error: 'loopback_only' });
    }
    const bearer = extractBearer(request.authorization);
    const entry = bearer ? this.deps.tokens.verify(bearer) : null;
    if (!entry) return jsonResponse(401, { error: 'unauthorized' });

    const connectionId = connectionIdFromPath(request.path);
    if (!connectionId) return jsonResponse(404, { error: 'not_found' });
    if (connectionId !== entry.connectionId) {
      this.deps.log?.(`[connections-gateway] bearer de ${entry.connectionId} contra la ruta de ${connectionId}: 403`);
      return jsonResponse(403, { error: 'forbidden' });
    }
    if (request.body.length > MAX_BODY_BYTES) return jsonResponse(413, { error: 'payload_too_large' });

    const connection = this.deps.connections.get(connectionId);
    if (!connection) return jsonResponse(404, { error: 'not_found' });

    const rpc = parseRpc(request.body);
    let tokens = this.deps.connections.readTokens(connectionId);
    if (!tokens) {
      return toolReadableFailure(rpc.id, rpc.method, `No hay una sesión guardada para ${connection.label || connection.name}: hay que volver a entrar desde Latte.`);
    }

    // Vencimiento CONOCIDO: se refresca antes de salir, con el margen de cinco
    // minutos. Es más barato que gastar un viaje para que el upstream nos
    // conteste 401 y tener que rehacerlo.
    if (isExpired(tokens, this.now())) {
      const renewed = await this.refresh(connection, tokens);
      if (!renewed) return this.expire(connection, rpc, 'la sesión venció y no se pudo renovar');
      tokens = renewed;
    }

    let response = await this.callUpstream(connection, tokens, request);
    if (response.status === 401) {
      // Vencimiento DESCONOCIDO: el upstream dijo que no. Se refresca y se
      // reintenta **una sola vez**; dos sería un bucle contra un servidor que
      // ya dijo que no.
      const renewed = await this.refresh(connection, tokens);
      if (!renewed) return this.expire(connection, rpc, 'el servidor rechazó la sesión y no se pudo renovar');
      response = await this.callUpstream(connection, renewed, request);
      if (response.status === 401) return this.expire(connection, rpc, 'el servidor sigue rechazando la sesión después de renovarla');
    }

    if (connection.state !== 'connected' && response.status < 400) {
      this.deps.connections.setState(connectionId, 'connected', '');
    }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_FROM_UPSTREAM) {
      const value = response.headers.get(name);
      if (value) headers[name === 'mcp-session-id' ? 'Mcp-Session-Id' : name] = value;
    }
    // Un cuerpo SSE se reenvía COMO STREAM: juntarlo entero haría que las
    // notificaciones de progreso llegaran todas al final, que es exactamente la
    // clase de infidelidad del riesgo 4.
    const contentType = response.headers.get('content-type') ?? '';
    if (response.body && contentType.includes('text/event-stream')) {
      return { status: response.status, headers, body: response.body };
    }
    return { status: response.status, headers: { 'Content-Type': 'application/json', ...headers }, body: await response.text() };
  }

  private async callUpstream(connection: ConnectionRecord, tokens: ConnectionTokens, request: GatewayRequest): Promise<UpstreamResponse> {
    const headers: Record<string, string> = { Authorization: `${tokens.tokenType || 'Bearer'} ${tokens.accessToken}` };
    for (const name of FORWARDED_TO_UPSTREAM) {
      const value = request.headers[name];
      if (value) headers[name] = value;
    }
    return this.fetchFn(connection.url, {
      method: request.method,
      headers,
      ...(request.method === 'GET' || request.method === 'DELETE' ? {} : { body: request.body }),
    });
  }

  /**
   * Un refresh por conexión aunque choquen diez miembros a la vez. Sin esta
   * memo, cada uno gastaría el mismo refresh token y los AS que rotan el
   * refresh invalidarían el de los otros nueve.
   */
  private refresh(connection: ConnectionRecord, tokens: ConnectionTokens): Promise<ConnectionTokens | null> {
    const inFlight = this.refreshing.get(connection.id);
    if (inFlight) return inFlight;
    const attempt = (async (): Promise<ConnectionTokens | null> => {
      try {
        const renewed = await refreshTokens(tokens, this.fetchFn as unknown as FetchLike, this.now);
        this.deps.connections.saveTokens(connection.id, renewed);
        return renewed;
      } catch (error) {
        this.deps.log?.(`[connections-gateway] no se pudo renovar ${connection.name}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        this.refreshing.delete(connection.id);
      }
    })();
    this.refreshing.set(connection.id, attempt);
    return attempt;
  }

  /**
   * La conexión pasa a **vencida** y el miembro recibe un error que se puede
   * leer, no un fallo de transporte. El aviso a la persona es asunto de quien
   * escuche `onExpired`: el gateway no sabe nada de chats.
   */
  private expire(connection: ConnectionRecord, rpc: ParsedRpc, detail: string): GatewayResponse {
    const already = connection.state === 'expired';
    this.deps.connections.setState(connection.id, 'expired', detail);
    if (!already) this.deps.onExpired?.(connection, detail);
    return toolReadableFailure(
      rpc.id,
      rpc.method,
      `No puedo entrar a ${connection.label || connection.name}: ${detail}. La persona tiene que volver a entrar desde Latte; mientras tanto, seguí sin esta herramienta.`,
    );
  }
}
