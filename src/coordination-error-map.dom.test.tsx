import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ERROR_KEYS, BRAND_ERROR_KEYS, COORDINATION_ERROR_KEYS } from './App';
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

/**
 * EL ALCANCE DE LA COORDINACIÓN, en una sola definición.
 *
 * L9 (ronda 9): el motor entero, más —POR CONTEXTO, no por archivo— toda
 * función cuyo nombre diga `Coordination`, esté donde esté. Es exactamente el
 * criterio que el test de N2 ya usaba para decidir si un código se le escapó
 * al mapa; `codesFromSource` usaba en cambio una LISTA FIJA de once archivos,
 * y esa lista dejaba afuera `services/validation.ts` y `storage/repository.ts`,
 * donde viven `assertCoordinationProposal` y `answerCoordinationAsk`. Dos
 * criterios distintos para la misma pregunta es cómo uno de los dos se
 * desactualiza en silencio.
 */
export const inCoordinationScope = (file: string, context: string): boolean =>
  file.startsWith('electron/coordination/') || /Coordination/.test(context);

/** Los códigos que el backend PUEDE tirar por los caminos de coordinación, leídos del fuente. */
function codesFromSource(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of electronSources()) {
    const text = readSource(file);
    // El primer argumento de `LatteError` no siempre es un literal: hay al
    // menos un ternario (`decision.reason === 'task_cap' ? 'TASK_CAP' :
    // 'DEPTH_CAP'`). Una regex que sólo mirara el literal pegado al paréntesis
    // habría dejado esos dos códigos afuera sin que nada lo dijera, que es
    // justo el agujero que este test existe para tapar. Se leen los primeros
    // 160 caracteres después del paréntesis y se toman TODOS los literales en
    // mayúsculas: los mensajes son prosa en minúsculas, así que no hay ruido.
    for (const match of text.matchAll(/LatteError\(/g)) {
      if (!inCoordinationScope(file, enclosingNameOf(text, match.index))) continue;
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
  // L5 (ronda 9): `BRAND_ARCHIVED`, `CONTEXT_EMPTY` y `CONTEXT_TOO_LONG`
  // SALIERON DE ACÁ. Su razón decía "contexto de marca, no coordinación", que
  // explica por qué no van en el mapa de COORDINACIÓN y se leía como si
  // explicara por qué no necesitan frase. Son dos cosas distintas: los tres
  // salen del mismo "Aprobar" que la persona aprieta, y ahora tienen copy
  // propia en `BRAND_ERROR_KEYS`.
  CONTEXT_STALE: 'contexto de marca: lo tira el editor de contexto, que muestra su propio conflicto',
  // N4: lo tira `backup.ts` ANTES de que exista una ventana: la app no abre
  // con una base de un esquema más nuevo, así que no hay pantalla que mostrar.
  INCOMPATIBLE_SCHEMA: 'arranque: se decide antes de que haya interfaz',
};

/** Las tres mitades juntas: lo que `displayError` puede traducir, venga de donde venga. */
const TRANSLATED = { ...COORDINATION_ERROR_KEYS, ...BRAND_ERROR_KEYS, ...APP_ERROR_KEYS };

/**
 * El nombre de la función o el método que ENCIERRA una posición. Es el
 * contexto que decide si un `LatteError` de un archivo compartido
 * (`storage/repository.ts`, `services/validation.ts`, `services/latteService.ts`)
 * pertenece igual al motor: `answerCoordinationAsk` y
 * `assertCoordinationProposal` lo dicen en su nombre.
 *
 * M8 (ronda 8): ACOTADO AL RANGO DE LA DECLARACIÓN. Antes atribuía por "la
 * última declaración que empieza antes del índice", así que un `throw` a nivel
 * de módulo —o dentro de un objeto literal, o después de la última función del
 * archivo— HEREDABA el nombre de la función anterior. Un código a nivel de
 * módulo podía colarse por la excepción `/Coordination/` sin estar en ninguna
 * función de coordinación. Ahora la declaración sólo cuenta si el índice cae
 * DENTRO de su cuerpo, que se cierra en la primera línea con una llave a su
 * misma indentación.
 */
/**
 * L8 (ronda 9): LA INDENTACIÓN SE CAPTURA, NO SE DEDUCE DEL ÍNDICE.
 *
 * La regex de métodos empieza en `^`, o sea que su `index` ES el principio de
 * la línea. `declarationEnd` calculaba la indentación como "lo que hay entre
 * el principio de la línea y `start`" — que para un método era la cadena
 * VACÍA—, así que buscaba un `}` en columna cero y el rango de todo método
 * llegaba hasta el cierre de la CLASE. Un `throw` que no está dentro de ningún
 * método —un inicializador de propiedad, por ejemplo— heredaba el nombre del
 * último método declarado antes. Ahora la indentación viaja con la
 * declaración.
 */
interface Declaration { index: number; name: string; indent: string }

/** La indentación de la línea donde empieza `index`. */
function indentAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, index))![0];
}

