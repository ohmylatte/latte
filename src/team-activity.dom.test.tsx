import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * N1: EN EL MODO EQUIPO SE VE QUE TRABAJAN.
 *
 * La captura del dueño: dos miembros "Trabajando" y el hilo de Strategist con
 * sólo "Despacho de Asistente 19:18", mientras en SU chat estaba leyendo,
 * buscando en memoria y escribiendo. Cuando arranca el equipo la persona se
 * queda en esta vista, y parecía que no pasaba nada.
 *
 * No es un chat de todos: es la fila diciendo qué hace ahora, y el hilo con
 * una línea por paso entre el despacho y el reporte. Nunca el razonamiento ni
 * el output de las herramientas: eso es el chat.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { cleanup, render } = await import('@testing-library/react');
const { TeamView } = await import('./TeamView');
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type { ChatMessage, ChatPart, CoordinationLogEntryView, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

afterEach(() => cleanup());

const work: Work = { id: 'w1', brandId: 'b1', title: 'Ayulem', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'working', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Asistente'), member('strat', 'Strategist')];
const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 1, tasksPending: 0,
};
const dispatch = (patch: Partial<Extract<CoordinationLogEntryView, { taskId: string }>> = {}): CoordinationLogEntryView => ({
  id: 'd1', taskId: 't1', memberId: 'strat', status: 'running', outcome: null,
  promptPreview: 'Estrategia mayorista', summaryPreview: null,
  createdAt: '2026-09-24T19:18:00.000Z', startedAt: '2026-09-24T19:18:00.000Z', settledAt: null, ...patch,
});

type ToolPart = Extract<ChatPart, { type: 'tool' }>;
const tool = (id: string, name: string, input: unknown, status: ToolPart['status'] = 'completed'): ToolPart =>
  ({ type: 'tool', id, tool: name, status, title: '', input: JSON.stringify(input), output: 'OUTPUT QUE NO SE MUESTRA', error: '' });
const said = (id: string, at: string, parts: ChatPart[]): ChatMessage => ({ id, chatId: 'strat', role: 'assistant', parts, createdAt: at, completed: true, error: null });

const working: ChatMessage[] = [
  said('a1', '2026-09-24T19:18:10.000Z', [
    { type: 'reasoning', id: 'r1', text: 'RAZONAMIENTO QUE NO SE MUESTRA' },
    tool('p1', 'Read', { file_path: 'C:\\Users\\gabog\\Latte\\Ayulem\\Cuestionario_Segmentacion_Mayorista_Meta.md' }),
  ]),
  said('a2', '2026-09-24T19:19:00.000Z', [tool('p2', 'mcp__latte_memory__mem_search', { query: 'Ayulem mayorista' })]),
  said('a3', '2026-09-24T19:20:00.000Z', [tool('p3', 'Write', { file_path: '/w/Ayulem/estrategia-mayorista.md', content: 'x' }, 'running')]),
];

const base: TeamViewProps = {
  work, team, roles: [], mode: 'simple', busy: false,
  selectedMemberId: 'strat', onSelectMember: () => {},
  coordinationRun: run, formatTime: (v: string) => v.slice(11, 16), formatDate: (v: string) => v,
};
const mount = (props: Partial<TeamViewProps> = {}) => { ui.locale = 'es-AR'; return render(createElement(TeamView, { ...base, ...props })); };
const rowLine = (container: HTMLElement, id: string) => container.querySelector(`[data-member-id="${id}"] .coord-row-line`)!.textContent;

describe('N1: la fila del miembro dice qué hace ahora', () => {
  it('con eventos de herramienta: el verbo y el objeto de la última', () => {
    const { container } = mount({ coordinationLog: [dispatch()], memberChats: { strat: working } });
    expect(rowLine(container, 'strat')).toBe('Escribe estrategia-mayorista.md');
  });

  it('sin eventos de su sesión: "Trabajando", a secas', () => {
    const { container } = mount({ coordinationLog: [dispatch()], memberChats: {} });
    expect(rowLine(container, 'strat')).toBe('Trabajando');
  });

  it('razonando después de la última herramienta: "Piensa…"', () => {
    const thinking = [...working, said('a4', '2026-09-24T19:21:00.000Z', [{ type: 'reasoning', id: 'r2', text: '...' }])];
    const { container } = mount({ coordinationLog: [dispatch()], memberChats: { strat: thinking } });
    expect(rowLine(container, 'strat')).toBe('Piensa…');
  });
});

describe('N1: el hilo del miembro lista los pasos del despacho', () => {
  it('una línea por herramienta, con verbo y objeto, sin rutas, JSON, output ni razonamiento', () => {
    const { container } = mount({ coordinationLog: [dispatch()], memberChats: { strat: working } });
    const steps = [...container.querySelectorAll('.coord-step')];
    expect(steps.map((s) => s.querySelector('.coord-step-text')!.textContent)).toEqual([
      'Lee Cuestionario_Segmentacion_Mayorista_Meta.md',
      'Busca en memoria: Ayulem mayorista',
      'Escribe estrategia-mayorista.md',
    ]);
    expect(steps.map((s) => s.querySelector('.coord-time')!.textContent)).toEqual(['19:18', '19:19', '19:20']);
    const text = container.querySelector('.coord-steps')!.textContent!;
    expect(text).not.toMatch(/[\\{}"]|\/w\/|Users/);
    expect(container.textContent).not.toContain('OUTPUT QUE NO SE MUESTRA');
    expect(container.textContent).not.toContain('RAZONAMIENTO QUE NO SE MUESTRA');
    // El último, en curso: con el punto.
    expect(steps.map((s) => s.classList.contains('is-live'))).toEqual([false, false, true]);
    expect(steps[2]!.querySelector('.coord-step-dot')).not.toBeNull();
    // Mientras trabaja, los pasos están a la vista, no plegados.
    expect(container.querySelector('.coord-steps-fold')).toBeNull();
  });

  it('al reportar, los pasos se pliegan en "N pasos"', () => {
    const reported = dispatch({ status: 'reported', outcome: 'succeeded', summaryPreview: 'Quedó la estrategia', settledAt: '2026-09-24T19:40:00.000Z' });
    const done = working.map((m) => ({ ...m, parts: m.parts.map((p) => (p.type === 'tool' ? { ...p, status: 'completed' as const } : p)) }));
    const { container } = mount({ coordinationLog: [reported], memberChats: { strat: done } });
    const fold = container.querySelector('details.coord-steps-fold') as HTMLDetailsElement;
    expect(fold).not.toBeNull();
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toBe('3 pasos');
    expect(fold.querySelectorAll('.coord-step')).toHaveLength(3);
    expect(container.querySelector('.coord-step.is-live')).toBeNull();
  });

  it('sin sesión ni transcripto: sin pasos, sin inventar', () => {
    const { container } = mount({ coordinationLog: [dispatch()], memberChats: {} });
    expect(container.querySelector('.coord-steps')).toBeNull();
  });

  it('tope de 50 pasos visibles: los anteriores quedan bajo "y N más"', () => {
    const many = Array.from({ length: 53 }, (_, i) => said('m' + i, `2026-09-24T19:${String(19 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
      [tool('q' + i, 'Read', { file_path: `/x/archivo-${i}.md` })]));
    const { container } = mount({ coordinationLog: [dispatch()], memberChats: { strat: many } });
    expect(container.querySelectorAll('.coord-step')).toHaveLength(50);
    expect(container.querySelector('.coord-steps-more')!.textContent).toBe('y 3 más');
    expect(container.querySelector('.coord-step .coord-step-text')!.textContent).toBe('Lee archivo-3.md');
  });
});
