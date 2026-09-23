import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ConnectionsContent, AddConnectionDialog, sortConnections, suggestedName } from './ConnectionsView';
import { formatMessage } from './i18n';
import { catalogs } from './i18n';
import type { Brand, Connection, ImportableConnection } from '../shared/contracts';

/**
 * UNA SOLA PANTALLA DE CONEXIONES.
 *
 * Antes eran dos —las globales en Ajustes, las de la marca adentro de la
 * marca— y el resultado era lo técnico metido en lo cotidiano: la pantalla de
 * una marca se llenaba de direcciones de servidores MCP. Ahora TODAS las
 * conexiones viven en Ajustes, en una lista sola, y cada fila dice de quién
 * es. El área de la marca no tiene ninguna.
 *
 * Todo contra la superficie PRESENTACIONAL: renderizarla no habla con ningún
 * servidor, así que lo que se prueba es lo que la persona ve.
 */
const t = (key: Parameters<typeof formatMessage>[1], params?: Record<string, string | number>) => formatMessage('es-AR', key, params);

const NOW = Date.parse('2026-09-23T12:00:00.000Z');

const brands: Brand[] = [
  { id: 'brd_1', name: 'Maldita Poesía', context: '', createdAt: '', archivedAt: null },
  { id: 'brd_2', name: 'Ámbar', context: '', createdAt: '', archivedAt: null },
];

const connection = (over: Partial<Connection> & Pick<Connection, 'id' | 'name'>): Connection => ({
  label: over.name,
  url: 'https://theagentcy.app/api/mcp',
  transport: 'http',
  authKind: 'oauth',
  clientId: null,
  identity: null,
  scope: 'global',
  brandId: null,
  state: 'connected',
  stateDetail: '',
  inherited: false,
  createdAt: '2026-09-23T10:00:00.000Z',
  updatedAt: '2026-09-23T10:00:00.000Z',
  ...over,
});

const props = (over: Partial<Parameters<typeof ConnectionsContent>[0]> = {}): Parameters<typeof ConnectionsContent>[0] => ({
  connections: [],
  brands,
  importable: [],
  busy: false,
  selectedId: null,
  onSelect: () => {},
  onAdd: () => {},
  onReconnect: () => {},
  onDisconnect: () => {},
  onDelete: () => {},
  onImport: () => {},
  onForget: () => {},
  onRefresh: () => {},
  now: NOW,
  ...over,
});

const global = connection({ id: 'con_g', name: 'meta', label: 'Meta Ads' });
const ofBrand = connection({
  id: 'con_b', name: 'theagentcy', label: 'The Agentcy', scope: 'brand', brandId: 'brd_1',
  state: 'expired', stateDetail: 'la sesión venció y no se pudo renovar',
  updatedAt: '2026-09-23T10:00:00.000Z',
});

describe('una sola lista: las globales y las de cada marca', () => {
  it('dibuja las dos en la misma lista, cada una con su alcance escrito en la línea', () => {
    render(<ConnectionsContent {...props({ connections: [global, ofBrand] })} />);
    const rows = document.querySelectorAll('.connections-list .coord-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Meta Ads')).toBeTruthy();
    expect(screen.getByText('The Agentcy')).toBeTruthy();
    expect(screen.getByText(t('connections.line', { scope: t('connections.scopeGlobalShort'), detail: t('connections.state.connected') }))).toBeTruthy();
    expect(screen.getByText(
      t('connections.line', {
        scope: t('connections.scopeBrandShort', { brand: 'Maldita Poesía' }),
        detail: `${t('connections.state.expired')} ${t('connections.agoHours', { count: 2 })}`,
      }),
    )).toBeTruthy();
  });

  it('las globales van primero y después cada marca', () => {
    const otherBrand = connection({ id: 'con_c', name: 'gmail', label: 'Gmail', scope: 'brand', brandId: 'brd_2' });
    const sorted = sortConnections([ofBrand, otherBrand, global], brands);
    expect(sorted.map(c => c.id)).toEqual(['con_g', 'con_c', 'con_b']);
  });

  it('sin ninguna conexión el vacío lo dice en una sola línea', () => {
    render(<ConnectionsContent {...props()} />);
    expect(screen.getByText(t('connections.empty'))).toBeTruthy();
  });
});

