import { createHash } from 'node:crypto';
import type { AdapterMcpServer } from '../types';

/** Codex reads the token only from this env var name; Phase 5 has exactly one http server type (`latte_coordination`), so one fixed name is enough. A second per-member-token server type would need its own. */
export const CODEX_COORD_TOKEN_ENV = 'LATTE_COORD_TOKEN';

/**
 * Identifies whether two `AdapterMcpServer[]` describe the SAME Codex
 * `app-server` process. Empty/absent input -> `''`, so every ordinary,
 * non-coordinated chat keeps sharing one process per account, exactly as
 * before this change.
 *
 * Deliberately includes each server's token: `latte_coordination`'s bearer
 * token is minted per member, and it is that difference -- not the
 * (shared) url -- that must force two coordinated members of one account
 * onto separate processes. The design note that inspired this ("fingerprint
 * = the array minus the token") describes a FUTURE server type with no
 * per-member token at all (Phase 6's engram entry, which fingerprints
 * identically across members of a brand because it carries nothing that
 * varies) -- it does not apply to `latte_coordination`, whose isolation IS
 * the token. Stripping it here would collide two members with the same url
 * onto one process, defeating per-member isolation. See
 * sdd/autonomous-coordination/apply-progress, Phase 5, for the full note.
 */
export function mcpFingerprint(servers: AdapterMcpServer[] | undefined): string {
  if (!servers || servers.length === 0) return '';
  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  const shape = sorted.map((s) => ({ name: s.name, url: s.url, token: s.token }));
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/**
 * Codex `-c mcp_servers.*` overrides for the app-server PROCESS -- verified
 * against the installed 0.154.0 (spike sdd/autonomous-coordination/spike-mcp-injection).
 * Per-*thread* overrides are a dead end on this version (thread/start hangs
 * the next turn/start, openai/codex#45361): these flags belong on the
 * process argv Latte builds in `codexAdapter.ts`'s `serverFor`, never on a
 * `thread/start` call. The token itself never appears here -- only the env
 * var NAME Codex should read it from; the value goes on the spawned
 * process's `env`, never on argv (visible in process listings).
 */
export function codexMcpConfigOverrides(servers: AdapterMcpServer[]): string[] {
  const args: string[] = [];
  for (const server of servers) {
    args.push('-c', `mcp_servers.${server.name}.url=${server.url}`);
    args.push('-c', `mcp_servers.${server.name}.bearer_token_env_var=${CODEX_COORD_TOKEN_ENV}`);
  }
  return args;
}

/** Env additions for the spawned app-server process; the token lives only here. */
export function codexMcpConfigEnv(servers: AdapterMcpServer[]): Record<string, string> {
  const first = servers[0];
  return first ? { [CODEX_COORD_TOKEN_ENV]: first.token } : {};
}
