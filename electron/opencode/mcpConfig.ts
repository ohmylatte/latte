/**
 * La inyección MCP de OpenCode: `OPENCODE_CONFIG_CONTENT`, el config inline que
 * el servidor lee de su propio entorno al arrancar.
 *
 * `OPENCODE_CONFIG_CONTENT` es del PROCESO, y el alcance de cada servidor MCP
 * vive en su bearer, que es POR MIEMBRO (brief de conexiones, 4.3). Por eso
 * Latte corre **un `opencode serve` por miembro** (`chatManager.ts`): el env
 * que devuelve `opencodeMcpEnv` va al proceso de ese miembro y de ningún otro.
 *
 * Verificado contra opencode 1.18.32 (`opencode serve --pure` con un servidor
 * MCP http de prueba): el config inline se aplica, `{env:VAR}` se resuelve y el
 * servidor recibe `Authorization: Bearer <token>` desde el `initialize`; y
 * `GET /mcp` devuelve el estado de cada servidor de ESE proceso, que es con lo
 * que `ChatManager` confirma la inyección.
 *
 * Una advertencia que no se arregla desde acá: `GET /config` de ese mismo
 * proceso devuelve el config RESUELTO, con el bearer adentro. Está detrás del
 * Basic auth del proceso (credenciales al azar por proceso, sólo loopback), así
 * que lo ve quien ya puede hablar con ese miembro; no está en el JSON del env,
 * ni en argv, ni en ningún log de Latte.
 */
import type { AdapterMcpServer } from '../agents/types';

/** El nombre de la variable de la que OpenCode lee el bearer de un servidor, con la misma regla que Codex. */
export function opencodeTokenEnvVar(serverName: string): string {
  return `LATTE_MCP_TOKEN_${serverName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * El JSON de `OPENCODE_CONFIG_CONTENT`. Los bearers NO van adentro: van por
 * `{env:VAR}`, que es la forma documentada de OpenCode y la única que mantiene
 * el secreto fuera de un valor de entorno que después se lee entero en un
 * volcado de config. El token real viaja en el `env` del proceso.
 */
export function opencodeMcpConfigContent(servers: AdapterMcpServer[]): string {
  const mcp: Record<string, unknown> = {};
  for (const server of servers) {
    mcp[server.name] = server.kind === 'http'
      ? {
        type: 'remote',
        url: server.url,
        enabled: true,
        headers: { Authorization: `Bearer {env:${opencodeTokenEnvVar(server.name)}}` },
      }
      : {
        type: 'local',
        command: [server.command, ...server.args],
        enabled: true,
        ...(server.env ? { environment: server.env } : {}),
      };
  }
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp });
}

/** El entorno del proceso de OpenCode: el config inline más un bearer por servidor http. Nunca en argv. */
export function opencodeMcpEnv(servers: AdapterMcpServer[]): Record<string, string> {
  if (servers.length === 0) return {};
  const env: Record<string, string> = { OPENCODE_CONFIG_CONTENT: opencodeMcpConfigContent(servers) };
  for (const server of servers) {
    if (server.kind === 'http') env[opencodeTokenEnvVar(server.name)] = server.token;
  }
  return env;
}
