import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The source-level half of the Contexto guard.
 *
 * `ContextView.dom.test.tsx` proves the view renders; this proves the list of
 * views and the branches that render them cannot drift apart, and that the
 * assets the shipped regression orphaned are referenced again. It reads the
 * files instead of importing them, because importing `App` pulls in the
 * terminal and the browser API, which a Node test has no business booting.
 *
 * The branch guard is deliberately narrow. A bare `toContain("view === 'context'")`
 * is satisfied by the nav button's className, so renaming only the render branch
 * left it green: a guard that cannot fail is worse than no guard. It now asserts
 * a `view === '<v>' … && <` pattern INSIDE `<main>`, which is where a render
 * branch lives and where the sidebar nav does not.
 */

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
const app = read('./App.tsx');
const contextView = read('./ContextView.tsx');

const listed = [...app.matchAll(/^export const VIEWS = \[([^\]]+)\] as const;$/gm)]
  .flatMap((match) => match[1].split(','))
  .map((part) => part.trim().replace(/^'|'$/g, ''))
  .filter(Boolean);

const mainStart = app.indexOf('<main className="workspace"');
const mainEnd = app.indexOf('</main>', mainStart);
const main = mainStart >= 0 && mainEnd > mainStart ? app.slice(mainStart, mainEnd) : '';

describe('workspace views', () => {
  it('enumerates every workspace view in one list', () => {
    // `home` is first on purpose: it is the landing of a returning user, and the
    // list order is what the render-branch guard below walks.
    expect(listed).toEqual(['home', 'resumen', 'trabajo', 'evidencia', 'brief', 'funnel', 'context', 'memory', 'decisions', 'resultados']);
  });

  it('renders a branch for each of them inside <main>', () => {
    expect(main, '<main> not found in App.tsx').not.toBe('');
    // El largo primero: si el `matchAll` de `VIEWS` dejara de matchear, este
    // `for … of` no correría una sola aserción y el guard de ramas de render
    // pasaría en verde sin haber mirado ninguna vista.
    expect(listed.length).toBeGreaterThan(0);
    for (const view of listed) {
      expect(main, `${view} has no render branch`).toMatch(new RegExp(`view === '${view}'[^\\n]*&&\\s*<`));
    }
  });

  it('keeps the dead duplicate diff out of App', () => {
    expect(app).not.toContain('function diffLines');
    expect(app).not.toContain('function proposedContext');
  });
});

/**
 * `useCoordination` wiring (autonomous-coordination Phase 7 task 7.11):
 * source-level, for the same reason `app-views.test.ts` itself is
 * source-level — importing `App` pulls in the terminal and the browser API,
 * which a Node test has no business booting. The task's own explicit ask:
 * "failing test asserting no new VIEWS entry" — this hook wires FOUR
 * pre-existing views plus the strip and the notice, it adds no view of its
 * own.
 */
