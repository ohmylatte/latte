import type { ChatMessage, ChatRuntime, ChatSession, EffortTier, PermissionReply } from '../../shared/contracts';

export interface AdapterStartInput {
  workId: string;
  /** Chat id to use (the team member id, stable across resumes). Adapters mint one when absent. */
  chatId?: string;
  /** Work directory: the agent's cwd and the only place it should write. */
  directory: string;
  title: string;
  /** Role the member plays; echoed on the session for the UI. */
  roleId?: string;
  roleName?: string;
  /** Role personality, appended to the runtime's system prompt for this chat only. Empty = plain chat. */
  instructions?: string;
  /** Runtime-native session/thread id persisted from an earlier run, if any. */
  previousSessionId?: string | null;
  /** Runtime-specific model id; null = runtime default. */
  model?: string | null;
  /**
   * How hard this member works per answer, in Latte's own words. The adapter
   * translates it through agents/tiers.ts; absent means the default tier.
   */
  tier?: EffortTier;
  /** Latte-managed account (Claude Code / Codex); null = system profile / not applicable. */
  accountId?: string | null;
  /** Human label shown in the chat header. */
  label: string;
  /**
   * The human granted this work permission to read and write inside its own
   * folder. Verified against Claude Code: the grant is scoped to the folder,
   * so anything outside it, and every other tool, still asks.
   */
  trustedFolder?: boolean;
  /** Extra environment for the agent process (ENGRAM_PROJECT etc.). */
  extraEnv?: Record<string, string>;
  /**
   * Latte's own coordination MCP server(s), scoped to this chat alone. Only
   * populated for a member reachable from an active coordination run; the
   * adapter decides how (or whether) its runtime can actually receive them.
   */
  mcpServers?: AdapterMcpServer[];
}

/**
 * One MCP server to inject into a single chat's runtime process. Namespaced
 * so it cannot collide with a user's own server. A discriminated union
 * (task 6.21, sdd/autonomous-coordination design-v2-conversational D3):
 * coordination is remote HTTP, memory is a local stdio process — the two
 * kinds an adapter's `--mcp-config`/`-c mcp_servers.*` translation must
 * speak are structurally different, so the type says so rather than
 * carrying optional fields that only make sense for one kind.
 *
 * `latte_coordination` is minted per member (its `token` is what forces two
 * coordinated members of one Codex account onto separate processes,
 * `mcpFingerprint.ts`); `latte_memory` carries no token at all and is
 * identical for every member of the same brand (what lets engram-only
 * Codex members of a brand SHARE one process, D3's load-bearing invariant).
 */
export type AdapterMcpServer =
  | {
    kind: 'http';
    name: 'latte_coordination';
    /** Streamable HTTP, always 127.0.0.1 plus a random port. */
    url: string;
    /** Opaque bearer, scoped to this member's grant. MUST be kept off argv (a spawned process's command line is visible to every other process on the machine). */
    token: string;
  }
  | {
    kind: 'stdio';
    name: 'latte_memory';
    /** Resolved `engram` executable path. */
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

export interface AdapterStartResult {
  session: ChatSession;
  /** Runtime-native id to persist for resume; empty when the runtime assigns it later. */
  runtimeSessionId: string;
  /**
   * Los nombres de los servidores MCP que este adaptador inyectó DE VERDAD en
   * el proceso que acaba de arrancar. El planificador decide antes del spawn,
   * pero los adaptadores se niegan después por su cuenta (Claude sin
   * `promptDir`, Codex con su propio contador de procesos lleno), y sin este
   * reporte la UI afirmaba capacidades que el proceso no tenía. `undefined`
   * = este adaptador no inyecta nada (OpenCode): el reclamo queda intacto.
   */
  injectedMcpServers?: string[];
  /**
   * LATTE se negó a inyectar lo que el planificador había reclamado: no hay
   * `promptDir`, el config no se pudo escribir, la versión del CLI está por
   * debajo del piso. Es un campo APARTE de `injectedMcpServers` a propósito
   * (D7c): meter esa negativa ahí la disfrazaba de reporte del runtime y
   * encendía `runtimeConfirmed` sin que el proceso hubiera dicho nada. Acá
   * degrada el reclamo, que es verdad, sin afirmar que el runtime habló, que
   * no lo es.
   */
  injectionRefusedByLatte?: boolean;
}

/**
 * One implementation per runtime (OpenCode server, Claude Code stream-json,
 * Codex app-server). The hub routes by chat id; the UI only ever sees
 * ChatEvents, so every runtime looks the same on screen.
 */
/** Session fields every adapter fills the same way from the start input. */
export function sessionFrom(input: AdapterStartInput, provider: ChatRuntime, model: string | null, accountId: string | null, label: string, resumed: boolean): ChatSession {
  return {
    // Runtimes that replay their own history (OpenCode, Codex) recover it whenever they resume.
    historyRecovered: resumed,
    id: input.chatId ?? '',
    workId: input.workId,
    provider,
    model,
    accountId,
    label,
    resumed,
    roleId: input.roleId ?? 'assistant',
    roleName: input.roleName ?? 'Asistente',
  };
}

export interface RuntimeAdapter {
  readonly runtime: ChatRuntime;
  /** Whether this runtime can receive a coordination MCP server scoped to one chat. */
  readonly mcpInjection: 'per-member' | 'none';
  /**
   * Si este adaptador puede DECIR qué servidores MCP levantó de verdad, alguna
   * vez. Claude lo reporta en su `system/init` y Codex lo pregunta por
   * `mcpStatus`; OpenCode no tiene ningún endpoint que los liste (mirá
   * `electron/opencode/client.ts`: hay sesión, permisos, proveedores y nada
   * más), así que para él la confirmación NUNCA va a llegar.
   *
   * Es una capacidad distinta de `mcpInjection`: aquélla dice si Latte puede
   * inyectar, ésta dice si el runtime puede confirmar. La UI las necesita
   * separadas porque "todavía no confirmó" (transitorio, puede cambiar en un
   * segundo) y "este runtime no informa" (permanente, no va a cambiar nunca)
   * son dos frases distintas, y decir la primera cuando la verdad es la
   * segunda deja a la persona esperando algo que no va a pasar.
   */
  readonly confirmsMcpInjection: boolean;
  start(input: AdapterStartInput): Promise<AdapterStartResult>;
  owns(chatId: string): boolean;
  /** True while the runtime is answering on this chat. */
  isBusy(chatId: string): boolean;
  listMessages(chatId: string): ChatMessage[];
  send(chatId: string, text: string): Promise<void>;
  abort(chatId: string): Promise<void>;
  replyPermission(chatId: string, requestId: string, reply: PermissionReply): Promise<void>;
  replyQuestion(chatId: string, requestId: string, answers: string[][] | null): Promise<void>;
  stop(chatId: string): void;
  shutdown(): void;
}
