import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ConnectionsContent, AddConnection, suggestedName } from './ConnectionsView';
import { formatMessage } from './i18n';
import type { Connection, ImportableConnection } from '../shared/contracts';

/**
 * Las dos pantallas de Conexiones (G5 del brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`, 4.3).
 *
 * Todo contra la superficie PRESENTACIONAL: renderizarla no habla con ningún
 * servidor, así que lo que se prueba es lo que la persona ve y no lo que el
 * backend hace.
 */
const t = (key: Parameters<typeof formatMessage>[1], params?: Record<string, string | number>) => formatMessage('es-AR', key, params);

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
  brandId: null,
  connections: [],
  importable: [],
  busy: false,
  adding: false,
  needsClientId: false,
  onAdding: () => {},
  onConnect: () => {},
  onReconnect: () => {},
  onDisconnect: () => {},
  onDelete: () => {},
  onImport: () => {},
  onRefresh: () => {},
  ...over,
});

describe('Ajustes → Conexiones (las globales)', () => {
  it('dice con todas las letras que una conexión de acá vale para todas las marcas', () => {
    render(<ConnectionsContent {...props()} />);
    expect(screen.getByText(t('connections.leadGlobal'))).toBeTruthy();
    expect(screen.getByText(t('connections.emptyGlobal'))).toBeTruthy();
  });

  it('la fila tiene la anatomía del equipo: estado, nombre, una línea y la hora', () => {
    render(<ConnectionsContent {...props({ connections: [connection({ id: 'con_1', name: 'theagentcy', label: 'The Agentcy' })] })} />);
    expect(screen.getByText('The Agentcy')).toBeTruthy();
    expect(screen.getByText(t('connections.state.connected'))).toBeTruthy();
    // Una conexión conectada ofrece desconectar, no volver a entrar.
    expect(screen.getByText(t('connections.disconnect'))).toBeTruthy();
    expect(screen.queryByText(t('connections.reenter'))).toBeNull();
  });

  it('una VENCIDA muestra su motivo en la misma línea y ofrece volver a entrar', () => {
    render(<ConnectionsContent {...props({
      connections: [connection({ id: 'con_1', name: 'theagentcy', label: 'The Agentcy', state: 'expired', stateDetail: 'la sesión venció y no se pudo renovar' })],
    })} />);
    expect(screen.getByText(t('connections.state.expired'))).toBeTruthy();
    expect(screen.getByText('la sesión venció y no se pudo renovar')).toBeTruthy();
    expect(screen.getByText(t('connections.reenter'))).toBeTruthy();
    expect(screen.queryByText(t('connections.disconnect'))).toBeNull();
  });

  it('una en ERROR también ofrece volver a entrar, con su motivo escrito', () => {
    render(<ConnectionsContent {...props({
      connections: [connection({ id: 'con_1', name: 'x', label: 'X', state: 'error', stateDetail: 'esa dirección no dice cómo se entra' })],
    })} />);
    expect(screen.getByText('esa dirección no dice cómo se entra')).toBeTruthy();
    expect(screen.getByText(t('connections.reenter'))).toBeTruthy();
  });
});

describe('Marca → Conexiones', () => {
  const inherited = connection({ id: 'con_g', name: 'meta', label: 'Meta Ads', scope: 'global', inherited: true });
  const own = connection({ id: 'con_b', name: 'theagentcy', label: 'The Agentcy', scope: 'brand', brandId: 'brd_1', inherited: false });

  it('separa las propias de las heredadas, y las heredadas no se pueden quitar desde acá', () => {
    render(<ConnectionsContent {...props({ brandId: 'brd_1', brandName: 'Ámbar', connections: [own, inherited] })} />);
    expect(screen.getByText(t('connections.leadBrand', { brand: 'Ámbar' }))).toBeTruthy();
    expect(screen.getByText(t('connections.inheritedHead'))).toBeTruthy();

    const inheritedRow = screen.getByText('Meta Ads').closest('.connection-card') as HTMLElement;
    expect(inheritedRow.className).toContain('inherited');
    // Ni borrar ni desconectar: desde acá se usa, no se toca.
    expect(within(inheritedRow).queryByLabelText(t('connections.delete', { name: 'Meta Ads' }))).toBeNull();
    expect(within(inheritedRow).queryByText(t('connections.disconnect'))).toBeNull();
    // La salida que sí ofrece: una cuenta propia, que pasa a ganar.
    expect(within(inheritedRow).getByText(t('connections.ownAccount'))).toBeTruthy();

    const ownRow = screen.getByText('The Agentcy').closest('.connection-card') as HTMLElement;
    expect(ownRow.className).not.toContain('inherited');
    expect(within(ownRow).getByLabelText(t('connections.delete', { name: 'The Agentcy' }))).toBeTruthy();
  });

  it('sin conexión propia, el vacío dice que puede estar usando una global', () => {
    render(<ConnectionsContent {...props({ brandId: 'brd_1', brandName: 'Ámbar', connections: [inherited] })} />);
    expect(screen.getByText(t('connections.emptyBrand'))).toBeTruthy();
  });
});

