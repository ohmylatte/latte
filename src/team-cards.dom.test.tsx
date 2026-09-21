import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * Las cinco tarjetas de coordinacion, en su casa nueva (B1.1).
 *
 * Este archivo salio entero de `DecisionsView.dom.test.tsx`: las mismas
 * aserciones, contra `TeamCards`. Decisiones es una pantalla de MARCA y
 * permanente; cada coordinacion la llenaba de ruido, y para contestar algo que
 * el equipo pregunto EN la conversacion habia que salir de la conversacion.
 * Lo unico que cambio en las aserciones son las clases (`team-card-*`) y los
 * dos editores que eran `window.prompt` y ahora son campos inline.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { TeamCards } = await import('./coordination/TeamCards');
import type { TeamCardsProps } from './coordination/TeamCards';
import type { AgentRole, CoordinationAskView, CoordinationGateView, CoordinationProposal, CoordinationRunView } from '../shared/contracts';

const role = (patch: Partial<AgentRole> = {}): AgentRole => ({ id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Compara opciones.', builtin: false, tier: 'deep', ...patch });
const gateView = (patch: Partial<CoordinationGateView> = {}): CoordinationGateView => ({
  id: 'g1', kind: 'plan', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const askView = (patch: Partial<CoordinationAskView> = {}): CoordinationAskView => ({
  id: 'ask1', runId: 'run1', taskId: null, memberId: 'm1', question: '¿Seguimos con el mismo tono?',
  answer: null, deadlineAt: '2026-09-02T00:00:00.000Z', answeredAt: null, createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const proposal = (patch: Partial<CoordinationProposal> = {}): CoordinationProposal => ({
  plan: [{ roleId: 'copywriter', spec: 'Escribir 3 posts para el lanzamiento' }],
  estimatedDispatches: 8,
  membersToHire: [{ roleId: 'designer', why: 'Necesitamos piezas visuales para las 3 posts' }],
  rationale: 'El equipo actual no alcanza para el volumen del mes.',
  ...patch,
});
/** Un gate es una conversacion con el COORDINADOR: por defecto, el chat montado es el suyo. */
const runView = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

const base: TeamCardsProps = { memberId: 'coord', coordinationRun: runView(), team: [], roles: [], formatDate: () => 'hace un rato' };

function renderCards(locale: 'es-AR' | 'en-US', props: Partial<TeamCardsProps> = {}) {
  ui.locale = locale;
  return render(createElement(TeamCards, { ...base, ...props }));
}

describe('coordination gates (additive, autonomous-coordination Phase 7 tasks 7.4-7.6)', () => {
  it('does not render when the caller has not wired gate state', () => {
    const { container } = renderCards('es-AR');
    expect(container.querySelector('.team-cards')).toBeNull();
  });

  it('renders no section when wired but there is nothing pending — zero rows is never a zero', () => {
    const { container } = renderCards('es-AR', { gates: [], openAsks: [] });
    expect(container.querySelector('.team-cards')).toBeNull();
  });

  it('renders the plan, dispatch and budget gates simultaneously, plus an open ask', () => {
    const { container } = renderCards('es-AR', {
      // El coordinador es `m1` en este caso, para que los gates Y la pregunta
      // de `m1` caigan en el mismo chat: lo que este test mide es que las
      // cuatro tarjetas conviven, no el ruteo (eso lo mide
      // `team-cards-routing.dom.test.tsx`).
      memberId: 'm1', coordinationRun: runView({ coordinatorMemberId: 'm1' }),
      gates: [
        gateView({ id: 'g-plan', kind: 'plan' }),
        gateView({ id: 'g-dispatch', kind: 'dispatch', taskId: 't1', dispatchId: 'd1', prompt: 'Escribir el post de lanzamiento' }),
        gateView({ id: 'g-budget', kind: 'budget' }),
      ],
      openAsks: [askView()],
    });
    expect(container.querySelectorAll('.team-card-plan')).toHaveLength(1);
    expect(container.querySelectorAll('.team-card-dispatch')).toHaveLength(1);
    expect(container.querySelectorAll('.team-card-budget')).toHaveLength(1);
    expect(container.querySelectorAll('.team-card-ask')).toHaveLength(1);
    expect(container.textContent).toContain('Escribir el post de lanzamiento');
    expect(container.textContent).toContain('¿Seguimos con el mismo tono?');
  });

  it('gives the budget-exhausted gate exactly 2 actions — the three-action triple is a pattern, not a contract', () => {
    const { container } = renderCards('es-AR', { gates: [gateView({ id: 'g-budget', kind: 'budget' })], onResolveGate: () => {} });
    const actions = container.querySelectorAll('.team-card-budget .team-card-actions button');
    expect(actions).toHaveLength(2);
    expect([...actions].map((b) => b.textContent)).toEqual(['Aprobar', 'Rechazar']);
  });

  it('gives the plan gate exactly 2 actions too — there is nothing to edit at plan-approval, the engine ignores it', () => {
    const { container } = renderCards('es-AR', { gates: [gateView({ id: 'g-plan', kind: 'plan' })], onResolveGate: () => {} });
    const actions = container.querySelectorAll('.team-card-plan .team-card-actions button');
    expect(actions).toHaveLength(2);
  });

  it('gives the dispatch gate all 3 actions, since its prompt is genuinely editable', () => {
    const { container } = renderCards('es-AR', { gates: [gateView({ id: 'g-dispatch', kind: 'dispatch', prompt: 'Prompt original' })], onResolveGate: () => {} });
    const actions = container.querySelectorAll('.team-card-dispatch .team-card-actions button');
    expect(actions).toHaveLength(3);
  });

  it('resolves the plan and budget gates through the real approve/reject verb', () => {
    const onResolveGate = vi.fn();
    const { container } = renderCards('es-AR', {
      gates: [gateView({ id: 'g-plan', kind: 'plan' }), gateView({ id: 'g-budget', kind: 'budget' })],
      onResolveGate,
    });
    fireEvent.click(container.querySelector('.team-card-plan .team-card-actions button')!);
    expect(onResolveGate).toHaveBeenCalledWith('g-plan', 'approve');
    const budgetButtons = container.querySelectorAll('.team-card-budget .team-card-actions button');
    fireEvent.click(budgetButtons[1]);
    expect(onResolveGate).toHaveBeenCalledWith('g-budget', 'reject');
  });

  it('edits the dispatch prompt and approves the edited payload through the same verb every other gate uses', () => {
    const onResolveGate = vi.fn();
    // B1.1: el editor es un <textarea> INLINE. `window.prompt` es un cuadro
    // del sistema operativo, de una linea y sin formato: no es un lugar donde
    // nadie pueda leer -- mucho menos editar -- un prompt de despacho.
    const nativePrompt = vi.spyOn(window, 'prompt');
    const { container } = renderCards('es-AR', { gates: [gateView({ id: 'g-dispatch', kind: 'dispatch', prompt: 'Prompt original' })], onResolveGate });
    const actions = container.querySelectorAll('.team-card-dispatch .team-card-actions button');
    fireEvent.click(actions[1]); // Editar y aprobar
    const area = container.querySelector('.team-card-edit-prompt') as HTMLTextAreaElement;
    expect(area.value).toBe('Prompt original');
    fireEvent.change(area, { target: { value: 'Prompt editado' } });
    fireEvent.click(container.querySelector('.team-card-dispatch .team-card-edit-actions button.primary')!);
    expect(onResolveGate).toHaveBeenCalledWith('g-dispatch', 'approve', 'Prompt editado');
    expect(nativePrompt).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('answers an open ask through onAnswerAsk, never through onResolveGate', () => {
    const onAnswerAsk = vi.fn();
    const onResolveGate = vi.fn();
    const nativePrompt = vi.spyOn(window, 'prompt');
    // La pregunta la hizo `m1`, asi que su tarjeta vive en el chat de `m1`.
    const { container } = renderCards('es-AR', { memberId: 'm1', openAsks: [askView({ id: 'ask1' })], onAnswerAsk, onResolveGate });
    fireEvent.change(container.querySelector('.team-card-answer')!, { target: { value: 'Sí, mismo tono' } });
    fireEvent.click(container.querySelector('.team-card-ask .team-card-actions button')!);
    expect(onAnswerAsk).toHaveBeenCalledWith('ask1', 'Sí, mismo tono');
    expect(onResolveGate).not.toHaveBeenCalled();
    expect(nativePrompt).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  describe('the proposal gate — the WOW surface (task 7.5)', () => {
    it('renders the plan, the hires with their reasons, the budget and the rationale, offering exactly the 3 real actions', () => {
      const { container } = renderCards('es-AR', {
        gates: [gateView({
          id: 'g-proposal', kind: 'proposal',
          proposalJson: JSON.stringify(proposal()),
          aggregate: { otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 },
        })],
        roles: [role({ id: 'copywriter', name: 'Redactor' }), role({ id: 'designer', name: 'Diseñador' })],
        // N10: las tres acciones existen PORQUE hay un handler. Sin
        // `onResolveGate` la tarjeta es de sólo lectura y no las ofrece —ver
        // `decisions-round7-proposal.dom.test.tsx`—; la app siempre lo pasa.
        onResolveGate: vi.fn(),
      });
      const card = container.querySelector('.team-card-proposal')!;
      expect(card).not.toBeNull();
      expect(card.textContent).toContain('Redactor');
      expect(card.textContent).toContain('Escribir 3 posts para el lanzamiento');
      expect(card.textContent).toContain('Diseñador');
      expect(card.textContent).toContain('Necesitamos piezas visuales');
      expect(card.textContent).toContain('El equipo actual no alcanza para el volumen del mes.');
      expect(card.textContent).toContain('8');
      const actions = card.querySelectorAll('.team-card-actions button');
      expect(actions).toHaveLength(3);
    });

    it('asserts there is no separate settings form anywhere in the flow: no dropdown, no modal dialog, just the plan', () => {
      const { container } = renderCards('es-AR', {
        gates: [gateView({ id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal()), aggregate: { otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 } })],
        onResolveGate: vi.fn(), // N10: sin handler no hay botones que abrir
      });
      const card = container.querySelector('.team-card-proposal')!;
      // L6 (ronda 9): "en este flujo", como el inglés lo dice desde siempre.
      // La frase vieja afirmaba que no existe NINGÚN formulario de
      // configuración, y sí existe: el tope global de despachos se escribe en
      // una pantalla de la app. Lo cierto es lo acotado: acá, decidiendo esta
      // propuesta, no hay nada que configurar — que es exactamente lo que este
      // test mide.
      expect(card.textContent).toContain('En este flujo no hay ningún formulario de configuración');
      expect(card.querySelector('select')).toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      // Even after opening the edit affordance, still no dialog and no dropdown.
      fireEvent.click(card.querySelectorAll('.team-card-actions button')[1]);
      expect(card.querySelector('select')).toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    it('lets you drop a hire and lower the cap, approving the EDITED payload through resolveCoordinationGate(id,"approve",edited)', () => {
      const onResolveGate = vi.fn();
      const { container } = renderCards('es-AR', {
        gates: [gateView({ id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal()), aggregate: { otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 } })],
        onResolveGate,
      });
      const card = container.querySelector('.team-card-proposal')!;
      fireEvent.click(card.querySelectorAll('.team-card-actions button')[1]); // Editar y aprobar
      const numberInput = card.querySelector('input[type="number"]') as HTMLInputElement;
      fireEvent.change(numberInput, { target: { value: '3' } });
      const hireCheckbox = card.querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(hireCheckbox);
      fireEvent.click(screen.getByText('Confirmar edición y aprobar'));
      expect(onResolveGate).toHaveBeenCalledTimes(1);
      const [gateId, decision, editedJson] = onResolveGate.mock.calls[0];
      expect(gateId).toBe('g-proposal');
      expect(decision).toBe('approve');
      const edited = JSON.parse(editedJson as string) as CoordinationProposal;
      expect(edited.estimatedDispatches).toBe(3);
      expect(edited.membersToHire).toEqual([]);
    });

    it('discard grants nothing: reject calls onResolveGate with no edited payload', () => {
      const onResolveGate = vi.fn();
      const { container } = renderCards('es-AR', {
        gates: [gateView({ id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal()), aggregate: { otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 } })],
        onResolveGate,
      });
      const card = container.querySelector('.team-card-proposal')!;
      const actions = card.querySelectorAll('.team-card-actions button');
      fireEvent.click(actions[2]); // Rechazar
      expect(onResolveGate).toHaveBeenCalledWith('g-proposal', 'reject');
      expect(onResolveGate).not.toHaveBeenCalledWith('g-proposal', 'reject', expect.anything());
    });
  });

  /**
   * O1: EL "APROBAR" SIMPLE NO PUEDE MANDAR LO QUE LA PANTALLA NO MUESTRA.
   *
   * `confirmEdit` cerraba el editor en el mismo tick del clic, sin esperar al
   * motor. Cuando el motor rechazaba, el gate seguía en pantalla con el editor
   * CERRADO, las casillas destildadas perdidas y el "Aprobar" simple de vuelta:
   * un clic más mandaba `onResolveGate(id,'approve')` sin payload, o sea el
   * plan GUARDADO entero, con todas las altas que la persona había rechazado.
   */
  describe('O1: el editor cierra cuando el motor acepta, y el "Aprobar" simple sólo existe intacto', () => {
    const twoHires = () => proposal({
      plan: [
        { roleId: 'copywriter', spec: 'Escribir los textos' },
        { roleId: 'designer', spec: 'Diseñar las piezas' },
      ],
      membersToHire: [
        { roleId: 'copywriter', why: 'Nadie escribe todavía' },
        { roleId: 'designer', why: 'Nadie diseña todavía' },
      ],
    });
    const proposalGate = () => gateView({
      id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(twoHires()),
      aggregate: { otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 },
    });

    it('la mutación RECHAZA: el editor queda abierto, las casillas intactas y no reaparece el "Aprobar" simple', async () => {
      const onResolveGate = vi.fn().mockRejectedValue(new Error('DEPTH_CAP'));
      const { container } = renderCards('es-AR', { gates: [proposalGate()], onResolveGate });
      const card = container.querySelector('.team-card-proposal')!;
      fireEvent.click(screen.getByText('Editar y aprobar'));
      const boxes = () => [...card.querySelectorAll('.team-card-edit-hire input[type="checkbox"]')] as HTMLInputElement[];
      expect(boxes()).toHaveLength(2); // la premisa: el editor SÍ se abrió
      fireEvent.click(boxes()[1]!); // destildo al diseñador

      fireEvent.click(screen.getByText('Confirmar edición y aprobar'));
      await waitFor(() => expect(onResolveGate).toHaveBeenCalledTimes(1));

      // El editor sigue abierto, con la casilla destildada como la dejó.
      expect(card.querySelector('.team-card-edit')).not.toBeNull();
      expect(boxes().map((b) => b.checked)).toEqual([true, false]);
      // Y NO hay ningún botón "Aprobar" pelado que pueda mandar el plan guardado.
      const labels = [...card.querySelectorAll('button')].map((b) => b.textContent);
      expect(labels).not.toContain('Aprobar');
    });

    it('la mutación resuelve `false` (el contrato de `useCoordination`): el editor tampoco cierra', async () => {
      const onResolveGate = vi.fn().mockResolvedValue(false);
      const { container } = renderCards('es-AR', { gates: [proposalGate()], onResolveGate });
      const card = container.querySelector('.team-card-proposal')!;
      fireEvent.click(screen.getByText('Editar y aprobar'));
      fireEvent.click(card.querySelectorAll('.team-card-edit-hire input[type="checkbox"]')[1]!);

      fireEvent.click(screen.getByText('Confirmar edición y aprobar'));
      await waitFor(() => expect(onResolveGate).toHaveBeenCalledTimes(1));

      expect(card.querySelector('.team-card-edit')).not.toBeNull();
    });

    it('la mutación resuelve bien: el editor cierra', async () => {
      const onResolveGate = vi.fn().mockResolvedValue(true);
      const { container } = renderCards('es-AR', { gates: [proposalGate()], onResolveGate });
      const card = container.querySelector('.team-card-proposal')!;
      fireEvent.click(screen.getByText('Editar y aprobar'));
      fireEvent.click(card.querySelectorAll('.team-card-edit-hire input[type="checkbox"]')[1]!);

      fireEvent.click(screen.getByText('Confirmar edición y aprobar'));

      await waitFor(() => expect(card.querySelector('.team-card-edit')).toBeNull());
    });

    it('el formulario MODIFICADO no ofrece "Aprobar" simple; cancelar la edición lo devuelve', () => {
      const { container } = renderCards('es-AR', { gates: [proposalGate()], onResolveGate: vi.fn() });
      const card = container.querySelector('.team-card-proposal')!;
      const labels = () => [...card.querySelectorAll('.team-card-actions button')].map((b) => b.textContent);
      // Intacto, el botón existe: la premisa de este test.
      expect(labels()).toContain('Aprobar');

      // Con el editor ABIERTO y el formulario intacto sigue estando: lo que lo
      // esconde es la edición, no el editor.
      fireEvent.click(screen.getByText('Editar y aprobar'));
      expect(labels()).toContain('Aprobar');

      // Basta destildar un alta para que desaparezca: el único camino pasa a
      // ser el payload derivado.
      fireEvent.click(card.querySelectorAll('.team-card-edit-hire input[type="checkbox"]')[1]!);
      expect(labels()).not.toContain('Aprobar');

      // Y con el tope cambiado, lo mismo.
      fireEvent.click(card.querySelectorAll('.team-card-edit-hire input[type="checkbox"]')[1]!); // vuelvo a tildar
      expect(labels()).toContain('Aprobar');
      fireEvent.change(card.querySelector('input[type="number"]') as HTMLInputElement, { target: { value: '3' } });
      expect(labels()).not.toContain('Aprobar');

      fireEvent.click(screen.getByText('Cancelar edición')); // vuelve al estado inicial
      expect(labels()).toContain('Aprobar');
    });
  });

  /**
   * O3: LO QUE SE CAE SE VE, SE ABRA O NO LA EDICIÓN.
   *
   * Los avisos de "se quitan N tareas" y "se quita N contratación sin tareas"
   * vivían dentro del bloque `{editing && ...}`, y la lista de contrataciones
   * no tachaba nada. Por el camino de "Aprobar" simple —un plan con un rol
   * huérfano que arrastra la única tarea de un alta— el payload salía sin esa
   * alta y la persona nunca se enteraba: leía una contratación que no iba a
   * ocurrir.
   *
   * O12: y un plan ENTERAMENTE huérfano dejaba los dos botones primarios
   * grises, sin una palabra afuera de la edición.
   */
  describe('O3/O12: el recorte automático se ve sin abrir la edición', () => {
    /**
     * Un huérfano (`ghost`) y un alta (`designer`) cuya única tarea depende de
     * la del huérfano: al caerse el huérfano cae la tarea del diseñador por
     * arrastre, y con ella el alta.
     */
    const orphanGate = () => gateView({
      id: 'g-proposal', kind: 'proposal',
      proposalJson: JSON.stringify(proposal({
        plan: [
          { roleId: 'ghost', spec: 'La que nadie puede hacer' },
          { roleId: 'designer', spec: 'La que depende de la anterior', dependsOn: [0] },
        ],
        membersToHire: [{ roleId: 'designer', why: 'Nadie diseña todavía' }],
      })),
      roleCoverage: [{ roleId: 'ghost', coverage: 'orphan' }, { roleId: 'designer', coverage: 'hire' }],
    });

    it('la nota del alta caída y su renglón tachado se ven SIN abrir la edición, y el payload no la lleva', () => {
      const onResolveGate = vi.fn();
      const { container } = renderCards('es-AR', {
        gates: [orphanGate()],
        roles: [role({ id: 'designer', name: 'Diseñador' })],
        onResolveGate,
      });
      const card = container.querySelector('.team-card-proposal')!;
      // Sin tocar "Editar y aprobar": el editor ni existe.
      expect(card.querySelector('.team-card-edit')).toBeNull();

      expect(card.querySelector('.team-card-edit-hire-dropped')).not.toBeNull();
      const dropped = card.querySelector('.team-card-hire-dropped')!;
      expect(dropped).not.toBeNull();
      expect(dropped.querySelector('s')!.textContent).toContain('Diseñador');
      expect(dropped.textContent).toContain('se quedó sin tareas');

      // O12: con TODO el plan caído, la frase de la única salida.
      expect(card.querySelector('.team-card-empty-plan')!.textContent).toContain('Ninguna tarea del plan tiene quien la haga');

      // Y si hubiera algo que aprobar, el payload no llevaría esa alta. Acá no
      // queda nada, así que el botón está deshabilitado: se comprueba que no
      // mandó nada.
      expect(onResolveGate).not.toHaveBeenCalled();
    });

    it('con una tarea que SÍ sobrevive, el "Aprobar" manda el payload derivado sin el alta caída', () => {
      const onResolveGate = vi.fn();
      const { container } = renderCards('es-AR', {
        gates: [gateView({
          id: 'g-proposal', kind: 'proposal',
          proposalJson: JSON.stringify(proposal({
            plan: [
              { roleId: 'ghost', spec: 'La que nadie puede hacer' },
              { roleId: 'designer', spec: 'La que depende de la anterior', dependsOn: [0] },
              { roleId: 'copywriter', spec: 'La que se puede hacer igual' },
            ],
            membersToHire: [{ roleId: 'designer', why: 'Nadie diseña todavía' }],
          })),
          roleCoverage: [
            { roleId: 'ghost', coverage: 'orphan' },
            { roleId: 'designer', coverage: 'hire' },
            { roleId: 'copywriter', coverage: 'member' },
          ],
        })],
        onResolveGate,
      });
      const card = container.querySelector('.team-card-proposal')!;
      // El alta tachada, y la frase de plan vacío NO (queda una tarea).
      expect(card.querySelector('.team-card-hire-dropped')).not.toBeNull();
      expect(card.querySelector('.team-card-empty-plan')).toBeNull();

      fireEvent.click(screen.getByText('Aprobar'));

      const [, , editedJson] = onResolveGate.mock.calls[0]!;
      const edited = JSON.parse(editedJson as string) as CoordinationProposal;
      expect(edited.membersToHire).toEqual([]);
      expect(edited.plan.map((task) => task.roleId)).toEqual(['copywriter']);
    });

    it('sin nada que recortar no se inventa ninguna nota ni ningún tachado', () => {
      const { container } = renderCards('es-AR', {
        gates: [gateView({ id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal()) })],
      });
      const card = container.querySelector('.team-card-proposal')!;
      expect(card.querySelector('.team-card-hire-dropped')).toBeNull();
      expect(card.querySelector('.team-card-edit-hire-dropped')).toBeNull();
      expect(card.querySelector('.team-card-empty-plan')).toBeNull();
      expect(card.querySelector('.team-card-edit-dropped')).toBeNull();
    });
  });

  describe('the aggregate — never hidden (task 7.6)', () => {
    it('shows this work, other teams now, and the total if approved', () => {
      const { container } = renderCards('es-AR', {
        gates: [gateView({
          id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal({ estimatedDispatches: 8 })),
          aggregate: { otherActiveRuns: 2, otherCommittedDispatches: 10, totalIfApproved: 18 },
        })],
      });
      const text = container.querySelector('.team-card-proposal')!.textContent!;
      expect(text).toContain('8');
      expect(text).toContain('2');
      expect(text).toContain('10');
      expect(text).toContain('18');
    });

    it('says so instead of printing a fabricated total when another run is explicitly unlimited', () => {
      const { container } = renderCards('es-AR', {
        gates: [gateView({
          id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal({ estimatedDispatches: 8 })),
          aggregate: { otherActiveRuns: 1, otherCommittedDispatches: null, totalIfApproved: null },
        })],
      });
      const text = container.querySelector('.team-card-proposal')!.textContent!;
      expect(text).toContain('no podemos calcular el total');
      expect(text).not.toContain('null');
    });
  });

  it('renders the same gates in English, with nothing left in Spanish', () => {
    const { container } = renderCards('en-US', {
      gates: [
        gateView({ id: 'g-budget', kind: 'budget' }),
        gateView({
          id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal({ estimatedDispatches: 8 })),
          aggregate: { otherActiveRuns: 1, otherCommittedDispatches: null, totalIfApproved: null },
        }),
      ],
    });
    expect(container.textContent).toContain('Budget exhausted');
    expect(container.textContent).toContain('COORDINATION PROPOSAL');
    expect(container.textContent).toContain('cannot calculate a total');
    expect(container.textContent).toContain('There is no settings form');
    for (const spanish of ['Presupuesto agotado', 'PROPUESTA DE COORDINACIÓN', 'no podemos calcular']) {
      expect(container.textContent).not.toContain(spanish);
    }
  });
});

