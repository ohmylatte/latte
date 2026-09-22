/**
 * Los bearers que Latte le emite a cada miembro contra su propio gateway.
 *
 * Es el modelo de `coordination/tokens.ts`, con una diferencia que es el corazón
 * del diseño: acá el token ata **(conexión, miembro)**, no (trabajo, miembro).
 * "El alcance vive en el bearer, no en la ruta" (brief 4.3): al emitirlo, Latte
 * ya resolvió marca→conexión, así que dos miembros de marcas distintas que
 * comparten la misma conexión global reciben **bearers distintos en la misma
 * ruta** —se revocan por separado y se audita quién llamó qué— y un bearer
 * contra una ruta que no le toca es 403, nunca 401.
 *
 * Nunca se persiste: la vida de un token es la vida del proceso del miembro, y
 * un reinicio de Latte los invalida a todos por el simple hecho de no existir.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface GatewayTokenEntry {
  connectionId: string;
  memberId: string;
  /** La marca para la que se resolvió esta conexión. `null` para una global usada sin marca. */
  brandId: string | null;
  mintedAt: string;
}

/**
 * El separador es `|`, imprimible a propósito y por el mismo motivo que en
 * `coordination/tokens.ts`: todo id de Latte matchea `^[a-z][a-z0-9_-]{2,63}$`,
 * así que nunca puede aparecer dentro de uno y dos pares distintos jamás
 * colisionan.
 */
function memberKey(connectionId: string, memberId: string): string {
  return `${connectionId}|${memberId}`;
}

export class GatewayTokenRegistry {
  private readonly tokens = new Map<string, GatewayTokenEntry>();
  private readonly byMember = new Map<string, string>();

  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  /** 64 caracteres hex. Vuelve a emitir reemplaza el anterior de ese par. */
  mint(connectionId: string, memberId: string, brandId: string | null): string {
    const key = memberKey(connectionId, memberId);
    const previous = this.byMember.get(key);
    if (previous) this.tokens.delete(previous);
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { connectionId, memberId, brandId, mintedAt: this.clock() });
    this.byMember.set(key, token);
    return token;
  }

  /**
   * Comparación en tiempo constante contra cada token vivo, por lo mismo que en
   * coordinación: quien llama no puede aprender nada de cuánto tardó el
   * chequeo. Un token desconocido o revocado da `null`.
   */
  verify(token: string): GatewayTokenEntry | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    const supplied = Buffer.from(token, 'utf8');
    for (const [candidate, entry] of this.tokens) {
      const known = Buffer.from(candidate, 'utf8');
      if (known.length === supplied.length && timingSafeEqual(known, supplied)) return entry;
    }
    return null;
  }

  revoke(token: string): void {
    const entry = this.tokens.get(token);
    if (!entry) return;
    this.tokens.delete(token);
    const key = memberKey(entry.connectionId, entry.memberId);
    if (this.byMember.get(key) === token) this.byMember.delete(key);
  }

  /**
   * Revoca por identidad, que es lo que sabe quien cierra un chat: **todas** las
   * conexiones de ese miembro de una. Es el candado "ningún bearer sobrevive al
   * chat" (G6), y por eso no hace falta que quien cierre recuerde qué
   * conexiones le habían tocado.
   */
  revokeMember(memberId: string): number {
    let removed = 0;
    for (const [token, entry] of [...this.tokens]) {
      if (entry.memberId === memberId) { this.revoke(token); removed += 1; }
    }
    return removed;
  }

  /** Revoca todo lo emitido contra una conexión: lo que hace "Desconectar". */
  revokeConnection(connectionId: string): number {
    let removed = 0;
    for (const [token, entry] of [...this.tokens]) {
      if (entry.connectionId === connectionId) { this.revoke(token); removed += 1; }
    }
    return removed;
  }

  get size(): number {
    return this.tokens.size;
  }
}
