/**
 * El almacén de Conexiones MCP (brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`, 4.3 y G1).
 *
 * Tres responsabilidades y ninguna más: filas, resolución marca→global y el
 * blob cifrado. Nada de HTTP, nada de OAuth, nada de Electron — el cifrado
 * entra por el puerto `SecretBox`, así que estas reglas se prueban sin
 * levantar nada.
 */
import type { Connection, ConnectionAuthKind, ConnectionScope, ConnectionState } from '../../shared/contracts';
import { SecretStoreUnavailableError, ValidationError } from '../core/errors';
import type { SqlDriver, SqlRow } from './driver';
import type { SecretBox } from './secretBox';

/**
 * Lo que el módulo OAuth guarda por conexión. NUNCA sale de aquí sin pasar por
 * `SecretBox`, nunca se loguea y nunca cruza el IPC: el renderer no tiene por
 * qué ver un token del proveedor ni una vez.
 */
export interface ConnectionTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO. Null cuando el servidor no dijo cuánto dura; el gateway refresca ante el primer 401. */
  expiresAt: string | null;
  tokenType: string;
  scope: string | null;
  /** El `client_id` con el que se obtuvo: el del registro dinámico, o el que trajo la conexión. */
  clientId: string | null;
  issuer: string | null;
  tokenEndpoint: string | null;
  revocationEndpoint: string | null;
  /** El recurso RFC 8707 por el que se pidió el token: la URL del servidor MCP. */
  resource: string | null;
}

