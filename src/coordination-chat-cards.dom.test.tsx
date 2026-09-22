import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * C6: LAS TARJETAS DEL CHAT, SEGÚN EL MOCKUP.
 *
 * La propuesta se lee como una lista de tareas —número en mono, título en una
 * línea, "tras N" cuando depende de otra, el mini-avatar del dueño—, no como
 * un formulario con cuatro encabezados. El alta es una fila con su ícono. Los
 * botones son un verbo cada uno, con ícono, y "Rechazar" va a la derecha: es
 * la salida, no una alternativa al mismo nivel.
 *
 * Y se elimina de las tarjetas el texto que repetía lo que el ícono ya dice:
 * el kicker "PROPUESTA DE COORDINACIÓN" arriba del título "Propuesta del
 * equipo", el encabezado "Contrataciones" sobre una fila que ya tiene el ícono
 * de alta, y el presupuesto bajo un título cuando la pastilla del encabezado
 * lo dice con el mismo número.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render } = await import('@testing-library/react');
const { TeamCards } = await import('./coordination/TeamCards');
import type { TeamCardsProps } from './coordination/TeamCards';
import { EMPTY_USAGE } from '../shared/contracts';
import type { AgentRole, CoordinationAskView, CoordinationGateView, CoordinationProposal, CoordinationRunView, TeamMember } from '../shared/contracts';

const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Asistente'), member('cm', 'Community Manager'), member('paid', 'Paid Media')];
const roles: AgentRole[] = [
  { id: 'cm', name: 'Community Manager', initial: 'C', summary: '', builtin: false, tier: 'balanced', avatar: null },
  { id: 'paid', name: 'Paid Media', initial: 'P', summary: '', builtin: false, tier: 'balanced', avatar: null },
];

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '2026-09-13T17:17:00.000Z', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 4, ...patch,
});

/** El plan real del mockup: cuatro tareas, dos con dependencia, un alta. */
const proposal: CoordinationProposal = {
  plan: [
    { roleId: 'paid', spec: 'Piezas publicitarias Meta: copy por ángulo y formato' },
    { roleId: 'cm', spec: '# Producir 14 piezas en Feed 1:1 y Story 9:16', dependsOn: [0] },
    { roleId: 'cm', spec: 'Calendario de publicación de la semana 1' },
    { roleId: 'paid', spec: 'Configurar campañas A y B en Meta Ads', dependsOn: [1] },
  ],
  estimatedDispatches: 3,
  membersToHire: [{ roleId: 'paid', why: 'No hay nadie que sepa de pauta en el equipo' }],
  rationale: 'Armé un plan con el brief y las imágenes que ya están en la carpeta.',
};

const proposalGate: CoordinationGateView = {
  id: 'g1', kind: 'proposal', runId: 'run1', proposalJson: JSON.stringify(proposal), createdAt: '2026-09-13T17:17:00.000Z',
};
const ask = (patch: Partial<CoordinationAskView> = {}): CoordinationAskView => ({
  id: 'ask1', runId: 'run1', taskId: 't4', memberId: 'paid',
  question: '¿Reparto los $60.000 entre las campañas A y B, o va todo a Mensajes por WhatsApp?',
  answer: null, deadlineAt: '2026-09-13T19:28:00.000Z', answeredAt: null, createdAt: '2026-09-13T18:58:00.000Z', ...patch,
});

const NOW = Date.parse('2026-09-13T19:00:00.000Z');
const mount = (props: Partial<TeamCardsProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(TeamCards, {
    memberId: 'coord', coordinationRun: run(), team, roles,
    formatDate: (v: string) => v, formatTime: (v: string) => v, now: NOW, ...props,
  }));
};

