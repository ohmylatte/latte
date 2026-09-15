import { describe, expect, it, vi } from 'vitest';
import type { McpRuntimeTools, McpServer } from '../shared/contracts';
const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: Parameters<typeof real.formatMessage>[1], params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});
vi.mock('./browser-api', () => ({ api: {} }));
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { ToolsViewContent } = await import('./ToolsView');
const { formatMessage } = await import('./i18n');
const statuses: McpServer['status'][] = ['connected', 'failed', 'pending', 'disabled', 'configured'];
const runtime: McpRuntimeTools = { runtime: 'claude', installed: true, canEdit: true, detail: '', servers: statuses.map(status => ({ name: status, status, transport: 'http', target: 'https://example.invalid/mcp', detail: '' })) };
function render(locale: typeof ui.locale, overrides: Partial<Parameters<typeof ToolsViewContent>[0]> = {}) {
  ui.locale = locale;
  return renderToStaticMarkup(createElement(ToolsViewContent, { runtimes: [runtime], loading: false, busy: false, adding: null, onRefresh: () => {}, onRemove: () => {}, onAdding: () => {}, onAdd: async () => {}, ...overrides }));
}
describe('Optional user-selected MCP tools', () => {
  it.each(['es-AR', 'en-US'] as const)('renders optionality, authorization and every status in %s', locale => {
    const html = render(locale);
    for (const key of ['tools.optional', 'tools.authorization', ...statuses.map(s => `tools.status.${s}`)] as Parameters<typeof formatMessage>[1][]) expect(html).toContain(formatMessage(locale, key));
    expect(html).toContain(`aria-label="${formatMessage(locale, 'tools.remove', { name: 'connected' })}"`);
    expect(html).toContain(`title="${formatMessage(locale, 'tools.removeHelp')}"`);
  });
  it.each(['es-AR', 'en-US'] as const)('does not require any MCP and leaves the add form empty in %s', locale => {
    const html = render(locale, { runtimes: [{ ...runtime, servers: [] }], adding: 'claude' });
    expect(html).toContain(formatMessage(locale, 'tools.optional'));
    expect(html).toContain(`placeholder="${formatMessage(locale, 'tools.namePlaceholder')}"`);
    expect(html).toContain(`placeholder="${formatMessage(locale, 'tools.commandPlaceholder')}"`);
    expect(html).toContain('id="mcp-name-claude"');
    expect(html).toContain('value=""');
    expect(html).not.toContain('@modelcontextprotocol/');
    expect(html).not.toContain('notion');
  });
  it('preserves Spanish accents and notice quotation marks', () => {
    expect(formatMessage('es-AR', 'tools.optional')).toContain('Agreg\u00e1');
    expect(formatMessage('es-AR', 'tools.authorization')).toContain('confirm\u00e1');
    expect(formatMessage('es-AR', 'tools.added', { name: 'demo', runtime: 'Codex' })).toBe('\u00abdemo\u00bb qued\u00f3 configurado en Codex');
    expect(formatMessage('es-AR', 'tools.removed', { name: 'demo', runtime: 'Codex' })).toBe('\u00abdemo\u00bb quitado de Codex');
  });
  it('English states and form have no Spanish literals', () => {
    const html = render('en-US', { adding: 'claude' });
    for (const literal of ['Conectado', 'No conecta', 'Pendiente de aprobar', 'Desactivado', 'Configurado', 'Quitar', 'Ej.']) expect(html).not.toContain(literal);
    expect(formatMessage('en-US', 'tools.removed', { name: 'demo', runtime: 'Codex' })).toContain('removed from Codex');
    expect(formatMessage('en-US', 'tools.added', { name: 'demo', runtime: 'Codex' })).toContain('configured in Codex');
  });
  it('offers Codex login and Claude authenticate when the server needs it', () => {
    ui.locale = 'es-AR';
    const html = renderToStaticMarkup(createElement(ToolsViewContent, {
      runtimes: [
        { runtime: 'codex', installed: true, canEdit: true, detail: '', servers: [{ name: 'remoto', status: 'needsAuth', transport: 'http', target: 'https://example.invalid/mcp', detail: '', needsAuth: true }] },
        { runtime: 'claude', installed: true, canEdit: true, detail: '', servers: [{ name: 'sentry', status: 'failed', transport: 'http', target: 'https://example.invalid/mcp', detail: 'auth' }] },
      ],
      loading: false, busy: false, adding: null, onRefresh: () => {}, onRemove: () => {}, onAdding: () => {}, onAdd: async () => {},
      onLoginCodex: () => {}, onAuthenticateClaude: () => {},
    }));
    expect(html).toContain(formatMessage('es-AR', 'tools.login'));
    expect(html).toContain(formatMessage('es-AR', 'tools.authenticateClaude'));
    expect(html).toContain(formatMessage('es-AR', 'tools.status.needsAuth'));
  });
});
