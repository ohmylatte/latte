import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * C7: LOS CANDADOS DEL DISEÑO.
 *
 * Los seis criterios que gobiernan esta pantalla no son un documento: son
 * reglas que se rompen solas la próxima vez que alguien agregue "una línea
 * más". Este archivo las pone a fallar.
 *
 *  1. toda fila tiene la misma anatomía: estado · nombre · qué hace · cuándo;
 *  2. un solo acento significa vivo / te necesita / acción principal;
 *  3. el ícono hace el sustantivo, la palabra agrega lo específico;
 *  4. la fila ES la acción: sin un verbo repetido al costado;
 *  5. los estados son señales, nunca una frase adentro de una pastilla;
 *  6. el vacío tiene propósito.
 *
 * Y el presupuesto de palabras: 2 líneas por fila, 1 línea de encabezado, 1
 * verbo por botón con ícono, 0 ids / numerales de Markdown / nombres de
 * herramientas en pantalla.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { render } = await import('@testing-library/react');
const { TeamView } = await import('./TeamView');
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationAskView, CoordinationLogEntryView, CoordinationRunTaskView, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Piezas para el primer encendido', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Asistente'), member('cm', 'Community Manager'), member('paid', 'Paid Media')];

const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '2026-09-13T17:17:00.000Z', updatedAt: '', lastEventAt: '',
  tasksDone: 1, tasksFailed: 0, tasksInFlight: 1, tasksPending: 2,
};

/** El motor deja entrar Markdown: el spec y el prompt llegan con su numeral. */
const tasks: CoordinationRunTaskView[] = [
  { id: 't1', roleId: 'paid', spec: '# Piezas publicitarias Meta', status: 'done', inPlan: true, dependsOn: [], attempts: 1, assignedMemberId: 'paid' },
  { id: 't2', roleId: 'cm', spec: '## Producir 14 piezas Feed y Story', status: 'running', inPlan: true, dependsOn: ['t1'], attempts: 1, assignedMemberId: 'cm' },
  { id: 't3', roleId: 'cm', spec: '- Calendario de la semana 1', status: 'ready', inPlan: true, dependsOn: [], attempts: 0, assignedMemberId: null },
];
const log: CoordinationLogEntryView[] = [
  {
    id: 'd1', taskId: 't1', memberId: 'paid', status: 'reported', outcome: 'succeeded',
    promptPreview: '# Piezas exactas para producción\nCon el brief.', summaryPreview: '14 piezas numeradas con ángulo, copy e imagen',
    createdAt: '2026-09-13T17:18:00.000Z', startedAt: '2026-09-13T17:18:00.000Z', settledAt: '2026-09-13T17:48:00.000Z',
  },
  {
    id: 'd2', taskId: 't2', memberId: 'cm', status: 'running', outcome: null,
    promptPreview: '## Producir 14 piezas', summaryPreview: null,
    createdAt: '2026-09-13T18:48:00.000Z', startedAt: '2026-09-13T18:48:00.000Z', settledAt: null,
  },
];
const asks: CoordinationAskView[] = [{
  id: 'ask1', runId: 'run1', taskId: 't3', memberId: 'paid', question: '¿Reparto los $60.000?',
  answer: null, deadlineAt: '2026-09-13T19:28:00.000Z', answeredAt: null, createdAt: '2026-09-13T18:58:00.000Z',
}];

const mount = (props: Partial<TeamViewProps> = {}) => {
  ui.locale = 'es-AR';
  return render(createElement(TeamView, {
    work, team, roles: [], mode: 'simple', busy: false, selectedMemberId: 'paid', onSelectMember: () => {},
    coordinationRun: run, coordinationTasks: tasks, coordinationLog: log, coordinationAsks: asks,
    now: Date.parse('2026-09-13T19:00:00.000Z'),
    formatTime: (v: string) => v, formatDate: (v: string) => v,
    onOpenChat: () => {}, onAnswerAsk: () => {}, onNewRequest: () => {}, onAddMember: () => {},
    ...props,
  }));
};

