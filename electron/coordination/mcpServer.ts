/**
 * The coordination MCP server: ONE process-wide HTTP endpoint, loopback
 * only, shared by every coordinated member across every Brand and every
 * Work (design-v2-conversational — "one server, several live runs", task
 * 6.18). `handleMcpRequest` is the pure routing core (task 6.17), separated
 * from the actual socket so it can be tested with zero network and zero
 * sockets opened — every test in `coordination-mcpserver.test.ts` calls it
 * directly.
 *
 * Wire contract (a deliberate, minimal decision for THIS slice): the
 * request body is `{ tool: string, args: unknown }`; the response body IS
 * the tool's own `ToolEnvelope` (see tools.ts), byte-identical. Full MCP
 * JSON-RPC framing — `initialize`, `tools/list`, capability negotiation —
 * is left to whichever slice actually constructs real client requests
 * against this endpoint (the adapter work in 6e/6f, explicitly out of scope
 * here); nothing in tasks 6.17-6.20 requires it, and inventing untested
 * protocol surface now would only have to be revisited then.
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
import { UnavailableError } from '../core/errors';
import type { CoordinationEngine } from './engine';
import { createCoordinationTools, type ToolEnvelope } from './tools';
import type { CoordinationTokenRegistry } from './tokens';
import type { LatteRepository } from '../storage/repository';

export interface McpHttpResponse {
  status: number;
  body: string;
}

export interface ListenHandle {
  port: number;
  close: () => void;
}

/** A request listener shaped like `http.RequestListener` -- kept structural so this file needs no `node:http` types beyond this signature. */
export type RequestListener = (req: { on: (event: 'data' | 'end', cb: (...args: never[]) => void) => void; headers: { authorization?: string }; socket: { remoteAddress?: string } }, res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }) => void;

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

  constructor(private readonly deps: CoordinationMcpServerDeps) {
    this.tools = deps.tools ?? createCoordinationTools(deps.engine);
    this.clock = deps.clock ?? (() => Date.now());
  }

  get listening(): boolean {
    return this.handle != null;
  }

  get boundPort(): number | null {
    return this.handle?.port ?? null;
  }

  /**
   * The pure routing core (task 6.17). A valid token routes the call to
   * `tools.ts` with the LAZILY resolved grant (`engine.resolveGrant`,
   * task 6.2) — never a grant frozen at mint. An unknown or revoked token,
   * or a non-loopback caller, is rejected `401` -- NEVER a `200` carrying an
   * error body: a caller must be able to trust the HTTP status alone.
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

    let parsed: { tool?: string; args?: unknown };
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as { tool?: string; args?: unknown }) : {};
    } catch {
      return { status: 400, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    const toolName = parsed.tool;
    const handler = toolName ? (this.tools as unknown as Record<string, (grant: ReturnType<CoordinationEngine['resolveGrant']>, args: unknown) => Promise<ToolEnvelope<unknown>>>)[toolName] : undefined;
    if (!handler) {
      return { status: 404, body: JSON.stringify({ error: 'unknown_tool', tool: toolName ?? null }) };
    }

    // Fresh every request, never cached: the same rule `tokens.ts` and
    // `resolveGrant` establish for the rest of the coordination surface.
    const grant = this.deps.engine.resolveGrant(entry.workId, entry.memberId);
    const envelope = await handler(grant, parsed.args ?? {});
    return { status: 200, body: JSON.stringify(envelope) };
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
   */
  async ensureStarted(): Promise<void> {
    if (this.handle) return;
    try {
      this.handle = await this.deps.listen((req, res) => this.onRequest(req, res));
    } catch (error) {
      this.handle = null;
      throw new UnavailableError(`Coordination MCP server could not bind a loopback port: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stops ONLY when BOTH hold: the token registry is empty AND no
   * coordination run is active anywhere app-wide (task 6.19 -- the v1
   * rule's ambiguous "no run is active" fixed to be explicit and app-wide:
   * ending brand A's run while brand B's is still live must NOT stop the
   * transport brand B's members depend on). A no-op if not currently
   * listening, or if either condition still fails.
   */
  stopIfIdle(): void {
    if (!this.handle) return;
    if (this.deps.tokens.size > 0) return;
    if (this.deps.repo.countActiveCoordinationRuns() > 0) return;
    this.handle.close();
    this.handle = null;
  }

  private onRequest(req: Parameters<RequestListener>[0], res: Parameters<RequestListener>[1]): void {
    const chunks: Buffer[] = [];
    req.on('data', ((chunk: Buffer) => chunks.push(chunk)) as never);
    req.on('end', (() => {
      void this.handleMcpRequest(Buffer.concat(chunks).toString('utf8'), req.headers.authorization, req.socket.remoteAddress).then((result) => {
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(result.body);
      });
    }) as never);
  }
}