describe('C6: la propuesta del equipo', () => {
  const wired = { gates: [proposalGate], onResolveGate: () => {} };

  it('el encabezado: ícono, título y la pastilla con las cuentas', () => {
    const { container } = mount(wired);
    const head = container.querySelector('.coord-card-head')!;
    expect(head.querySelector('.coord-tic')).not.toBeNull();
    expect(head.querySelector('.coord-card-title')!.textContent).toBe('Propuesta del equipo');
    expect(head.querySelector('.coord-card-counts')!.textContent).toBe('4 tareas · 3 despachos');
  });

  it('una fila por tarea: número, título en una línea y el dueño', () => {
    const { container } = mount(wired);
    const tasks = [...container.querySelectorAll('.coord-plan-task')];
    expect(tasks).toHaveLength(4);
    expect(tasks.map((task) => task.querySelector('.coord-plan-n')!.textContent)).toEqual(['1', '2', '3', '4']);
    expect(tasks[0]!.querySelector('.coord-plan-title')!.textContent).toBe('Piezas publicitarias Meta: copy por ángulo y formato');
    // D5: el dueno es su CARA, no su inicial. Lo que se comprueba es que la
    // fila diga de quien es —y lo diga a la tecnologia de asistencia, que no
    // ve un dibujo— no que dibuje dos letras.
    const owner = tasks[0]!.querySelector('.coord-av')!;
    expect(owner.getAttribute('aria-label')).toBe('Paid Media');
    expect(owner.querySelector('.av-face')).not.toBeNull();
    expect(owner.textContent).toBe('');
  });

  /** Criterio: 0 numerales de Markdown en pantalla. */
  it('ningún título de tarea llega con su numeral de Markdown', () => {
    const { container } = mount(wired);
    const second = container.querySelectorAll('.coord-plan-task')[1]!;
    expect(second.querySelector('.coord-plan-title')!.textContent).toBe('Producir 14 piezas en Feed 1:1 y Story 9:16');
    expect(container.querySelector('.coord-plan')!.textContent).not.toContain('#');
  });

  it('"tras N" sólo en las que dependen de otra, con el número que se ve', () => {
    const { container } = mount(wired);
    const after = [...container.querySelectorAll('.coord-plan-task')].map((task) => task.querySelector('.coord-plan-after')?.textContent ?? '');
    expect(after).toEqual(['', 'tras 1', '', 'tras 2']);
  });

  it('el alta es una fila con su ícono, y el motivo vive en el tooltip', () => {
    const { container } = mount(wired);
    const hire = container.querySelector('.coord-hire')!;
    expect(hire.querySelector('.coord-hire-name')!.textContent).toBe('Suma a Paid Media');
    expect(hire.querySelector('.coord-hire-note')!.textContent).toBe('no está en el equipo');
    expect(hire.querySelector('.coord-hire-note')!.getAttribute('title')).toContain('pauta');
  });

  /** Lo que el ícono ya dice no se vuelve a escribir. */
  it('no quedan encabezados que repitan lo que la tarjeta ya muestra', () => {
    const { container } = mount(wired);
    const text = container.textContent ?? '';
    expect(text).not.toContain('PROPUESTA DE COORDINACIÓN');
    expect(text).not.toContain('Contrataciones');
    expect(text).not.toContain('Presupuesto de despachos');
    expect(container.querySelectorAll('.team-card-proposal h3')).toHaveLength(0);
  });

  it('tres verbos: Aprobar primario, Editar, y Rechazar a la derecha', () => {
    const { container } = mount(wired);
    const actions = [...container.querySelectorAll('.coord-card-actions button')];
    expect(actions.map((b) => b.textContent)).toEqual(['Aprobar', 'Editar', 'Rechazar']);
    expect(actions[0]!.className).toContain('primary');
    expect(actions[2]!.className).toContain('coord-btn-ghost');
    // "Rechazar" queda separado por el espaciador: es la salida, no una tercera opción.
    expect(container.querySelector('.coord-card-spacer')).not.toBeNull();
  });

  /** El flujo de "Editar y aprobar" sigue intacto detrás de "Editar". */
  it('"Editar" abre el mismo recorte de tareas y altas de siempre', () => {
    const { container } = mount(wired);
    fireEvent.click([...container.querySelectorAll('.coord-card-actions button')][1]!);
    const editor = container.querySelector('.team-card-edit')!;
    expect(editor).not.toBeNull();
    expect(editor.querySelectorAll('.team-card-edit-hire')).toHaveLength(1);
    expect(editor.querySelector('.team-card-edit-actions button')!.textContent).toBe('Confirmar edición y aprobar');
  });
});

