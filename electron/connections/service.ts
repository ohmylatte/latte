/**
 * Lo que las pantallas de Conexiones pueden pedir, y nada más.
 *
 * Es la capa que junta las cuatro piezas de abajo —repositorio, caja de
 * secretos, módulo OAuth y gateway— y las expone como cinco verbos que una
 * persona entiende: listar, conectar, volver a entrar, desconectar y borrar.
 * Más el sexto, que existe una sola vez: importar lo que ya hay en el registro
 * del CLI (decisión C del brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`).
 *
 * El renderer nunca ve un token. Ni uno del proveedor, ni un bearer del
 * gateway: `Connection` no tiene campo donde ponerlo.
 */
import type { ChatRuntime, Connection, ConnectionInput, ConnectionScope, ImportableConnection, McpRuntimeTools } from '../../shared/contracts';
import { NotFoundError, ValidationError } from '../core/errors';
import { newId } from '../core/ids';
import type { ConnectionRecord, ConnectionsRepository } from '../storage/connectionsRepository';
import { toConnection } from '../storage/connectionsRepository';
import type { SecretBox } from '../storage/secretBox';
import type { ConnectionGateway } from './gateway';
import type { GatewayTokenRegistry } from './gatewayTokens';
import type { LoginOutcome, LoginRequest } from './login';
import { revokeTokens } from './oauth';

/** Minúsculas, dígitos y guiones: es lo que se namespacea en el nombre de la tool que ve el modelo. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

export interface ConnectionsServiceDeps {
  connections: ConnectionsRepository;
  secretBox: SecretBox;
  gateway: ConnectionGateway;
  tokens: GatewayTokenRegistry;
  /** El login completo. Inyectado para que el servicio se pruebe sin abrir una ventana. */
  login: (request: LoginRequest) => Promise<LoginOutcome>;
  /** El registro del CLI, de sólo lectura: la fuente de la importación única. */
  listCliServers?: () => Promise<McpRuntimeTools[]>;
  clock?: () => string;
  log?: (line: string) => void;
  /** El evento a `agents.log`: id, servidor, alcance y estado. **Nunca contenido.** */
  audit?: (line: string) => void;
  /** Volvió a entrar: quien escuche retira el aviso del chat de los miembros que la llevan. */
  onRestored?: (connection: ConnectionRecord) => void;
  /**
   * Borra de la caché de "necesita autenticación" de Claude Code las entradas
   * de estos nombres (1.4 del brief). Se llama al crear una Conexión: desde ese
   * momento el login lo hace el gateway, y dejar la mentira ahí sólo sirve para
   * que la pantalla de Herramientas siga asustando para siempre.
   */
  forgetCliNeedsAuth?: (names: string[]) => void;
}

/**
 * El default sugerido por servidor. Es una SUGERENCIA y la pantalla la deja
 * cambiar siempre (decisión A): Meta Ads es global porque todas las marcas
 * cuelgan del mismo portfolio, theagentcy es por marca porque es una conexión
 * por cliente. Lo que Latte no conoce arranca en `brand`, que es el alcance que
 * menos daño hace si se elige mal — una conexión global mal elegida toca a
 * todas las marcas (riesgo 3).
 */
const SUGGESTED_SCOPE: Array<{ host: RegExp; scope: ConnectionScope }> = [
  { host: /(^|\.)facebook\.com$/i, scope: 'global' },
  { host: /(^|\.)canva\.com$/i, scope: 'global' },
  { host: /(^|\.)theagentcy\.app$/i, scope: 'brand' },
];

export function suggestedScopeFor(url: string): ConnectionScope {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'brand';
  }
  return SUGGESTED_SCOPE.find((entry) => entry.host.test(host))?.scope ?? 'brand';
}

/** Un slug legible a partir de la URL, para no obligar a nadie a inventarlo. */
export function slugFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const base = host.split('.').slice(0, -1).join('-') || host;
    return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'conexion';
  } catch {
    return 'conexion';
  }
}