function declarationsIn(text: string): Declaration[] {
  const out: Declaration[] = [];
  for (const m of text.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)) {
    out.push({ index: m.index!, name: m[1]!, indent: indentAt(text, m.index!) });
  }
  for (const m of text.matchAll(/^([ \t]{2})(?:(?:public|private|protected|readonly|static|async|get|set)\s+)*(\w+)\s*(?:<[^>\n]*>)?\s*\(/gm)) {
    out.push({ index: m.index!, name: m[2]!, indent: m[1]! });
  }
  return out
    // `if (`, `for (`, `while (`, `return (`… también entran por la segunda
    // regex, y un `if` a dos espacios adentro de una función pisaba el nombre
    // de la función. No son declaraciones de nada.
    .filter((d) => !/^(if|for|while|switch|catch|return|throw|do|else|super|await|typeof|void|new|const|let|var)$/.test(d.name))
    .sort((a, b) => a.index - b.index);
}

export function enclosingNameOf(text: string, index: number): string {
  let name = '';
  for (const declaration of declarationsIn(text)) {
    if (declaration.index > index) break;
    if (index <= declarationEnd(text, declaration.index, declaration.indent)) name = declaration.name;
  }
  return name;
}

/**
 * Dónde termina la declaración que empieza en `start`: la primera línea
 * posterior que cierra con una llave a su MISMA indentación. Una función de
 * nivel superior cierra con `}` en columna cero; un método de clase, con `  }`.
 */
function declarationEnd(text: string, start: number, indent: string): number {
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const closer = new RegExp(`^${indent}[}]`, 'm');
  const match = closer.exec(text.slice(lineStart));
  return match ? lineStart + match.index + match[0].length : text.length;
}

