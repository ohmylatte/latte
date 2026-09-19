import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationGateView, CoordinationProposal, HandoffRequest, TeamMember } from '../shared/contracts';
import { DecisionsView, trimPlanWithoutRoles } from './DecisionsView';

/**
 * Q4: DESTILDAR UNA CONTRATACIÓN RECORTA EL PLAN, Y SE VE.
 *
 * `confirmEdit` filtraba `membersToHire` y mandaba `proposal.plan` intacto. Las
 * tareas del rol rechazado quedaban en el plan aprobado: nacían `ready`, el
 * primer despacho moría con `ROLE_NOT_APPROVED`, la tarea quedaba `failed` y
 * `recomputeReadiness` derribaba a sus dependientes. La persona destildaba UNA
 * contratación y se le caía media planificación, en silencio, después de haber
 * aprobado.
 */

const PROPOSAL: CoordinationProposal = {
  plan: [
    { roleId: 'strategist', spec: 'Definir el naming' },
    { roleId: 'copywriter', spec: 'Escribir el copy', dependsOn: [0] },
    { roleId: 'strategist', spec: 'Revisar el copy', dependsOn: [1] },
  ],
  membersToHire: [
    { roleId: 'strategist', why: 'no hay estratega' },
    { roleId: 'copywriter', why: 'no hay redactor' },
  ],
  estimatedDispatches: 10,
  rationale: 'Porque sí',
};

const GATE: CoordinationGateView = {
  id: 'g1', kind: 'proposal', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z',
  proposalJson: JSON.stringify(PROPOSAL),
};

const member = (roleId: string, status: TeamMember['status'] = 'idle'): TeamMember => ({
  id: 'mem_' + roleId, workId: 'w1', roleId, roleName: roleId, initial: roleId[0]!.toUpperCase(),
  runtime: 'claude', model: null, accountId: null, label: 'Claude', status, tier: 'balanced',
  usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});

const baseProps = {
  work: { id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', outcome: '', resultPath: null, folder: '', createdAt: '', updatedAt: '' },
  decisions: [], team: [] as readonly TeamMember[], roles: [], permissions: 'ask' as const, handoffs: [] as readonly HandoffRequest[],
  decisionAuthority: 'suggest' as const, draft: '', busy: false,
  formatDate: (v: string) => v, titlesByWork: {},
  onDraftChange: () => undefined, onAdd: () => undefined, onApprove: () => undefined, onEditApprove: () => undefined,
  onReject: () => undefined, onArchive: () => undefined, onAuthorityChange: () => undefined,
};

const mount = (extra: Record<string, unknown>) =>
  render(<I18nProvider><DecisionsView {...baseProps} {...(extra as Record<string, unknown>)} /></I18nProvider>);

/** Abre "Editar y aprobar" y devuelve las casillas de contratación, en orden. */
function openEdit(container: HTMLElement): HTMLInputElement[] {
  fireEvent.click(container.querySelector('.decision-gate-actions button:not(.primary)')!);
  const boxes = [...container.querySelectorAll<HTMLInputElement>('.decision-gate-edit-hire input[type="checkbox"]')];
  expect(boxes).toHaveLength(2); // la premisa del test existe de verdad
  return boxes;
}

describe('Q4: el recorte del plan al destildar una contratación', () => {
  it('destildar al redactor muestra cuántas tareas se van, contando las dependientes', () => {
    const { container } = mount({ gates: [GATE], onResolveGate: vi.fn() });
    const [, copywriter] = openEdit(container);

    expect(container.querySelector('.decision-gate-edit-dropped')).toBeNull();
    fireEvent.click(copywriter!);

    const note = container.querySelector('.decision-gate-edit-dropped');
    expect(note).not.toBeNull();
    // Dos: la del redactor y la del estratega que dependía de ella.
    expect(note!.textContent).toContain('2 tareas');
  });

  it('y el payload que se aprueba lleva el plan RECORTADO, con los `dependsOn` saneados', () => {
    const onResolveGate = vi.fn();
    const { container } = mount({ gates: [GATE], onResolveGate });
    const [, copywriter] = openEdit(container);
    fireEvent.click(copywriter!);

    fireEvent.click(container.querySelector('.decision-gate-edit-actions button.primary')!);

    expect(onResolveGate).toHaveBeenCalledTimes(1);
    const [gateId, decision, json] = onResolveGate.mock.calls[0]!;
    expect(gateId).toBe('g1');
    expect(decision).toBe('approve');
    const edited = JSON.parse(json as string) as CoordinationProposal;
    expect(edited.plan).toEqual([{ roleId: 'strategist', spec: 'Definir el naming' }]);
    expect(edited.membersToHire).toEqual([{ roleId: 'strategist', why: 'no hay estratega' }]);
  });

  it('un rol que YA está en el equipo no se recorta al destildar: no hay que contratarlo', () => {
    const onResolveGate = vi.fn();
    const { container } = mount({ gates: [GATE], onResolveGate, team: [member('copywriter')] });
    const [, copywriter] = openEdit(container);
    fireEvent.click(copywriter!);

    expect(container.querySelector('.decision-gate-edit-dropped')).toBeNull();
    fireEvent.click(container.querySelector('.decision-gate-edit-actions button.primary')!);
    const edited = JSON.parse(onResolveGate.mock.calls[0]![2] as string) as CoordinationProposal;
    expect(edited.plan).toHaveLength(3);
  });

  it('destildar todo deja el plan vacío: se dice, y no se puede aprobar', () => {
    const onResolveGate = vi.fn();
    const { container } = mount({ gates: [GATE], onResolveGate });
    const [strategist, copywriter] = openEdit(container);
    fireEvent.click(strategist!);
    fireEvent.click(copywriter!);

    expect(container.querySelector('.decision-gate-edit-empty')).not.toBeNull();
    const confirm = container.querySelector('.decision-gate-edit-actions button.primary') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onResolveGate).not.toHaveBeenCalled();
  });

  it('sin destildar nada el plan viaja entero, como siempre', () => {
    const onResolveGate = vi.fn();
    const { container } = mount({ gates: [GATE], onResolveGate });
    openEdit(container);
    fireEvent.click(container.querySelector('.decision-gate-edit-actions button.primary')!);
    const edited = JSON.parse(onResolveGate.mock.calls[0]![2] as string) as CoordinationProposal;
    expect(edited.plan).toEqual(PROPOSAL.plan);
  });
});

describe('Q4: el recorte, como cálculo', () => {
  it('arrastra transitivamente y remapea los índices', () => {
    const plan = [
      { roleId: 'a', spec: '0' },
      { roleId: 'x', spec: '1' },
      { roleId: 'a', spec: '2', dependsOn: [1] },
      { roleId: 'a', spec: '3', dependsOn: [2] },
      { roleId: 'a', spec: '4', dependsOn: [0] },
    ];
    const result = trimPlanWithoutRoles(plan, new Set(['x']));
    expect(result.removed).toBe(3);
    expect(result.plan).toEqual([
      { roleId: 'a', spec: '0' },
      { roleId: 'a', spec: '4', dependsOn: [0] },
    ]);
  });

  it('sin ningún rol sacado no toca nada', () => {
    const plan = [{ roleId: 'a', spec: '0' }, { roleId: 'b', spec: '1', dependsOn: [0] }];
    const result = trimPlanWithoutRoles(plan, new Set<string>());
    expect(result.removed).toBe(0);
    expect(result.plan).toEqual(plan);
  });
});
