import type { OpenCodeEndpoint } from './server';
import type {
  OcAuthMethod,
  OcGlobalEvent,
  OcMessageWithParts,
  OcOAuthAuthorization,
  OcPermissionRequest,
  OcProviderCatalog,
  OcProvidersResponse,
  OcSession,
  OcSessionStatus,
} from './wire';

export interface ClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenCodeHttpError extends Error {
  constructor(readonly status: number, readonly path: string, body: string) {
    super(`OpenCode ${path} failed with ${status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'OpenCodeHttpError';
  }
}

/**
 * Thin typed client over the loopback OpenCode server. Every call is bounded
 * by a timeout; the `directory` query parameter scopes requests to one work.
 */
export class OpenCodeClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly endpoint: OpenCodeEndpoint, options: ClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  health(): Promise<unknown> {
    return this.request('GET', '/global/health');
  }

  providers(directory: string): Promise<OcProvidersResponse> {
    return this.request('GET', '/config/providers', { directory }) as Promise<OcProvidersResponse>;
  }

  /** Full catalog (all providers), which ones are connected, and the defaults. */
  providerCatalog(directory: string): Promise<OcProviderCatalog> {
    return this.request('GET', '/provider', { directory }) as Promise<OcProviderCatalog>;
  }

  /** Login methods per provider (OAuth flows, API key prompts). */
  providerAuthMethods(directory: string): Promise<Record<string, OcAuthMethod[]>> {
    return this.request('GET', '/provider/auth', { directory }) as Promise<Record<string, OcAuthMethod[]>>;
  }

  /** Stores credentials in the runtime's own store. The key never touches Latte's disk. */
  setApiKey(providerId: string, directory: string, key: string): Promise<unknown> {
    return this.request('PUT', `/auth/${encodeURIComponent(providerId)}`, { directory }, { type: 'api', key });
  }

  removeAuth(providerId: string, directory: string): Promise<unknown> {
    return this.request('DELETE', `/auth/${encodeURIComponent(providerId)}`, { directory });
  }

  oauthAuthorize(providerId: string, directory: string, method: number, inputs: Record<string, string>): Promise<OcOAuthAuthorization> {
    return this.request('POST', `/provider/${encodeURIComponent(providerId)}/oauth/authorize`, { directory }, { method, inputs }) as Promise<OcOAuthAuthorization>;
  }

  oauthCallback(providerId: string, directory: string, method: number, code: string | null): Promise<unknown> {
    const body: Record<string, unknown> = { method };
    if (code !== null) body.code = code;
    return this.request('POST', `/provider/${encodeURIComponent(providerId)}/oauth/callback`, { directory }, body);
  }

  createSession(directory: string, title: string): Promise<OcSession> {
    return this.request('POST', '/session', { directory }, { title }) as Promise<OcSession>;
  }

  getSession(sessionId: string, directory: string): Promise<OcSession> {
    return this.request('GET', `/session/${encodeURIComponent(sessionId)}`, { directory }) as Promise<OcSession>;
  }

  deleteSession(sessionId: string, directory: string): Promise<unknown> {
    return this.request('DELETE', `/session/${encodeURIComponent(sessionId)}`, { directory });
  }

  messages(sessionId: string, directory: string): Promise<OcMessageWithParts[]> {
    return this.request('GET', `/session/${encodeURIComponent(sessionId)}/message`, { directory }) as Promise<OcMessageWithParts[]>;
  }

  /** `variant` is how the server names reasoning effort on a prompt; omitted, the model's own default stands. */
  promptAsync(sessionId: string, directory: string, text: string, model?: { providerID: string; modelID: string } | null, system?: string | null, variant?: string | null): Promise<unknown> {
    const body: Record<string, unknown> = { parts: [{ type: 'text', text }] };
    if (model) body.model = model;
    if (system) body.system = system;
    if (variant) body.variant = variant;
    return this.request('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, { directory }, body);
  }

  abort(sessionId: string, directory: string): Promise<unknown> {
    return this.request('POST', `/session/${encodeURIComponent(sessionId)}/abort`, { directory });
  }

  sessionStatus(directory: string): Promise<Record<string, OcSessionStatus>> {
    return this.request('GET', '/session/status', { directory }) as Promise<Record<string, OcSessionStatus>>;
  }

  /**
   * What THIS process connected, per MCP server: `{ name: { status, error? } }`
   * with `connected`, `failed`, `disabled`, `needs_auth`... (verified against
   * opencode 1.18.32). Scoped by `directory` like every other call.
   */
  mcpStatus(directory: string): Promise<Record<string, unknown>> {
    return this.request('GET', '/mcp', { directory }) as Promise<Record<string, unknown>>;
  }

  pendingPermissions(directory: string): Promise<OcPermissionRequest[]> {
    return this.request('GET', '/permission', { directory }) as Promise<OcPermissionRequest[]>;
  }

  replyPermission(requestId: string, directory: string, reply: 'once' | 'always' | 'reject'): Promise<unknown> {
    return this.request('POST', `/permission/${encodeURIComponent(requestId)}/reply`, { directory }, { reply });
  }

  replyQuestion(requestId: string, directory: string, answers: string[][]): Promise<unknown> {
    return this.request('POST', `/question/${encodeURIComponent(requestId)}/reply`, { directory }, { answers });
  }

  rejectQuestion(requestId: string, directory: string): Promise<unknown> {
    return this.request('POST', `/question/${encodeURIComponent(requestId)}/reject`, { directory });
  }

  /**
   * Subscribes to the global SSE stream (every directory). Resolves when the
   * stream ends; rejects on transport failure. Cancel through the signal.
   */
  async globalEvents(onEvent: (event: OcGlobalEvent) => void, signal: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(`${this.endpoint.baseUrl}/global/event`, {
      headers: { Authorization: this.endpoint.authorization, Accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new OpenCodeHttpError(response.status, '/global/event', await safeText(response));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = parseSseData(frame);
        if (data !== null) {
          try {
            const parsed = JSON.parse(data) as OcGlobalEvent;
            if (parsed && typeof parsed === 'object' && parsed.payload && typeof parsed.payload.type === 'string') onEvent(parsed);
          } catch {
            // Malformed frame: skip, never crash the stream.
          }
        }
        separator = buffer.indexOf('\n\n');
      }
    }
  }

  private async request(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    const url = new URL(`${this.endpoint.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Authorization: this.endpoint.authorization, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new OpenCodeHttpError(response.status, path, await safeText(response));
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}

export function parseSseData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length > 0 ? data.join('\n') : null;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