export class ConnectionsService {
  private readonly clock: () => string;

  constructor(private readonly deps: ConnectionsServiceDeps) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  list(brandId: string | null): Connection[] {
    return this.deps.connections.list(brandId);
  }

  /** TODAS, globales y de marca: la pantalla única de Ajustes. */
  listAll(): Connection[] {
    return this.deps.connections.listAll();
  }

  /**
   * Crear y entrar, en un solo paso. Si el login falla, **no queda una fila
   * a medias**: la conexión se borra y el error sube tal cual. Una fila
   * "conectando" que nunca se conectó es exactamente el tipo de estado mentiroso
   * que esta pantalla no puede tener.
   */
  async connect(input: ConnectionInput): Promise<Connection> {
    const record = this.insert(input);
    try {
      return await this.login(record);
    } catch (error) {
      this.deps.connections.remove(record.id);
      throw error;
    }
  }

  /** Volver a entrar a una conexión que ya existe: lo que hace el botón de una vencida. */
  async reconnect(connectionId: string): Promise<Connection> {
    const record = this.require(connectionId);
    return this.login(record);
  }

  /**
   * Desconectar deja la fila y se lleva las credenciales: se revoca contra el
   * proveedor si publica cómo (RFC 7009), se borra el blob, y se revocan todos
   * los bearers que el gateway hubiera emitido contra ella — un miembro vivo
   * deja de tener esa herramienta en el acto, sin esperar a que cierre el chat.
   */
  async disconnect(connectionId: string): Promise<Connection> {
    const record = this.require(connectionId);
    const tokens = this.deps.connections.readTokens(connectionId, this.deps.secretBox);
    if (tokens) {
      try { await revokeTokens(tokens); } catch { /* que el proveedor no quiera revocar no puede impedir borrar lo nuestro */ }
    }
    this.deps.connections.clearTokens(connectionId);
    this.deps.gateway.credentialsChanged(connectionId);
    this.deps.tokens.revokeConnection(connectionId);
    this.deps.gateway.stopIfIdle();
    this.deps.connections.setState(connectionId, 'disconnected', '', this.clock());
    this.audit(record, 'desconectada');
    return toConnection(this.require(connectionId), false);
  }

  /** Borrar del todo. Pasa por `disconnect` primero para no dejar un token vivo del otro lado. */
  async remove(connectionId: string): Promise<void> {
    await this.disconnect(connectionId);
    const record = this.require(connectionId);
    this.deps.connections.remove(connectionId);
    this.audit(record, 'borrada');
  }

