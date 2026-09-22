import { ProfileStore, profileFingerprint } from './profiles';
import { DEFAULT_EFFORT_TIER, type AgentRole, type AgentProfile, type ProfileInput } from '../../shared/contracts';
import type { InstructionPack, PackRole } from '../workspace/instructions';
import { avatarFromSeed, parseAvatar, serializeAvatar } from '../../shared/avatar';

export const ASSISTANT_ROLE_ID = 'assistant';
/**
 * La clave del override en `meta`. Vive aca y no suelta en dos archivos
 * porque la escribe el servicio y la lee el bootstrap: si se escriben
 * distinto, el override se guarda y no lo lee nadie.
 */
export const ROLE_AVATAR_KEY = (roleId: string): string => `role-avatar:${roleId}`;
export const ROLE_ID = /^[a-z][a-z0-9-]{0,40}$/;

const ASSISTANT: PackRole = {
  id: ASSISTANT_ROLE_ID,
  name: 'Asistente',
  initial: 'A',
  // El punto de partida tambien tiene cara: la del tablero.
  avatar: 'short.2.2.lanyard',
  summary: 'Trabaja el brief con vos sin un rol fijo. Es el punto de partida.',
  // The starting point has no specialty, so it takes the middle: neither the
  // cheapest answer nor the slowest one for someone who is still framing.
  tier: DEFAULT_EFFORT_TIER,
  instructions: '',
};

/**
 * The roles a team member can open with. The neutral assistant is always
 * first; the rest come from the discipline pack. A role's instructions are
 * appended to the runtime's own system prompt for that member only, so the
 * shared CLAUDE.md / AGENTS.md context stays identical for the whole team.
 */
export class RoleCatalog {
  private readonly roles: PackRole[];
  private readonly base: string;

  /**
   * De donde salen los avatares elegidos a mano para los roles INCLUIDOS.
   *
   * Un rol del pack trae su cara en el frontmatter, que es un archivo del
   * programa: si alguien quiere otra, no se puede editar ahi. El override
   * vive en la instalacion y GANA sobre el pack, asi que actualizar Latte no
   * le pisa la cara que eligio, y borrarlo devuelve la del pack. Es una
   * funcion y no un mapa porque se consulta al leer: lo que se guardo hace
   * un segundo tiene que verse ya.
   */
  constructor(pack: InstructionPack | null, private readonly profiles?: ProfileStore, private readonly override?: (roleId: string) => string | null) {
    const fromPack = (pack?.roles ?? []).filter((r) => r.id !== ASSISTANT_ROLE_ID);
    this.roles = [ASSISTANT, ...fromPack];
    this.base = (pack?.base ?? '').trim();
  }

  /**
   * El avatar de un rol, ya resuelto y serializado.
   *
   * NUNCA devuelve null: un rol que no eligio cara —uno del pack anterior a
   * esto, un perfil propio guardado antes, cualquiera— deriva la suya de su
   * propio id. Por eso esto no necesita migrar nada: el avatar de un rol
   * viejo no se inventa al leer el disco, se CALCULA, y siempre da lo mismo.
   */
  private avatarOf(id: string, stored: string | null | undefined): string {
    let chosen: string | null = null;
    // Un override ilegible —o una base que no se puede leer— no deja a nadie
    // sin cara: se cae al del pack, y de ahi al que deriva el id.
    try { chosen = this.override?.(id) ?? null; } catch { chosen = null; }
    return serializeAvatar(parseAvatar(chosen) ?? parseAvatar(stored) ?? avatarFromSeed(id));
  }

  static isValidId(value: unknown): value is string {
    return typeof value === 'string' && ROLE_ID.test(value);
  }

  list(): AgentRole[] {
    let custom: AgentProfile[] = [];
    try { custom = this.profiles?.list(false) ?? []; } catch { /* Settings reports unsafe/corrupt storage; builtins remain usable. */ }
    // A profile the human wrote carries no tier of its own: it opens at the
    // default and the human moves it from the conversation if it needs more.
    return [...this.roles, ...custom.filter(p => !this.roles.some(r => r.id === p.id))].map((r) => ({ id: r.id, name: r.name, initial: r.initial, summary: r.summary, builtin: r.id === ASSISTANT_ROLE_ID, tier: 'tier' in r ? r.tier : DEFAULT_EFFORT_TIER, avatar: this.avatarOf(r.id, r.avatar) }));
  }

  listProfiles(): AgentProfile[] {
    return [...this.roles.map(r => ({ id: r.id, name: r.name, initial: r.initial, summary: r.summary, builtin: r.id === ASSISTANT_ROLE_ID, tier: r.tier, avatar: this.avatarOf(r.id, r.avatar), source: 'builtin' as const, directory: null, soul: r.instructions, skills: '', fingerprint: profileFingerprint([r.id, r.instructions]) })), ...(this.profiles?.listReported() ?? []).filter(p => !this.roles.some(r => r.id === p.id)).map(p => ({ ...p, avatar: this.avatarOf(p.id, p.avatar) }))];
  }

  saveProfile(input: ProfileInput, expectedFingerprint: string | null): AgentProfile {
    if (!this.profiles) throw new TypeError('Profile store is unavailable');
    const saved = this.profiles.save(input, expectedFingerprint, this.roles.map(r => r.id));
    return { ...saved, avatar: this.avatarOf(saved.id, saved.avatar) };
  }

  get(id: string): PackRole | null {
    const builtin = this.roles.find(r => r.id === id);
    // El override tambien vale aca: es por donde el hub le pregunta la cara
    // a un rol cuando dibuja un miembro.
    if (builtin) return { ...builtin, avatar: this.avatarOf(builtin.id, builtin.avatar) };
    if (!this.profiles || !this.profiles.has(id)) return null;
    const custom = this.profiles.read(id);
    return { id: custom.id, name: custom.name, initial: custom.initial, summary: custom.summary, avatar: this.avatarOf(custom.id, custom.avatar), tier: custom.tier, instructions: [custom.soul, custom.skills].filter(Boolean).join('\n\n---\n\n') };
  }

  /**
   * The system prompt handed to the runtime for a member.
   *
   * Every conversation gets the pack's marketing behaviour, the neutral
   * assistant included: instruction files (CLAUDE.md / AGENTS.md) only arrive
   * if the runtime chooses to read them, while this text travels through each
   * runtime's own prompt channel. A named role adds its responsibility on top.
   */
  promptFor(id: string): string {
    const role = this.get(id);
    if (!role && this.profiles) throw new TypeError(`Profile unavailable: ${id}`);
    const parts: string[] = [];
    if (this.base) parts.push(this.base);
    if (role && role.instructions) {
      parts.push(
        [
          `You are a member of a Latte marketing team, acting as: ${role.name}.`,
          'The instructions below narrow the behaviour above to your responsibility in this work. They never override the user\'s explicit requests, the brand context or the runtime\'s permission rules.',
          '',
          role.instructions,
        ].join('\n'),
      );
    }
    return parts.join('\n\n---\n\n');
  }

  /** True when this build actually has marketing behaviour to hand out. */
  get hasBase(): boolean {
    return this.base.length > 0;
  }
}
