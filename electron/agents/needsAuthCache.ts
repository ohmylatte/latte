/**
 * La caché de "necesita autenticación" de Claude Code, y por qué Latte la toca.
 *
 * Medido en 1.4 del brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`: en
 * `<CLAUDE_CONFIG_DIR>/mcp-needs-auth-cache.json` hay una entrada por NOMBRE de
 * servidor —no por URL— y, mientras está fresca, el CLI **cortocircuita la
 * conexión**: marca `needs-auth` sin abrir el socket. Verificado: con la
 * entrada presente, cero requests; vaciándola, sale.
 *
 * El efecto para una persona es que reintentar con el mismo nombre no sirve
 * nunca, y que la pantalla de Herramientas dice "necesita autenticación" para
 * siempre aunque no haya nada que autenticar. En la máquina de Gabriel hay tres
 * entradas —`the-agentcy`, `Theagentcy`, `The-agentcy`— que son el rastro de
 * haber probado tres veces.
 *
 * Latte borra la entrada de un nombre cuando ese servidor pasa a ser una
 * Conexión suya: a partir de ahí el login lo hace el gateway, y dejar la
 * mentira en la caché sólo sirve para que la pantalla siga asustando.
 *
 * Todo best-effort: si el archivo no existe, no se puede leer o no es JSON, no
 * pasa nada. No es una fuente de verdad de Latte, es la caché de otro programa.
 */
import fs from 'node:fs';
import path from 'node:path';

export const NEEDS_AUTH_CACHE_FILE = 'mcp-needs-auth-cache.json';

/** Compara como lo haría una persona: sin mayúsculas y sin guiones, que es exactamente en qué se diferencian las tres entradas medidas. */
function loose(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Saca del objeto de la caché toda entrada cuyo nombre coincida —de forma
 * laxa— con alguno de estos. Devuelve el objeto nuevo y qué claves salieron;
 * pura, para poder probarla sin tocar un disco.
 */
export function withoutNeedsAuthEntries(cache: Record<string, unknown>, names: string[]): { next: Record<string, unknown>; removed: string[] } {
  const targets = new Set(names.map(loose).filter((n) => n.length > 0));
  const next: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(cache)) {
    if (targets.has(loose(key))) removed.push(key);
    else next[key] = value;
  }
  return { next, removed };
}

/**
 * Lo mismo, sobre el archivo de un perfil de Claude Code. `configDir` es el
 * `CLAUDE_CONFIG_DIR` de la cuenta que interesa: un perfil gestionado tiene el
 * suyo, y borrar en el equivocado no arregla nada (es el mismo error de perfil
 * que 1.5).
 */
export function clearNeedsAuthEntries(configDir: string, names: string[], log?: (line: string) => void): string[] {
  const file = path.join(configDir, NEEDS_AUTH_CACHE_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const { next, removed } = withoutNeedsAuthEntries(parsed as Record<string, unknown>, names);
  if (removed.length === 0) return [];
  try {
    fs.writeFileSync(file, JSON.stringify(next), 'utf8');
  } catch (error) {
    log?.(`[conexiones] no se pudo limpiar la caché de needs-auth: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  log?.(`[conexiones] caché de needs-auth limpiada: ${removed.join(', ')}`);
  return removed;
}