describe('la fila es la acción: abre el detalle', () => {
  it('clickearla la selecciona', () => {
    const onSelect = vi.fn();
    render(<ConnectionsContent {...props({ connections: [global], onSelect })} />);
    fireEvent.click(screen.getByText('Meta Ads').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith('con_g');
  });

  it('el detalle trae la dirección, el alcance y los botones; conectada ofrece desconectar', () => {
    render(<ConnectionsContent {...props({ connections: [global], selectedId: 'con_g' })} />);
    const detail = document.querySelector('.connection-detail') as HTMLElement;
    expect(detail).toBeTruthy();
    expect(within(detail).getByText('https://theagentcy.app/api/mcp')).toBeTruthy();
    expect(within(detail).getByText(t('connections.scopeGlobalShort'))).toBeTruthy();
    expect(within(detail).getByText(t('connections.disconnect'))).toBeTruthy();
    expect(within(detail).queryByText(t('connections.reenter'))).toBeNull();
  });

  it('una vencida muestra su motivo y ofrece volver a entrar, y nombra la marca dueña', () => {
    render(<ConnectionsContent {...props({ connections: [ofBrand], selectedId: 'con_b' })} />);
    const detail = document.querySelector('.connection-detail') as HTMLElement;
    expect(within(detail).getByText(t('connections.scopeBrandShort', { brand: 'Maldita Poesía' }))).toBeTruthy();
    expect(detail.textContent).toContain('la sesión venció y no se pudo renovar');
    expect(within(detail).getByText(t('connections.reenter'))).toBeTruthy();
    expect(within(detail).queryByText(t('connections.disconnect'))).toBeNull();
  });

  it('la cuenta sólo aparece cuando el servidor dijo alguna', () => {
    const { rerender } = render(<ConnectionsContent {...props({ connections: [global], selectedId: 'con_g' })} />);
    expect(screen.queryByText(t('connections.accountLabel'))).toBeNull();
    rerender(<ConnectionsContent {...props({ connections: [connection({ ...global, identity: 'ads@estudio.com' })], selectedId: 'con_g' })} />);
    expect(screen.getByText(t('connections.accountLabel'))).toBeTruthy();
    expect(screen.getByText('ads@estudio.com')).toBeTruthy();
  });
});

describe('Agregar conexión: un diálogo, con el alcance adentro', () => {
  const dialog = (over: Partial<Parameters<typeof AddConnectionDialog>[0]> = {}) => render(<AddConnectionDialog
    brands={brands} initial={{ url: '', name: '' }} busy={false} needsClientId={false}
    onCancel={() => {}} onConnect={() => {}} {...over} />);

  it('es un modal, como el de sumar un miembro', () => {
    dialog();
    const modal = screen.getByRole('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(within(modal).getByText(t('connections.add'))).toBeTruthy();
  });

  it('arranca en todas las marcas y el selector de marca no existe todavía', () => {
    dialog();
    const scope = screen.getByLabelText(t('connections.scopeLabel')) as HTMLSelectElement;
    expect(scope.value).toBe('global');
    expect([...scope.options].map(o => o.textContent)).toEqual([t('connections.scope.global'), t('connections.scope.brand')]);
    expect(screen.queryByLabelText(t('connections.brandLabel'))).toBeNull();
  });

  it('elegir "Una marca" abre el selector con las marcas y manda esa marca al entrar', () => {
    const onConnect = vi.fn();
    dialog({ initial: { url: 'https://theagentcy.app/api/mcp', name: '' }, onConnect });
    fireEvent.change(screen.getByLabelText(t('connections.scopeLabel')), { target: { value: 'brand' } });
    const picker = screen.getByLabelText(t('connections.brandLabel')) as HTMLSelectElement;
    expect([...picker.options].map(o => o.textContent)).toEqual(['Maldita Poesía', 'Ámbar']);
    fireEvent.change(picker, { target: { value: 'brd_2' } });
    fireEvent.click(screen.getByText(t('connections.connect')).closest('button')!);
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ scope: 'brand', brandId: 'brd_2', name: 'theagentcy' }));
  });

  it('una conexión para todas las marcas no manda ninguna marca', () => {
    const onConnect = vi.fn();
    dialog({ initial: { url: 'https://theagentcy.app/api/mcp', name: '' }, onConnect });
    fireEvent.click(screen.getByText(t('connections.connect')).closest('button')!);
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global', brandId: null }));
  });

  it('no deja entrar sin una dirección http(s)', () => {
    dialog();
    expect((screen.getByText(t('connections.connect')).closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('el id de cliente sólo aparece cuando el servidor no da de alta clientes solo', () => {
    dialog({ needsClientId: true });
    expect(screen.getByLabelText(t('connections.clientIdLabel'))).toBeTruthy();
  });

  it('propone un nombre a partir del dominio, así nadie tiene que inventarlo', () => {
    expect(suggestedName('https://theagentcy.app/api/mcp')).toBe('theagentcy');
    expect(suggestedName('https://www.facebook.com/ads')).toBe('facebook');
    expect(suggestedName('no es una url')).toBe('');
  });
});

/**
 * K3: EL ÁREA DE LA MARCA QUEDA LIMPIA.
 *
 * Una conexión es una cuenta con un servidor MCP: algo técnico, que se
 * configura una vez. La vista Contexto es el día a día de la marca. Mezclarlas
 * era el error, así que el candado mira el código: si alguien vuelve a colgar
 * `ConnectionsView` de la pantalla de la marca, esto falla.
 */
describe('K3: Contexto sin conexiones', () => {
  const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');

  it('App no importa ni dibuja ConnectionsView en ninguna vista de la marca', () => {
    expect(app.length).toBeGreaterThan(1000);
    expect(app).not.toContain('ConnectionsView');
  });

  it('la vista Contexto tampoco las nombra por su cuenta', () => {
    const context = readFileSync(join(process.cwd(), 'src', 'ContextView.tsx'), 'utf8');
    expect(context.length).toBeGreaterThan(500);
    expect(context).not.toContain('Connection');
  });
});

/**
 * K2: EL REGISTRO DE LOS CLI ES UN BLOQUE SECUNDARIO, NO UNA PANTALLA.
 *
 * "Herramientas (MCP)" era una sección entera de Ajustes para mostrar lo que
 * Claude Code y Codex tienen anotado por su cuenta. Eso no es una pantalla: es
 * una nota al pie de Conexiones, plegada, que se abre el día que alguien
 * quiere traerse algo de un CLI.
 */
const importable: ImportableConnection = {
  runtime: 'claude', name: 'the-agentcy', url: 'https://theagentcy.app/api/mcp', suggestedScope: 'brand', alreadyImported: false,
};

describe('K2: "De tus CLI", plegado al pie', () => {
  it('es un <details> CERRADO: no ocupa la pantalla de nadie que no lo pidió', () => {
    render(<ConnectionsContent {...props({ importable: [importable] })} />);
    const block = document.querySelector('details.connections-cli') as HTMLDetailsElement;
    expect(block).toBeTruthy();
    expect(block.open).toBe(false);
    expect(within(block).getByText(t('connections.importHead'))).toBeTruthy();
  });

  it('lista lo anotado, con importar y el tacho para quitarlo del registro', () => {
    const onImport = vi.fn();
    const onForget = vi.fn();
    render(<ConnectionsContent {...props({ importable: [importable], onImport, onForget })} />);
    const block = document.querySelector('details.connections-cli') as HTMLElement;
    expect(within(block).getByText('the-agentcy')).toBeTruthy();
    expect(within(block).getByText('https://theagentcy.app/api/mcp')).toBeTruthy();
    fireEvent.click(within(block).getByText(t('connections.import')).closest('button')!);
    expect(onImport).toHaveBeenCalledWith(importable);
    fireEvent.click(within(block).getByLabelText(t('connections.forget', { name: 'the-agentcy' })));
    expect(onForget).toHaveBeenCalledWith(importable);
  });

  it('sin nada anotado lo dice, en vez de dejar un bloque vacío', () => {
    render(<ConnectionsContent {...props()} />);
    expect(screen.getByText(t('connections.cliEmpty'))).toBeTruthy();
  });

  it('la advertencia es UNA línea gris, no un párrafo', () => {
    render(<ConnectionsContent {...props()} />);
    const line = screen.getByText(t('connections.authorization'));
    expect(line.className).toContain('footnote');
    expect(t('connections.authorization').length).toBeLessThan(120);
  });
});

describe('K2: Herramientas (MCP) se fue del menú de Ajustes', () => {
  const settings = readFileSync(join(process.cwd(), 'src', 'SettingsScreen.tsx'), 'utf8');

  it('la sección ya no existe ni se puede navegar a ella', () => {
    expect(settings.length).toBeGreaterThan(1000);
    expect(settings).not.toContain("'tools'");
    expect(settings).not.toContain('ToolsView');
  });

  it('la pantalla que la dibujaba tampoco', () => {
    expect(existsSync(join(process.cwd(), 'src', 'ToolsView.tsx'))).toBe(false);
  });

  it('y su nombre salió de los dos idiomas', () => {
    expect(Object.keys(catalogs['es-AR'])).not.toContain('settings.tools');
    expect(Object.keys(catalogs['en-US'])).not.toContain('settings.tools');
  });
});
