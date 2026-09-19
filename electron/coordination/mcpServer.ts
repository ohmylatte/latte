/**
 * The coordination MCP server: ONE process-wide HTTP endpoint, loopback
 * only, shared by every coordinated member across every Brand and every
 * Work (design-v2-conversational — "one server, several live runs", task
 * 6.18). `handleMcpRequest` is the pure routing core (task 6.17), separated
 * from the actual socket so it can be tested with zero network and zero
 * sockets opened — every test in `coordination-mcpserver.test.ts` calls it
 * directly.
 *
 * Wire contract (task 6.20b): real MCP JSON-RPC 2.0 — `initialize`,
 * `tools/list`, `tools/call`. Slice 6-B (task 6.17-6.20) shipped a
 * deliberately minimal `{tool,args}` body instead (see the superseded
 * decision, `latte/mcpserver-wire-contract-decision`) because nothing in
 * that slice constructed a real client request. This slice is the one that
 * does: Claude Code and Codex speak MCP over JSON-RPC 2.0 — they open with
 * `initialize`, then `tools/list`, then `tools/call` — and a server that
 * only understands `{tool,args}` fails their handshake silently (the agent
 * just sees no tools, with every unit test still green). Method names,
 * field names and the protocol version come from the official spec,
 * https://modelcontextprotocol.io/specification/2025-06-18 (transports,
 * lifecycle and server/tools pages) — the last HANDSHAKE-based revision
 * (initialize → tools/list → tools/call). The newer 2026-07-28 revision
 * replaces the handshake with a `server/discover` RPC and per-request
 * `_meta` version negotiation; no installed Claude Code or Codex build is
 * known to speak it, so implementing it now would build untested protocol
 * surface against a client nobody has yet. `MCP_PROTOCOL_VERSION` is the
 * single version this server declares; initialize always responds with it
 * (per the spec's own negotiation rule: echo the client's version if
 * supported, otherwise offer the server's own — for a single-version server
 * these are the same branch).
 *
 * The Streamable HTTP transport allows a server to answer a JSON-RPC
 * request with a single `application/json` object instead of opening an
 * SSE stream (transports page, "Sending Messages to the Server", clause 5)
 * — that is the shape this server always uses, so `handleMcpRequest` stays
 * a pure `(body) -> {status, body}` function with no stream, no session
 * (`Mcp-Session-Id` is spec-optional — "MAY assign"; the per-member bearer
 * token already identifies the caller, so no separate session id is
 * minted), and no `Origin` header check (the transport's own loopback-only
 * binding plus the bearer token already close the DNS-rebinding risk that
 * check exists for). These are documented gaps, not oversights.
 *
 * `resolveGrant` is called fresh on every request (never cached on the
 * token or on this server) — the same lazy-resolution rule `tokens.ts` and
 * `CoordinationEngine.resolveGrant` establish. This server holds NO
 * per-run/per-work state of its own: every read goes straight through
 * `tokens`/`engine`/`repo`.
 *
 * The actual socket is intentionally NOT opened by this module itself:
 * `listen` is an injected dependency (task 6.19), and there is no default —
 * a caller (hub wiring, task 6f, out of scope here) supplies the real
 * `node:http` implementation. Starting/stopping this shared singleton on
 * mint/run-end is ALSO hub wiring's job (task 6.28+); this module only
 * implements the lifecycle rules themselves (`ensureStarted`/`stopIfIdle`),
 * tested directly.
 */
import type { CoordinationAuthorityMode } from '../../shared/contracts';
import { LatteError, UnavailableError } from '../core/errors';
import { LIMITS } from '../services/validation';
import type { CoordinationBudgetBlock, CoordinationEngine } from './engine';
import { validateAgainstSchema } from './schemaGuard';
import { createCoordinationTools, type ToolEnvelope } from './tools';
import type { CoordinationTokenRegistry } from './tokens';
import type { LatteRepository } from '../storage/repository';

/** The one MCP protocol version this server speaks (see the module header for why). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** This transport's own version, independent of Latte's app version — it changes only when this wire surface does. */
const SERVER_INFO = { name: 'latte-coordination', version: '1.0.0' } as const;