export interface ConnectionRecord {
  id: string;
  name: string;
  label: string;
  url: string;
  transport: 'http';
  authKind: ConnectionAuthKind;
  clientId: string | null;
  identity: string | null;
  scope: ConnectionScope;
  brandId: string | null;
  state: ConnectionState;
  stateDetail: string;
  memberOverride: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionRow extends SqlRow {
  id: string;
  name: string;
  label: string;
  url: string;
  transport: string;
  auth_kind: string;
  client_id: string | null;
  identity: string | null;
  scope: string;
  brand_id: string | null;
  state: string;
  state_detail: string;
  member_override: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: ConnectionRow): ConnectionRecord => ({
  id: r.id,
  name: r.name,
  label: r.label,
  url: r.url,
  transport: 'http',
  authKind: r.auth_kind as ConnectionAuthKind,
  clientId: r.client_id ?? null,
  identity: r.identity ?? null,
  scope: r.scope as ConnectionScope,
  brandId: r.brand_id ?? null,
  state: r.state as ConnectionState,
  stateDetail: r.state_detail,
  memberOverride: r.member_override ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** La fila tal como la lee la UI: el registro más si esa marca la hereda. */
export const toConnection = (record: ConnectionRecord, inherited: boolean): Connection => ({
  id: record.id,
  name: record.name,
  label: record.label,
  url: record.url,
  transport: record.transport,
  authKind: record.authKind,
  clientId: record.clientId,
  identity: record.identity,
  scope: record.scope,
  brandId: record.brandId,
  state: record.state,
  stateDetail: record.stateDetail,
  inherited,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const SELECT = 'SELECT id, name, label, url, transport, auth_kind, client_id, identity, scope, brand_id, state, state_detail, member_override, created_at, updated_at FROM connections';

export class ConnectionsRepository {
  constructor(private readonly db: SqlDriver) {}

  /**
   * El `CHECK` de la tabla ya lo impide, pero un error de SQLite ("CHECK
   * constraint failed") no le sirve a nadie: esto falla antes y dice cuál de
   * las dos reglas se rompió.
   */
  private assertScope(scope: ConnectionScope, brandId: string | null): void {
    if (scope === 'brand' && !brandId) throw new ValidationError('Una conexión de marca necesita una marca.');
    if (scope === 'global' && brandId) throw new ValidationError('Una conexión global vale para todas las marcas: no lleva marca.');
  }

  insert(record: ConnectionRecord): ConnectionRecord {
    this.assertScope(record.scope, record.brandId);
    this.db.run(
      'INSERT INTO connections(id, name, label, url, transport, auth_kind, client_id, identity, scope, brand_id, state, state_detail, member_override, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [record.id, record.name, record.label, record.url, record.transport, record.authKind, record.clientId, record.identity, record.scope, record.brandId, record.state, record.stateDetail, record.memberOverride, record.createdAt, record.updatedAt],
    );
    return record;
  }

  get(id: string): ConnectionRecord | null {
    const row = this.db.get<ConnectionRow>(`${SELECT} WHERE id = ?`, [id]);
    return row ? toRecord(row) : null;
  }

  /** Todas las de esa marca MÁS las globales (heredadas). `null` = sólo las globales: la pantalla de Ajustes. */
  list(brandId: string | null): Connection[] {
    const rows = brandId
      ? this.db.all<ConnectionRow>(`${SELECT} WHERE scope = 'global' OR brand_id = ? ORDER BY name ASC, scope ASC`, [brandId])
      : this.db.all<ConnectionRow>(`${SELECT} WHERE scope = 'global' ORDER BY name ASC`);
    return rows.map((row) => {
      const record = toRecord(row);
      return toConnection(record, brandId != null && record.scope === 'global');
    });
  }

  /** Las de un alcance solo, sin heredadas: lo que la pantalla de una marca puede quitar. */
  listOwn(brandId: string | null): ConnectionRecord[] {
    const rows = brandId
      ? this.db.all<ConnectionRow>(`${SELECT} WHERE brand_id = ? ORDER BY name ASC`, [brandId])
      : this.db.all<ConnectionRow>(`${SELECT} WHERE scope = 'global' ORDER BY name ASC`);
    return rows.map(toRecord);
  }

  /**
   * Qué conexión le toca a cada servidor para un trabajo de esta marca: **la
   * de marca gana sobre la global** para el mismo `name` (brief 4.3). Una
   * marca con su propia cuenta de Canva pisa la pro compartida sin tocar a las
   * demás; si no hay ninguna para un servidor, ese servidor no se inyecta —
   * que es lo mismo que decir que no aparece en esta lista.
   */
  resolveForBrand(brandId: string): ConnectionRecord[] {
    const byName = new Map<string, ConnectionRecord>();
    for (const row of this.db.all<ConnectionRow>(`${SELECT} WHERE scope = 'global' ORDER BY name ASC`)) {
      const record = toRecord(row);
      byName.set(record.name, record);
    }
    for (const row of this.db.all<ConnectionRow>(`${SELECT} WHERE brand_id = ? ORDER BY name ASC`, [brandId])) {
      const record = toRecord(row);
      byName.set(record.name, record);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  setState(id: string, state: ConnectionState, detail: string, updatedAt: string): void {
    this.db.run('UPDATE connections SET state = ?, state_detail = ?, updated_at = ? WHERE id = ?', [state, detail, updatedAt, id]);
  }

  setIdentity(id: string, identity: string | null, updatedAt: string): void {
    this.db.run('UPDATE connections SET identity = ?, updated_at = ? WHERE id = ?', [identity, updatedAt, id]);
  }

  /** El `client_id` que devolvió el registro dinámico, para no volver a registrarse en cada login. */
  setClientId(id: string, clientId: string | null, updatedAt: string): void {
    this.db.run('UPDATE connections SET client_id = ?, updated_at = ? WHERE id = ?', [clientId, updatedAt, id]);
  }

  remove(id: string): void {
    // El ON DELETE CASCADE de `connection_tokens` hace el resto, pero el
    // borrado explícito no depende de que el PRAGMA esté prendido: un secreto
    // que sobrevive a su conexión es exactamente lo que no puede pasar.
    this.db.run('DELETE FROM connection_tokens WHERE connection_id = ?', [id]);
    this.db.run('DELETE FROM connections WHERE id = ?', [id]);
  }

  // --- Secretos ----------------------------------------------------------

  /**
   * Sin `safeStorage` NO SE GUARDA. La alternativa sería escribir el token del
   * proveedor en claro en la base del usuario, que es justo lo que este diseño
   * existe para evitar; la persona se entera por el mensaje, no por un
   * silencio (brief 4.3, riesgo 1).
   */
  saveTokens(id: string, tokens: ConnectionTokens, box: SecretBox, updatedAt: string): void {
    if (!box.available) throw new SecretStoreUnavailableError(box.detail || 'El almacén de secretos del sistema no está disponible, así que la conexión no se puede guardar.');
    const blob = box.encrypt(JSON.stringify(tokens));
    this.db.run(
      'INSERT INTO connection_tokens(connection_id, blob, updated_at) VALUES (?,?,?) ON CONFLICT(connection_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at',
      [id, blob, updatedAt],
    );
  }

  /**
   * `null` cubre los tres casos que a quien llama le dan lo mismo: no hay
   * fila, la caja no está disponible, o el blob no se puede descifrar (otro
   * perfil del sistema, base copiada a otra máquina). Ninguno es una
   * excepción: todos significan "hay que volver a entrar".
   */
  readTokens(id: string, box: SecretBox): ConnectionTokens | null {
    const row = this.db.get<{ blob: string }>('SELECT blob FROM connection_tokens WHERE connection_id = ?', [id]);
    if (!row || !box.available) return null;
    try {
      return JSON.parse(box.decrypt(row.blob)) as ConnectionTokens;
    } catch {
      return null;
    }
  }

  clearTokens(id: string): void {
    this.db.run('DELETE FROM connection_tokens WHERE connection_id = ?', [id]);
  }

  hasTokens(id: string): boolean {
    return this.db.get('SELECT connection_id FROM connection_tokens WHERE connection_id = ?', [id]) != null;
  }
}
