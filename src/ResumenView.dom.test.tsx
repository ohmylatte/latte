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
const { ResumenView } = await import('./ResumenView');
const { EMPTY_USAGE } = await import('../shared/contracts');
import type { ResumenViewProps } from './ResumenView';
import type { Brand, Decision, DocumentState, TeamMember, Work, WorkDocument } from '../shared/contracts';

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
const outdated = (id: string): DocumentState => ({ documentId: id, fingerprint: 'fp', modifiedAt: null, baseOutdated: true });

const base: ResumenViewProps = {
  brand: brand(),
  work: work(),
  documents: [],
  decisions: [],
  states: {},
  checking: false,
  team: [],
  permissions: 'ask',
  live: false,
  brandContextDefined: true,
  formatDate: () => 'hace un rato',
  onOpenBrief: () => {},
};

function render(locale: 'es-AR' | 'en-US', props: Partial<ResumenViewProps> = {}): string {
  ui.locale = locale;
  return renderToStaticMarkup(createElement(ResumenView, { ...base, ...props }));
}

/** Every estado the header can show, plus the full work, in one pass. */
const everyState = (locale: 'es-AR' | 'en-US'): string => [
  render(locale, { live: true }),
  render(locale, { team: [member({ status: 'working' })] }),
  render(locale, { documents: [doc({ status: 'review' })] }),
  render(locale, { decisions: [decision()] }),
  render(locale, {}),
  render(locale, {
    work: work({ folder: null, expectedOutput: '', resultPath: null }),
    documents: [doc({ status: 'review' })],
    decisions: [decision({ text: 'Elegimos X', createdAt: '2026-09-01T00:00:00.000Z' })],
    permissions: 'folder',
    brandContextDefined: false,
  }),
].join('\n');

describe('the Resumen, in both interface languages', () => {
  it('speaks Spanish from the catalog: every item, every estado, every cycle phase', () => {
    const html = everyState('es-AR');
    for (const text of [
      'aria-label="Resumen"', 'role="region"',
      'DÓNDE ESTAMOS',
      'Objetivo', 'Lanzamiento', 'Lanzar la campaña de primavera.', 'Abrir el brief',
      'Resultado esperado', 'Un PDF de dos páginas', 'propuesta.pdf', 'sin definir',
      'Marca', 'Casa Oliva', 'Alcance', 'este trabajo', 'Carpeta', 'casa-oliva', 'Sin carpeta vinculada',
      'Estado actual', 'Con agente en vivo', 'Trabajando', 'En revisión', 'Decisiones pendientes', 'En pausa',
      'Acciones autorizadas', 'Preguntar siempre', 'Trabajar en esta carpeta',
      'Elegimos X', 'hace un rato',
      'Siguiente paso', 'Sin pendientes', 'Revisar 1 documento', 'Revisar 1 decisión pendiente',
      'Observar', 'Entender', 'Decidir', 'Actuar', 'Medir',
      'Lo alimenta: Contexto', 'Lo alimenta: Documentos', 'Lo alimenta: Decisiones',
      'Lo alimenta: Conversación', 'Lo alimenta: Embudo',
      'Definido', 'Vacío', 'Para revisar',
    ]) expect(html).toContain(text);
  });

  it('renders the same Resumen in English, with nothing left in Spanish', () => {
    const html = everyState('en-US');
    for (const text of [
      'aria-label="Summary"',
      'WHERE WE ARE',
      'Objective', 'Open the brief',
      'Expected output', 'not set',
      'Brand', 'Scope', 'this work', 'Folder', 'No folder linked',
      'Current state', 'Live agent', 'Working', 'In review', 'Pending decisions', 'Idle',
      'Authorized actions', 'Always ask', 'Work in this folder',
      'Next step', 'Nothing pending', 'Review 1 document', 'Review 1 pending decision',
      'Observe', 'Understand', 'Decide', 'Act', 'Measure',
      'Fed by: Context', 'Fed by: Documents', 'Fed by: Decisions',
      'Fed by: Conversation', 'Fed by: Funnel',
      'Defined', 'Empty', 'To review',
    ]) expect(html).toContain(text);
    for (const spanish of ['DÓNDE', 'Objetivo', 'Marca', 'Alcance', 'Carpeta', 'Estado', 'Acciones', 'Lo alimenta', 'Siguiente', 'Observar', 'Entender', 'Decidir', 'Actuar', 'Medir']) {
      expect(html).not.toContain(spanish);
    }
  });

  it('owns the single next-step ladder: one rung, never the retired strip', () => {
    const html = render('es-AR', { documents: [doc({ status: 'review' })] });
    expect(html.match(/resumen-next/g) ?? []).toHaveLength(1);
    expect(html).not.toContain('orientation-strip');
    expect(html).toContain('data-step="review"');
  });

  it('renders a safe empty state when no work is selected, with no derived content', () => {
    const html = render('es-AR', { work: null });
    expect(html).toContain('aria-label="Resumen"');
    expect(html).not.toContain('Objetivo');
    expect(html).not.toContain('Estado actual');
    expect(html).not.toContain('cycle-map');
  });

  it('leaves no literal copy in the component: every word a human reads comes from a key', () => {
    const source = readFileSync(resolve('src/ResumenView.tsx'), 'utf8');
    // No attribute a screen reader or a tooltip reads is a literal.
    expect(source).not.toMatch(/\b(?:aria-label|title|placeholder)="/);
  });
});
