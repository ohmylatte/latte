/**
 * Qué Conexiones MCP le tocan a un miembro, y con qué bearer.
 *
 * Es el paso que traduce la decisión del brief (4.3) a lo que un adaptador
 * entiende: resolver marca→conexión (la de marca gana sobre la global),
 * levantar el gateway si hace falta, emitir un bearer por (conexión, miembro) y
 * devolver un `AdapterMcpServer` http por cada una, **apuntando al gateway,
 * nunca al proveedor**.
 *
 * Separado del planificador de coordinación a propósito: aquél decide cupos de
 * procesos y pisos de versión, y éste no decide nada de eso — un servidor de
 * conexión es un header más en un config que ya se escribe igual.
 */
import type { AdapterMcpServer } from '../agents/types';
import type { ConnectionRecord } from '../storage/connectionsRepository';
import type { GatewayTokenRegistry } from './gatewayTokens';

/** La franja del repositorio que hace falta. Angosta para probar sin base. */
export interface ConnectionInjectionRepoPort {
  resolveForBrand(brandId: string): ConnectionRecord[];
  hasTokens(id: string): boolean;
}

export interface ConnectionInjectionGatewayPort {
  ensureStarted(): Promise<void>;
  stopIfIdle(): void;
  urlFor(connectionId: string): string;
}

export interface ConnectionInjectionDeps {
  repo: ConnectionInjectionRepoPort;
  tokens: GatewayTokenRegistry;
  gateway: ConnectionInjectionGatewayPort;
  log?: (line: string) => void;
  /** El evento que va a `agents.log`: id, servidor, alcance y estado. **Nunca el bearer ni el token.** */
  audit?: (event: { connectionId: string; name: string; scope: string; state: string; memberId: string }) => void;
}

/**
 * El nombre namespaceado que ve el runtime. El prefijo no es decorativo: separa
 * lo que Latte inyecta de lo que la persona pudiera tener en el registro de su
 * CLI, y hace que dos conexiones al mismo servidor (una global, una de marca)
 * jamás puedan colisionar — porque el slug ya es único por alcance y la
 * resolución deja una sola en pie para cada uno.
 */
export function connectionServerName(slug: string): string {
  return `latte_conn_${slug}`;
}

export class ConnectionInjectionPlanner {
  /** memberId -> los bearers vivos que se le entregaron. Lo que `release` tiene que poder deshacer. */
  private readonly issued = new Map<string, string[]>();

  constructor(private readonly deps: ConnectionInjectionDeps) {}

  /**
   * Los servidores de conexión de este miembro. Vacío es una respuesta
   * legítima y frecuente: una marca sin conexiones propias ni globales no
   * inyecta nada, exactamente como dice el brief ("si no hay ninguna, ese
   * servidor no se inyecta").
   *
   * Una conexión **vencida** SÍ se inyecta. Parece contraintuitivo y es el
   * punto entero del gateway: el miembro llama, el gateway contesta un error de
   * tool legible y la persona recibe el aviso en el chat con el botón de volver
   * a entrar. Sacarla de la inyección la haría desaparecer en silencio, que es
   * el fallo mudo que este diseño existe para matar.
   */
  async assign(input: { memberId: string; brandId: string }): Promise<AdapterMcpServer[]> {
    const candidates = this.deps.repo.resolveForBrand(input.brandId)
      // Sin credenciales guardadas no hay nada que proxear: la conexión existe
      // pero nadie entró todavía.
      .filter((connection) => this.deps.repo.hasTokens(connection.id));
    if (candidates.length === 0) return [];

    try {
      await this.deps.gateway.ensureStarted();
    } catch (error) {
      // El gateway no ató puerto: el miembro arranca SIN estas herramientas, que
      // es honesto, en vez de con una URL que no responde.
      this.deps.log?.(`[connections-injection] el gateway no arrancó, ${input.memberId} va sin conexiones: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }

    const servers: AdapterMcpServer[] = [];
    const minted: string[] = [];
    for (const connection of candidates) {
      const token = this.deps.tokens.mint(connection.id, input.memberId, connection.scope === 'brand' ? connection.brandId : input.brandId);
      minted.push(token);
      servers.push({ kind: 'http', name: connectionServerName(connection.name), url: this.deps.gateway.urlFor(connection.id), token });
      this.deps.audit?.({ connectionId: connection.id, name: connection.name, scope: connection.scope, state: connection.state, memberId: input.memberId });
    }
    // Lo que había antes de este miembro se reemplaza, no se acumula: volver a
    // abrir un chat vuelve a emitir, y los bearers viejos ya no valen.
    const previous = this.issued.get(input.memberId) ?? [];
    for (const token of previous) this.deps.tokens.revoke(token);
    this.issued.set(input.memberId, minted);
    return servers;
  }

  /**
   * Se cierra el chat: **ningún bearer sobrevive**. Se revoca por identidad del
   * miembro, no por token, porque quien cierra sabe QUIÉN cierra y no qué
   * conexiones le habían tocado.
   */
  release(memberId: string): void {
    this.issued.delete(memberId);
    const removed = this.deps.tokens.revokeMember(memberId);
    if (removed > 0) this.deps.gateway.stopIfIdle();
  }

  releaseAll(): void {
    for (const memberId of [...this.issued.keys()]) this.release(memberId);
  }
}