describe('useCoordination wiring adds no new VIEWS entry (task 7.11)', () => {
  it('the workspace view list is unchanged by the coordination wiring', () => {
    // Byte-for-byte the same list `app-views.test.ts` already pins above —
    // repeated here as its own assertion so a future edit that adds a
    // coordination-only view fails THIS test with a name that says why.
    expect(listed).toEqual(['home', 'resumen', 'trabajo', 'evidencia', 'brief', 'funnel', 'context', 'memory', 'decisions', 'resultados']);
  });

  it('calls the hook exactly once, unconditionally, scoped to the open Work', () => {
    expect(app).toContain('useCoordination(work?.id ?? null,');
    expect(app.match(/useCoordination\(/g) ?? []).toHaveLength(1);
  });

  it('renders the active-teams strip and the memory notice', () => {
    expect(app).toContain('<ActiveTeamsStrip');
    expect(app).toContain('<MemoryNotice');
  });

  it('wires the coordination gates and the settle action into the real IPC verbs, not a reinvention', () => {
    // B1.1: los gates ya no van a Decisiones. Van al CHAT del miembro al que
    // le corresponden, por `chatCoordination` de `TeamPanel`; Decisiones queda
    // para lo que perdura. El verbo es el mismo (`resolveCoordinationGate`,
    // via `coordination.resolveGate`): lo que cambio es a quien se lo pasa.
    expect(app).toMatch(/TeamPanel[\s\S]{0,4000}chatCoordination=\{\{[\s\S]{0,600}gates: work \? coordination\.gates/);
    expect(app).toMatch(/TeamPanel[\s\S]{0,4000}chatCoordination=\{\{[\s\S]{0,600}onResolveGate: coordination\.resolveGate/);
    expect(app).toMatch(/TeamPanel[\s\S]{0,4000}chatCoordination=\{\{[\s\S]{0,600}onAnswerAsk: coordination\.answerAsk/);
    expect(app).not.toMatch(/DecisionsView[\s\S]{0,2000}gates=\{/);
    expect(app).toMatch(/ResumenView[\s\S]{0,2000}onSettleDispatch=\{coordination\.settleDispatch\}/);
    expect(app).toMatch(/TeamPanel[\s\S]{0,4000}coordinationRun=\{work \? coordination\.run/);
    expect(app).toMatch(/TeamPanel[\s\S]{0,4000}onPauseCoordination=\{coordination\.pauseRun\}/);
  });

  /**
   * B1.4: INICIO Y LA TIRA ABREN EL CHAT DEL COORDINADOR.
   *
   * Las dos mandaban a Decisiones, que desde esta tanda no tiene una sola
   * tarjeta de gate: la persona llegaba a una pantalla donde no estaba lo que
   * fue a buscar. La aprobacion vive en el chat del coordinador.
   */
  it('la fila de aprobacion de Inicio y la tira de equipos abren la conversacion del coordinador', () => {
    expect(app).toMatch(/HomeView[\s\S]{0,2000}onOpenCoordination=\{openWorkCoordination\}/);
    expect(app).toContain("selectWork(target, 'brief', 'conversation')");
    // La tira, en la MISMA marca y en otra: las dos ramas piden el coordinador.
    expect(app).toMatch(/openActiveRun[\s\S]{0,600}openWorkCoordination\(run\.workId\)/);
    expect(app).toMatch(/openActiveRun[\s\S]{0,800}wantCoordinatorRef\.current = run\.workId/);
    // Y ninguna de las dos aterriza ya en Decisiones.
    expect(app).not.toMatch(/pendingViewRef\.current = 'decisions'/);
  });

  /**
   * B1.4: EL CONTADOR DE LA PESTANA DECISIONES CUENTA DECISIONES.
   *
   * Sumarle los gates de un run haria que la pestana prometiera pendientes
   * que ya no viven ahi.
   */
  it('el contador de la pestana Decisiones no suma gates', () => {
    const tab = app.match(/view === 'decisions' \? 'selected'[\s\S]{0,300}?<\/button>/);
    expect(tab, 'no se encontro la pestana Decisiones').not.toBeNull();
    expect(tab![0]).toContain('visibleDecisions.filter');
    expect(tab![0]).not.toContain('coordination.gates');
    expect(tab![0]).not.toContain('pendingGates');
  });

  /**
   * B5.2: ABRIR LA PESTAÑA DE UN MIEMBRO QUE YA ESTÁ VIVO MUESTRA SU CHAT.
   *
   * `hub.openMember` devuelve la sesión viva si la hay —o sea que no se abre
   * un segundo proceso encima del que spawneó el motor, que era la primera
   * mitad de la duda—, pero esa sesión viene con `resumed:false`: no se
   * resumió nada, ya estaba abierta. Y `openSession` sólo pide el transcripto
   * cuando la sesión viene `resumed`. Como `openMember` hace `forget` antes,
   * el renderer borraba lo que tenía y no volvía a pedirlo NUNCA: la persona
   * abría la pestaña del miembro que el motor había puesto a trabajar y
   * encontraba una pantalla en blanco, sin el despacho ni la respuesta que el
   * transcripto sí tiene guardados.
   *
   * Source-level por lo mismo que el resto de este archivo: importar `App`
   * arrastra la terminal y la browser-api.
   */
  it('openMember sincroniza el transcripto aunque la sesión viva no venga `resumed`', () => {
    const fn = app.match(/const openMember = async \(memberId: string\) => \{[\s\S]{0,600}?\n  \};/);
    expect(fn, 'no se encontró openMember en App.tsx').not.toBeNull();
    expect(fn![0]).toContain('chatStore.forget(memberId)');
    expect(fn![0]).toContain('chatStore.sync(opened.id)');
    expect(fn![0]).toContain('!opened.resumed');
  });

  /**
   * B5.2: y el equipo se recarga con cada evento de coordinación del Trabajo
   * abierto. `coordination-hire-appears.dom.test.tsx` lo prueba corriendo;
   * esto pincha el cableado exacto para que no se pierda en un refactor.
   */
  it('todo evento de coordinación del Trabajo abierto recarga el equipo', () => {
    expect(app).toMatch(/useCoordination\(work\?\.id \?\? null,[\s\S]{0,200}loadTeam\(id\)/);
  });
});

/**
 * B3.5: LLEGAR DESDE UN PENDIENTE ES PEDIR VER ESE PENDIENTE.
 *
 * `openWorkCoordination` (la fila "te espera una aprobacion" de Inicio, la tira
 * lateral) abre la conversacion del coordinador justamente para que la persona
 * apruebe. Desde B3.2 la tarjeta nace plegada; dejarsela plegada JUSTO en este
 * camino seria cobrarle un clic mas por lo que ya pidio. En cualquier otra
 * navegacion queda plegada, que es el default.
 */
describe('B3.5: la navegacion desde un pendiente despliega la tarjeta', () => {
  it('openWorkCoordination marca que se viene de un pendiente', () => {
    const fn = app.match(/const openWorkCoordination = \(workId: string\) => \{[\s\S]{0,600}?\};/);
    expect(fn, 'no se encontro openWorkCoordination').not.toBeNull();
    expect(fn![0]).toContain('setCardsFromPending(true)');
  });

  it('la tira en OTRA marca marca lo mismo', () => {
    expect(app).toMatch(/openActiveRun[\s\S]{0,900}setCardsFromPending\(true\)/);
  });

  it('el chat del miembro recibe el aviso por `initiallyExpanded`', () => {
    expect(app).toMatch(/chatCoordination=\{\{[\s\S]{0,800}initiallyExpanded: cardsFromPending/);
  });

  it('y elegir un miembro a mano lo apaga: ese clic no viene de ningun pendiente', () => {
    const fn = app.match(/const selectMember = \(memberId: string\) => \{[\s\S]{0,400}?\};/);
    expect(fn, 'no se encontro selectMember').not.toBeNull();
    expect(fn![0]).toContain('setCardsFromPending(false)');
  });
});

describe('orphaned context assets', () => {
  it('uses the context.* keys the restored view was meant to show', () => {
    for (const key of ['context.ask', 'context.ask.needWork', 'context.proposal', 'context.accept', 'context.editAccept', 'context.reject', 'context.diff', 'context.mode.replace', 'context.mode.append', 'context.changedSince', 'context.acceptStale']) {
      expect(contextView, `${key} is orphaned`).toContain(`'${key}'`);
    }
    expect(app, 'context.staleDraft is orphaned').toContain("'context.staleDraft'");
  });

  it('renders the line diff with the shipped .context-diff styles', () => {
    expect(contextView).toContain('context-diff-line context-diff-');
  });
});
