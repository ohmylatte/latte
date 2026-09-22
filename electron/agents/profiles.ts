import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_EFFORT_TIER, type AgentProfile, type ProfileInput } from '../../shared/contracts';
import { parseAvatar, serializeAvatar } from '../../shared/avatar';
import { writeFileAtomic } from '../core/atomicFile';

const FILES = ['profile.json', 'SOUL.md', 'SKILL.md'] as const;
const MAX_TEXT = 256 * 1024;
export function profileFingerprint(parts: string[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function validate(input: ProfileInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid profile');
  if (typeof input.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.id) || input.id.length > 41 || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(input.id)) throw new TypeError('Invalid profile id');
  for (const [key, limit] of [['name', 120], ['initial', 8], ['summary', 2000], ['soul', MAX_TEXT], ['skills', MAX_TEXT]] as const) {
    if (typeof input[key] !== 'string' || input[key].includes('\0') || Buffer.byteLength(input[key], 'utf8') > limit) throw new TypeError(`Invalid profile ${key}`);
  }
  if (!input.name.trim() || !input.initial.trim() || !input.soul.trim()) throw new TypeError('Profile name, initial and SOUL are required');
  // El avatar es opcional y tolerante: una eleccion ilegible se descarta y el
  // rol vuelve a la cara que le deriva su id. Lo unico inaceptable es un tipo
  // que no sea texto: eso es un cliente roto, no una eleccion vieja.
  if (input.avatar !== undefined && input.avatar !== null && typeof input.avatar !== 'string') throw new TypeError('Invalid profile avatar');
}
/**
 * Real path of `directory`, or of its deepest existing ancestor with the missing tail re-appended.
 * The store is created lazily, so the path usually does not exist yet when it is resolved.
 */
function canonical(directory: string): string {
  const resolved = path.resolve(directory);
  let current = resolved;
  const tail: string[] = [];
  while (true) {
    // Any failure (missing, unreadable, an ancestor that is a file) just moves the question one level up;
    // the real I/O later reports it properly instead of the constructor throwing.
    try { return path.join(fs.realpathSync(current), ...tail.reverse()); } catch { /* try the parent */ }
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    tail.push(path.basename(current));
    current = parent;
  }
}
/** Synchronous operations serialize writes in the main process. A disk lock also rejects other writers. */
export class ProfileStore {
  readonly root: string;
  /** Real path of the directory holding the store: where the link walk in safe() stops. */
  private readonly container: string;
  constructor(root: string) {
    const resolved = path.resolve(root);
    this.container = canonical(path.dirname(resolved));
    this.root = path.join(this.container, path.basename(resolved));
  }

  private safe(target: string): void {
    // A profile inside the store must never be a link pointing somewhere else, so every level from the
    // target up to and including the store root is checked. The walk stops there: links at or above the
    // container belong to the OS or to the person using the app - macOS resolves /var to /private/var,
    // app data may be moved to another disk, Windows relocates folders with junctions - and rejecting
    // those would refuse the entire store instead of the one suspicious profile.
    let current = path.resolve(target);
    while (current !== this.container) {
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new TypeError('Profile symbolic links are not allowed'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
  }
  private directory(id: string): string {
    validate({ id, name: 'n', initial: 'i', summary: '', soul: 's', skills: '' });
    const directory = path.join(this.root, id); this.safe(directory); return directory;
  }
  has(id: string): boolean { return fs.existsSync(this.directory(id)); }
  private readFile(directory: string, file: string, optional = false): string {
    const target = path.join(directory, file); this.safe(target);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.size > (file === 'profile.json' ? 8192 : MAX_TEXT)) throw new TypeError('Invalid profile file size or type');
      return fs.readFileSync(target, 'utf8');
    } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }
  read(id: string): AgentProfile {
    try {
      const directory = this.directory(id);
      if (fs.existsSync(path.join(directory, '.writing'))) throw new TypeError('Incomplete profile save; inspect files before removing .writing');
      const parts = FILES.map(file => this.readFile(directory, file, file === 'SKILL.md'));
      const metadata: unknown = JSON.parse(parts[0]);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('Invalid profile metadata');
      // El `avatar` del disco NO pasa por `validate`: es lo unico del perfil que
      // se puede descartar sin perder nada, y un perfil entero no puede caerse
      // porque alguien escribio cualquier cosa en el campo de la cara.
      const input = { ...metadata, avatar: undefined, soul: parts[1], skills: parts[2] } as ProfileInput;
      validate(input); if (input.id !== id) throw new TypeError('Profile id does not match directory');
      // A profile the human wrote declares no effort of its own: it opens at the
      // default tier, and the human moves that member from its conversation.
      const stored = parseAvatar((metadata as { avatar?: unknown }).avatar);
      return { id, name: input.name, initial: input.initial, summary: input.summary, avatar: stored === null ? null : serializeAvatar(stored), tier: DEFAULT_EFFORT_TIER, soul: input.soul, skills: input.skills, builtin: false, source: 'custom', directory, fingerprint: profileFingerprint(parts) };
    } catch (error) { throw new TypeError(`Invalid profile ${id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  list(strict = true): AgentProfile[] {
    this.safe(this.root);
    if (!fs.existsSync(this.root)) return [];
    const result: AgentProfile[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      try { result.push(this.read(entry.name)); } catch (error) { if (strict) throw error; }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  /** Settings never loses valid profiles because one manually edited folder is broken. */
  listReported(): AgentProfile[] {
    const diagnostic = (id: string, directory: string, error: unknown): AgentProfile => ({
      id, name: id === '__profile-storage-error' ? 'Profile storage error' : id, initial: '!', avatar: null, summary: 'Repair the profile files externally, then reload.',
      tier: DEFAULT_EFFORT_TIER, soul: '', skills: '', builtin: false, source: 'custom', directory, fingerprint: '', error: error instanceof Error ? error.message : String(error),
    });
    try {
      this.safe(this.root);
      if (!fs.existsSync(this.root)) return [];
      return fs.readdirSync(this.root).filter(id => !id.startsWith('.')).map(id => {
        try { return this.read(id); } catch (error) { return diagnostic(id, path.join(this.root, id), error); }
      });
    } catch (error) { return [diagnostic('__profile-storage-error', this.root, error)]; }
  }
  save(input: ProfileInput, expectedFingerprint: string | null, protectedIds: string[]): AgentProfile {
    validate(input);
    if (protectedIds.includes(input.id)) throw new TypeError('Shipped profile is read-only; clone with another id');
    if (expectedFingerprint !== null && (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint))) throw new TypeError('Invalid profile fingerprint');
    const directory = this.directory(input.id);
    this.safe(this.root); fs.mkdirSync(this.root, { recursive: true });
    const lock = path.join(this.root, '.save.lock'); this.safe(lock);
    let fd: number;
    try { fd = fs.openSync(lock, 'wx'); } catch { throw new TypeError('Profile save conflict: another writer or stale .save.lock'); }
    try {
      this.safe(directory);
      const exists = fs.existsSync(directory);
      if (expectedFingerprint === null && exists) throw new TypeError('Profile already exists');
      if (expectedFingerprint !== null && (!exists || this.read(input.id).fingerprint !== expectedFingerprint)) throw new TypeError('Profile save conflict: reload the disk version');
      const old = exists ? FILES.map(f => ({ exists: fs.existsSync(path.join(directory, f)), text: this.readFile(directory, f, f === 'SKILL.md') })) : null;
      if (!exists) fs.mkdirSync(directory);
      const { id, name, initial, summary, soul, skills } = input;
      // El avatar viaja al lado de `initial` en profile.json, que es donde vive
      // la identidad visible de un perfil propio. Una eleccion ilegible no se
      // guarda: mejor sin avatar —y derivado del id— que basura en disco.
      const chosen = parseAvatar(input.avatar);
      const avatar = chosen === null ? null : serializeAvatar(chosen);
      const parts = [JSON.stringify({ id, name, initial, summary, avatar }, null, 2) + '\n', soul, skills];
      const marker = path.join(directory, '.writing'); this.safe(marker);
      writeFileAtomic(marker, 'Incomplete save: inspect SOUL.md, SKILL.md and profile.json before removing this marker.\n');
      try {
        FILES.forEach((file, index) => { this.safe(path.join(directory, file)); writeFileAtomic(path.join(directory, file), parts[index]); });
        fs.unlinkSync(marker);
        return this.read(input.id);
      } catch (error) {
        // Roll back ordinary I/O failures. A process crash remains detectable as malformed files.
        FILES.forEach((file, index) => {
          this.safe(path.join(directory, file));
          if (old?.[index].exists) writeFileAtomic(path.join(directory, file), old[index].text);
          else fs.rmSync(path.join(directory, file), { force: true });
        });
        fs.rmSync(marker, { force: true });
        if (!exists) fs.rmdirSync(directory);
        throw error;
      }
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}
