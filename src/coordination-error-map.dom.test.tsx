import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COORDINATION_ERROR_KEYS } from './App';
import { catalogs } from './i18n';

/**
 * Q6: EL MAPA DE ERRORES DICE LO QUE EL MOTOR TIRA, Y SÓLO ESO.
 *
 * El mapa tenía una entrada para `INVALID_ARGUMENT` —un código que sólo existe
 * en el sobre MCP, o sea en la respuesta a un AGENTE, y que no cruza la
 * frontera IPC ni una vez— y no tenía ninguna para `VALIDATION`, que es el
 * código de TODO `ValidationError` que sí la cruza. Alrededor de esa asimetría
 * faltaban diez códigos más que la persona alcanza con un clic.
 *
 * Una lista escrita a mano se desincroniza en silencio, así que este test la
 * deriva del fuente: todo `LatteError('X')` de la coordinación tiene frase
 * propia o está en una allowlist explícita, con el motivo escrito. Y al revés:
 * ninguna clave del mapa puede nombrar un código que el backend no tira.
 */

/** Los códigos que el backend PUEDE tirar por los caminos de coordinación, leídos del fuente. */
function codesFromSource(): Map<string, string[]> {
  const files = [
    'electron/coordination/budget.ts',
    'electron/coordination/dag.ts',
    'electron/coordination/engine.ts',
    'electron/coordination/injection.ts',
    'electron/coordination/limits.ts',
    'electron/coordination/mcpServer.ts',
    'electron/coordination/mcpTransport.ts',
    'electron/coordination/schemaGuard.ts',
    'electron/coordination/tokens.ts',
    'electron/coordination/tools.ts',
    'electron/services/latteService.ts',
  ];
  const found = new Map<string, string[]>();
  for (const file of files) {
    // CRLF: el repo guarda así, y una regex que asuma `\n` no encuentra nada.
    const text = readFileSync(resolve(process.cwd(), file), 'utf8').replace(/\r?\n/g, '\n');
    for (const match of text.matchAll(/LatteError\(\s*'([A-Z_]+)'/g)) {
      const code = match[1]!;
      found.set(code, [...(found.get(code) ?? []), file]);
    }
  }
  return found;
}

/**
 * Los códigos que NO necesitan frase en este mapa, cada uno con su motivo. Una
 * allowlist es una decisión, no un cajón: si un código entra acá sin que su
 * razón siga siendo cierta, la persona vuelve a leer un mensaje escrito para
 * quien lee el código.
 */
const NOT_FOR_THE_PERSON: Record<string, string> = {
  // Sólo-MCP: la respuesta va al AGENTE, dentro del sobre `{ok:false, error}`
  // de `tools.ts`. Ninguno de estos cruza IPC.
  FORBIDDEN: 'autorización del token de coordinación: se le responde al agente, nunca a una pantalla',
  // No son de coordinación: viven en los caminos de contexto de marca y tienen
  // su propia pantalla, con su propia copy.
  BRAND_ARCHIVED: 'contexto de marca, no coordinación',
  CONTEXT_EMPTY: 'contexto de marca, no coordinación',
  CONTEXT_STALE: 'contexto de marca, no coordinación',
  CONTEXT_TOO_LONG: 'contexto de marca, no coordinación',
};

describe('Q6: el mapa de errores de coordinación', () => {
  const codes = codesFromSource();

  it('la lectura del fuente encuentra códigos de verdad', () => {
    // Un test que depende de encontrar algo tiene que fallar cuando no lo encuentra.
    expect(codes.size).toBeGreaterThan(10);
    expect([...codes.keys()]).toContain('ASK_CLOSED');
    expect([...codes.keys()]).toContain('PLAN_HAS_UNAPPROVED_ROLES');
  });

  it('todo código que el backend tira tiene frase propia, o una razón escrita para no tenerla', () => {
    const uncovered = [...codes.keys()].filter((code) => !(code in COORDINATION_ERROR_KEYS) && !(code in NOT_FOR_THE_PERSON));
    expect(uncovered).toEqual([]);
  });

  it('ninguna clave del mapa nombra un código que el backend no tira', () => {
    // `VALIDATION` es la excepción declarada: no se escribe con `new LatteError`
    // sino que lo lleva `ValidationError` (`code:'VALIDATION'`), así que no
    // aparece en la lectura del fuente aunque sea el código más frecuente que
    // cruza IPC.
    const invented = Object.keys(COORDINATION_ERROR_KEYS).filter((code) => code !== 'VALIDATION' && !codes.has(code));
    expect(invented).toEqual([]);
  });

  it('`VALIDATION` es de verdad el código de `ValidationError`', async () => {
    const { ValidationError } = await import('../electron/core/errors');
    expect(new ValidationError('x').code).toBe('VALIDATION');
    expect(COORDINATION_ERROR_KEYS.VALIDATION).toBeDefined();
  });

  it('`INVALID_ARGUMENT` no está: es del sobre MCP y no cruza IPC', () => {
    expect(COORDINATION_ERROR_KEYS.INVALID_ARGUMENT).toBeUndefined();
    expect(codes.has('INVALID_ARGUMENT')).toBe(false);
  });

  it('cada frase existe en los dos idiomas, y ninguna quedó vacía', () => {
    const keys = Object.values(COORDINATION_ERROR_KEYS);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      for (const locale of ['es-AR', 'en-US'] as const) {
        const text = catalogs[locale][key];
        expect(text, `${locale} ${key}`).toBeTypeOf('string');
        expect(text.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
  });
});
