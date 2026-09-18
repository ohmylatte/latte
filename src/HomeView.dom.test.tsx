import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HomeView, type HomeViewProps } from './HomeView';
import { I18nProvider } from './i18n';
import type { Brand, Decision, DocumentState, WorkDocument } from '../shared/contracts';

// The library's 1s default is a race against the scheduler, not a statement
// about the product: the assertions below are unchanged, only the wait is.
configure({ asyncUtilTimeout: 5_000 });

/**
 * Inicio, rendered directly.
 *
 * `HomeView` is props-only (the `ContextView` pattern), so this file needs no
 * `browser-api` mock: every signal is a fixture, `formatDate` is a stub, and no
 * assertion depends on the machine's locale. The `App`-level wiring — the nav
 * item, the hidden tabs, the landing — is guarded by the existing files.
 */

const brand = (patch: Partial<Brand> = {}): Brand => ({ id: 'b1', name: 'Casa Oliva', context: 'Tono cálido.', createdAt: '', archivedAt: null, ...patch });
const work = (patch: Partial<{ id: string; title: string; updatedAt: string }> = {}) => ({ id: 'w1', title: 'Lanzamiento', updatedAt: '2026-09-01T00:00:00.000Z', ...patch });
const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Una campaña con nombre', fileName: 'oferta.md',
  status: 'draft', funnelStages: [], proposedFunnelStages: [], baseDocumentId: null,
  baseRevisionId: null, baseFingerprint: null, createdAt: '', updatedAt: '', ...patch,
});
const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', workId: 'w1', text: 'Elegimos un tono cercano', rationale: '', alternativesRejected: [],
  evidenceRefs: [], status: 'pending',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '', decidedAt: null, ...patch,
});
const outdated = (id: string): DocumentState => ({ documentId: id, fingerprint: 'fp', modifiedAt: null, baseOutdated: true });

const handlers = () => ({
  onOpenWork: vi.fn(), onOpenDecisions: vi.fn(), onOpenDocument: vi.fn(),
  onOpenContext: vi.fn(), onNewWork: vi.fn(), onAddBrand: vi.fn(),
});

const props = (patch: Partial<HomeViewProps> = {}): HomeViewProps => ({
  brand: brand(),
  works: [],
  documents: [],
  decisions: [],
  states: {},
  checking: false,
  liveWorkIds: [],
  pendingContextProposals: 0,
  formatDate: () => 'hace un rato',
  ...handlers(),
  ...patch,
});

const mount = (input: HomeViewProps) => render(<I18nProvider><HomeView {...input} /></I18nProvider>);