describe('C6: la línea plegada de un plan aprobado', () => {
  it('tilde verde, la frase, la hora y un solo verbo para ir al equipo', () => {
    const onShowTeam = vi.fn();
    const { container } = mount({ gates: [], openAsks: [], onShowTeam });
    const line = container.querySelector('.coord-approved')!;
    expect(line.querySelector('.coord-tic-ok')).not.toBeNull();
    expect(line.querySelector('.coord-approved-text')!.textContent).toBe('Plan aprobado · el equipo trabaja');
    expect(line.querySelector('.coord-time')!.getAttribute('dateTime')).toBe('2026-09-13T17:17:00.000Z');
    fireEvent.click(line.querySelector('.coord-approved-go')!);
    expect(onShowTeam).toHaveBeenCalled();
  });

  it('con una propuesta todavía sin aprobar manda la tarjeta, no la línea', () => {
    const { container } = mount({ gates: [proposalGate], onResolveGate: () => {} });
    expect(container.querySelector('.coord-approved')).toBeNull();
    expect(container.querySelector('.team-card-proposal')).not.toBeNull();
  });
});

describe('C6: la pregunta en el chat', () => {
  const wired = { memberId: 'paid', openAsks: [ask()], onAnswerAsk: () => {} };

  it('ícono en el acento, quién pregunta y hace cuánto', () => {
    const { container } = mount(wired);
    const head = container.querySelector('.team-card-ask .coord-card-head')!;
    expect(head.querySelector('.coord-tic-live')).not.toBeNull();
    expect(head.querySelector('.coord-card-title')!.textContent).toBe('Paid Media pregunta');
    expect(head.querySelector('.coord-time')!.textContent).toBe('hace 2 min');
  });

  it('la pregunta entera y un campo con un solo verbo', () => {
    const answers: unknown[][] = [];
    const { container } = mount({ ...wired, onAnswerAsk: (...a: unknown[]) => { answers.push(a); } });
    expect(container.querySelector('.coord-card-question')!.textContent).toContain('$60.000');
    fireEvent.change(container.querySelector('.coord-ask-input')!, { target: { value: 'Mitad y mitad' } });
    fireEvent.click(container.querySelector('.coord-ask-send')!);
    expect(answers).toEqual([['ask1', 'Mitad y mitad']]);
  });

  it('el vencimiento no se repite acá: eso lo dice el modo Equipo', () => {
    const { container } = mount(wired);
    expect(container.querySelector('.team-card-ask')!.textContent).not.toContain('vence');
  });

  it('sin handler no se ofrece un campo que no contesta nada', () => {
    const { container } = mount({ memberId: 'paid', openAsks: [ask()] });
    expect(container.querySelector('.team-card-ask')).not.toBeNull();
    expect(container.querySelector('.coord-ask-form')).toBeNull();
  });
});

describe('C6: las mismas tarjetas en inglés', () => {
  it('sin nada en castellano', () => {
    const { container } = mount({ gates: [proposalGate], onResolveGate: () => {} }, 'en-US');
    const text = container.textContent ?? '';
    expect(text).toContain('The team’s proposal');
    expect(text).toContain('Adds Paid Media');
    expect(text).toContain('after 1');
    expect(text).not.toContain('Propuesta del equipo');
    expect(text).not.toContain('Suma a');
  });
});
