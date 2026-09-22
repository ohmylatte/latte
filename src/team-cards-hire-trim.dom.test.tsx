import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationGateView, CoordinationProposal, CoordinationRunView, HandoffRequest, TeamMember } from '../shared/contracts';
import { TeamCards, trimPlanWithoutRoles } from './coordination/TeamCards';
import type { TeamCardsProps } from './coordination/TeamCards';

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

/**
 * Q6: la cobertura la calcula el MOTOR y llega en el gate. Esta pantalla ya no
 * recalcula el equipo desde `team`: dos respuestas distintas a "¿quién puede
 * hacer este rol?" es exactamente cómo una aprobación rebota con un error que
 * la pantalla no supo anticipar.
 */
const GATE: CoordinationGateView = {
  id: 'g1', kind: 'proposal', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z',
  proposalJson: JSON.stringify(PROPOSAL),
  roleCoverage: [{ roleId: 'strategist', coverage: 'hire' }, { roleId: 'copywriter', coverage: 'hire' }],
};

const member = (roleId: string, status: TeamMember['status'] = 'idle'): TeamMember => ({
  id: 'mem_' + roleId, workId: 'w1', roleId, roleName: roleId, initial: roleId[0]!.toUpperCase(), avatar: null,
  runtime: 'claude', model: null, accountId: null, label: 'Claude', status, tier: 'balanced',
  usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
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
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0,
};

const baseProps: TeamCardsProps = { memberId: 'coord', coordinationRun: runView, team: [], roles: [], formatDate: () => 'hace un rato' };

const mount = (extra: Record<string, unknown>) =>
  render(<I18nProvider><TeamCards {...baseProps} {...(extra as Record<string, unknown>)} /></I18nProvider>);

/** Abre "Editar y aprobar" y devuelve las casillas de contratación, en orden. */
function openEdit(container: HTMLElement): HTMLInputElement[] {
  fireEvent.click(container.querySelector('.team-card-actions button:not(.primary)')!);
  const boxes = [...container.querySelectorAll<HTMLInputElement>('.team-card-edit-hire input[type="checkbox"]')];
  expect(boxes).toHaveLength(2); // la premisa del test existe de verdad
  return boxes;
}

describe('Q4: el recorte del plan al destildar una contratación', () => {
  it('destildar al redactor muestra cuántas tareas se van, contando las dependientes', () => {
    const { container } = mount({ gates: [GATE], onResolveGate: vi.fn() });
    const [, copywriter] = openEdit(container);

    expect(container.querySelector('.team-card-edit-dropped')).toBeNull();
    fireEvent.click(copywriter!);

    const note = container.querySelector('.team-card-edit-dropped');
    expect(note).not.toBeNull();
    // Dos: la del redactor y la del estratega que dependía de ella.
    expect(note!.textContent).toContain('2 tareas');
  });

  it('y el payload que se aprueba lleva el plan RECORTADO, con los `dependsOn` saneados', () => {
    const onResolveGate = vi.fn();
    const { container } = mount({ gates: [GATE], onResolveGate });
    const [, copywriter] = openEdit(container);
    fireEvent.click(copywriter!);

    fireEvent.click(container.querySelector('.team-card-edit-actions button.primary')!);

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
    // Lo dice el gate (`member`), no la foto del renderer.
    const gate: CoordinationGateView = { ...GATE, roleCoverage: [{ roleId: 'strategist', coverage: 'hire' }, { roleId: 'copywriter', coverage: 'member' }] };
    const { container } = mount({ gates: [gate], onResolveGate, team: [member('copywriter')] });
    const [, copywriter] = openEdit(container);
    fireEvent.click(copywriter!);

    expect(container.querySelector('.team-card-edit-dropped')).toBeNull();
    fireEvent.click(container.querySelector('.team-card-edit-actions button.primary')!);
    const edited = JSON.parse(onResolveGate.mock.calls[0]![2] as string) as CoordinationProposal;
    expect(edited.plan).toHaveLength(3);
  });

  it('destildar todo deja el plan vacío: se dice, y no se puede aprobar', () => {
    const onResolveGate = vi.fn();
    const { container } = mount({ gates: [GATE], onResolveGate });
    const [strategist, copywriter] = openEdit(container);
    fireEvent.click(strategist!);
    fireEvent.click(copywriter!);

    expect(container.querySelector('.team-card-edit-empty')).not.toBeNull();
    const confirm = container.querySelector('.team-card-edit-actions button.primary') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onResolveGate).not.toHaveBeenCalled();
  });

  it('sin destildar nada el plan viaja entero, como siempre', () => {
    const onResolveGate = vi.fn();
    const { container } = mount({ gates: [GATE], onResolveGate });
    openEdit(container);
    fireEvent.click(container.querySelector('.team-card-edit-actions button.primary')!);
    const edited = JSON.parse(onResolveGate.mock.calls[0]![2] as string) as CoordinationProposal;
    expect(edited.plan).toEqual(PROPOSAL.plan);
  });
});

