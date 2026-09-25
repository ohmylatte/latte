import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * E2: "LO QUE PRODUJO EL EQUIPO" LEE LA LISTA DEL REPORTE, Y NUNCA UNA RUTA.
 *
 * `latte_report.files` ahora es una lista de rutas relativas. La pantalla
 * muestra el NOMBRE de cada archivo (ninguna superficie muestra rutas) y, si
 * el reporte no trajo lista, sigue leyendo los nombres del resumen como antes.
 * Y la opción "revisión antes de publicar" vive con el resto de los ajustes
 * del equipo, con su costo dicho.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { cleanup, fireEvent, render } = await import('@testing-library/react');
const { RunOutput, outcomeRows } = await import('./coordination/TeamOutcome');
const { TeamView } = await import('./TeamView');
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationLogEntryView, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

afterEach(() => cleanup());

const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Asistente'), member('writer', 'Redactor')];
const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'done', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: false, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 2, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0,
};
const report = (id: string, patch: Partial<CoordinationLogEntryView> = {}): CoordinationLogEntryView => ({
  id, taskId: 't-' + id, memberId: 'writer', status: 'reported', outcome: 'succeeded',
  promptPreview: 'Escribir la propuesta', summaryPreview: 'Quedó la propuesta en propuesta-vieja.pdf',
  createdAt: '2026-09-25T10:00:00.000Z', startedAt: '2026-09-25T10:00:00.000Z', settledAt: '2026-09-25T12:00:00.000Z',
  ...patch,
} as CoordinationLogEntryView);

describe('E2: los archivos del reporte', () => {
  it('con lista: los nombres salen de la lista, sin carpetas', () => {
    const rows = outcomeRows([report('d1', { files: ['borradores/propuesta.pdf', 'borradores/anexos/tabla.xlsx'] } as Partial<CoordinationLogEntryView>)]);
    expect(rows[0]!.files).toEqual(['propuesta.pdf', 'tabla.xlsx']);
  });

  it('sin lista: los nombres que dice el resumen, como antes', () => {
    expect(outcomeRows([report('d1')])[0]!.files).toEqual(['propuesta-vieja.pdf']);
  });

  it('ninguna ruta llega a la pantalla, ni en lo producido ni en el detalle', () => {
    const log = [report('d1', { files: ['borradores/propuesta.pdf'] } as Partial<CoordinationLogEntryView>)];
    const output = render(createElement(RunOutput, { run, team, log, formatTime: (v: string) => v, now: Date.parse('2026-09-25T13:00:00.000Z') }));
    expect(output.container.querySelector('.coord-file')!.textContent).toBe('propuesta.pdf');
    expect(output.container.textContent).not.toContain('borradores/');
    cleanup();
    const work: Work = { id: 'w1', brandId: 'b1', title: 'Ayulem', brief: '', folder: null, updatedAt: '' };
    const view = render(createElement(TeamView, {
      work, team, roles: [], mode: 'simple', busy: false, selectedMemberId: 'writer', onSelectMember: () => {},
      coordinationRun: { ...run, status: 'running', active: true }, coordinationLog: log,
      formatTime: (v: string) => v, formatDate: (v: string) => v,
    }));
    const chips = [...view.container.querySelectorAll('.coord-event .coord-file')].map((chip) => chip.textContent);
    expect(chips).toContain('propuesta.pdf');
    expect(view.container.textContent).not.toContain('borradores/');
  });
});

describe('E2: la opción "revisión antes de publicar"', () => {
  const work: Work = { id: 'w1', brandId: 'b1', title: 'Ayulem', brief: '', folder: null, updatedAt: '' };
  const mount = (props: Record<string, unknown>) => render(createElement(TeamView, {
    work, team, roles: [], mode: 'advanced', busy: false, selectedMemberId: null, onSelectMember: () => {}, ...props,
  }));

  it('se lee prendida, con su costo dicho, y apagarla llama al handler', () => {
    ui.locale = 'es-AR';
    const onSetCoordinationReview = vi.fn();
    const { container } = mount({ coordinationReview: true, onSetCoordinationReview });
    const box = container.querySelector<HTMLInputElement>('.team-advanced-review input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    expect(container.querySelector('.team-advanced-review')!.textContent).toContain('Revisión antes de publicar');
    expect(container.querySelector('.team-advanced-review')!.textContent).toContain('Cuesta un despacho por entrega');
    fireEvent.click(box);
    expect(onSetCoordinationReview).toHaveBeenCalledWith(false);
  });

  it('en inglés, y sin handler no se puede tocar', () => {
    ui.locale = 'en-US';
    const { container } = mount({ coordinationReview: false });
    const box = container.querySelector<HTMLInputElement>('.team-advanced-review input[type="checkbox"]')!;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    expect(container.querySelector('.team-advanced-review')!.textContent).toContain('Review before publishing');
  });
});
