import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * C4: EL ESTADO "TE NECESITA", DICHO UNA VEZ EN CADA ALTURA.
 *
 * Criterio 2: el acento significa vivo / te necesita / acción principal, y
 * nada más. Una pregunta abierta se anuncia en tres alturas, cada una con la
 * forma que le corresponde:
 *
 *  - el segmento "Equipo" del rail lleva el NÚMERO (hay algo, no dice qué);
 *  - el encabezado del run lleva la pastilla "Te necesita" (qué clase de algo);
 *  - el detalle del miembro que preguntó lleva la tarjeta grande con la
 *    pregunta entera y su única acción: contestarla.
 *
 * Y después de responder, la tarjeta se va: el hecho queda en la línea de
 * tiempo, que es donde vive lo que ya pasó.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render } = await import('@testing-library/react');
const { TeamView } = await import('./TeamView');
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationAskView, CoordinationRunTaskView, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Piezas para el primer encendido', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Asistente'), member('cm', 'Community Manager'), member('paid', 'Paid Media')];

const NOW = Date.parse('2026-09-13T19:00:00.000Z');
const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '2026-09-13T17:17:00.000Z', updatedAt: '', lastEventAt: '',
  tasksDone: 2, tasksFailed: 0, tasksInFlight: 2, tasksPending: 0,
};
const tasks: CoordinationRunTaskView[] = [
  { id: 't4', roleId: 'paid', spec: 'Campañas A y B en Meta Ads', status: 'dispatched', inPlan: true, dependsOn: [], attempts: 1, assignedMemberId: 'paid' },
];
const ask = (patch: Partial<CoordinationAskView> = {}): CoordinationAskView => ({
  id: 'ask1', runId: 'run1', taskId: 't4', memberId: 'paid',
  question: '¿Reparto los $60.000 entre las campañas A y B, o va todo a Mensajes por WhatsApp?',
  answer: null, deadlineAt: '2026-09-13T19:28:00.000Z', answeredAt: null, createdAt: '2026-09-13T18:58:00.000Z', ...patch,
});

const mount = (props: Partial<TeamViewProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(TeamView, {
    work, team, roles: [], mode: 'simple', busy: false, selectedMemberId: 'paid', onSelectMember: () => {},
    coordinationRun: run, coordinationTasks: tasks, coordinationAsks: [ask()], now: NOW,
    formatTime: (v: string) => v, formatDate: (v: string) => v,
    ...props,
  }));
};

describe('C4: el encabezado dice que algo te espera', () => {
  it('la pastilla "Te necesita" aparece con una pregunta abierta', () => {
    const { container } = mount();
    const pill = container.querySelector('.coord-pill-live')!;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toBe('Te necesita');
  });

  it('sin preguntas abiertas no hay pastilla: el acento nunca decora', () => {
    const { container } = mount({ coordinationAsks: [] });
    expect(container.querySelector('.coord-pill-live')).toBeNull();
  });

  /** La ficha de la tarea que espera la respuesta lo dice con su propio ícono. */
  it('la tarea de la pregunta se marca en la tira', () => {
    const { container } = mount();
    expect(container.querySelector('.coord-task')!.getAttribute('data-task-state')).toBe('asking');
  });
});

describe('C4: la tarjeta de la pregunta, en el detalle de quien preguntó', () => {
  it('la pregunta entera, para qué tarea es y cuánto falta', () => {
    const { container } = mount();
    const card = container.querySelector('.coord-ask-card')!;
    expect(card.querySelector('.coord-ask-question')!.textContent).toContain('$60.000');
    expect(card.querySelector('.coord-ask-due')!.textContent).toBe('Para: Campañas A y B en Meta Ads · vence en 28 min');
  });

  /** Una pregunta vencida no miente con "vence en 0 min". */
  it('una pregunta vencida lo dice', () => {
    const { container } = mount({ coordinationAsks: [ask({ deadlineAt: '2026-09-13T18:00:00.000Z' })] });
    expect(container.querySelector('.coord-ask-due')!.textContent).toBe('Para: Campañas A y B en Meta Ads · vencida');
  });

  it('sólo la ofrece en el detalle de QUIEN preguntó', () => {
    const { container } = mount({ selectedMemberId: 'cm' });
    expect(container.querySelector('.coord-ask-card')).toBeNull();
  });

  it('responder llama al mismo `answerAsk` de siempre, con el id de la pregunta', () => {
    const onAnswerAsk = vi.fn();
    const { container } = mount({ onAnswerAsk });
    const input = container.querySelector('.coord-ask-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Repartilo mitad y mitad' } });
    fireEvent.click(container.querySelector('.coord-ask-send')!);
    expect(onAnswerAsk).toHaveBeenCalledWith('ask1', 'Repartilo mitad y mitad');
  });

  it('una respuesta vacía no se manda', () => {
    const onAnswerAsk = vi.fn();
    const { container } = mount({ onAnswerAsk });
    const send = container.querySelector('.coord-ask-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(onAnswerAsk).not.toHaveBeenCalled();
  });

  /** Mientras la mutación está en vuelo, el botón no se puede apretar dos veces. */
  it('con la respuesta en vuelo el botón no vuelve a salir', () => {
    const { container } = mount({ onAnswerAsk: () => {}, pending: { 'ask:ask1': true } });
    expect((container.querySelector('.coord-ask-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sin handler no se ofrece un campo que no contesta nada', () => {
    const { container } = mount();
    expect(container.querySelector('.coord-ask-card')).not.toBeNull();
    expect(container.querySelector('.coord-ask-form')).toBeNull();
  });

  /**
   * Después de responder, la tarjeta se va y el hecho queda en la línea de
   * tiempo. La pregunta contestada ya no espera nada de nadie.
   */
  it('contestada, la tarjeta se va y el hecho queda en la línea de tiempo', () => {
    const answered = ask({ answer: 'Mitad y mitad', answeredAt: '2026-09-13T19:01:00.000Z' });
    const { container } = mount({ coordinationAsks: [answered], onAnswerAsk: () => {} });
    expect(container.querySelector('.coord-ask-card')).toBeNull();
    expect(container.querySelector('.coord-pill-live')).toBeNull();
    const kinds = [...container.querySelectorAll('.coord-event')].map((e) => e.getAttribute('data-kind'));
    expect(kinds).toEqual(['answer', 'ask']);
  });

  it('la misma pregunta en inglés, sin nada en castellano', () => {
    const { container } = mount({ onAnswerAsk: () => {} }, 'en-US');
    const card = container.querySelector('.coord-ask-card')!;
    expect(card.querySelector('.coord-ask-due')!.textContent).toContain('due in 28 min');
    expect(container.textContent).not.toContain('Te necesita');
    expect(container.textContent).toContain('Needs you');
  });
});
