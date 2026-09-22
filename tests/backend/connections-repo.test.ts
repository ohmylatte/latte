import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../../electron/storage/driver';
import { openDriver } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { memorySecretBox, unavailableSecretBox } from '../../electron/storage/secretBox';
import { makeTempDir, removeDir } from './helpers';
import path from 'node:path';

/**
 * La entidad Conexión (G1 del brief `2026-09-23-conexiones-mcp-arquitectura`,
 * sección 4.3): alcance elegido al conectar, la de marca gana sobre la global
 * para el mismo servidor, tokens cifrados en una tabla aparte.
 */
describe('connections repository', () => {
  let dir: string;
  let driver: SqlDriver | undefined;
  let repo: LatteRepository;

  beforeEach(async () => {
    dir = makeTempDir('latte-conn-');
    const opened = await openDriver(path.join(dir, 'latte.db'), 'node:sqlite');
    driver = opened.driver;
    repo = new LatteRepository(driver);
    repo.migrate();
    repo.insertBrand({ id: 'brd_1', name: 'Ámbar', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
    repo.insertBrand({ id: 'brd_2', name: 'Latte', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
  });

  afterEach(() => {
    try { driver?.close(); } catch { /* closed */ }
    removeDir(dir);
  });

  const input = (over: Partial<Parameters<LatteRepository['connections']['insert']>[0]> = {}) => ({
    id: 'con_1',
    name: 'theagentcy',
    label: 'The Agentcy',
    url: 'https://theagentcy.app/api/mcp',
    transport: 'http' as const,
    authKind: 'oauth' as const,
    clientId: null,
    identity: null,
    scope: 'global' as const,
    brandId: null,
    state: 'disconnected' as const,
    stateDetail: '',
    memberOverride: null,
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
    ...over,
  });

  it('el esquema quedó en 13 y creó las dos tablas', () => {
    expect(SCHEMA_VERSION).toBe('13');
    expect(driver!.get("SELECT name FROM sqlite_master WHERE type='table' AND name='connections'")?.name).toBe('connections');
    expect(driver!.get("SELECT name FROM sqlite_master WHERE type='table' AND name='connection_tokens'")?.name).toBe('connection_tokens');
  });

  it('guarda y relee una conexión global', () => {
    repo.connections.insert(input());
    const all = repo.connections.list(null);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'con_1', name: 'theagentcy', scope: 'global', brandId: null, inherited: false });
  });

  it('una conexión de marca exige brandId y una global lo prohíbe', () => {
    expect(() => repo.connections.insert(input({ scope: 'brand', brandId: null }))).toThrow(/marca/i);
    expect(() => repo.connections.insert(input({ scope: 'global', brandId: 'brd_1' }))).toThrow(/global/i);
  });

  it('el índice único es por (servidor, alcance, marca)', () => {
    repo.connections.insert(input({ id: 'con_g', scope: 'global', brandId: null }));
    // Mismo nombre, misma marca, mismo alcance: choca.
    expect(() => repo.connections.insert(input({ id: 'con_g2', scope: 'global', brandId: null }))).toThrow();
    // Mismo nombre, alcance distinto: convive.
    repo.connections.insert(input({ id: 'con_b1', scope: 'brand', brandId: 'brd_1' }));
    // Mismo nombre, otra marca: convive.
    repo.connections.insert(input({ id: 'con_b2', scope: 'brand', brandId: 'brd_2' }));
    expect(repo.connections.list(null).map((c) => c.id)).toEqual(['con_g']);
    expect(repo.connections.list('brd_1').map((c) => c.id).sort()).toEqual(['con_b1', 'con_g']);
  });

  it('list(brandId) marca las globales como heredadas', () => {
    repo.connections.insert(input({ id: 'con_g', scope: 'global', brandId: null }));
    repo.connections.insert(input({ id: 'con_b', name: 'gmail', scope: 'brand', brandId: 'brd_1' }));
    const listed = repo.connections.list('brd_1');
    expect(listed.find((c) => c.id === 'con_g')!.inherited).toBe(true);
    expect(listed.find((c) => c.id === 'con_b')!.inherited).toBe(false);
  });

  describe('resolución marca → global', () => {
    it('sólo global: la usa', () => {
      repo.connections.insert(input({ id: 'con_g', scope: 'global', brandId: null }));
      expect(repo.connections.resolveForBrand('brd_1').map((c) => c.id)).toEqual(['con_g']);
    });

    it('sólo de marca: la usa', () => {
      repo.connections.insert(input({ id: 'con_b', scope: 'brand', brandId: 'brd_1' }));
      expect(repo.connections.resolveForBrand('brd_1').map((c) => c.id)).toEqual(['con_b']);
    });

    it('las dos: gana la de marca, y la otra marca sigue con la global', () => {
      repo.connections.insert(input({ id: 'con_g', scope: 'global', brandId: null }));
      repo.connections.insert(input({ id: 'con_b', scope: 'brand', brandId: 'brd_1' }));
      expect(repo.connections.resolveForBrand('brd_1').map((c) => c.id)).toEqual(['con_b']);
      expect(repo.connections.resolveForBrand('brd_2').map((c) => c.id)).toEqual(['con_g']);
    });

    it('ninguna: no se inyecta nada', () => {
      expect(repo.connections.resolveForBrand('brd_1')).toEqual([]);
    });
  });

  describe('tokens', () => {
    const tokens = {
      accessToken: 'at-secreto',
      refreshToken: 'rt-secreto',
      expiresAt: '2026-09-23T11:00:00.000Z',
      tokenType: 'Bearer',
      scope: 'mcp',
      clientId: 'cli_1',
      issuer: 'https://theagentcy.app',
      tokenEndpoint: 'https://theagentcy.app/api/mcp/oauth/token',
      revocationEndpoint: null,
      resource: 'https://theagentcy.app/api/mcp',
    };

    it('cifra el blob: el access token no aparece en claro en la base', () => {
      const box = memorySecretBox();
      repo.connections.insert(input());
      repo.connections.saveTokens('con_1', tokens, box, '2026-09-23T10:01:00.000Z');
      const row = driver!.get<{ blob: string }>('SELECT blob FROM connection_tokens WHERE connection_id = ?', ['con_1']);
      expect(row).toBeTruthy();
      expect(row!.blob).not.toContain('at-secreto');
      expect(row!.blob).not.toContain('rt-secreto');
      expect(repo.connections.readTokens('con_1', box)).toEqual(tokens);
    });

    it('sin safeStorage no se guarda nada y lo explica', () => {
      const box = unavailableSecretBox('El almacén de secretos del sistema no está disponible.');
      repo.connections.insert(input());
      expect(() => repo.connections.saveTokens('con_1', tokens, box, '2026-09-23T10:01:00.000Z'))
        .toThrow(/almacén de secretos|no está disponible/i);
      expect(driver!.get('SELECT connection_id FROM connection_tokens WHERE connection_id = ?', ['con_1'])).toBeUndefined();
      expect(repo.connections.readTokens('con_1', box)).toBeNull();
    });

    it('borrar la conexión borra sus tokens', () => {
      const box = memorySecretBox();
      repo.connections.insert(input());
      repo.connections.saveTokens('con_1', tokens, box, '2026-09-23T10:01:00.000Z');
      repo.connections.remove('con_1');
      expect(driver!.get('SELECT connection_id FROM connection_tokens WHERE connection_id = ?', ['con_1'])).toBeUndefined();
      expect(repo.connections.get('con_1')).toBeNull();
    });

    it('un blob ilegible se lee como "no hay tokens", no explota', () => {
      const box = memorySecretBox();
      repo.connections.insert(input());
      repo.connections.saveTokens('con_1', tokens, box, '2026-09-23T10:01:00.000Z');
      driver!.run('UPDATE connection_tokens SET blob = ? WHERE connection_id = ?', ['no-es-un-blob', 'con_1']);
      expect(repo.connections.readTokens('con_1', box)).toBeNull();
    });
  });

  it('el estado se actualiza sin tocar el resto de la fila', () => {
    repo.connections.insert(input());
    repo.connections.setState('con_1', 'expired', 'la sesión se venció', '2026-09-23T12:00:00.000Z');
    const found = repo.connections.get('con_1')!;
    expect(found.state).toBe('expired');
    expect(found.stateDetail).toBe('la sesión se venció');
    expect(found.updatedAt).toBe('2026-09-23T12:00:00.000Z');
    expect(found.url).toBe('https://theagentcy.app/api/mcp');
  });

  it('borrar la marca borra sus conexiones', () => {
    repo.connections.insert(input({ id: 'con_b', scope: 'brand', brandId: 'brd_1' }));
    driver!.run('DELETE FROM brands WHERE id = ?', ['brd_1']);
    expect(repo.connections.get('con_b')).toBeNull();
  });
});