/** One entry per tool `tools.ts` exports — real JSON-Schema, not a placeholder, so a real MCP client can validate arguments before calling. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Every tool `createCoordinationTools` builds, with the arguments schema
 * each handler in `tools.ts` actually destructures. `tools/list` never
 * filters this by the caller's role (task 6.20b's filtering decision):
 * the same token can become a coordinator moments later (grant is resolved
 * LAZILY per request, task 6.2/6.3), so hiding a tool a worker cannot call
 * YET would also hide the one door out — `latte_request_coordination` —
 * from the member who most needs to discover it. A worker calling a
 * coordinator-only tool still gets the FORBIDDEN envelope that names
 * `latte_request_coordination` (task 6.4); the rejection keeps teaching the
 * path over MCP exactly as it does over `tools.ts` directly.
 */
export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'latte_plan_submit',
    description: 'Coordinator only. Submits the tasks of an already-approved plan into the active coordination run.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              roleId: { type: 'string', description: 'The role that should do this task.' },
              spec: { type: 'string', description: 'What the task asks for.' },
              dependsOn: { type: 'array', items: { type: 'integer' }, description: 'Indexes into this same tasks array that must finish first.' },
            },
            required: ['roleId', 'spec'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'latte_task_create',
    description: 'Coordinator only. Creates one new task in the active coordination run.',
    inputSchema: {
      type: 'object',
      properties: {
        roleId: { type: 'string', description: 'The role that should do this task.' },
        spec: { type: 'string', description: 'What the task asks for.' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Existing task ids this task depends on.' },
      },
      required: ['roleId', 'spec'],
    },
  },
  {
    name: 'latte_dispatch',
    description: 'Coordinator only. Starts a ready task on its assigned member, subject to the Work\'s authority mode and budget.',
    inputSchema: {
      type: 'object',
      // `approvedGateId` se publicaba acá y el handler de `tools.ts` lo
      // DESCARTABA: un agente que lo mandara creía estar presentando una
      // aprobación humana y no estaba presentando nada. Lo que se publica
      // existe. La aprobación de un gate entra por `resolveCoordinationGate`,
      // la interfaz de la persona, nunca por una herramienta del agente.
      properties: {
        taskId: { type: 'string' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'latte_team_list',
    description: 'Coordinator only. Lists the members of this Work and their current status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'latte_report',
    description: 'Reports the outcome of a task this member was dispatched to do.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        outcome: { type: 'string', enum: ['succeeded', 'failed'] },
        summary: { type: 'string' },
        files: { type: ['string', 'null'], description: 'Relative paths of files this task produced or changed, if any.' },
      },
      required: ['taskId', 'outcome', 'summary'],
    },
  },
  {
    name: 'latte_check',
    // La verdad, no la promesa: hoy NADA en Latte escribe en el buzón
    // (`insertCoordinationMessage` no tiene ningún llamador de producción), así
    // que esta herramienta siempre devuelve una lista vacía. El parámetro
    // `wait` se publicaba documentado como "hasta ~30s" mientras la
    // implementación era `void _wait;`: se saca en vez de seguir anunciando un
    // comportamiento que el servidor no implementa. La herramienta queda —
    // AGENTS.md prohíbe sacar capacidades para simplificar — pero descripta
    // por lo que hace, no por lo que va a hacer.
    description: "Reads this member's mailbox. Latte has no producer of coordination messages yet, so this always returns an empty list; it never blocks and never waits.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'latte_ask',
    description: 'Asks the human (or the coordinator) a question and suspends this task until it is answered or the TTL expires.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        ttlMinutes: { type: 'number', description: 'Defaults to 30, capped at 1440 (24h).' },
        taskId: { type: 'string' },
      },
      required: ['question'],
    },
  },
  {
    name: 'latte_request_coordination',
    description: 'Any member may call this. Proposes a concrete plan — tasks, who does each, who is missing and why, and the estimated budget — for a human to approve in one gesture. This is how a worker becomes the coordinator.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              roleId: { type: 'string' },
              spec: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'integer' } },
            },
            required: ['roleId', 'spec'],
          },
        },
        // `['integer','null']` publicaba como legal el único valor que el
        // validador de presupuesto rechaza SIEMPRE desde acá: un ilimitado
        // sólo vale con una confirmación humana, y `requestCoordination`
        // descarta la que escriba el agente. Publicarlo dejaba que un agente
        // bien portado, siguiendo el esquema al pie de la letra, escribiera un
        // `budget_json` ilegible que después rompía la tira de TODAS las
        // marcas. Lo que no se puede aceptar no se publica.
        estimatedDispatches: { type: 'integer', minimum: 1, description: 'How many dispatches this plan is estimated to need. A positive integer; an unlimited budget is a human choice made when approving, never something a plan can ask for.' },
        membersToHire: {
          type: 'array',
          items: {
            type: 'object',
            // R6: el tope se PUBLICA, y por eso se puede hacer cumplir en la
            // frontera. `assertCoordinationProposal` ya lo aplicaba (LIMITS.decision)
            // y el esquema no lo decía: el agente descubría el límite recién
            // cuando su llamada fallaba, sin saber cuál era.
            properties: { roleId: { type: 'string' }, why: { type: 'string', maxLength: LIMITS.decision } },
            required: ['roleId', 'why'],
          },
        },
        rationale: { type: 'string', maxLength: LIMITS.decision },
      },
      required: ['plan', 'estimatedDispatches', 'rationale'],
    },
  },
];

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface McpHttpResponse {
  status: number;
  body: string;
}