describe('Q6: los roles huérfanos, las altas sin tareas y lo que la pantalla muestra', () => {
  /** Una propuesta guardada por una base vieja: `copywriter` no lo cubre nadie. */
  const ORPHAN_GATE: CoordinationGateView = {
    id: 'g1', kind: 'proposal', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z',
    proposalJson: JSON.stringify({ ...PROPOSAL, membersToHire: [{ roleId: 'strategist', why: 'no hay estratega' }] }),
    roleCoverage: [{ roleId: 'strategist', coverage: 'hire' }, { roleId: 'copywriter', coverage: 'orphan' }],
  };

  it('el contador dice cuántas tareas se van por roles que nadie contrata', () => {
    const { container } = mount({ gates: [ORPHAN_GATE], onResolveGate: vi.fn() });

    const note = container.querySelector('.team-card-orphan-note');
    expect(note).not.toBeNull();
    // La del redactor y la del estratega que dependía de ella.
    expect(note!.textContent).toContain('2 tareas');
  });

  it('el "Aprobar" simple manda el plan RECORTADO: aprobar lo guardado rebotaría', () => {
    const onResolveGate = vi.fn();
    const { container } = mount({ gates: [ORPHAN_GATE], onResolveGate });

    fireEvent.click(container.querySelector('.team-card-actions button.primary')!);

    expect(onResolveGate).toHaveBeenCalledTimes(1);
    const [, decision, json] = onResolveGate.mock.calls[0]!;
    expect(decision).toBe('approve');
    const edited = JSON.parse(json as string) as CoordinationProposal;
    expect(edited.plan).toEqual([{ roleId: 'strategist', spec: 'Definir el naming' }]);
  });

  it('las tareas que se van se muestran aparte, y la lista principal es la que se aprueba', () => {
    const { container } = mount({ gates: [ORPHAN_GATE], onResolveGate: vi.fn() });

    const kept = [...container.querySelectorAll('.team-card-plan-list li')];
    expect(kept).toHaveLength(1);
    expect(kept[0]!.textContent).toContain('Definir el naming');
    const dropped = [...container.querySelectorAll('.team-card-plan-dropped-list li')];
    expect(dropped).toHaveLength(2);
    expect(dropped.map((li) => li.textContent).join(' ')).toContain('Escribir el copy');
  });

  it('un alta que se quedó sin tareas por arrastre se quita, y se dice', () => {
    const onResolveGate = vi.fn();
    // `analyst` sólo tiene la tarea que depende de la del redactor: al destildar
    // al redactor, esa tarea se cae y el analista se queda sin nada que hacer.
    const proposal: CoordinationProposal = {
      plan: [
        { roleId: 'copywriter', spec: 'Escribir el copy' },
        { roleId: 'analyst', spec: 'Medir el copy', dependsOn: [0] },
      ],
      membersToHire: [{ roleId: 'copywriter', why: 'no hay redactor' }, { roleId: 'analyst', why: 'nadie mide' }],
      estimatedDispatches: 10,
      rationale: 'Porque sí',
    };
    const gate: CoordinationGateView = {
      id: 'g1', kind: 'proposal', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z',
      proposalJson: JSON.stringify(proposal),
      roleCoverage: [{ roleId: 'copywriter', coverage: 'hire' }, { roleId: 'analyst', coverage: 'hire' }],
    };
    const { container } = mount({ gates: [gate], onResolveGate });
    fireEvent.click(container.querySelector('.team-card-actions button:not(.primary)')!);
    const boxes = [...container.querySelectorAll<HTMLInputElement>('.team-card-edit-hire input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);

    fireEvent.click(boxes[0]!); // se destilda al redactor, y el analista queda sin tareas

    const note = container.querySelector('.team-card-edit-hire-dropped');
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain('1 contratación');
    // Y el payload no lo contrata: un proceso levantado para alguien sin nada que hacer.
    expect(container.querySelector('.team-card-edit-empty')).not.toBeNull();
  });

  it('un alta que NUNCA tuvo tareas en el plan se respeta: puede ser deliberada', () => {
    const onResolveGate = vi.fn();
    const proposal: CoordinationProposal = {
      plan: [{ roleId: 'strategist', spec: 'Definir el naming' }],
      membersToHire: [{ roleId: 'strategist', why: 'no hay estratega' }, { roleId: 'analyst', why: 'para después' }],
      estimatedDispatches: 10,
      rationale: 'Porque sí',
    };
    const gate: CoordinationGateView = {
      id: 'g1', kind: 'proposal', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z',
      proposalJson: JSON.stringify(proposal),
      roleCoverage: [{ roleId: 'strategist', coverage: 'hire' }],
    };
    const { container } = mount({ gates: [gate], onResolveGate });
    fireEvent.click(container.querySelector('.team-card-actions button:not(.primary)')!);

    fireEvent.click(container.querySelector('.team-card-edit-actions button.primary')!);

    const edited = JSON.parse(onResolveGate.mock.calls[0]![2] as string) as CoordinationProposal;
    expect(edited.membersToHire).toEqual(proposal.membersToHire);
    expect(container.querySelector('.team-card-edit-hire-dropped')).toBeNull();
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
    expect(result.dropped).toEqual([false, false]);
  });

  /**
   * P13: la regla "un índice fuera de rango se cae" estaba escrita como un
   * accidente del lenguaje (`dropped[idx] !== false`, que da verdadero para el
   * `undefined` de un índice inexistente). Ahora es explícita, y este test lo
   * fija: el validador del motor ya no deja entrar un `dependsOn` así, pero una
   * fila vieja sí puede tenerlo y la pantalla no puede aprobar lo que el motor
   * no va a poder crear.
   */
  it('un `dependsOn` fuera de rango o negativo tira la tarea abajo', () => {
    const plan = [
      { roleId: 'a', spec: '0' },
      { roleId: 'a', spec: '1', dependsOn: [7] },
      { roleId: 'a', spec: '2', dependsOn: [-1] },
      { roleId: 'a', spec: '3', dependsOn: [1] },
    ];
    const result = trimPlanWithoutRoles(plan, new Set<string>());
    expect(result.dropped).toEqual([false, true, true, true]);
    expect(result.plan).toEqual([{ roleId: 'a', spec: '0' }]);
  });
});
