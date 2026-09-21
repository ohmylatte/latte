import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { AgentRole, CoordinationGateView, CoordinationProposal, CoordinationRunView, Work } from '../shared/contracts';

/**
 * Ronda 7 sobre la tarjeta de la propuesta:
 *
 *  - N7: un alta que la persona DESTILDÓ no se tacha con "se quedó sin
 *        tareas". Ese motivo es falso: la sacó ella, y el tachado le atribuye
 *        una consecuencia del plan a una decisión suya.
 *  - N8: las ramas de "ilimitado" de la propuesta GUARDADA eran inalcanzables
 *        (`requestCoordination` exige un entero y fuerza `unlimitedConfirmedAt:
 *        null`). La casilla del EDITOR sí existe y sí se alcanza.
 *  - N10: sin `onResolveGate` la tarjeta es de sólo lectura, en vez de cerrar
 *         el editor sobre una aprobación que nunca salió.
 */

const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña.',
  folder: null, updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const role = (patch: Partial<AgentRole> = {}): AgentRole => ({ id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Compara opciones.', builtin: false, tier: 'deep', ...patch });
const gateView = (patch: Partial<CoordinationGateView> = {}): CoordinationGateView => ({
  id: 'g-proposal', kind: 'proposal', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const proposal = (patch: Partial<CoordinationProposal> = {}): CoordinationProposal => ({
  plan: [{ roleId: 'copywriter', spec: 'Escribir 3 posts para el lanzamiento' }],
  estimatedDispatches: 8,
  membersToHire: [{ roleId: 'designer', why: 'Necesitamos piezas visuales' }],
  rationale: 'El equipo actual no alcanza para el volumen del mes.',
  ...patch,
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

beforeEach(() => { ui.locale = 'es-AR'; });

function renderView(props: Partial<TeamCardsProps> = {}) {
  return render(createElement(TeamCards, { ...base, ...props }));
}

const card = (container: HTMLElement) => container.querySelector('.team-card-proposal')!;

describe('N7: un alta destildada no se tacha con un motivo falso', () => {
  /**
   * Dos altas. La persona destilda una en el editor; la otra queda tildada y
   * su rol sobrevive. La destildada NO puede leerse "No se contrata: se quedó
   * sin tareas" — la sacó ella, y la casilla ya lo dice.
   */
  const twoHires = () => gateView({
    proposalJson: JSON.stringify(proposal({
      plan: [
        { roleId: 'copywriter', spec: 'Escribir los posts' },
        { roleId: 'designer', spec: 'Diseñar las piezas' },
      ],
      membersToHire: [
        { roleId: 'copywriter', why: 'Nadie escribe todavía' },
        { roleId: 'designer', why: 'Nadie diseña todavía' },
      ],
    })),
    roleCoverage: [{ roleId: 'copywriter', coverage: 'hire' }, { roleId: 'designer', coverage: 'hire' }],
  });

  it('la destildada se marca como sacada por la persona, sin tachado ni "se quedó sin tareas"', () => {
    const { container } = renderView({
      gates: [twoHires()],
      roles: [role({ id: 'copywriter', name: 'Redactor' }), role({ id: 'designer', name: 'Diseñador' })],
      onResolveGate: vi.fn(),
    });
    fireEvent.click(screen.getByText('Editar y aprobar'));
    const boxes = card(container).querySelectorAll<HTMLInputElement>('.team-card-edit-hire input');
    expect(boxes).toHaveLength(2); // la premisa
    fireEvent.click(boxes[1]!); // destilda al diseñador

    const items = card(container).querySelectorAll('.team-card-hire-list li');
    expect(items).toHaveLength(2);
    const designer = [...items].find((li) => li.textContent?.includes('Diseñador'))!;
    expect(designer).toBeDefined();
    expect(designer.className).toContain('team-card-hire-unticked');
    expect(designer.querySelector('s')).toBeNull();
    expect(designer.textContent).not.toContain('se quedó sin tareas');
    expect(designer.textContent).toContain('La sacaste vos');
  });

  it('la que la persona dejó tildada y se quedó sin tareas por arrastre SÍ se tacha con ese motivo', () => {
    const { container } = renderView({
      gates: [gateView({
        proposalJson: JSON.stringify(proposal({
          plan: [
            { roleId: 'ghost', spec: 'La que nadie puede hacer' },
            { roleId: 'designer', spec: 'La que depende de la anterior', dependsOn: [0] },
          ],
          membersToHire: [{ roleId: 'designer', why: 'Nadie diseña todavía' }],
        })),
        roleCoverage: [{ roleId: 'ghost', coverage: 'orphan' }, { roleId: 'designer', coverage: 'hire' }],
      })],
      roles: [role({ id: 'designer', name: 'Diseñador' })],
      onResolveGate: vi.fn(),
    });

    const dropped = card(container).querySelector('.team-card-hire-dropped')!;
    expect(dropped).not.toBeNull();
    expect(dropped.querySelector('s')!.textContent).toContain('Diseñador');
    expect(dropped.textContent).toContain('se quedó sin tareas');
    expect(dropped.className).not.toContain('team-card-hire-unticked');
  });

  /**
   * La comparación es por ÍNDICE. Con dos altas del mismo rol y el mismo
   * motivo —una propuesta repetida, que nada impide— `hiresToSend.includes(hire)`
   * decidía por referencia sobre objetos que el `filter` conserva, y bastaba
   * con que uno sobreviviera para que la lista tratara a los dos igual.
   */
  it('dos altas idénticas no se confunden entre sí', () => {
    const { container } = renderView({
      gates: [gateView({
        proposalJson: JSON.stringify(proposal({
          plan: [{ roleId: 'designer', spec: 'Diseñar' }],
          membersToHire: [
            { roleId: 'designer', why: 'Nadie diseña' },
            { roleId: 'designer', why: 'Nadie diseña' },
          ],
        })),
        roleCoverage: [{ roleId: 'designer', coverage: 'hire' }],
      })],
      roles: [role({ id: 'designer', name: 'Diseñador' })],
      onResolveGate: vi.fn(),
    });
    fireEvent.click(screen.getByText('Editar y aprobar'));
    const boxes = card(container).querySelectorAll<HTMLInputElement>('.team-card-edit-hire input');
    fireEvent.click(boxes[0]!); // destilda SÓLO la primera

    const items = [...card(container).querySelectorAll('.team-card-hire-list li')];
    expect(items).toHaveLength(2);
    expect(items[0]!.className).toContain('team-card-hire-unticked');
    expect(items[1]!.className).not.toContain('team-card-hire-unticked');
  });
});

describe('N8: la casilla de ilimitado del EDITOR sigue viva; las ramas muertas de la tarjeta no', () => {
  it('borrar el número y tildar la casilla: no hay "Aprobar" simple y el payload lleva la confirmación', () => {
    const onResolveGate = vi.fn().mockResolvedValue(true);
    const { container } = renderView({ gates: [gateView({ proposalJson: JSON.stringify(proposal()) })], onResolveGate });
    // Con el formulario intacto, el "Aprobar" simple existe: la premisa.
    expect(screen.queryByText('Aprobar')).not.toBeNull();

    fireEvent.click(screen.getByText('Editar y aprobar'));
    const number = card(container).querySelector<HTMLInputElement>('.team-card-edit input[type="number"]')!;
    fireEvent.change(number, { target: { value: '' } });
    const unlimited = card(container).querySelector<HTMLInputElement>('.team-card-edit-unlimited input')!;
    expect(unlimited).not.toBeNull(); // la casilla del editor es alcanzable
    fireEvent.click(unlimited);

    // Un formulario modificado no puede convivir con el "Aprobar" simple, que
    // mandaría la propuesta GUARDADA y no lo que la pantalla muestra.
    expect(screen.queryByText('Aprobar')).toBeNull();

    fireEvent.click(screen.getByText('Confirmar edición y aprobar'));
    const [, , editedJson] = onResolveGate.mock.calls[0]!;
    const edited = JSON.parse(editedJson as string) as CoordinationProposal;
    expect(edited.estimatedDispatches).toBeNull();
    expect(edited.unlimitedConfirmedAt).not.toBeNull();
  });

  it('la tarjeta de una propuesta guardada muestra su tope y ninguna frase de ilimitado', () => {
    const { container } = renderView({ gates: [gateView({ proposalJson: JSON.stringify(proposal({ estimatedDispatches: 8 })) })], onResolveGate: vi.fn() });
    const text = card(container).textContent ?? '';
    expect(text).toContain('8');
    expect(text).not.toContain('Sin tope');
    // Y no queda ningún aviso de "confirmá el ilimitado": esa rama no existe.
    expect(card(container).querySelector('.team-card-unlimited-note')).toBeNull();
  });
});

describe('N10: sin handler la tarjeta es de sólo lectura', () => {
  it('no se renderizan los botones que no pueden hacer nada', () => {
    const { container } = renderView({ gates: [gateView({ proposalJson: JSON.stringify(proposal()) })] });
    const actions = card(container).querySelector('.team-card-actions');
    expect(actions).toBeNull();
    expect(screen.queryByText('Aprobar')).toBeNull();
    expect(screen.queryByText('Editar y aprobar')).toBeNull();
    expect(screen.queryByText('Rechazar')).toBeNull();
    // Pero el contenido sí se lee: sólo lectura, no invisible.
    expect(card(container).textContent).toContain('Escribir 3 posts para el lanzamiento');
  });

  it('con handler, los tres botones vuelven', () => {
    renderView({ gates: [gateView({ proposalJson: JSON.stringify(proposal()) })], onResolveGate: vi.fn() });
    expect(screen.queryByText('Aprobar')).not.toBeNull();
    expect(screen.queryByText('Editar y aprobar')).not.toBeNull();
    expect(screen.queryByText('Rechazar')).not.toBeNull();
  });
});