export interface ListenHandle {
  port: number;
  close: () => void;
}

/** A request listener shaped like `http.RequestListener` -- kept structural so this file needs no `node:http` types beyond this signature. */
export type RequestListener = (req: { on: (event: 'data' | 'end' | 'error' | 'aborted', cb: (...args: never[]) => void) => void; headers: { authorization?: string }; socket: { remoteAddress?: string }; destroy: () => void }, res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }) => void;

export type ListenFn = (requestListener: RequestListener) => Promise<ListenHandle>;

export interface CoordinationMcpServerDeps {
  repo: LatteRepository;
  engine: CoordinationEngine;
  tokens: CoordinationTokenRegistry;
  tools?: ReturnType<typeof createCoordinationTools>;
  log?: (line: string) => void;
  /** REQUIRED, never defaulted: the real `node:http` bind lives with whoever wires this server up (hub wiring, task 6f). */
  listen: ListenFn;
  clock?: () => number;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Techo del cuerpo de un pedido, en bytes. Un `tools/call` real entra holgado; más que esto es un cliente roto o malicioso. */
const MAX_MCP_BODY_BYTES = 1_000_000;

/** At most one "rejected request" log line per this window, regardless of how many bad tokens arrive — a hammering caller must never flood the log. */
const REJECTED_LOG_WINDOW_MS = 5_000;

function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress != null && LOOPBACK_ADDRESSES.has(remoteAddress);
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1] : null;
}

export class CoordinationMcpServer {
  private readonly tools: ReturnType<typeof createCoordinationTools>;
  private readonly clock: () => number;
  private handle: ListenHandle | null = null;
  private lastRejectedLogAt = -Infinity;
  /** The in-flight `listen` call, memoised (task 11) -- see `ensureStarted`. */
  private pendingListen: Promise<ListenHandle> | null = null;