describe('Agregar conexión', () => {
  it('desde Ajustes el alcance es global y AVISA que toca a todas las marcas', () => {
    render(<AddConnection brandId={null} busy={false} needsClientId={false} onCancel={() => {}} onConnect={() => {}} />);
    const select = screen.getByLabelText(t('connections.scopeLabel')) as HTMLSelectElement;
    expect(select.value).toBe('global');
    // Desde Ajustes no hay a qué marca acotarlo, así que la opción no existe.
    expect(select.disabled).toBe(true);
    expect(screen.getByText(t('connections.scopeGlobalWarning'))).toBeTruthy();
  });

  it('desde una marca arranca en "sólo esta marca" y explica que le gana a la global', () => {
    render(<AddConnection brandId="brd_1" busy={false} needsClientId={false} onCancel={() => {}} onConnect={() => {}} />);
    const select = screen.getByLabelText(t('connections.scopeLabel')) as HTMLSelectElement;
    expect(select.value).toBe('brand');
    expect(select.disabled).toBe(false);
    expect(screen.getByText(t('connections.scopeBrandHelp'))).toBeTruthy();
  });

  it('el id de cliente sólo aparece cuando el servidor no da de alta clientes solo', () => {
    const { rerender } = render(<AddConnection brandId={null} busy={false} needsClientId={false} onCancel={() => {}} onConnect={() => {}} />);
    expect(screen.queryByLabelText(t('connections.clientIdLabel'))).toBeNull();
    rerender(<AddConnection brandId={null} busy={false} needsClientId onCancel={() => {}} onConnect={() => {}} />);
    expect(screen.getByLabelText(t('connections.clientIdLabel'))).toBeTruthy();
    expect(screen.getByText(t('connections.clientIdHelp'))).toBeTruthy();
  });

  it('propone un nombre a partir del dominio, así nadie tiene que inventarlo', () => {
    expect(suggestedName('https://theagentcy.app/api/mcp')).toBe('theagentcy');
    expect(suggestedName('https://www.facebook.com/ads')).toBe('facebook');
    expect(suggestedName('no es una url')).toBe('');
  });

  it('no deja conectar sin una URL http(s)', () => {
    const onConnect = vi.fn();
    render(<AddConnection brandId={null} busy={false} needsClientId={false} onCancel={() => {}} onConnect={onConnect} />);
    const connect = screen.getByText(t('connections.connect')).closest('button') as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
  });
});

describe('Importación única del registro del CLI', () => {
  const importable: ImportableConnection = { runtime: 'claude', name: 'the-agentcy', url: 'https://theagentcy.app/api/mcp', suggestedScope: 'brand', alreadyImported: false };

  it('ofrece importar y explica que los tokens del CLI no se copian', () => {
    render(<ConnectionsContent {...props({ importable: [importable] })} />);
    expect(screen.getByText(t('connections.importHead'))).toBeTruthy();
    expect(screen.getByText(t('connections.importHelp'))).toBeTruthy();
    expect(screen.getByText('the-agentcy')).toBeTruthy();
    expect(screen.getByText(t('connections.import'))).toBeTruthy();
  });

  it('sin nada que importar, la sección no existe', () => {
    render(<ConnectionsContent {...props()} />);
    expect(screen.queryByText(t('connections.importHead'))).toBeNull();
  });
});

describe('copy fija', () => {
  it('cada clave de conexiones existe en los dos idiomas y ninguna se repite tal cual', () => {
    const keys = [
      'connections.title', 'connections.leadGlobal', 'connections.leadBrand', 'connections.add',
      'connections.connect', 'connections.reenter', 'connections.disconnect', 'connections.import',
      'connections.state.connected', 'connections.state.expired', 'connections.state.error', 'connections.state.disconnected',
      'connections.scope.global', 'connections.scope.brand', 'connections.scopeGlobalWarning',
      'connections.inheritedHead', 'connections.ownAccount', 'connections.clientIdLabel',
    ] as const;
    for (const key of keys) {
      const es = formatMessage('es-AR', key, { brand: 'X', name: 'X', url: 'X', identity: '' });
      const en = formatMessage('en-US', key, { brand: 'X', name: 'X', url: 'X', identity: '' });
      expect(es.length, key).toBeGreaterThan(0);
      expect(en.length, key).toBeGreaterThan(0);
    }
  });

  it('el aviso de alcance global nombra a TODAS las marcas en los dos idiomas', () => {
    expect(formatMessage('es-AR', 'connections.scopeGlobalWarning')).toContain('TODAS');
    expect(formatMessage('en-US', 'connections.scopeGlobalWarning')).toContain('EVERY');
  });
});
