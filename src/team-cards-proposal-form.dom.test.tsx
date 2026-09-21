import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render, screen } = await import('@testing-library/react');
const { TeamCards } = await import('./coordination/TeamCards');
import type { TeamCardsProps } from './coordination/TeamCards';
import type { CoordinationGateView, CoordinationProposal, CoordinationRunView, Work } from '../shared/contracts';

/**
 * U5: el formulario de la propuesta no puede quedarse con el estado viejo.
 *
 * Dos agujeros, el mismo síntoma: la persona lee una cosa y aprueba otra.
 *
 *  a) `key={gate.id}` es ESTABLE mientras `gate.proposalJson` cambia. Un
 *     agente que re-envía la propuesta (mismo gate, otro plan, otro tope)
 *     dejaba los `useState` inicializados con los valores de la propuesta
 *     VIEJA: el bloque de lectura mostraba el tope nuevo y `confirmEdit`
 *     mandaba el viejo.
 *  b) `unlimitedConfirmed` sólo se reseteaba en `editCancel`. Tildar
 *     "confirmo un presupuesto ILIMITADO", escribir un tope y volver a
 *     borrarlo dejaba viva una confirmación dada sobre otro estado del campo.
 */

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };

const proposal = (patch: Partial<CoordinationProposal> = {}): CoordinationProposal => ({
  plan: [{ roleId: 'copywriter', spec: 'Escribir 3 posts' }],
  estimatedDispatches: 8,
  membersToHire: [],
  rationale: 'El equipo actual no alcanza.',
  ...patch,
});

const gate = (p: CoordinationProposal): CoordinationGateView => ({
  id: 'g-prop', kind: 'proposal', runId: 'run1', proposalJson: JSON.stringify(p), createdAt: '2026-09-01T00:00:00.000Z',
});


/**
 * Las tarjetas se mudaron al chat del miembro al que le corresponden (B1.1).
 * Un gate es una conversación con el COORDINADOR, así que el run de este
 * archivo lo nombra y el chat que se monta es el suyo. Las aserciones son las
 * mismas: lo que cambió es la casa, no la regla.
 */
const runView: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0,
};

const base: TeamCardsProps = { memberId: 'coord', coordinationRun: runView, team: [], roles: [], formatDate: () => 'hace un rato' };

const dispatchesInput = (container: HTMLElement) => container.querySelector('.team-card-edit input[type="number"]') as HTMLInputElement;
const unlimitedBox = (container: HTMLElement) => container.querySelector('.team-card-edit-unlimited input[type="checkbox"]') as HTMLInputElement;

describe('una propuesta re-enviada no deja estado viejo en el formulario', () => {
  it('cambiar `proposalJson` con el MISMO gate id resetea el formulario', () => {
    const onResolveGate = vi.fn();
    const props = (p: CoordinationProposal) => ({ ...base, gates: [gate(p)], onResolveGate });
    const { container, rerender } = render(createElement(TeamCards, props(proposal({ estimatedDispatches: 8 }))));

    fireEvent.click(screen.getByRole('button', { name: 'Editar y aprobar' }));
    expect(dispatchesInput(container).value).toBe('8');

    // El agente re-envía la propuesta: mismo gate, otro tope.
    rerender(createElement(TeamCards, props(proposal({ estimatedDispatches: 3 }))));

    // El formulario se cerró con la propuesta vieja: no queda una edición a
    // medio hacer sobre un plan que ya no existe.
    expect(container.querySelector('.team-card-edit')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Editar y aprobar' }));
    expect(dispatchesInput(container).value).toBe('3');
  });

  it('confirmar después de una propuesta re-enviada manda el tope NUEVO, no el viejo', () => {
    const onResolveGate = vi.fn();
    const props = (p: CoordinationProposal) => ({ ...base, gates: [gate(p)], onResolveGate });
    const { rerender } = render(createElement(TeamCards, props(proposal({ estimatedDispatches: 8 }))));
    fireEvent.click(screen.getByRole('button', { name: 'Editar y aprobar' }));

    rerender(createElement(TeamCards, props(proposal({ estimatedDispatches: 3 }))));
    fireEvent.click(screen.getByRole('button', { name: 'Editar y aprobar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar edición y aprobar' }));

    expect(onResolveGate).toHaveBeenCalledTimes(1);
    const [, decision, payload] = onResolveGate.mock.calls[0] as [string, string, string];
    expect(decision).toBe('approve');
    expect((JSON.parse(payload) as CoordinationProposal).estimatedDispatches).toBe(3);
  });

  it('un re-render con la MISMA propuesta no tira la edición en curso', () => {
    const onResolveGate = vi.fn();
    const props = () => ({ ...base, gates: [gate(proposal({ estimatedDispatches: 8 }))], onResolveGate });
    const { container, rerender } = render(createElement(TeamCards, props()));
    fireEvent.click(screen.getByRole('button', { name: 'Editar y aprobar' }));
    fireEvent.change(dispatchesInput(container), { target: { value: '5' } });

    rerender(createElement(TeamCards, props()));

    expect(dispatchesInput(container).value).toBe('5');
  });
});

describe('la confirmación de presupuesto ilimitado no sobrevive a un cambio del campo', () => {
  const unlimited = () => proposal({ estimatedDispatches: null });

  it('tildar ilimitado, escribir un tope y volver a borrarlo deja la casilla DESTILDADA', () => {
    const onResolveGate = vi.fn();
    const { container } = render(createElement(TeamCards, { ...base, gates: [gate(unlimited())], onResolveGate }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar y aprobar' }));

    fireEvent.click(unlimitedBox(container));
    expect(unlimitedBox(container).checked).toBe(true);

    fireEvent.change(dispatchesInput(container), { target: { value: '7' } });
    fireEvent.change(dispatchesInput(container), { target: { value: '' } });

    expect(unlimitedBox(container).checked).toBe(false);
  });

  it('y confirmar ahí NO manda un `unlimitedConfirmedAt` que la persona no acaba de dar', () => {
    const onResolveGate = vi.fn();
    const { container } = render(createElement(TeamCards, { ...base, gates: [gate(unlimited())], onResolveGate }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar y aprobar' }));
    fireEvent.click(unlimitedBox(container));
    fireEvent.change(dispatchesInput(container), { target: { value: '7' } });
    fireEvent.change(dispatchesInput(container), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar edición y aprobar' }));

    const [, , payload] = onResolveGate.mock.calls[0] as [string, string, string];
    expect((JSON.parse(payload) as CoordinationProposal).unlimitedConfirmedAt).toBeNull();
  });

  it('tildar la casilla y confirmar sin tocar nada más SÍ manda la confirmación', () => {
    const onResolveGate = vi.fn();
    const { container } = render(createElement(TeamCards, { ...base, gates: [gate(unlimited())], onResolveGate }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar y aprobar' }));
    fireEvent.click(unlimitedBox(container));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar edición y aprobar' }));

    const [, , payload] = onResolveGate.mock.calls[0] as [string, string, string];
    expect((JSON.parse(payload) as CoordinationProposal).unlimitedConfirmedAt).not.toBeNull();
  });
});
