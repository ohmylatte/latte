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