  constructor(private readonly deps: CoordinationMcpServerDeps) {
    this.tools = deps.tools ?? createCoordinationTools(deps.engine);
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * El motor que sirve todo `tools/call`. Expuesto para que se pueda
   * COMPROBAR que es el mismo objeto que el del servicio: el motor tiene
   * estado en memoria (`assigning`, `pendingClose`), así que dos instancias
   * sobre el mismo repo no son intercambiables (R1).
   */
  get engine(): CoordinationEngine {
    return this.deps.engine;
  }

  get listening(): boolean {
    return this.handle != null;
  }

  get boundPort(): number | null {
    return this.handle?.port ?? null;
  }

  /**
   * The pure routing core (task 6.17), now speaking real MCP JSON-RPC 2.0
   * (task 6.20b). Transport-level auth (loopback + bearer token) runs
   * BEFORE any JSON-RPC parsing, exactly as it did in slice 6-B: an unknown
   * or revoked token, or a non-loopback caller, is rejected `401` -- NEVER a
   * `200` carrying an error body, and never a JSON-RPC-shaped body either --
   * a caller must be able to trust the HTTP status alone, before the
   * protocol layer even begins.
   */
  async handleMcpRequest(rawBody: string, authHeader: string | undefined, remoteAddress: string | undefined): Promise<McpHttpResponse> {
    if (!isLoopback(remoteAddress)) {
      this.logRejectedRateLimited(remoteAddress, 'non-loopback address');
      return { status: 401, body: JSON.stringify({ error: 'loopback_only' }) };
    }
    const token = extractBearer(authHeader);
    const entry = token ? this.deps.tokens.verify(token) : null;
    if (!entry) {
      this.logRejectedRateLimited(remoteAddress, 'unknown or revoked token');
      return { status: 401, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let parsed: JsonRpcRequest;
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as JsonRpcRequest) : {};
    } catch {
      // Cannot even tell if this was a request or a notification -- a JSON-RPC parse error, id null.
      return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
    }

    // A JSON-RPC NOTIFICATION is identified by the ABSENCE of `id`, not by
    // its value -- an explicit `id: null` is still a request. Per the
    // Streamable HTTP transport spec, a notification the server accepts is
    // answered with 202 and NO body, never a JSON-RPC response.
    if (!('id' in parsed)) {
      return { status: 202, body: '' };
    }
    const id = parsed.id ?? null;
    const method = typeof parsed.method === 'string' ? parsed.method : '';

    switch (method) {
      case 'initialize':
        return { status: 200, body: JSON.stringify(this.handleInitialize(id)) };
      case 'tools/list':
        return { status: 200, body: JSON.stringify(this.handleToolsList(id)) };
      case 'tools/call': {
        // Fresh every request, never cached: the same rule `tokens.ts` and
        // `resolveGrant` establish for the rest of the coordination surface.
        //
        // F12: ADENTRO del try. `resolveGrant` lee la base —el run activo del
        // Trabajo, el meta del coordinador—, y si esa lectura tira, la
        // excepción escapaba de `handleMcpRequest` entero y el transporte la
        // devolvía como HTTP 500. Un cliente MCP lee un 500 como "el servidor
        // está roto", no como "esta llamada falló": es el mismo crítico que
        // `wrap` ya resolvió una capa más arriba para las dos lecturas del
        // sobre. Un fallo de UNA llamada sale como el resultado de esa llamada.
        let grant: ReturnType<CoordinationEngine['resolveGrant']>;
        try {
          grant = this.deps.engine.resolveGrant(entry.workId, entry.memberId);
        } catch (error) {
          return { status: 200, body: JSON.stringify(this.toolFailure(id, error)) };
        }
        return { status: 200, body: JSON.stringify(await this.handleToolsCall(id, parsed.params, grant)) };
      }
      default:
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method || '(missing method)'}` } }) };
    }
  }

  /**
   * El fallo de una llamada, con la MISMA forma que el de cualquier tool
   * (F12): un `result` con `isError:true` y un `ToolEnvelope` adentro, nunca
   * un error de protocolo ni un 500. El bloque de presupuesto va en ceros y
   * `null` —el mismo "no se pudo leer" que usa `tools.ts`—, porque sin grant
   * no hay run del cual leer un número honesto.
   */
  private toolFailure(id: string | number | null, error: unknown): Record<string, unknown> {
    const envelope: ToolEnvelope<never> = {
      ok: false,
      authority: 'manual',
      budget: { dispatchesUsed: 0, maxDispatches: null, inFlight: 0, maxConcurrent: null },
      data: null,
      error: {
        code: error instanceof LatteError ? error.code : 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
      },
    };
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: true },
    };
  }

  /** `initialize` (task 6.20b): version negotiation collapses to "always this server's one version" — see the module header. */
  private handleInitialize(id: string | number | null): Record<string, unknown> {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }

  /** `tools/list` (task 6.20b): the full catalog, unfiltered by role — see `MCP_TOOL_DEFINITIONS`'s own comment for why. */
  private handleToolsList(id: string | number | null): Record<string, unknown> {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOL_DEFINITIONS } };
  }

  /**
   * `tools/call` (task 6.20b): an unknown tool name is a JSON-RPC PROTOCOL
   * error (`-32602`, "Invalid params", matching the spec's own "Unknown
   * tool" example) -- a client bug, not a business rejection. A tool that
   * runs but the grant does not permit (FORBIDDEN) or that otherwise fails
   * is NOT a protocol error: it is a normal `result` with `isError:true`,
   * carrying the tool's own `ToolEnvelope`, both as `structuredContent` and
   * as its JSON-stringified text twin (spec's structured-content guidance)
   * -- so the FORBIDDEN message naming `latte_request_coordination` reaches
   * the agent exactly as it does through `tools.ts` directly.
   */
  private async handleToolsCall(id: string | number | null, params: unknown, grant: ReturnType<CoordinationEngine['resolveGrant']>): Promise<Record<string, unknown>> {
    const name = isRecord(params) && typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params) && 'arguments' in params ? params.arguments : {};
    // `name` es dato del que llama, nunca una llave al prototipo: sin el
    // chequeo de propiedad propia, `"__proto__"` devolvía `Object.prototype`
    // (verdadero, así que pasaba el `if` de abajo) y explotaba con "handler is
    // not a function", y `"constructor"` devolvía el grant resuelto entero
    // como `structuredContent`. Cualquiera con un token podía hacerlo.
    const table = this.tools as unknown as Record<string, (grant: ReturnType<CoordinationEngine['resolveGrant']>, args: unknown) => Promise<ToolEnvelope<unknown>>>;
    const handler = name && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
    if (typeof handler !== 'function') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name || '(missing name)'}` } };
    }
    // R6: LOS ARGUMENTOS SE VALIDAN CONTRA EL ESQUEMA QUE ESTE MISMO SERVIDOR
    // PUBLICA, para TODA herramienta, antes de que `tools.ts` vea nada. Sólo
    // `latte_request_coordination` validaba, y de rebote (el motor lo hace por
    // su cuenta): `latte_report` con `outcome:"success"` —prohibido por su
    // propio enum— caía en el `else` de `report()` y contaba como FRACASO, con
    // un intento cobrado contra el tope de reintentos de la tarea.
    //
    // NO es un error de PROTOCOLO: el cliente habló bien, el agente se
    // equivocó de argumento. Sale como cualquier otro rechazo de negocio —
    // `result` con `isError:true` y un sobre con `INVALID_ARGUMENT`— así que
    // el agente lo lee, ve qué campo fue y lo corrige.
    const definition = MCP_TOOL_DEFINITIONS.find((d) => d.name === name);
    const violation = definition ? validateAgainstSchema(definition.inputSchema, args ?? {}) : null;
    if (violation) return this.invalidArgument(id, grant, violation);
    const envelope = await handler(grant, args ?? {});
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
        structuredContent: envelope,
        isError: !envelope.ok,
      },
    };
  }

  /**
   * R6: el rechazo de un argumento que no cumple el esquema publicado, con la
   * MISMA forma que cualquier otro rechazo de `tools.ts` — mismo sobre, mismo
   * `authority`/`budget`, `isError:true`. El bloque se lee de verdad (no van
   * ceros por comodidad): la llamada falló, pero el estado del equipo que el
   * agente necesita para corregirse sigue siendo legible. Si ESA lectura
   * tampoco se puede hacer, van ceros y `null`, el mismo "no se pudo leer" que
   * usa `tools.ts`.
   */
  private invalidArgument(id: string | number | null, grant: ReturnType<CoordinationEngine['resolveGrant']>, message: string): Record<string, unknown> {
    let authority: CoordinationAuthorityMode = 'manual';
    let budget: CoordinationBudgetBlock = { dispatchesUsed: 0, maxDispatches: null, inFlight: 0, maxConcurrent: null };
    try {
      authority = this.deps.engine.readAuthorityForEnvelope(grant.workId);
      budget = this.deps.engine.budgetBlockForEnvelope(grant.runId);
    } catch { /* un presupuesto ilegible no puede tapar el motivo real del rechazo */ }
    const envelope: ToolEnvelope<never> = {
      ok: false, authority, budget, data: null,
      error: { code: 'INVALID_ARGUMENT', message },
    };
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: true },
    };
  }

  private logRejectedRateLimited(remoteAddress: string | undefined, reason: string): void {
    const now = this.clock();
    if (now - this.lastRejectedLogAt < REJECTED_LOG_WINDOW_MS) return;
    this.lastRejectedLogAt = now;
    this.deps.log?.(`[coordination-mcp] rejected request from ${remoteAddress ?? 'unknown'}: ${reason}`);
  }

  /**
   * Starts the shared singleton lazily, on demand (the intended call site is
   * "on the first mint" -- hub wiring, task 6.28, out of scope here).
   * Idempotent: a second call while already listening is a no-op.
   *
   * Throws `UnavailableError` if the injected `listen` rejects (task 6.20)
   * -- e.g. the loopback port never binds -- BEFORE returning to the
   * caller, so a run start that awaits this never tells any member
   * coordination exists when it in fact does not.
   *
   * Task 11: `if (this.handle) return;` then `await listen(...)` was a
   * TOCTOU -- two concurrent callers both observe `handle === null` before
   * either bind settles, so BOTH called `listen`, the second silently
   * overwrote `this.handle`, and the first's socket leaked forever (never
   * closed, unreachable from `stopIfIdle`, still serving `tools/call` on a
   * port some member was handed). The in-flight promise is memoised so every
   * concurrent caller awaits the SAME bind instead of racing their own.
   */
  async ensureStarted(): Promise<void> {
    if (this.handle) return;
    if (!this.pendingListen) {
      this.pendingListen = this.deps.listen((req, res) => this.onRequest(req, res));
    }
    const pending = this.pendingListen;
    try {
      this.handle = await pending;
    } catch (error) {
      this.handle = null;
      throw new UnavailableError(`Coordination MCP server could not bind a loopback port: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Clear the memo once THIS attempt settles (success or failure) so a
      // later call mints a fresh bind instead of replaying a stale promise —
      // guarded so a NEWER attempt (started after this one already cleared
      // itself) never gets its own memo wiped out from under it.
      if (this.pendingListen === pending) this.pendingListen = null;
    }
  }

  /**
   * Stops ONLY when BOTH hold: no DELIVERED token remains AND no
   * coordination run is active anywhere app-wide (task 6.19 -- the v1
   * rule's ambiguous "no run is active" fixed to be explicit and app-wide:
   * ending brand A's run while brand B's is still live must NOT stop the
   * transport brand B's members depend on). A no-op if not currently
   * listening, or if either condition still fails.
   *
   * Task 10: this used to check `tokens.size` -- every MINTED token, not
   * every DELIVERED one. The injection planner mints a token unconditionally
   * for every member of every Work of every Brand, regardless of
   * coordination eligibility, so `size` was almost always non-zero and this
   * server could never actually stop. Only a token a runtime actually
   * received can justify keeping the loopback port open.
   */
  stopIfIdle(): void {
    if (!this.handle) return;
    if (this.deps.tokens.deliveredSize > 0) return;
    if (this.deps.repo.countActiveCoordinationRuns() > 0) return;
    this.handle.close();
    this.handle = null;
  }

  /**
   * El cuerpo se acumulaba en un `Buffer[]` sin techo: un cliente local podía
   * hacer crecer la memoria del proceso principal sin límite. Un pedido MCP
   * legítimo entra holgado en 1 MiB.
   */
  private onRequest(req: Parameters<RequestListener>[0], res: Parameters<RequestListener>[1]): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let closed = false;
    const write = (status: number, body: string): void => {
      if (closed) return;
      closed = true;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    };
    req.on('data', ((chunk: Buffer) => {
      if (closed) return;
      size += chunk.length;
      if (size > MAX_MCP_BODY_BYTES) {
        write(413, JSON.stringify({ error: 'payload_too_large' }));
        // Sin esto, un cliente local podía seguir mandando datos para
        // siempre hacia un handler ya descartado -- la respuesta ya salió,
        // pero el socket del otro lado nunca se enteraba.
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }) as never);
    req.on('end', (() => {
      if (closed) return;
      // `handleMcpRequest` es async y esto no tenía `.catch`: cualquier
      // rechazo (una lectura de base que falla, un handler que explota) dejaba
      // la respuesta sin escribir —el cliente colgado para siempre— y además
      // levantaba un unhandled rejection en el proceso principal de Electron.
      void this.handleMcpRequest(Buffer.concat(chunks).toString('utf8'), req.headers.authorization, req.socket.remoteAddress)
        .then((result) => write(result.status, result.body))
        .catch((error: unknown) => {
          this.deps.log?.(`[coordination-mcp] request failed: ${error instanceof Error ? error.message : String(error)}`);
          write(500, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
        });
    }) as never);
    // Un cliente que resetea la conexión a mitad del cuerpo dispara 'error' o
    // 'aborted' en `req` -- sin manejador, es la misma excepción sin capturar
    // que tumbaba el proceso principal de Electron. El socket ya está muerto
    // acá: marcar cerrado alcanza para dejar de acumular Y para que 'data'/
    // 'end' nunca intenten escribirle una respuesta a nadie del otro lado.
    req.on('error', (() => { closed = true; }) as never);
    req.on('aborted', (() => { closed = true; }) as never);
  }
}
