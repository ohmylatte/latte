import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * B1.1: LA TARJETA VIVE EN EL CHAT DEL MIEMBRO AL QUE LE CORRESPONDE.
 *
 * Hasta acá todo lo de coordinación se dibujaba en Decisiones, y Decisiones es
 * de marca: la persona tenía que salir de la conversación para contestar algo
 * que el equipo le preguntó EN la conversación. Acá se verifica lo único que
 * hace que la mudanza sea una mudanza y no un movimiento de cajas: que cada
 * cosa aparezca en UN chat, el correcto, y en ningún otro — y que cuando la
 * persona está mirando otro chat del mismo Trabajo se lo diga, con el salto.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render } = await import('@testing-library/react');
const { TeamCards, routeTeamCards } = await import('./coordination/TeamCards');
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationAskView, CoordinationGateView, CoordinationRunView, TeamMember } from '../shared/contracts';

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});
const gate = (patch: Partial<CoordinationGateView> = {}): CoordinationGateView => ({
  id: 'g1', kind: 'dispatch', runId: 'run1', prompt: 'Escribir el copy', createdAt: '', ...patch,
});
const ask = (patch: Partial<CoordinationAskView> = {}): CoordinationAskView => ({
  id: 'ask1', runId: 'run1', taskId: null, memberId: 'redactor', question: '¿Mantenemos el tono?',
  answer: null, deadlineAt: '2026-09-02T00:00:00.000Z', answeredAt: null, createdAt: '', ...patch,
});
const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Coordinador'), member('redactor', 'Redactor')];

const mount = (memberId: string, extra: Record<string, unknown> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(TeamCards, { memberId, team, roles: [], formatDate: (v: string) => v, ...extra }));
};

describe('B1.1: a quién le toca cada tarjeta', () => {
  it('la propuesta se dibuja en el chat del COORDINADOR', () => {
    const { container } = mount('coord', { coordinationRun: run(), gates: [gate({ kind: 'proposal', proposalJson: JSON.stringify({ plan: [{ roleId: 'copywriter', spec: 'Escribir' }], estimatedDispatches: 3, membersToHire: [], rationale: 'porque sí' }) })], onResolveGate: () => {} });
    expect(container.querySelector('[data-gate-kind="proposal"]')).not.toBeNull();
    expect(container.querySelector('.team-cards-waiting')).toBeNull();
  });

  it('y NO en el chat de otro miembro: ahí sólo queda la línea de espera', () => {
    const { container } = mount('redactor', { coordinationRun: run(), gates: [gate({ kind: 'proposal', proposalJson: '{"plan":[],"estimatedDispatches":1,"rationale":"x"}' })], onResolveGate: () => {} });
    expect(container.querySelector('[data-gate-kind="proposal"]')).toBeNull();
    expect(container.querySelector('.team-cards-waiting')!.textContent).toContain('1');
  });

  it('la pregunta se dibuja en el chat de QUIEN PREGUNTÓ, no en el del coordinador', () => {
    const asMine = mount('redactor', { coordinationRun: run(), openAsks: [ask()], onAnswerAsk: () => {} });
    expect(asMine.container.querySelector('[data-gate-kind="ask"]')).not.toBeNull();
    asMine.unmount();
    const asCoord = mount('coord', { coordinationRun: run(), openAsks: [ask()], onAnswerAsk: () => {} });
    expect(asCoord.container.querySelector('[data-gate-kind="ask"]')).toBeNull();
  });

  it('una pregunta SIN miembro cae en el coordinador, que es el único destinatario que siempre existe', () => {
    const routing = routeTeamCards('coord', [], [ask({ memberId: '' })], run());
    expect(routing.asks).toHaveLength(1);
  });

  it('sin coordinador no se elige un miembro al azar: no se dibuja en ningún chat', () => {
    for (const id of ['coord', 'redactor']) {
      const routing = routeTeamCards(id, [gate()], [], run({ coordinatorMemberId: null }));
      expect(routing.gates).toHaveLength(0);
      expect(routing.elsewhere).toBe(0);
    }
  });

  it('un run TERMINADO no pide nada en ningún chat', () => {
    const { container } = mount('coord', { coordinationRun: run({ status: 'done', active: false }), gates: [gate()], openAsks: [ask()], onResolveGate: () => {} });
    expect(container.querySelector('.team-cards')).toBeNull();
  });

  it('sin nada pendiente no se dibuja ninguna sección — cero filas nunca es un cero', () => {
    const { container } = mount('coord', { coordinationRun: run(), gates: [], openAsks: [] });
    expect(container.querySelector('.team-cards')).toBeNull();
  });
});

