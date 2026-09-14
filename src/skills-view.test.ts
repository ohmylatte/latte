import { describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: Parameters<typeof real.formatMessage>[1], params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});
vi.mock('./browser-api', () => ({ isDesktop: true, api: {} }));

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { SkillsViewContent } = await import('./SkillsView');
const { formatMessage } = await import('./i18n');

const skill = { id: 'writing', name: 'Escritura', summary: 's', enabled: true };
const noop = () => {};

describe('SkillsView learning inbox', () => {
  it('does not render learning.inbox or learning.empty when the feature is off', () => {
    ui.locale = 'es-AR';
    const html = renderToStaticMarkup(createElement(SkillsViewContent, {
      learningOn: false, skills: [skill], candidates: [], loading: false, busy: '',
      onToggle: noop, onDecide: noop, onPromote: noop,
    }));
    expect(html).not.toContain(formatMessage('es-AR', 'learning.inbox'));
    expect(html).not.toContain(formatMessage('es-AR', 'learning.empty'));
  });

  it('renders the empty inbox when learning is on', () => {
    ui.locale = 'es-AR';
    const html = renderToStaticMarkup(createElement(SkillsViewContent, {
      learningOn: true, skills: [skill], candidates: [], loading: false, busy: '',
      onToggle: noop, onDecide: noop, onPromote: noop,
    }));
    expect(html).toContain(formatMessage('es-AR', 'learning.inbox'));
    expect(html).toContain(formatMessage('es-AR', 'learning.empty'));
  });
});