describe('C7 (a): la fila ES la acción, y ningún verbo se repite al costado', () => {
  it('no existe un botón que diga "Abrir chat"', () => {
    const { container } = mount();
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).not.toContain('Abrir chat');
    expect(container.querySelector('.team-inbox-open-chat')).toBeNull();
  });

  it('cada fila de miembro es un `<button>` entero', () => {
    const { container } = mount();
    const rows = [...container.querySelectorAll('.team-view-list .team-inbox-row')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const button = row.querySelector('button.coord-row');
      expect(button, 'una fila sin botón: ' + row.getAttribute('data-member-id')).not.toBeNull();
      // Y un botón por fila: dos acciones en la misma fila es la vuelta al
      // "Abrir chat" al costado con otro nombre.
      expect(row.querySelectorAll('button')).toHaveLength(1);
    }
  });
});

describe('C7 (b): el avance es una señal, no una frase con contadores', () => {
  it('hay exactamente un elemento de progreso', () => {
    const { container } = mount();
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  });

  /**
   * "0 listas · 1 en curso · 0 fallidas · 3 sin empezar" era una sola línea
   * con cuatro contadores. Ninguna frase de esta pantalla puede volver a tener
   * tres o más números separados por el punto medio.
   */
  it('ningún texto encadena tres o más contadores con " · "', () => {
    const { container } = mount();
    const offenders: string[] = [];
    for (const node of container.querySelectorAll('*')) {
      if (node.children.length > 0) continue; // sólo las hojas: el texto real
      const text = node.textContent ?? '';
      const parts = text.split(' · ');
      if (parts.length < 3) continue;
      if (parts.filter((part) => /\d/.test(part)).length >= 3) offenders.push(text);
    }
    expect(offenders).toEqual([]);
  });
});

describe('C7 (c): un botón sólo-ícono siempre se nombra', () => {
  it('todo botón sin texto trae `aria-label`', () => {
    const { container } = mount();
    const unnamed = [...container.querySelectorAll('button')]
      .filter((b) => (b.textContent ?? '').trim() === '')
      .filter((b) => !b.getAttribute('aria-label'));
    expect(unnamed.map((b) => b.className)).toEqual([]);
  });
});

describe('C7 (d): 0 numerales de Markdown en pantalla', () => {
  it('ningún título de tarea o de evento empieza con `#`', () => {
    const { container } = mount();
    const titles = [
      ...container.querySelectorAll('.coord-task-title'),
      ...container.querySelectorAll('.coord-event-title'),
      ...container.querySelectorAll('.coord-event-task'),
      ...container.querySelectorAll('.coord-row-line'),
    ].map((node) => (node.textContent ?? '').trim());
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title.startsWith('#'), 'empieza con numeral: ' + title).toBe(false);
  });

  it('la tira de tareas no muestra un solo numeral ni una viñeta suelta', () => {
    const { container } = mount();
    const strip = container.querySelector('.coord-tasks')!.textContent ?? '';
    expect(strip).not.toContain('#');
    expect(strip).toContain('Piezas publicitarias Meta');
    expect(strip).toContain('Calendario de la semana 1');
  });
});

describe('C7 (e): el evento de reporte muestra su resumen', () => {
  it('el reporte trae el texto que el miembro reportó', () => {
    const { container } = mount({ selectedMemberId: 'paid' });
    const reported = container.querySelector('.coord-event[data-kind="reported"]')!;
    expect(reported).not.toBeNull();
    expect(reported.querySelector('.coord-event-text')!.textContent).toBe('14 piezas numeradas con ángulo, copy e imagen');
  });
});

describe('C7 (f): las claves nuevas existen en los dos idiomas', () => {
  it('cada `coord.*` está en castellano y en inglés', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { catalogs } = await import('./i18n');
    const es = Object.keys(catalogs['es-AR']).filter((k) => k.startsWith('coord.'));
    const en = Object.keys(catalogs['en-US']).filter((k) => k.startsWith('coord.'));
    expect(es.length).toBeGreaterThan(50);
    expect(en.sort()).toEqual(es.sort());
    // Y ninguna se quedó sin traducir: la misma cadena en los dos idiomas sólo
    // vale para lo que no se traduce (un número, un símbolo).
    const untranslated = es.filter((key) => {
      const a = (catalogs['es-AR'] as Record<string, string>)[key]!;
      const b = (catalogs['en-US'] as Record<string, string>)[key]!;
      return a === b && /[a-zA-Z]{4}/.test(a);
    });
    expect(untranslated).toEqual([]);
  });
});

