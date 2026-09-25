import type { Readable, Writable } from 'node:stream';

/**
 * JSON-RPC 2.0 sobre el stdio de un agente ACP: una línea, un mensaje (NDJSON).
 *
 * Lo que hace distinto a esta conexión de la de Codex es que el agente habla
 * MUCHO más de lo que se le pregunta. Grok manda decenas de notificaciones
 * `_x.ai/*` por sesión y, en modo leader, respuestas con `id: "skills-reload"`
 * que nadie pidió (brief 2026-09-25, sección 3.1). Así que la regla es:
 *
 *   - una respuesta a un id que no está pendiente se descarta en silencio;
 *   - un request del agente que nadie maneja se contesta `-32601`, SIEMPRE:
 *     un request sin respuesta deja al agente esperando para siempre;
 *   - una línea que no es JSON se loguea y se sigue.
 */

export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

/** `-32601`: el método no existe (o este cliente no lo maneja). */
export const METHOD_NOT_FOUND = -32601;
/** `-32800`: request cancelado (convención de LSP que ACP hereda). */
export const REQUEST_CANCELLED = -32800;

export interface AcpConnectionHandlers {
  /** Un request del agente. Lo que devuelve es el `result`; si tira `AcpRpcError`, es el `error`. `undefined` = no lo maneja nadie. */
  onRequest: (method: string, params: unknown, id: number | string) => Promise<unknown> | undefined;
  onNotification: (method: string, params: unknown) => void;
  log?: (line: string) => void;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

/** Lo que entra en una línea de log sin volverla ilegible. */
const LOG_LIMIT = 300;

export class AcpConnection {
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedReason: string | null = null;

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly handlers: AcpConnectionHandlers,
  ) {
    output.on('data', (chunk: Buffer | string) => this.onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    // Un stdin cerrado (el proceso se murió, o Latte lo cerró) emite `error`
    // en cada write: sin este listener, eso tumba el proceso principal.
    input.on('error', (error) => this.handlers.log?.(`[acp] stdin error: ${error.message}`));
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  /**
   * Un request al agente. `timeoutMs` sólo para lo que tiene que volver rápido
   * (`initialize`, `session/new`, `session/set_model`): un `session/prompt`
   * dura lo que dure el turno y no lleva reloj.
   */
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.closedReason !== null) return Promise.reject(new AcpRpcError(-32000, `ACP connection closed: ${this.closedReason}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new AcpRpcError(-32000, `${method} did not answer within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closedReason !== null) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Corta todo lo pendiente. Idempotente. */
  close(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new AcpRpcError(-32000, `ACP connection closed: ${reason}`));
      this.pending.delete(id);
    }
  }

  private write(message: unknown): void {
    // Contestarle a un proceso que ya no escucha no es un error de nadie.
    if (this.input.writableEnded || this.input.destroyed) return;
    try {
      this.input.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.handlers.log?.(`[acp] write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      message = parsed as Record<string, unknown>;
    } catch {
      this.handlers.log?.(`[acp] non-json: ${line.slice(0, LOG_LIMIT)}`);
      return;
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string') {
      if (hasId) this.onRequest(message.method, message.params, message.id as number | string);
      else this.safely(() => this.handlers.onNotification(message.method as string, message.params));
      return;
    }
    if (!hasId) return;
    // Una respuesta. Sólo cuenta si la pedimos nosotros: `skills-reload` y
    // cualquier id que no sea nuestro se descartan.
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error && typeof message.error === 'object') {
      const error = message.error as { code?: unknown; message?: unknown; data?: unknown };
      const detail = typeof error.data === 'object' && error.data !== null && typeof (error.data as { details?: unknown }).details === 'string'
        ? (error.data as { details: string }).details
        : null;
      pending.reject(new AcpRpcError(
        typeof error.code === 'number' ? error.code : -32000,
        detail ?? (typeof error.message === 'string' ? error.message : `${pending.method} failed`),
        error.data,
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private onRequest(method: string, params: unknown, id: number | string): void {
    let handled: Promise<unknown> | undefined;
    try {
      handled = this.handlers.onRequest(method, params, id);
    } catch (error) {
      this.replyError(id, error);
      return;
    }
    if (handled === undefined) {
      this.write({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
      return;
    }
    handled.then(
      (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
      (error: unknown) => this.replyError(id, error),
    );
  }

  private replyError(id: number | string, error: unknown): void {
    const code = error instanceof AcpRpcError ? error.code : -32603;
    const message = error instanceof Error ? error.message : String(error);
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.handlers.log?.(`[acp] notification handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