describe('Inicio, the attention surface', () => {
  it('names the single next step from the ladder', () => {
    const empty = mount(props({ brand: brand({ context: '' }) }));
    expect(empty.container.querySelector('.home-next')?.getAttribute('data-step')).toBe('brand');
    expect(empty.container.querySelector('.home-next')?.textContent).toContain('Definir el contexto de marca');
    empty.unmount();

    const checking = mount(props({ works: [work()], checking: true }));
    expect(checking.container.querySelector('.home-next')?.getAttribute('data-step')).toBe('checking');
    expect(checking.container.querySelector('.home-next')?.textContent).toContain('Revisando qué falta');
  });

  it('shows no brand as a ladder rung and one action, never an empty shell', () => {
    const input = props({ brand: null, works: [], documents: [], decisions: [] });
    const { container } = mount(input);
    expect(container.querySelector('.home-next')?.getAttribute('data-step')).toBe('start');
    expect(container.querySelectorAll('.home-card')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Agregar marca' }));
    expect(input.onAddBrand).toHaveBeenCalledTimes(1);
  });

  it('orders Continuar by recency, marks only the work with activity, and opens the work', () => {
    const input = props({
      works: [work({ id: 'w1', title: 'Uno', updatedAt: '2026-09-01T00:00:00.000Z' }), work({ id: 'w2', title: 'Dos', updatedAt: '2026-09-05T00:00:00.000Z' })],
      liveWorkIds: ['w1'],
    });
    const { container } = mount(input);
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.home-continue .home-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Dos');
    expect(rows[0].textContent).not.toContain('Con actividad');
    expect(rows[1].textContent).toContain('Con actividad');
    fireEvent.click(rows[0]);
    expect(input.onOpenWork).toHaveBeenCalledWith('w2');
  });

  it('collapses Continuar to a single action when the brand has no work, with no zero anywhere', () => {
    const input = props({ works: [] });
    const { container } = mount(input);
    expect(container.querySelector('.home-next')?.getAttribute('data-step')).toBe('works');
    const cards = [...container.querySelectorAll<HTMLElement>('.home-card')];
    expect(cards).toHaveLength(1);
    expect(cards[0].classList.contains('home-continue')).toBe(true);
    expect(cards[0].querySelectorAll('.home-row')).toHaveLength(0);
    for (const card of cards) expect(card.textContent).not.toMatch(/\d/);
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo trabajo' }));
    expect(input.onNewWork).toHaveBeenCalledTimes(1);
  });

  it('lists only the pending decisions, routes each to its work, and offers the context proposal', () => {
    const input = props({
      works: [work({ id: 'w1', title: 'Lanzamiento' })],
      decisions: [decision({ id: 'd1', workId: 'w1', text: 'Elegimos X' }), decision({ id: 'd2', status: 'approved', text: 'Ya decidido' })],
      pendingContextProposals: 1,
    });
    const { container } = mount(input);
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.home-decisions .home-row')];
    expect(rows).toHaveLength(2);
    expect(container.textContent).not.toContain('Ya decidido');
    expect(rows[0].textContent).toContain('Lanzamiento');
    fireEvent.click(rows[0]);
    expect(input.onOpenDecisions).toHaveBeenCalledWith('w1');
    fireEvent.click(screen.getByRole('button', { name: /Propuesta de contexto de marca/ }));
    expect(input.onOpenContext).toHaveBeenCalledTimes(1);
  });

  it('lists what needs review from status and from a moved base, and opens the document', () => {
    const input = props({
      works: [work({ id: 'w1', title: 'Lanzamiento' })],
      documents: [
        doc({ id: 'a', workId: 'w1', title: 'Estrategia', status: 'review' }),
        doc({ id: 'b', workId: 'w1', title: 'Base vieja', status: 'approved' }),
        doc({ id: 'c', workId: 'w1', title: 'Al día', status: 'draft' }),
      ],
      states: { b: outdated('b') },
    });
    const { container } = mount(input);
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.home-review .home-row')];
    expect(rows.map(r => r.textContent)).toHaveLength(2);
    expect(rows[0].textContent).toContain('Estrategia');
    expect(rows[1].textContent).toContain('Base vieja');
    expect(container.textContent).not.toContain('Al día');
    fireEvent.click(rows[0]);
    expect(input.onOpenDocument).toHaveBeenCalledWith('a');
  });

  it('renders nothing for the cards with nothing in them', () => {
    const { container } = mount(props({ works: [work()], decisions: [], documents: [] }));
    expect(container.querySelector('.home-decisions')).toBeNull();
    expect(container.querySelector('.home-review')).toBeNull();
  });

  it('is an attention surface, not a dashboard: every card leads to an action', () => {
    const spies = handlers();
    const { container } = mount(props({
      ...spies,
      works: [work({ id: 'w1' }), work({ id: 'w2', title: 'Otro', updatedAt: '2026-09-09T00:00:00.000Z' })],
      liveWorkIds: ['w1'],
      decisions: [decision()],
      pendingContextProposals: 1,
      documents: [doc({ status: 'review' })],
    }));
    const view = container.querySelector('.home-view') as HTMLElement;
    // No in-work chrome: the region is not a document pane and holds no nav.
    expect(view.querySelectorAll('nav')).toHaveLength(0);
    expect(view.querySelectorAll('.document-scroll')).toHaveLength(0);

    const cards = [...view.querySelectorAll('.home-card')];
    expect(cards).toHaveLength(3);
    for (const card of cards) expect(card.querySelectorAll('button').length).toBeGreaterThan(0);
    for (const row of view.querySelectorAll('.home-row')) expect(row.tagName).toBe('BUTTON');
    // Every row is an action, and it is exactly one action: a row that leads
    // nowhere is the decorative metric the brief forbids.
    const navigation = [spies.onOpenWork, spies.onOpenDecisions, spies.onOpenDocument, spies.onOpenContext];
    for (const row of [...view.querySelectorAll<HTMLButtonElement>('.home-row')]) {
      vi.clearAllMocks();
      fireEvent.click(row);
      const calls = navigation.reduce((total, handler) => total + handler.mock.calls.length, 0);
      expect(calls, `the row "${row.textContent}" leads nowhere`).toBe(1);
    }
  });

  it('takes the date formatting from its props, so no locale leaks in', () => {
    const input = props({ works: [work({ updatedAt: '2026-09-01T00:00:00.000Z' })], formatDate: (value) => `d:${value}` });
    mount(input);
    expect(screen.getByText('d:2026-09-01T00:00:00.000Z')).toBeDefined();
  });
});

describe('the since-last-visit card (additive, autonomous-coordination Phase 7)', () => {
  it('does not render when the caller has not wired coordination state', () => {
    const { container } = mount(props({ works: [work()] }));
    expect(container.querySelector('.home-since')).toBeNull();
  });

  it('renders no card for an explicitly empty list — zero rows is never a zero', () => {
    const { container } = mount(props({ works: [work()], coordinationSinceLastVisit: [] }));
    expect(container.querySelector('.home-since')).toBeNull();
  });

  it('renders one row per event and routes a pending-approval row to Decisiones, the rest to the work', () => {
    const input = props({
      works: [work({ id: 'w1', title: 'Lanzamiento' })],
      coordinationSinceLastVisit: [
        { id: 'e1', workId: 'w1', kind: 'done' },
        { id: 'e2', workId: 'w1', kind: 'awaitingYou' },
      ],
    });
    const { container } = mount(input);
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.home-since .home-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Lanzamiento');
    expect(rows[0].textContent).toContain('terminó su trabajo');
    fireEvent.click(rows[0]);
    expect(input.onOpenWork).toHaveBeenCalledWith('w1');
    expect(rows[1].textContent).toContain('espera tu aprobación');
    fireEvent.click(rows[1]);
    expect(input.onOpenDecisions).toHaveBeenCalledWith('w1');
  });

  it('renders the same card in English, with nothing left in Spanish', async () => {
    localStorage.setItem('latte-ui-locale', 'en-US');
    const input = props({
      works: [work({ id: 'w1', title: 'Launch' })],
      coordinationSinceLastVisit: [{ id: 'e1', workId: 'w1', kind: 'budgetConsumed' }],
    });
    const { container } = render(<I18nProvider><HomeView {...input} /></I18nProvider>);
    await waitFor(() => expect(container.textContent).toContain('Since your last visit'));
    expect(container.textContent).toContain('dispatch budget ran out');
    localStorage.removeItem('latte-ui-locale');
  });
});
