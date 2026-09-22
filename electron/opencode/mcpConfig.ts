/**
 * La inyección MCP de OpenCode: `OPENCODE_CONFIG_CONTENT`, el config inline que
 * el servidor lee de su propio entorno al arrancar.
 *
 * **Y por qué OpenCode todavía no recibe nada, dicho con todas las letras.**
 *
 * La tabla de la sección 2 del brief
 * (`docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`) dice que OpenCode
 * acepta config por invocación con esta variable y headers con `{env:VAR}`, y
 * es verdad. Lo que no cambia es la forma en que Latte lo corre: **un solo
 * servidor de OpenCode para todos los miembros** (`chatManager.ts`,
 * `ensureClient`). `OPENCODE_CONFIG_CONTENT` es del PROCESO, así que el config
 * que se le escriba vale para todos los miembros a la vez — y el modelo entero
 * de este diseño es que el bearer sea POR MIEMBRO, porque es en el bearer donde
 * vive el alcance (4.3). Un bearer compartido entre miembros de marcas
 * distintas rompe exactamente lo que el gateway vino a arreglar.
 *
 * Por eso esta función existe, está probada y es correcta, pero `ChatManager`
 * sigue declarando `mcpInjection = 'none'`: la pieza que falta no es esta
 * traducción sino **un servidor de OpenCode por miembro**, que es una decisión
 * de arquitectura con costo de procesos y no entra en este alcance. La
 * coordinación ya modela esta misma limitación con su razón
 * `opencode_shared_server`; ésta es la misma, en otro lugar.
 *
 * El día que haya un servidor por miembro, lo único que hace falta es pasarle a
 * `OpenCodeServer` el `env` que devuelve `opencodeMcpEnv`.
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
