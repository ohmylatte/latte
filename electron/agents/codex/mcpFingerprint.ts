import { createHash } from 'node:crypto';
import type { AdapterMcpServer } from '../types';

/** Codex reads the coordination token only from this env var name. Se mantiene fijo para `latte_coordination`: es el nombre que ya viaja en procesos vivos y en los tests de la fase 5. */
export const CODEX_COORD_TOKEN_ENV = 'LATTE_COORD_TOKEN';

/**
 * El nombre de la variable de entorno de la que Codex lee el bearer de UN
 * servidor http. Hasta las Conexiones MCP había exactamente uno
 * (`latte_coordination`) y un nombre fijo alcanzaba; ahora un miembro puede
 * llevar varias conexiones a la vez, y dos servidores que compartieran nombre
 * de variable se pisarían el token en silencio — el peor fallo posible, porque
 * el que perdiera se conectaría con la credencial del otro.
 *
 * Determinista y derivado del nombre del servidor, que ya es único por miembro.
 */
export function codexTokenEnvVar(serverName: string): string {
  if (serverName === 'latte_coordination') return CODEX_COORD_TOKEN_ENV;
  return `LATTE_MCP_TOKEN_${serverName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Identifies whether two `AdapterMcpServer[]` describe the SAME Codex
 * `app-server` process. Empty/absent input -> `''`, so every ordinary,
 * non-coordinated, non-memory chat keeps sharing one process per account,
 * exactly as before this change.
 *
 * The two kinds fingerprint DIFFERENTLY on purpose (Phase 6, task 6.21/6.24
 * — this is where the Phase 5 deviation note below finally applies):
 * - `http` (`latte_coordination`): includes the token. Its bearer token is
 *   minted per member, and it is that difference -- not the (shared) url --
 *   that must force two coordinated members of one account onto separate
 *   processes.
 * - `stdio` (`latte_memory`): no token exists to include; `command`/`args`/
 *   `env` are identical for every member of the SAME brand (same resolved
 *   engram binary, same `--project=latte-<brandId>`), so two engram-only
 *   members of one brand+account fingerprint IDENTICALLY and share ONE
 *   process (design-v2-conversational D3's load-bearing invariant — see
 *   task 6.30, hub wiring, for the test that proves it end to end).
 *
 * The Phase 5 note that inspired this ("fingerprint = the array minus the
 * token") was written before this union existed and described exactly this
 * future stdio case; it never applied to `latte_coordination`, whose
 * isolation IS the token — stripping it there would collide two members
 * with the same url onto one process, defeating per-member isolation. See
 * sdd/autonomous-coordination/apply-progress, Phase 5, for the full history.
 */
export function mcpFingerprint(servers: AdapterMcpServer[] | undefined): string {
  if (!servers || servers.length === 0) return '';
  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  const shape = sorted.map((s) => (s.kind === 'http'
    ? { kind: s.kind, name: s.name, url: s.url, token: s.token }
    : { kind: s.kind, name: s.name, command: s.command, args: s.args, env: s.env ?? {} }));
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/**
 * Codex `-c mcp_servers.*` overrides for the app-server PROCESS -- verified
 * against the installed 0.154.0 (spike sdd/autonomous-coordination/spike-mcp-injection,
 * task 5.1). Per-*thread* overrides are a dead end on this version
 * (thread/start hangs the next turn/start, openai/codex#45361): these flags
 * belong on the process argv Latte builds in `codexAdapter.ts`'s
 * `serverFor`, never on a `thread/start` call.
 *
 * `http` (`latte_coordination`): the token itself never appears here --
 * only the env var NAME Codex should read it from (`bearer_token_env_var`);
 * the value goes on the spawned process's `env`, never on argv (visible in
 * process listings).
 *
 * `stdio` (`latte_memory`, task 6.24): `.command`, a TOML-array `.args`
 * (`JSON.stringify` produces valid TOML array syntax for a string array --
 * the exact form the Phase 5 addendum spike verified against the real
 * binary: `mcp_servers.latte_memory.args=["mcp","--tools=agent","--project=latte-probe"]`),
 * and one `.env.<KEY>=<value>` override per entry (the dotted-table form the
 * same spike verified for `ENGRAM_PROJECT`). No token exists for this kind.
 */
export function codexMcpConfigOverrides(servers: AdapterMcpServer[]): string[] {
  const args: string[] = [];
  for (const server of servers) {
    if (server.kind === 'http') {
      args.push('-c', `mcp_servers.${server.name}.url=${server.url}`);
      args.push('-c', `mcp_servers.${server.name}.bearer_token_env_var=${codexTokenEnvVar(server.name)}`);
    } else {
      args.push('-c', `mcp_servers.${server.name}.command=${server.command}`);
      args.push('-c', `mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`);
      for (const [key, value] of Object.entries(server.env ?? {})) {
        args.push('-c', `mcp_servers.${server.name}.env.${key}=${value}`);
      }
    }
  }
  return args;
}

/**
 * Env additions for the spawned app-server process itself. The coordination
 * bearer token lives ONLY here -- found by kind, not by array position, since
 * a coordinated member's `mcpServers` may carry `latte_memory` first, second
 * or not at all. `latte_memory` needs no process-level env of its own: its
 * env vars (e.g. `ENGRAM_PROJECT`) are set on the CHILD mcp server Codex
 * spawns internally, via the `.env.<KEY>` `-c` overrides above -- a
 * different env than the `codex app-server` process's own.
 */
export function codexMcpConfigEnv(servers: AdapterMcpServer[]): Record<string, string> {
  const env: Record<string, string> = {};
  // TODOS los http, no el primero: un miembro puede llevar `latte_coordination`
  // y varias Conexiones MCP a la vez, y cada una tiene su bearer. Buscar sólo
  // uno dejaba a las demás sin token y el runtime las reportaba como `failed`.
  for (const server of servers) {
    if (server.kind === 'http') env[codexTokenEnvVar(server.name)] = server.token;
  }
  return env;
}
