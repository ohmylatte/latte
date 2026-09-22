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
  return renderToStaticMarkup(createElement(ToolsViewContent, { runtimes: [runtime], loading: false, busy: false, onRefresh: () => {}, onRemove: () => {}, ...overrides }));
}
describe('El registro MCP de cada CLI, de sólo lectura', () => {
  it.each(['es-AR', 'en-US'] as const)('renders authorization and every status in %s', locale => {
    const html = render(locale);
    for (const key of ['tools.readOnlyLead', 'tools.authorization', ...statuses.map(s => `tools.status.${s}`)] as Parameters<typeof formatMessage>[1][]) expect(html).toContain(formatMessage(locale, key));
    expect(html).toContain(`aria-label="${formatMessage(locale, 'tools.remove', { name: 'connected' })}"`);
    expect(html).toContain(`title="${formatMessage(locale, 'tools.removeHelp')}"`);
  });

  /**
   * Decisiones C y D del brief `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`.
   *
   * Este test es el candado: mientras exista, esta pantalla no puede volver a
   * ofrecer "Agregar", ni "Autenticar" con su terminal embebida. No es una
   * preferencia estética — ese botón era el ÚNICO camino que podía terminar un
   * OAuth desde Latte, guardaba el token en el perfil de un CLI indexado por
   * nombre (y por eso se perdía al renombrar el servidor), y no tenía forma de
   * dar una cuenta distinta por marca. Lo reemplazó el módulo OAuth del main.
   */
  it('ya no ofrece agregar, ni entrar, ni autenticar con terminal', () => {
    ui.locale = 'es-AR';
    const html = renderToStaticMarkup(createElement(ToolsViewContent, {
      runtimes: [
        { runtime: 'codex', installed: true, canEdit: true, detail: '', servers: [{ name: 'remoto', status: 'needsAuth', transport: 'http', target: 'https://example.invalid/mcp', detail: '', needsAuth: true }] },
        { runtime: 'claude', installed: true, canEdit: true, detail: '', servers: [{ name: 'sentry', status: 'failed', transport: 'http', target: 'https://example.invalid/mcp', detail: 'auth' }] },
      ],
      loading: false, busy: false, onRefresh: () => {}, onRemove: () => {},
    }));
    for (const key of ['tools.login', 'tools.authenticateClaude'] as Parameters<typeof formatMessage>[1][]) {
      expect(html).not.toContain(formatMessage('es-AR', key));
    }
    expect(html).not.toContain('id="mcp-name-claude"');
    // Lo que SÍ queda: el estado que reporta el CLI, y a dónde ir ahora.
    expect(html).toContain(formatMessage('es-AR', 'tools.status.needsAuth'));
    expect(html).toContain(formatMessage('es-AR', 'tools.movedToConnections'));
  });

  it('preserves Spanish accents and notice quotation marks', () => {
    expect(formatMessage('es-AR', 'tools.authorization')).toContain('confirmá');
    expect(formatMessage('es-AR', 'tools.removed', { name: 'demo', runtime: 'Codex' })).toBe('«demo» quitado de Codex');
  });

  it('English states have no Spanish literals', () => {
    const html = render('en-US');
    for (const literal of ['Conectado', 'No conecta', 'Pendiente de aprobar', 'Desactivado', 'Configurado', 'Quitar', 'Ej.']) expect(html).not.toContain(literal);
    expect(formatMessage('en-US', 'tools.removed', { name: 'demo', runtime: 'Codex' })).toContain('removed from Codex');
  });
});
