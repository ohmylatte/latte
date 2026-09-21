import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * B1.4: DECISIONES QUEDA PARA LO QUE PERDURA.
 *
 * "Decisiones es de marca y permanente; cada coordinación la llena de ruido."
 * Este archivo era el de un run terminado visto desde Decisiones; hoy su
 * trabajo es el contrario: verificar que de esta pantalla NO queda nada de un
 * run. Las tarjetas y sus preguntas se fueron al chat del miembro
 * (`team-cards*.dom.test.tsx`); el estado del equipo, el tope de despachos, la
 * autoridad y el estado por miembro se fueron al panel del equipo
 * (`team-inbox`, `team-advanced*`). Acá quedan las decisiones de marca y
 * "Permisos y traspasos".
 *
 * El test escanea props Y render: una prop que vuelva a entrar lo rompe antes
 * de que alguien la use.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { render } = await import('@testing-library/react');
const { DecisionsView } = await import('./DecisionsView');
import type { DecisionsViewProps } from './DecisionsView';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Decision, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', workId: 'w1', text: 'Elegimos el naming corto', rationale: '', alternativesRejected: [], evidenceRefs: [],
  status: 'approved', source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '2026-09-01T00:00:00.000Z', decidedAt: null, ...patch,
});

const base: DecisionsViewProps = {
  work, decisions: [], team: [], roles: [], permissions: 'ask', handoffs: [], decisionAuthority: 'suggest',
  draft: '', busy: false, formatDate: () => 'hace un rato', titlesByWork: { w1: 'Lanzamiento' },
  onDraftChange: () => {}, onAdd: () => {}, onApprove: () => {}, onEditApprove: () => {},
  onReject: () => {}, onArchive: () => {}, onAuthorityChange: () => {},
};

const mount = (props: Partial<DecisionsViewProps> = {}) => render(createElement(DecisionsView, { ...base, ...props }));

const source = readFileSync(join(process.cwd(), 'src', 'DecisionsView.tsx'), 'utf8');

describe('Decisiones ya no renderiza nada de un run de coordinación', () => {
  it('ni tarjetas de gate, ni preguntas, ni equipos activos, ni el bloque de coordinación autónoma', () => {
    const { container } = mount({ decisions: [decision()] });
    for (const gone of [
      '.decision-gates', '.decision-gate', '.decision-ask', '.decision-coordination',
      '.decision-coordination-support', '.decision-coordination-budget-edit', '.decision-coordination-finished',
      '.team-card', '.team-cards',
    ]) {
      expect(container.querySelector(gone), `${gone} sigue en Decisiones`).toBeNull();
    }
  });

  it('lo que perdura sigue ahí: las decisiones de marca y "Permisos y traspasos"', () => {
    const { container } = mount({ decisions: [decision()] });
    expect(container.querySelector('.decision-list')!.textContent).toContain('Elegimos el naming corto');
    expect(container.querySelector('.decision-permissions')).not.toBeNull();
    expect(container.querySelector('.decision-form')).not.toBeNull();
  });

  /**
   * El fuente, no sólo el render: una prop que vuelva a entrar se ve acá
   * aunque ningún test monte la rama que la usa. Se corta por `/\r?\n/` porque
   * el repo es CRLF.
   */
  it('el componente no recibe una sola prop de coordinación', () => {
    const lines = source.split(/\r?\n/);
    expect(lines.length).toBeGreaterThan(50); // el archivo existe y se leyó de verdad
    const offenders = lines.filter((line) => /^\s{2}(gates|openAsks|onResolveGate|onAnswerAsk|coordinationRun|coordinationAuthority|coordinationBudget|coordinationSupport|coordinatorGrant|onSetCoordinationBudget|pending)\??:/.test(line));
    expect(offenders).toEqual([]);
  });

  it('y no importa una sola pieza de coordinación', () => {
    for (const gone of ['CoordinationGateView', 'CoordinationAskView', 'CoordinationRunView', 'CoordinationMemberSupport', 'CoordinationBudgetView']) {
      expect(source, `${gone} sigue importado en DecisionsView`).not.toContain(gone);
    }
  });
});
