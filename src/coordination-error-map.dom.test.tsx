import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ERROR_KEYS, COORDINATION_ERROR_KEYS } from './App';
import { catalogs } from './i18n';

/**
 * TODO `electron/**\/*.ts` que no sea un test, por glob y no por lista escrita
 * a mano: una lista fija se desactualiza en silencio, que es exactamente el
 * defecto que estos tests existen para tapar.
 */
function electronSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(rel); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      if (/\.test\.ts$/.test(entry.name)) continue;
      out.push(rel);
    }
  };
  walk('electron');
  return out;
}

/** CRLF: el repo guarda así, y una regex que asuma `\n` no encuentra nada. */
const readSource = (file: string) => readFileSync(resolve(process.cwd(), file.split('/').join(sep)), 'utf8').replace(/\r?\n/g, '\n');

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
/**
 * N4 (ronda 7): EL ESCÁNER LEE TODO `electron`, NO TRES ARCHIVOS.
 *
 * La lista fija era `errors.ts` + `features.ts` + `budget.ts`, y había
 * subclases en `storage/learningRepository.ts`, `storage/backup.ts`,
 * `branding/types.ts` y `generation/errors.ts` que nadie miraba: una subclase
 * nueva en cualquier otro módulo entraba sin vigilancia y su código podía
 * llegar a una pantalla sin frase.
 *
 * Y el recorte del cuerpo era frágil: `[\s\S]{0,400}?` hasta un `\n}` en
 * columna 0 no encuentra una clase indentada, ni una con docstring largo. Se
 * lee de la declaración hasta la declaración siguiente (o el final), sin tope
 * de caracteres y sin exigir una llave en ninguna columna concreta.
 */
export interface SubclassHit { code: string; file: string; className: string }

