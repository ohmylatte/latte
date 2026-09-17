import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

// `translate` follows the language the provider last rendered with. Here the
// test picks it, with no provider: the markup is rendered to a string.
const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { fireEvent, render, screen } = await import('@testing-library/react');
const { TrabajoView } = await import('./TrabajoView');
const { EMPTY_USAGE } = await import('../shared/contracts');
import type { TrabajoViewProps } from './TrabajoView';
import type { Brand, Decision, DocumentState, HandoffRequest, TeamMember, Work, WorkDocument } from '../shared/contracts';

const brand = (patch: Partial<Brand> = {}): Brand => ({ id: 'b1', name: 'Casa Oliva', context: 'Tono cálido.', createdAt: '', archivedAt: null, ...patch });
const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña de primavera.',
  folder: 'casa-oliva', expectedOutput: 'Un PDF de dos páginas', resultPath: 'propuesta.pdf',
  updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Una campaña con nombre', fileName: 'oferta.md',
  status: 'draft', funnelStages: [], proposedFunnelStages: [], baseDocumentId: null,
  baseRevisionId: null, baseFingerprint: null, createdAt: '', updatedAt: '', ...patch,
});
const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', workId: 'w1', text: 'Elegimos X', rationale: '', alternativesRejected: [],
  evidenceRefs: [], status: 'pending',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '2026-09-01T00:00:00.000Z', decidedAt: null, ...patch,
});
const member = (patch: Partial<TeamMember> = {}): TeamMember => ({
  id: 'm1', workId: 'w1', roleId: 'r1', roleName: 'Estratega', initial: 'E',
  runtime: 'opencode', model: null, accountId: null, label: 'OpenCode', status: 'idle',
  tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '', ...patch,
});
const handoff = (patch: Partial<HandoffRequest> = {}): HandoffRequest => ({
  fileName: 'brief.md', roleId: 'r2', roleName: 'Diseñadora', known: false, request: 'Necesito a alguien de diseño.', ...patch,
});
const outdated = (id: string): DocumentState => ({ documentId: id, fingerprint: 'fp', modifiedAt: null, baseOutdated: true });

const base: TrabajoViewProps = {
  brand: brand(),
  work: work(),
  documents: [],
  decisions: [],
  states: {},
  checking: false,
  team: [],
  permissions: 'ask',
  handoffs: [],
  live: false,
  brandContextDefined: true,
  mode: 'simple',
  formatDate: () => 'hace un rato',
  onOpenChat: () => {},
};

function renderMarkup(locale: 'es-AR' | 'en-US', props: Partial<TrabajoViewProps> = {}): string {
  ui.locale = locale;
  return renderToStaticMarkup(createElement(TrabajoView, { ...base, ...props }));
}

/** A populated work: encargo, documents, handoffs, team and the advanced detail. */
const populated = (patch: Partial<TrabajoViewProps> = {}): Partial<TrabajoViewProps> => ({
  documents: [doc({ title: 'Una campaña con nombre', kind: 'note', status: 'review' })],
  handoffs: [handoff()],
  team: [member({ model: 'gpt-5' })],
  mode: 'advanced',
  ...patch,
});

describe('the Trabajo, in both interface languages', () => {
  it('speaks Spanish from the catalog: every section and the advanced detail', () => {
    const html = renderMarkup('es-AR', populated());
    for (const text of [
      'aria-label="Trabajo"', 'role="region"',
      'EL TRABAJO EN MARCHA',
      'Encargo actual', 'Lanzamiento', 'Lanzar la campaña de primavera.',
      'Resultado esperado', 'Un PDF de dos páginas', 'propuesta.pdf',
      'Documentos', 'Una campaña con nombre', 'Nota', 'Para revisar',
      'Permisos', 'Preguntar siempre', 'Diseñadora', 'brief.md',
      'Runtime', 'OpenCode', 'Modelo', 'gpt-5', 'Esfuerzo', 'Equilibrado',
      'Progreso', 'En revisión', 'Trabajando', 'Decisiones pendientes',
      'Próximos pasos', 'Revisar 1 documento',
      'Conversar',
    ]) expect(html).toContain(text);
  });

  it('renders the same Trabajo in English, with nothing left in Spanish', () => {
    const html = renderMarkup('en-US', populated());
    for (const text of [
      'aria-label="Work"',
      'THE WORK IN MOTION',
      'Current brief', 'Lanzamiento', 'Lanzar la campaña de primavera.',
      'Expected output', 'Un PDF de dos páginas', 'propuesta.pdf',
      'Documents', 'Una campaña con nombre', 'Note', 'To review',
      'Permissions', 'Always ask', 'Diseñadora', 'brief.md',
      'Runtime', 'OpenCode', 'Model', 'gpt-5', 'Effort', 'Balanced',
      'Progress', 'In review', 'Working', 'Pending decisions',
      'Next steps', 'Review 1 document',
      'Talk',
    ]) expect(html).toContain(text);
    for (const spanish of ['DÓNDE', 'Objetivo', 'Encargo', 'Documentos', 'Permisos', 'Progreso', 'Próximos', 'Conversar', 'Estado', 'Esfuerzo', 'Equilibrado']) {
      expect(html).not.toContain(spanish);
    }
  });

  it('renders a safe empty state when no work is selected, with no derived content', () => {
    const html = renderMarkup('es-AR', { work: null });
    expect(html).toContain('aria-label="Trabajo"');
    expect(html).not.toContain('Encargo actual');
    expect(html).not.toContain('Progreso');
    expect(html).not.toContain('trabajo-conversar');
  });

  it('gates the member runtime/modelo/esfuerzo behind advanced mode, keeping permissions in both', () => {
    const simple = renderMarkup('es-AR', populated({ mode: 'simple' }));
    for (const hidden of ['Runtime', 'Modelo', 'Esfuerzo', 'OpenCode', 'Equilibrado']) expect(simple).not.toContain(hidden);
    // permissions stay: the permission mode and the handoff are always visible.
    expect(simple).toContain('Permisos');
    expect(simple).toContain('Preguntar siempre');
    expect(simple).toContain('Diseñadora');

    const advanced = renderMarkup('es-AR', populated({ mode: 'advanced' }));
    for (const shown of ['Runtime', 'Modelo', 'Esfuerzo', 'OpenCode', 'Equilibrado']) expect(advanced).toContain(shown);
  });

  it('owns the single next-step rung: never the retired orientation strip', () => {
    const html = renderMarkup('es-AR', { documents: [doc({ status: 'review' })] });
    expect(html).toContain('data-step="review"');
    expect(html).not.toContain('orientation-strip');
  });

  it('leaves no literal copy in the component: every word a human reads comes from a key', () => {
    const source = readFileSync(resolve('src/TrabajoView.tsx'), 'utf8');
    expect(source).not.toMatch(/\b(?:aria-label|title|placeholder)="/);
  });
});

describe('the Conversar CTA', () => {
  it('opens the drawer through onOpenChat and never renders the chat inline', () => {
    ui.locale = 'es-AR';
    const onOpenChat = vi.fn();
    const { container } = render(createElement(TrabajoView, { ...base, ...populated({ onOpenChat }) }));

    const button = screen.getByRole('button', { name: 'Conversar' });
    expect(button).toBeDefined();
    fireEvent.click(button);
    expect(onOpenChat).toHaveBeenCalledTimes(1);

    // The conversation lives in the drawer (`TeamPanel`), never inside <main>.
    expect(container.querySelector('.chat-scroll')).toBeNull();
    expect(container.querySelector('.prompt-form')).toBeNull();
  });
});