describe('B1.1: "El equipo te espera" desde otro chat', () => {
  it('cuenta TODO lo pendiente del Trabajo y ofrece el salto al miembro correcto', () => {
    const jumped: string[] = [];
    const { container } = mount('otro', {
      coordinationRun: run(), gates: [gate(), gate({ id: 'g2', kind: 'plan' })], openAsks: [ask()],
      team: [...team, member('otro', 'Otro')],
      onSelectMember: (id: string) => jumped.push(id),
    });
    expect(container.querySelector('.team-cards-waiting')!.textContent).toContain('3');
    fireEvent.click(container.querySelector('.team-cards-goto')!);
    expect(jumped).toEqual(['coord']);
  });

  it('sin `onSelectMember` la línea se dice igual, sin ofrecer un botón que no hace nada', () => {
    const { container } = mount('otro', { coordinationRun: run(), gates: [gate()] });
    expect(container.querySelector('.team-cards-waiting')).not.toBeNull();
    expect(container.querySelector('.team-cards-goto')).toBeNull();
  });

  it('la misma línea en inglés, sin nada en castellano', () => {
    const { container } = mount('otro', { coordinationRun: run(), gates: [gate()] }, 'en-US');
    const text = container.textContent ?? '';
    expect(text).toContain('waiting');
    expect(text).not.toContain('espera');
  });
});

describe('B1.1: las acciones inline llaman a la API', () => {
  it('aprobar un despacho', () => {
    const calls: unknown[][] = [];
    const { container } = mount('coord', { coordinationRun: run(), gates: [gate()], onResolveGate: (...a: unknown[]) => { calls.push(a); } });
    fireEvent.click(container.querySelector('.team-card-actions button.primary')!);
    expect(calls).toEqual([['g1', 'approve']]);
  });

  it('editar el prompt del despacho con un textarea inline, NUNCA con window.prompt', () => {
    const calls: unknown[][] = [];
    const nativePrompt = vi.fn();
    vi.stubGlobal('prompt', nativePrompt);
    const { container } = mount('coord', { coordinationRun: run(), gates: [gate()], onResolveGate: (...a: unknown[]) => { calls.push(a); } });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.team-card-actions button')];
    fireEvent.click(buttons[1]!); // "Editar y aprobar"
    const area = container.querySelector<HTMLTextAreaElement>('.team-card-edit-prompt')!;
    expect(area.value).toBe('Escribir el copy');
    fireEvent.change(area, { target: { value: 'Escribir el copy, en dos versiones' } });
    fireEvent.click(container.querySelector('.team-card-edit-actions button.primary')!);
    expect(calls).toEqual([['g1', 'approve', 'Escribir el copy, en dos versiones']]);
    expect(nativePrompt).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rechazar', () => {
    const calls: unknown[][] = [];
    const { container } = mount('coord', { coordinationRun: run(), gates: [gate()], onResolveGate: (...a: unknown[]) => { calls.push(a); } });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.team-card-actions button')];
    fireEvent.click(buttons[2]!);
    expect(calls).toEqual([['g1', 'reject']]);
  });

  it('responder una pregunta desde un textarea, nunca desde window.prompt', () => {
    const calls: unknown[][] = [];
    const nativePrompt = vi.fn();
    vi.stubGlobal('prompt', nativePrompt);
    const { container } = mount('redactor', { coordinationRun: run(), openAsks: [ask()], onAnswerAsk: (...a: unknown[]) => { calls.push(a); } });
    const answer = container.querySelector<HTMLButtonElement>('.team-card-ask .team-card-actions button')!;
    expect(answer.disabled).toBe(true); // una respuesta vacía no es una respuesta
    fireEvent.change(container.querySelector('.team-card-answer')!, { target: { value: 'Sí, el mismo tono' } });
    fireEvent.click(answer);
    expect(calls).toEqual([['ask1', 'Sí, el mismo tono']]);
    expect(nativePrompt).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('B1.1: el texto largo se lee como Markdown y arranca colapsado', () => {
  it('un prompt de varias líneas muestra la primera y ofrece "ver más"', () => {
    const { container } = mount('coord', { coordinationRun: run(), gates: [gate({ prompt: '# Primera\n\nSegunda línea con **negrita**' })], onResolveGate: () => {} });
    expect(container.querySelector('.team-card-first-line')!.textContent).toBe('# Primera');
    fireEvent.click(container.querySelector('.team-card-more')!);
    expect(container.querySelector('.team-card-prompt .markdown h1')).not.toBeNull();
    expect(container.querySelector('.team-card-prompt .markdown strong')).not.toBeNull();
  });

  it('un prompt de una sola línea no ofrece un "ver más" que no muestra nada nuevo', () => {
    const { container } = mount('coord', { coordinationRun: run(), gates: [gate({ prompt: 'Una sola' })], onResolveGate: () => {} });
    expect(container.querySelector('.team-card-more')).toBeNull();
  });
});