  /**
   * Lo que hay en el registro del CLI y todavía no es una Conexión de Latte.
   *
   * Sólo servidores **http**: un stdio es un proceso local con sus propias
   * credenciales, no una cuenta con la que loguearse, y el gateway no tendría
   * qué proxear. Los tokens del CLI **no se importan** (son de otro cliente
   * OAuth): la importada pide un login que ahora dura en Latte.
   */
  async listImportable(): Promise<ImportableConnection[]> {
    if (!this.deps.listCliServers) return [];
    let runtimes: McpRuntimeTools[];
    try {
      runtimes = await this.deps.listCliServers();
    } catch (error) {
      this.deps.log?.(`[connections] no se pudo leer el registro del CLI: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const seen = new Set<string>();
    const out: ImportableConnection[] = [];
    for (const runtime of runtimes) {
      for (const server of runtime.servers) {
        if (server.transport !== 'http' || !/^https?:\/\//i.test(server.target)) continue;
        const key = server.target.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const name = SLUG.test(server.name) ? server.name : slugFromUrl(server.target);
        out.push({
          runtime: runtime.runtime as ChatRuntime,
          name,
          url: server.target,
          suggestedScope: suggestedScopeFor(server.target),
          alreadyImported: this.deps.connections.list(null).some((c) => c.url === server.target)
            || this.deps.connections.listOwn(null).some((c) => c.name === name),
        });
      }
    }
    return out;
  }

  // --- Interno ----------------------------------------------------------

  private insert(input: ConnectionInput): ConnectionRecord {
    const name = (input.name || slugFromUrl(input.url)).trim().toLowerCase();
    if (!SLUG.test(name)) throw new ValidationError('El nombre de una conexión lleva minúsculas, números y guiones.');
    const url = input.url.trim();
    if (!/^https?:\/\//i.test(url)) throw new ValidationError('La dirección de un servidor MCP empieza con http:// o https://.');
    if (input.scope !== 'global' && input.scope !== 'brand') throw new ValidationError('Una conexión es global o de una marca.');
    // Antes de escribir nada: sin dónde cifrar, esta conexión no se puede
    // guardar, y decirlo acá evita dejar una fila sin credenciales posibles.
    if (!this.deps.secretBox.available) {
      throw new ValidationError(this.deps.secretBox.detail || 'Este sistema no tiene dónde guardar una credencial cifrada.');
    }
    const at = this.clock();
    // Antes de escribir la fila: esa caché está indexada por NOMBRE, no por
    // URL, y con la entrada fresca el CLI marca `needs-auth` sin abrir el
    // socket. Se borran las variantes del nombre y las del slug de la URL,
    // porque el rastro de haber probado son justamente nombres parecidos.
    this.deps.forgetCliNeedsAuth?.([name, slugFromUrl(url), (input.label ?? '').trim()].filter((n) => n.length > 0));
    return this.deps.connections.insert({
      id: newId('con'),
      name,
      label: (input.label ?? '').trim() || name,
      url,
      transport: 'http',
      authKind: 'oauth',
      clientId: (input.clientId ?? '').trim() || null,
      identity: null,
      scope: input.scope,
      brandId: input.scope === 'brand' ? (input.brandId ?? null) : null,
      state: 'disconnected',
      stateDetail: '',
      memberOverride: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  private async login(record: ConnectionRecord): Promise<Connection> {
    let outcome: LoginOutcome;
    try {
      outcome = await this.deps.login({ resourceUrl: record.url, clientId: record.clientId });
    } catch (error) {
      // El estado queda en `error` con el motivo escrito: la fila dice qué pasó
      // en vez de volver a "sin conectar" como si no hubiera pasado nada.
      this.deps.connections.setState(record.id, 'error', error instanceof Error ? error.message : String(error), this.clock());
      throw error;
    }
    const at = this.clock();
    this.deps.connections.saveTokens(record.id, outcome.tokens, this.deps.secretBox, at);
    // El gateway tiene que enterarse de que estas credenciales son otras: sin
    // esto, una conexión cuyo refresh había fallado quedaba clavada en "no se
    // pudo renovar" aunque la persona acabara de volver a entrar.
    this.deps.gateway.credentialsChanged(record.id);
    // Un `client_id` del registro dinámico se guarda para no registrar un
    // cliente nuevo en cada login.
    if (outcome.clientIdFromRegistration && outcome.tokens.clientId) {
      this.deps.connections.setClientId(record.id, outcome.tokens.clientId, at);
    }
    this.deps.connections.setState(record.id, 'connected', '', at);
    const saved = this.require(record.id);
    this.audit(saved, 'conectada');
    this.deps.onRestored?.(saved);
    return toConnection(saved, false);
  }

  private require(connectionId: string): ConnectionRecord {
    const record = this.deps.connections.get(connectionId);
    if (!record) throw new NotFoundError('Connection', connectionId);
    return record;
  }

  /** Id, servidor, alcance y estado. Jamás un token ni el contenido de una llamada. */
  private audit(record: ConnectionRecord, what: string): void {
    this.deps.audit?.(`[conexiones] ${what}: ${record.id} ${record.name} alcance=${record.scope}${record.brandId ? `:${record.brandId}` : ''} estado=${record.state}`);
  }
}