/**
 * C7 (g): EL CSS DEL BLOQUE `coord-` SÓLO HABLA EN TOKENS.
 *
 * Un hex suelto es un color que no existe en el sistema: la próxima vez que
 * la marca cambie, ese color se queda. Y `--text-xs` está prohibido por el
 * ratchet tipográfico del repo.
 */
describe('C7 (g): el CSS del bloque coord-', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
  const lines = css.split(/\r?\n/);
  /** Las reglas cuyo selector menciona una clase `coord-`. */
  const coordRules = lines.filter((line) => {
    const brace = line.indexOf('{');
    if (brace < 0) return false;
    return /\.coord-[\w-]+/.test(line.slice(0, brace));
  });

  it('el bloque existe de verdad', () => {
    expect(coordRules.length).toBeGreaterThan(30);
  });

  it('no usa --text-xs: el piso tipográfico es --text-sm', () => {
    const offenders = coordRules.filter((rule) => rule.includes('--text-xs'));
    expect(offenders).toEqual([]);
  });

  it('no usa un solo color hex suelto: todo sale de un token', () => {
    // `rgb(0 0 0 / .08)` de una sombra es una opacidad sobre negro, no un color
    // de marca; un `#rrggbb` sí lo sería.
    const offenders = coordRules.filter((rule) => /#[0-9a-fA-F]{3,8}\b/.test(rule));
    expect(offenders).toEqual([]);
  });

  /** Cada clase que el producto pinta tiene una regla que la pinta. */
  it('las clases del diseño nuevo tienen regla con declaraciones', () => {
    const needed = [
      'coord-av', 'coord-dot', 'coord-dot-live', 'coord-dot-ok', 'coord-dot-idle',
      'coord-time', 'coord-badge', 'coord-row', 'coord-row-text', 'coord-row-top',
      'coord-row-name', 'coord-row-line', 'coord-row-coordinator',
      'coord-head', 'coord-head-name', 'coord-head-sub', 'coord-progress', 'coord-bar',
      'coord-bar-done', 'coord-bar-live', 'coord-bar-failed', 'coord-pill', 'coord-pill-live',
      'coord-btn', 'coord-btn-primary', 'coord-btn-ghost', 'coord-icon-btn',
      'coord-tasks', 'coord-task', 'coord-task-title', 'coord-tic', 'coord-tic-ok', 'coord-tic-live',
      'coord-detail', 'coord-detail-head', 'coord-detail-sub', 'coord-timeline', 'coord-event',
      'coord-event-title', 'coord-event-card', 'coord-event-task', 'coord-event-spec',
      'coord-files', 'coord-file', 'coord-ask-card', 'coord-ask-question', 'coord-ask-due',
      'coord-ask-form', 'coord-ask-input', 'coord-ask-send',
      'coord-empty', 'coord-empty-title', 'coord-empty-body', 'coord-empty-example', 'coord-add',
      'coord-output', 'coord-output-row', 'coord-output-summary', 'coord-log', 'coord-log-row',
      'coord-card', 'coord-card-head', 'coord-card-title', 'coord-plan', 'coord-plan-task',
      'coord-plan-n', 'coord-plan-title', 'coord-plan-after', 'coord-hire', 'coord-hire-name',
      'coord-hire-note', 'coord-approved', 'coord-approved-text', 'coord-approved-go',
    ];
    const missing = needed.filter((name) => {
      const pattern = new RegExp('\\.' + name + '(?![\\w-])');
      return !coordRules.some((rule) => {
        const selector = rule.slice(0, rule.indexOf('{'));
        if (!pattern.test(selector)) return false;
        return rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}')).trim().length > 3;
      });
    });
    expect(missing).toEqual([]);
  });
});
