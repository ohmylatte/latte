import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render, screen } = await import('@testing-library/react');
const { DecisionsView } = await import('./DecisionsView');
import type { DecisionsViewProps } from './DecisionsView';
import type { CoordinationGateView, CoordinationRunView, Work } from '../shared/contracts';

/**
 * U1: Decisiones tiene que SABER si el equipo sigue vivo.
 *
 * `DecisionsViewProps` no recibía el run, así que la pantalla donde la persona
 * aprueba y rechaza no tenía forma de distinguir un equipo trabajando de uno
 * que ya cerró. Un run terminado se veía exactamente igual que uno vivo, con
 * sus tarjetas de gate y sus botones de Aprobar/Rechazar sobre algo que el
 * motor no va a ejecutar nunca más.
 */

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z',
  tasksDone: 0, tasksFailed: 0, tasksPending: 0, ...patch,
});

const base: DecisionsViewProps = {
  work, decisions: [], team: [], roles: [], permissions: 'ask', handoffs: [], decisionAuthority: 'suggest',
  draft: '', busy: false, formatDate: () => 'hace un rato', titlesByWork: { w1: 'Lanzamiento' },
  onDraftChange: () => {}, onAdd: () => {}, onApprove: () => {}, onEditApprove: () => {},
  onReject: () => {}, onArchive: () => {}, onAuthorityChange: () => {},
};

const mount = (props: Partial<DecisionsViewProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(DecisionsView, { ...base, ...props }));
};

const gate = (patch: Partial<CoordinationGateView> = {}): CoordinationGateView => ({
  id: 'g1', kind: 'dispatch', runId: 'run1', prompt: 'Escribir el copy', createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});

describe('un run terminado, visto desde Decisiones', () => {
  it('dice cómo terminó, con las tres cuentas separadas', () => {
    const { container } = mount({ coordinationRun: run({ status: 'done', active: false, tasksDone: 4, tasksFailed: 1, tasksPending: 0 }) });
    const banner = container.querySelector('.decision-coordination-finished');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('4');
    expect(banner!.textContent).toContain('1');
    expect(banner!.textContent?.toLowerCase()).toContain('termin');
  });

  it('un run cancelado lo dice con sus propias palabras, no con las del terminado', () => {
    const { container } = mount({ coordinationRun: run({ status: 'cancelled', active: false, tasksDone: 1, tasksFailed: 0, tasksPending: 2 }) });
    const banner = container.querySelector('.decision-coordination-finished');
    expect(banner).not.toBeNull();
    expect(banner!.textContent?.toLowerCase()).toContain('cancel');
  });

});

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
  const budgetEditor = (container: HTMLElement) => container.querySelector('.decision-coordination-budget-edit');
  const input = (container: HTMLElement) => container.querySelector('.decision-coordination-budget-input') as HTMLInputElement;
  const save = (container: HTMLElement) => container.querySelector('.decision-coordination-budget-save') as HTMLButtonElement;

  for (const state of ['unset', 'set', 'invalid'] as const) {
    it(`el editor esta disponible en \`${state}\``, () => {
      const budget = state === 'set' ? { state, budget: { maxDispatches: 5, unlimitedConfirmedAt: null } } as const : { state } as const;
      const { container } = mount({ coordinationAuthority: 'manual', coordinationBudget: budget, onSetCoordinationBudget: () => {} });
      expect(budgetEditor(container)).not.toBeNull();
    });
  }

  it('desde `invalid`, guardar manda el numero que la persona escribio', () => {
    const onSetCoordinationBudget = vi.fn();
    const { container } = mount({ coordinationAuthority: 'manual', coordinationBudget: { state: 'invalid' }, onSetCoordinationBudget });
    fireEvent.change(input(container), { target: { value: '12' } });
    fireEvent.click(save(container));
    expect(onSetCoordinationBudget).toHaveBeenCalledWith(12);
  });

  it('un valor que no es un entero positivo no manda nada: el boton esta deshabilitado', () => {
    const onSetCoordinationBudget = vi.fn();
    const { container } = mount({ coordinationAuthority: 'manual', coordinationBudget: { state: 'unset' }, onSetCoordinationBudget });
    expect(save(container).disabled).toBe(true); // vacio
    for (const bad of ['0', '-3', '2.5', 'hola']) {
      fireEvent.change(input(container), { target: { value: bad } });
      fireEvent.click(save(container));
    }
    expect(onSetCoordinationBudget).not.toHaveBeenCalled();
  });

  it('sin `onSetCoordinationBudget` (un llamador sin cablear) no aparece ningun editor', () => {
    const { container } = mount({ coordinationAuthority: 'manual', coordinationBudget: { state: 'invalid' } });
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
  const invalidNote = (container: HTMLElement) => container.querySelector('.decision-coordination-run-budget-invalid');

  it('se dice, en la sección de presupuesto, junto al editor', () => {
    const { container } = mount({
      coordinationAuthority: 'manual',
      coordinationBudget: { state: 'set', budget: { maxDispatches: 5, unlimitedConfirmedAt: null } },
      coordinationRun: run({ budgetInvalid: true }),
      onSetCoordinationBudget: () => {},
    });

    const note = invalidNote(container);
    expect(note).not.toBeNull();
    expect(note!.textContent!.length).toBeGreaterThan(0);
    // Y el editor, que es la salida, está ahí mismo.
    expect(container.querySelector('.decision-coordination-budget-edit')).not.toBeNull();
  });

  it('con el presupuesto del run legible no se dice nada', () => {
    const { container } = mount({
      coordinationAuthority: 'manual',
      coordinationBudget: { state: 'set', budget: { maxDispatches: 5, unlimitedConfirmedAt: null } },
      coordinationRun: run({ budgetInvalid: false }),
      onSetCoordinationBudget: () => {},
    });

    expect(invalidNote(container)).toBeNull();
  });

  it('sin run tampoco: no se inventa un problema que nadie reportó', () => {
    const { container } = mount({
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
    const { container } = mount({ ...budgetProps, coordinationRun: run({ status: 'done', active: false, budgetInvalid: true }) });

    expect(invalidNote(container)).toBeNull();
  });

  it('O5: con el run activo, la frase es PROPIA — no la del presupuesto del Trabajo', () => {
    const { container } = mount({ ...budgetProps, coordinationRun: run({ budgetInvalid: true }) });

    const note = invalidNote(container)!;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('equipo en curso');
    // La otra frase, la del Trabajo, sigue existiendo en su propio párrafo y no
    // es ésta: si fueran la misma, este test no distinguiría nada.
    const workBudget = container.querySelector('.decision-coordination-budget')!;
    expect(workBudget.textContent).not.toBe(note.textContent);
  });

  it('O5: y en inglés, sin nada en castellano', () => {
    const { container } = mount({ ...budgetProps, coordinationRun: run({ budgetInvalid: true }) }, 'en-US');

    const note = invalidNote(container)!;
    expect(note.textContent).toContain('running team');
    expect(note.textContent).not.toContain('equipo');
  });
});