describe('Q6: el mapa de errores de coordinación', () => {
  const codes = codesFromSource();

  it('la lectura del fuente encuentra códigos de verdad', () => {
    // Un test que depende de encontrar algo tiene que fallar cuando no lo encuentra.
    expect(codes.size).toBeGreaterThan(10);
    expect([...codes.keys()]).toContain('ASK_CLOSED');
    expect([...codes.keys()]).toContain('PLAN_HAS_UNAPPROVED_ROLES');
  });

  /**
   * L9 (ronda 9): Y MUERDE EN LOS ARCHIVOS QUE LA LISTA FIJA DEJABA AFUERA.
   *
   * `services/validation.ts` y `storage/repository.ts` no estaban en los once
   * archivos escritos a mano, y ahí viven `assertCoordinationProposal`
   * (`TASK_CAP`, `DEPTH_CAP`) y `answerCoordinationAsk` (`ASK_CLOSED`) — que el
   * test de alcance de N2 reconoce como portadores legítimos por CONTEXTO. Dos
   * criterios para la misma pregunta; ahora es uno.
   */
  it('L9: el alcance se deriva, así que alcanza a los archivos compartidos', () => {
    for (const [code, file] of [
      ['TASK_CAP', 'electron/services/validation.ts'],
      ['DEPTH_CAP', 'electron/services/validation.ts'],
      ['ASK_CLOSED', 'electron/storage/repository.ts'],
    ] as const) {
      expect(codes.get(code) ?? [], `${code} @ ${file}`).toContain(file);
    }
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
  const enclosingName = enclosingNameOf;

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
    // El alcance: el motor entero y —por contexto, no por archivo— toda
    // función cuyo nombre diga `Coordination`, esté donde esté (el repositorio
    // compartido, `services/validation.ts`, `latteService.ts`).
    //
    // M2 (ronda 8): `latteService.ts` YA NO ESTÁ EXENTO COMO ARCHIVO. Esa
    // línea eximía un archivo de 3.000 líneas en el que vive medio backend, y
    // tapaba tres fugas reales: `approveBrandContextProposal` y
    // `requestBrandContextDraft` —contexto de MARCA, no coordinación— tiraban
    // códigos del mapa de coordinación y la persona leía copy de equipos al
    // aprobar una propuesta de marca. Un archivo no es un alcance; una función
    // sí.
    //
    // L9 (ronda 9): y el criterio es UNO SOLO, compartido con
    // `codesFromSource` (`inCoordinationScope`), que hasta ahora usaba una
    // lista fija de archivos para responder esta misma pregunta.
    const allowed = (site: Site) => inCoordinationScope(site.file, site.context);
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

  it('ningún código está en dos mapas a la vez', () => {
    const both = Object.keys(COORDINATION_ERROR_KEYS).filter((code) => code in APP_ERROR_KEYS || code in BRAND_ERROR_KEYS);
    expect(both).toEqual([]);
    expect(Object.keys(BRAND_ERROR_KEYS).filter((code) => code in APP_ERROR_KEYS)).toEqual([]);
  });

  /**
   * M2(b): los tres códigos que el contexto de MARCA tiraba prestados del
   * mapa de coordinación tienen los suyos, y su copy habla de marca.
   */
  it('los errores de marca tienen código propio, se tiran de verdad, y NINGUNO sale de la coordinación', () => {
    const brandCodes = Object.keys(BRAND_ERROR_KEYS);
    expect(brandCodes).toEqual(expect.arrayContaining([
      'BRAND_PROPOSAL_STALE', 'BRAND_PROPOSAL_DECIDED', 'STRATEGIST_BUSY',
      // L5 (ronda 9): los tres que llegaban sin frase desde el mismo "Aprobar".
      'CONTEXT_TOO_LONG', 'CONTEXT_EMPTY', 'BRAND_ARCHIVED',
    ]));
    for (const code of brandCodes) {
      const where = allSites.filter((s) => s.code === code);
      expect(where.length, `${code} no se tira en ningún lado`).toBeGreaterThan(0);
      for (const site of where) {
        // El alcance se mide por lo que NO es: la copy de estos códigos habla
        // de marcas y de contexto, así que ninguno puede salir de un camino de
        // coordinación. `BRAND_ARCHIVED` lo tiran `requireActiveBrand` y
        // `prepareGeneration` —dos caminos de marca que no son el de contexto—,
        // así que exigir `BrandContext` en el nombre era un criterio prestado
        // de los tres primeros, no el de este mapa.
        expect(inCoordinationScope(site.file, site.context), `${code} @ ${site.file}#${site.context}`).toBe(false);
      }
    }
  });

  /**
   * M2(c): el motor de coordinación NO tira `PROPOSAL_STALE` ni
   * `PROPOSAL_DECIDED` — eran códigos del contexto de marca desde el principio
   * —, así que salieron del mapa de coordinación en vez de quedarse como una
   * frase que nadie alcanza.
   */
  it('`PROPOSAL_STALE` y `PROPOSAL_DECIDED` ya no existen en ningún lado', () => {
    expect(COORDINATION_ERROR_KEYS.PROPOSAL_STALE).toBeUndefined();
    expect(COORDINATION_ERROR_KEYS.PROPOSAL_DECIDED).toBeUndefined();
    expect(allSites.filter((s) => s.code === 'PROPOSAL_STALE' || s.code === 'PROPOSAL_DECIDED')).toEqual([]);
  });

  /** `MEMBER_BUSY` se queda: lo tira el motor de verdad, en `reserveTargetMember`. */
  it('`MEMBER_BUSY` sigue siendo de coordinación, y sólo del motor', () => {
    expect(COORDINATION_ERROR_KEYS.MEMBER_BUSY).toBeDefined();
    const files = [...new Set(allSites.filter((s) => s.code === 'MEMBER_BUSY').map((s) => s.file))];
    expect(files).toEqual(['electron/coordination/engine.ts']);
  });
});

/**
 * M8: EL CONTEXTO SE ATRIBUYE POR RANGO, NO POR "LA ÚLTIMA DECLARACIÓN ANTES".
 */
describe('M8: `enclosingName` no le presta su nombre a lo que está afuera', () => {
  const source = [
    'function unaFuncion() {',
    "  throw new LatteError('ADENTRO', 'x');",
    '}',
    '',
    "export const suelto = new LatteError('AFUERA', 'y');",
    '',
    'class Algo {',
    '  unCoordinationMetodo() {',
    "    throw new LatteError('EN_EL_METODO', 'z');",
    '  }',
    '',
    '  otroMetodo() {',
    "    throw new LatteError('EN_EL_OTRO_METODO', 'v');",
    '  }',
    '',
    "  readonly campo = new LatteError('ENTRE_LLAVES_PERO_EN_NINGUN_METODO', 'u');",
    '}',
    '',
    "const despues = new LatteError('DESPUES_DEL_METODO', 'w');",
  ].join('\n');

  it('un throw DENTRO de una función lleva su nombre', () => {
    expect(enclosingNameOf(source, source.indexOf("'ADENTRO'"))).toBe('unaFuncion');
    expect(enclosingNameOf(source, source.indexOf("'EN_EL_METODO'"))).toBe('unCoordinationMetodo');
  });

  it('un throw a nivel de MÓDULO no hereda el nombre de la función anterior', () => {
    expect(enclosingNameOf(source, source.indexOf("'AFUERA'"))).toBe('');
    expect(enclosingNameOf(source, source.indexOf("'DESPUES_DEL_METODO'"))).toBe('');
  });

  /**
   * L8: cada MÉTODO termina en su propio `  }`, no en el de la clase.
   *
   * Con la indentación deducida del índice —vacía, porque la regex de métodos
   * ancla en `^`— el rango de `unCoordinationMetodo` llegaba hasta el cierre
   * de la CLASE, así que todo lo que hubiera entre métodos, o después del
   * último, quedaba adentro de él.
   */
  it('cada método termina donde termina el método, no donde termina la clase', () => {
    expect(enclosingNameOf(source, source.indexOf("'EN_EL_OTRO_METODO'"))).toBe('otroMetodo');
    // Un throw adentro de la clase pero fuera de todo método no es de nadie —
    // y sobre todo no es del método anterior, cuyo nombre lleva `Coordination`
    // y por lo tanto abre la puerta del alcance.
    expect(enclosingNameOf(source, source.indexOf("'ENTRE_LLAVES_PERO_EN_NINGUN_METODO'"))).toBe('');
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
      const keys = Object.keys(catalogs[locale]).filter((k) => k.startsWith('error.coordination.') || k.startsWith('error.brand.') || k.startsWith('error.app.') || k.startsWith('coordination.'));
      expect(keys.length, locale).toBeGreaterThan(20);
      for (const key of keys) {
        const text = catalogs[locale][key as keyof typeof catalogs['es-AR']];
        // `noSettingsNote` es la excepción declarada: dice justamente que NO
        // hay ningún formulario de configuración, así que nombrarlo es negarlo.
        if (key.endsWith('noSettingsNote')) continue;
        // M6 (ronda 8): SIN MIRAR LAS MAYÚSCULAS. "en ajustes" a mitad de
        // frase es exactamente la misma promesa falsa que "en Ajustes", y el
        // guardián case-sensitive la dejaba pasar — que es la forma más
        // probable de escribirla.
        expect(text, `${locale} ${key}`).not.toMatch(/\bajustes\b|\bsettings\b/i);
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
