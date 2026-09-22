import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * El tope de despachos del Trabajo, en su casa nueva (B1.3).
 *
 * Estos casos salieron de `decisions-finished-run.dom.test.tsx`. El tope no es
 * una decision de marca: es como trabaja ESTE equipo, y vive al pie del panel
 * del equipo, en modo avanzado. Las aserciones son las mismas; lo que cambio
 * son las clases y la casa.
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
import type { CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const member: TeamMember = {
  id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E', avatar: null, runtime: 'claude', model: null,
  accountId: null, label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
};
const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

const base: TeamViewProps = {
  work, team: [member], roles: [], mode: 'advanced', busy: false,
  selectedMemberId: null, onSelectMember: () => {},
};

const mountAdvanced = (props: Partial<TeamViewProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(TeamView, { ...base, ...props }));
};

/**
 * U4: el presupuesto de este Trabajo se puede ESCRIBIR.
 *
 * `setCoordinationBudget` existia en la IPC y no tenia un solo llamador en el
 * renderer. Peor: el copy del estado `invalid` promete "hasta que lo escribas
 * de nuevo, cada despacho se deniega" y no habia donde escribirlo. La persona
 * quedaba encerrada, con cada despacho denegado y una frase que la mandaba a
 * un campo que no existia.
 */
describe('el presupuesto de este Trabajo, editable', () => {
  const budgetEditor = (container: HTMLElement) => container.querySelector('.team-advanced-budget-edit');
  const input = (container: HTMLElement) => container.querySelector('.team-advanced-budget-input') as HTMLInputElement;
  const save = (container: HTMLElement) => container.querySelector('.team-advanced-budget-save') as HTMLButtonElement;

  for (const state of ['unset', 'set', 'invalid'] as const) {
    it(`el editor esta disponible en \`${state}\``, () => {
      const budget = state === 'set' ? { state, budget: { maxDispatches: 5, unlimitedConfirmedAt: null } } as const : { state } as const;
      const { container } = mountAdvanced({ coordinationAuthority: 'manual', coordinationBudget: budget, onSetCoordinationBudget: () => {} });
      expect(budgetEditor(container)).not.toBeNull();
    });
  }

  it('desde `invalid`, guardar manda el numero que la persona escribio', () => {
    const onSetCoordinationBudget = vi.fn();
    const { container } = mountAdvanced({ coordinationAuthority: 'manual', coordinationBudget: { state: 'invalid' }, onSetCoordinationBudget });
    fireEvent.change(input(container), { target: { value: '12' } });
    fireEvent.click(save(container));
    expect(onSetCoordinationBudget).toHaveBeenCalledWith(12);
  });

  it('un valor que no es un entero positivo no manda nada: el boton esta deshabilitado', () => {
    const onSetCoordinationBudget = vi.fn();
    const { container } = mountAdvanced({ coordinationAuthority: 'manual', coordinationBudget: { state: 'unset' }, onSetCoordinationBudget });
    expect(save(container).disabled).toBe(true); // vacio
    for (const bad of ['0', '-3', '2.5', 'hola']) {
      fireEvent.change(input(container), { target: { value: bad } });
      fireEvent.click(save(container));
    }
    expect(onSetCoordinationBudget).not.toHaveBeenCalled();
  });

  it('sin `onSetCoordinationBudget` (un llamador sin cablear) no aparece ningun editor', () => {
    const { container } = mountAdvanced({ coordinationAuthority: 'manual', coordinationBudget: { state: 'invalid' } });
    expect(budgetEditor(container)).toBeNull();
  });
});

/**
 * P6: EL PRESUPUESTO ILEGIBLE DEL RUN EN CURSO SE VE.
 *
 * `CoordinationRunView.budgetInvalid` lo calcula el motor y lo publica desde
 * siempre, y ninguna pantalla del Trabajo lo renderizaba: el equipo tenía cada
 * despacho denegado contra unos bytes rotos y la persona no tenía dónde
 * enterarse. Va en la sección de presupuesto, al lado del editor que es la
 * salida.
 */
describe('P6: el presupuesto ilegible del run en curso', () => {
  const invalidNote = (container: HTMLElement) => container.querySelector('.team-advanced-run-budget-invalid');

  it('se dice, en la sección de presupuesto, junto al editor', () => {
    const { container } = mountAdvanced({
      coordinationAuthority: 'manual',
      coordinationBudget: { state: 'set', budget: { maxDispatches: 5, unlimitedConfirmedAt: null } },
      coordinationRun: run({ budgetInvalid: true }),
      onSetCoordinationBudget: () => {},
    });

    const note = invalidNote(container);
    expect(note).not.toBeNull();
    expect(note!.textContent!.length).toBeGreaterThan(0);
    // Y el editor, que es la salida, está ahí mismo.
    expect(container.querySelector('.team-advanced-budget-edit')).not.toBeNull();
  });

  it('con el presupuesto del run legible no se dice nada', () => {
    const { container } = mountAdvanced({
      coordinationAuthority: 'manual',
      coordinationBudget: { state: 'set', budget: { maxDispatches: 5, unlimitedConfirmedAt: null } },
      coordinationRun: run({ budgetInvalid: false }),
      onSetCoordinationBudget: () => {},
    });

    expect(invalidNote(container)).toBeNull();
  });

  it('sin run tampoco: no se inventa un problema que nadie reportó', () => {
    const { container } = mountAdvanced({
      coordinationAuthority: 'manual',
      coordinationBudget: { state: 'set', budget: { maxDispatches: 5, unlimitedConfirmedAt: null } },
      onSetCoordinationBudget: () => {},
    });

    expect(invalidNote(container)).toBeNull();
  });

  /**
   * O5: NI SOBRE UN RUN TERMINADO, NI CON LA FRASE DEL TRABAJO.
   *
   * Se renderizaba con sólo `budgetInvalid`, sin mirar `active`: un equipo que
   * ya cerró mostraba un aviso sobre despachos que no se están denegando ni se
   * van a denegar. Y reusaba `coordination.budget.invalid`, que habla del
   * presupuesto del TRABAJO — otro byte, otro lugar donde se arregla.
   */
  const budgetProps = {
    coordinationAuthority: 'manual' as const,
    coordinationBudget: { state: 'set' as const, budget: { maxDispatches: 5, unlimitedConfirmedAt: null } },
    onSetCoordinationBudget: () => {},
  };

  it('O5: con el run TERMINADO no se muestra, aunque sus bytes sigan rotos', () => {
    const { container } = mountAdvanced({ ...budgetProps, coordinationRun: run({ status: 'done', active: false, budgetInvalid: true }) });

    expect(invalidNote(container)).toBeNull();
  });

  it('O5: con el run activo, la frase es PROPIA — no la del presupuesto del Trabajo', () => {
    const { container } = mountAdvanced({ ...budgetProps, coordinationRun: run({ budgetInvalid: true }) });

    const note = invalidNote(container)!;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('equipo en curso');
    // La otra frase, la del Trabajo, sigue existiendo en su propio párrafo y no
    // es ésta: si fueran la misma, este test no distinguiría nada.
    const workBudget = container.querySelector('.team-advanced-budget')!;
    expect(workBudget.textContent).not.toBe(note.textContent);
  });

  it('O5: y en inglés, sin nada en castellano', () => {
    const { container } = mountAdvanced({ ...budgetProps, coordinationRun: run({ budgetInvalid: true }) }, 'en-US');

    const note = invalidNote(container)!;
    expect(note.textContent).toContain('running team');
    expect(note.textContent).not.toContain('equipo');
  });
});