function subclassHits(): SubclassHit[] {
  const hits: SubclassHit[] = [];
  for (const file of electronSources()) {
    const text = readSource(file);
    const declarations = [...text.matchAll(/class\s+(\w+)\s+extends\s+\w*Error\b/g)];
    for (let i = 0; i < declarations.length; i += 1) {
      const start = declarations[i]!.index!;
      const body = text.slice(start, declarations[i + 1]?.index ?? text.length);
      for (const literal of body.matchAll(/(?:super\(|readonly code\s*(?::[^=]*)?=\s*)'([A-Z][A-Z_]{2,})'/g)) {
        hits.push({ code: literal[1]!, file, className: declarations[i]![1]! });
      }
    }
  }
  return hits;
}

/**
 * Las subclases que los caminos de COORDINACIÓN pueden tirar: las que viven en
 * `core/` (genéricas de toda la app, y la coordinación es parte de la app) y
 * las de `coordination/`. Una subclase de `generation/` o de `storage/` existe
 * y se vigila —abajo, en el test de N4— pero no llega por acá.
 */
function subclassCodes(found: Map<string, string[]>): void {
  for (const hit of subclassHits()) {
    if (!hit.file.startsWith('electron/core/') && !hit.file.startsWith('electron/coordination/')) continue;
    found.set(hit.code, [...(found.get(hit.code) ?? []), hit.file]);
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
    const text = readSource(file);
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
  // N4: lo tira `backup.ts` ANTES de que exista una ventana: la app no abre
  // con una base de un esquema más nuevo, así que no hay pantalla que mostrar.
  INCOMPATIBLE_SCHEMA: 'arranque: se decide antes de que haya interfaz',
};

/** Las dos mitades juntas: lo que `displayError` puede traducir, venga de donde venga. */
const TRANSLATED = { ...COORDINATION_ERROR_KEYS, ...APP_ERROR_KEYS };

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
    const uncovered = [...codes.keys()].filter((code) => !(code in TRANSLATED) && !(code in NOT_FOR_THE_PERSON));
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
    // N2: y vive en el mapa GENÉRICO, no en el de coordinación: un nombre de
    // marca vacío es un `ValidationError` y no tiene nada que ver con equipos.
    expect(APP_ERROR_KEYS.VALIDATION).toBeDefined();
    expect(COORDINATION_ERROR_KEYS.VALIDATION).toBeUndefined();
  });

  it('`INVALID_ARGUMENT` no está: es del sobre MCP y no cruza IPC', () => {
    expect(COORDINATION_ERROR_KEYS.INVALID_ARGUMENT).toBeUndefined();
    expect(codes.has('INVALID_ARGUMENT')).toBe(false);
  });

  it('cada frase existe en los dos idiomas, y ninguna quedó vacía', () => {
    const keys = Object.values(TRANSLATED);
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

/**
 * N2: LOS DOS MAPAS SON DOS ALCANCES, Y EL FUENTE TIENE QUE DARLES LA RAZÓN.
 *
 * `displayError` sirve a toda la app. Un código con frase de coordinación sólo
 * puede estar en el mapa de coordinación si NADIE fuera de la coordinación lo
 * tira; y un código en el mapa genérico tiene que ser genérico de verdad, o
 * sea vivir en `core/` o ser tirado desde más de un módulo. Las dos
 * condiciones se leen del fuente, no de una lista.
 */
describe('N2: cada mapa cubre su alcance, verificado contra `electron/**`', () => {
  /** Módulo = la carpeta de primer nivel bajo `electron/` (`core`, `coordination`, `branding`, …). */
  const moduleOf = (file: string) => file.split('/')[1]!;

  /**
   * Dónde se tira cada código, mirando TODO `electron`: el literal de
   * `LatteError('X'` y, para las subclases, cada `new XxxError(` más el
   * archivo donde la clase se declara.
   */
  interface Site { code: string; file: string; context: string }

  /**
   * El nombre de la función o el método que ENCIERRA una posición. Es el
   * contexto que decide si un `LatteError` de un archivo compartido
   * (`storage/repository.ts`, `services/validation.ts`) pertenece igual al
   * motor: `answerCoordinationAsk` y `assertCoordinationProposal` lo dicen en
   * su nombre. Leer 400 caracteres para atrás no alcanzaba — un docstring
   * largo tapaba la firma.
   */
  function enclosingName(text: string, index: number): string {
    const declarations = [
      ...text.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g),
      ...text.matchAll(/^\s{2}(?:(?:public|private|protected|readonly|static|async|get|set)\s+)*(\w+)\s*(?:<[^>\n]*>)?\s*\(/gm),
    ].sort((a, b) => a.index! - b.index!)
      // `if (`, `for (`, `while (`, `return (`… también entran por la segunda
      // regex, y un `if` a dos espacios adentro de una función pisaba el nombre
      // de la función. No son declaraciones de nada.
      .filter((m) => !/^(if|for|while|switch|catch|return|throw|do|else|super|await|typeof|void|new|const|let|var)$/.test(m[1]!));
    let name = '';
    for (const declaration of declarations) {
      if (declaration.index! > index) break;
      name = declaration[1]!;
    }
    return name;
  }

  function throwSites(): Site[] {
    const byClass = new Map<string, { code: string; file: string }>();
    for (const hit of subclassHits()) byClass.set(hit.className, { code: hit.code, file: hit.file });
    const found: Site[] = [];
    // La declaración de una subclase cuenta: ahí vive el código.
    for (const { code, file } of byClass.values()) found.push({ code, file, context: '' });
    for (const file of electronSources()) {
      const text = readSource(file);
      for (const match of text.matchAll(/LatteError\(/g)) {
        const head = text.slice(match.index + match[0].length, match.index + match[0].length + 160);
        // El CONTEXTO es lo de antes: el nombre del método que lo tira. Un
        // `ASK_CLOSED` adentro de `answerCoordinationAsk` sigue siendo del
        // motor aunque la fila viva en el repositorio compartido.
        const context = enclosingName(text, match.index);
        for (const literal of head.matchAll(/'([A-Z][A-Z_]{2,})'/g)) found.push({ code: literal[1]!, file, context });
      }
      for (const [className, { code }] of byClass) {
        for (const match of text.matchAll(new RegExp(`new\\s+${className}\\s*\\(`, 'g'))) {
          found.push({ code, file, context: enclosingName(text, match.index) });
        }
      }
      // `requireFeature(...)` es un `throw new FeatureDisabledError` disfrazado:
      // es el camino por el que CUATRO features tiran el mismo código, y es
      // justamente el hecho que N2 vino a arreglar.
      for (const match of text.matchAll(/requireFeature\s*\(/g)) {
        found.push({ code: 'FEATURE_DISABLED', file, context: enclosingName(text, match.index) });
      }
    }
    return found;
  }

  const allSites = throwSites();
  const filesOf = (code: string) => [...new Set(allSites.filter((s) => s.code === code).map((s) => s.file))];
  const sites = new Map<string, string[]>(
    [...new Set(allSites.map((s) => s.code))].map((code) => [code, filesOf(code)]),
  );

  it('la lectura encuentra sitios de verdad', () => {
    expect(sites.size).toBeGreaterThan(15);
    expect([...(sites.get('FEATURE_DISABLED') ?? [])].length).toBeGreaterThan(2);
  });

  it('ningún código del mapa de COORDINACIÓN se tira fuera de la coordinación', () => {
    // El alcance: el motor entero, los métodos de coordinación de
    // `latteService`, y —por contexto, no por archivo— los métodos
    // `…Coordination…` del repositorio compartido, que es donde viven las
    // tablas del motor.
    const allowed = (site: Site) =>
      site.file.startsWith('electron/coordination/')
      || site.file === 'electron/services/latteService.ts'
      || /Coordination/.test(site.context);
    const codes = Object.keys(COORDINATION_ERROR_KEYS);
    expect(codes.length).toBeGreaterThan(10);
    const leaked = allSites
      .filter((s) => s.code in COORDINATION_ERROR_KEYS && !allowed(s))
      .map((s) => `${s.code} @ ${s.file}`);
    // Si esto falla, el código dejó de ser exclusivo del motor y su frase —que
    // habla de equipos y tareas— ya le está mintiendo a alguien.
    expect(leaked).toEqual([]);
  });

  it('cada código del mapa GENÉRICO lo es de verdad: vive en `core/` o lo tira más de un módulo', () => {
    const codes = Object.keys(APP_ERROR_KEYS);
    expect(codes.length).toBeGreaterThan(3);
    for (const code of codes) {
      const files = [...(sites.get(code) ?? [])];
      expect(files.length, `${code} no se tira en ningún lado`).toBeGreaterThan(0);
      const inCore = files.some((f) => f.startsWith('electron/core/'));
      const modules = new Set(files.map(moduleOf));
      expect(inCore || modules.size > 1, `${code} sólo lo tira ${[...modules].join(', ')}`).toBe(true);
    }
  });

  it('`FEATURE_DISABLED` lo tiran cuatro features, que es el hecho entero de N2', () => {
    const files = [...(sites.get('FEATURE_DISABLED') ?? [])];
    for (const file of ['electron/branding/service.ts', 'electron/learning/service.ts', 'electron/services/latteService.ts']) {
      expect(files, file).toContain(file);
    }
  });

  it('ningún código está en los dos mapas a la vez', () => {
    const both = Object.keys(COORDINATION_ERROR_KEYS).filter((code) => code in APP_ERROR_KEYS);
    expect(both).toEqual([]);
  });
});

/**
 * N3: NINGUNA FRASE PROMETE UN CONTROL QUE NO EXISTE.
 *
 * No hay interruptor de features en ninguna pantalla: los flags se escriben en
 * `meta`. "Prendela en Ajustes" mandaba a la persona a buscar algo que no está.
 */
describe('N3: la copy no manda a Ajustes', () => {
  it('ninguna clave de error ni de coordinación nombra Ajustes o Settings', () => {
    for (const locale of ['es-AR', 'en-US'] as const) {
      const keys = Object.keys(catalogs[locale]).filter((k) => k.startsWith('error.coordination.') || k.startsWith('error.app.') || k.startsWith('coordination.'));
      expect(keys.length, locale).toBeGreaterThan(20);
      for (const key of keys) {
        const text = catalogs[locale][key as keyof typeof catalogs['es-AR']];
        // `noSettingsNote` es la excepción declarada: dice justamente que NO
        // hay ningún formulario de configuración, así que nombrarlo es negarlo.
        if (key.endsWith('noSettingsNote')) continue;
        expect(text, `${locale} ${key}`).not.toMatch(/\bAjustes\b|\bSettings\b/);
      }
    }
  });
});

/**
 * N4: EL ESCÁNER DE SUBCLASES MUERDE EN TODO `electron`.
 */
describe('N4: el escáner de subclases lee todo `electron`', () => {
  const hits = subclassHits();
  const files = new Set(hits.map((h) => h.file));

  it('encuentra subclases de verdad, y en más módulos que los tres de la lista vieja', () => {
    expect(hits.length).toBeGreaterThanOrEqual(7);
    for (const file of ['electron/core/errors.ts', 'electron/core/features.ts', 'electron/coordination/budget.ts', 'electron/storage/backup.ts']) {
      expect([...files], file).toContain(file);
    }
    // Y las clases, por nombre: si alguna cambia de forma, el escáner deja de
    // verla y este test lo dice en vez de quedarse verde sin mirar nada.
    const names = new Set(hits.map((h) => h.className));
    for (const name of ['ValidationError', 'NotFoundError', 'UnavailableError', 'ConflictError', 'FeatureDisabledError', 'BudgetUnsetError', 'IncompatibleSchemaError']) {
      expect([...names], name).toContain(name);
    }
  });

  it('el barrido mira más archivos que la lista fija que reemplazó', () => {
    expect(electronSources().length).toBeGreaterThan(50);
    expect(electronSources().some((f) => f === 'electron/coordination/injection.ts')).toBe(true);
  });

  it('todo código de subclase, de cualquier módulo, tiene frase o una razón escrita', () => {
    const uncovered = [...new Set(hits.map((h) => h.code))].filter((code) => !(code in TRANSLATED) && !(code in NOT_FOR_THE_PERSON));
    expect(uncovered).toEqual([]);
  });
});
