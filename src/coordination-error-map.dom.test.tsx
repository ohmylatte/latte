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

/**
 * O2: LOS CÓDIGOS DE LAS SUBCLASES TAMBIÉN EXISTEN.
 *
 * El escáner sólo miraba `LatteError(`, así que toda subclase era INVISIBLE:
 * `FeatureDisabledError` (`FEATURE_DISABLED`), `BudgetUnsetError`
 * (`BUDGET_UNSET`), `NotFoundError`, `UnavailableError`, `ConflictError`. El
 * primero se alcanza con UN clic —aprobar una propuesta con el flag apagado—
 * y no tenía frase: la persona leía el mensaje de log en castellano fijo que
 * `features.ts` escribe para quien lee el código.
 *
 * Una clase que extiende un Error y fija su código con `super('CODE'` o con
 * `readonly code = 'CODE'` es exactamente la misma promesa que un
 * `new LatteError('CODE')`: un código que puede llegar a una pantalla.
 */
const SUBCLASS_FILES = [
  'electron/core/errors.ts',
  'electron/core/features.ts',
  'electron/coordination/budget.ts',
];

function subclassCodes(found: Map<string, string[]>): void {
  for (const file of SUBCLASS_FILES) {
    const text = readFileSync(resolve(process.cwd(), file), 'utf8').replace(/\r?\n/g, '\n');
    for (const match of text.matchAll(/class\s+\w+\s+extends\s+\w*Error\b([\s\S]{0,400}?)(?=\n})/g)) {
      const body = match[1]!;
      for (const literal of body.matchAll(/(?:super\(|readonly code\s*(?::[^=]*)?=\s*)'([A-Z][A-Z_]{2,})'/g)) {
        const code = literal[1]!;
        found.set(code, [...(found.get(code) ?? []), file]);
      }
    }
  }
}

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
    // El primer argumento de `LatteError` no siempre es un literal: hay al
    // menos un ternario (`decision.reason === 'task_cap' ? 'TASK_CAP' :
    // 'DEPTH_CAP'`). Una regex que sólo mirara el literal pegado al paréntesis
    // habría dejado esos dos códigos afuera sin que nada lo dijera, que es
    // justo el agujero que este test existe para tapar. Se leen los primeros
    // 160 caracteres después del paréntesis y se toman TODOS los literales en
    // mayúsculas: los mensajes son prosa en minúsculas, así que no hay ruido.
    for (const match of text.matchAll(/LatteError\(/g)) {
      const head = text.slice(match.index + match[0].length, match.index + match[0].length + 160);
      for (const literal of head.matchAll(/'([A-Z][A-Z_]{2,})'/g)) {
        const code = literal[1]!;
        found.set(code, [...(found.get(code) ?? []), file]);
      }
    }
  }
  subclassCodes(found);
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

  it('O2: y encuentra también los de las SUBCLASES, que no se escriben con `new LatteError`', () => {
    // Los cinco que el escáner viejo no veía. Si alguno deja de aparecer acá,
    // es que su clase cambió de forma y el mapa se quedó sin vigilancia.
    for (const code of ['FEATURE_DISABLED', 'BUDGET_UNSET', 'VALIDATION', 'NOT_FOUND', 'UNAVAILABLE', 'CONFLICT']) {
      expect([...codes.keys()], code).toContain(code);
    }
  });

  it('todo código que el backend tira tiene frase propia, o una razón escrita para no tenerla', () => {
    const uncovered = [...codes.keys()].filter((code) => !(code in COORDINATION_ERROR_KEYS) && !(code in NOT_FOR_THE_PERSON));
    expect(uncovered).toEqual([]);
  });

  it('ninguna clave del mapa nombra un código que el backend no tira', () => {
    // Sin excepciones declaradas: `VALIDATION` era una, porque no se escribe
    // con `new LatteError` sino que lo lleva `ValidationError`. Desde O2 el
    // escáner lee también las subclases, así que ya no hay ningún código del
    // mapa que la lectura del fuente no pueda encontrar por sí sola.
    const invented = Object.keys(COORDINATION_ERROR_KEYS).filter((code) => !codes.has(code));
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
