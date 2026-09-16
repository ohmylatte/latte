import type { InstallOutcome, UpdateState, UpdateUnsupportedKind } from '../../shared/contracts';

/**
 * The part of an update engine this controller needs. Deliberately smaller
 * than electron-updater's surface: nothing here knows about GitHub, files or
 * signatures, so the whole flow can be driven by a fake in the tests.
 */
export interface UpdaterEngine {
  onAvailable(listener: (version: string) => void): void;
  onNotAvailable(listener: () => void): void;
  onProgress(listener: (percent: number) => void): void;
  onDownloaded(listener: (version: string) => void): void;
  onError(listener: (message: string) => void): void;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
}

/** Live work that a restart would interrupt. Used for the wording, not to block. */
export interface UpdateActivity {
  chats: number;
  terminals: number;
}

export interface UpdateControllerDeps {
  /**
   * Null when there is nothing to talk to: a source checkout, a development
   * run, or a build where electron-updater is not installed. The controller
   * then reports `unsupported` and never pretends to check.
   */
  engine: UpdaterEngine | null;
  /** Why there is no engine. Shown verbatim; must be honest. */
  unsupportedReason?: string;
  /** Structured reason for renderer presentation; never inferred from prose. */
  unsupportedKind?: UpdateUnsupportedKind;
  emit: (state: UpdateState) => void;
  /** Latest state reported by the renderer. A restart must never discard it. */
  hasUnsavedWork: () => boolean;
  activity: () => UpdateActivity;
  /** Native confirmation before the restart. True means "install now". */
  confirmInstall: (activity: UpdateActivity, version: string) => boolean;
  /** Quits and installs. Called only after the confirmation was given. */
  beginInstall: () => void;
  /** Restore any close authorization if the installer fails without quitting. */
  installFailed?: () => void;
  log?: (line: string) => void;
}

const IDLE: UpdateState = { phase: 'idle', version: null, percent: 0, message: '' };

/**
 * Drives the update flow and, above all, decides when it is NOT allowed to
 * run. Downloading never interrupts anything; installing always asks first,
 * and is refused outright while a document has unsaved changes.
 */
export class UpdateController {
  private state: UpdateState;
  private installing = false;

  constructor(private readonly deps: UpdateControllerDeps) {
    this.state = deps.engine
      ? { ...IDLE }
      : {
        phase: 'unsupported',
        unsupportedKind: deps.unsupportedKind ?? 'unavailable',
        version: null,
        percent: 0,
        message: deps.unsupportedReason ?? 'Las actualizaciones automáticas no están disponibles en esta instalación.',
      };
    if (deps.engine) this.listen(deps.engine);
  }

  current(): UpdateState {
    return { ...this.state };
  }

  /**
   * Asks the server for a newer version. A check never starts a download and
   * never disturbs a download or an installation already in progress.
   */
  async check(): Promise<UpdateState> {
    const engine = this.deps.engine;
    if (!engine) return this.current();
    if (this.state.phase === 'checking' || this.state.phase === 'downloading' || this.state.phase === 'ready') {
      return this.current();
    }
    this.set({ phase: 'checking', version: null, percent: 0, message: '' });
    try {
      await engine.checkForUpdates();
    } catch (error) {
      this.fail(error);
    }
    return this.current();
  }

  /**
   * Downloads the offered version. The user keeps working: this reports
   * progress and nothing else. Also the retry path after a failed download.
   */
  async download(): Promise<UpdateState> {
    const engine = this.deps.engine;
    if (!engine) return this.current();
    if (this.state.phase === 'downloading' || this.state.phase === 'ready') return this.current();
    if (this.state.phase !== 'available' && this.state.phase !== 'error') return this.current();
    if (this.state.phase === 'error' && this.state.version === null) {
      // The failure happened before anything was offered: check again first.
      return this.check();
    }
    this.set({ phase: 'downloading', version: this.state.version, percent: 0, message: '' });
    try {
      await engine.downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
    return this.current();
  }

  /**
   * The only path that restarts the app.
   *
   * Order matters: unsaved work is checked BEFORE anything is asked, so the
   * user is sent back to the editor instead of being offered a choice that
   * could lose the document. Only then does the confirmation appear, and only
   * a yes reaches `beginInstall`.
   */
  install(): InstallOutcome {
    if (this.state.phase !== 'ready' || this.state.version === null) return { status: 'not-ready' };
    if (this.installing) return { status: 'installing' };
    if (this.deps.hasUnsavedWork()) return { status: 'unsaved' };
    if (!this.deps.confirmInstall(this.deps.activity(), this.state.version)) return { status: 'cancelled' };
    this.installing = true;
    try {
      this.deps.beginInstall();
    } catch (error) {
      // A failed restart must leave a working app behind, not a frozen one.
      this.fail(error);
      return { status: 'not-ready' };
    }
    // electron-updater can emit an error synchronously instead of throwing.
    return { status: this.installing ? 'installing' : 'not-ready' };
  }

  private listen(engine: UpdaterEngine): void {
    engine.onAvailable((version) => {
      // An event that arrives while downloading or ready must not rewind the
      // flow: the user already accepted this version.
      if (this.state.phase === 'downloading' || this.state.phase === 'ready') return;
      this.set({ phase: 'available', version, percent: 0, message: '' });
    });
    engine.onNotAvailable(() => {
      if (this.state.phase === 'downloading' || this.state.phase === 'ready') return;
      this.set({ ...IDLE });
    });
    engine.onProgress((percent) => {
      if (this.state.phase !== 'downloading') return;
      this.set({ ...this.state, percent: clampPercent(percent) });
    });
    engine.onDownloaded((version) => {
      this.set({ phase: 'ready', version: version || this.state.version, percent: 100, message: '' });
    });
    engine.onError((message) => this.fail(message));
  }

  private fail(error: unknown): void {
    if (this.installing) {
      this.installing = false;
      this.deps.installFailed?.();
    }
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log?.(`[latte:update] ${message}`);
    // The offered version is kept so "Reintentar" knows what it was retrying.
    this.set({ phase: 'error', version: this.state.version, percent: 0, message: friendly(message) });
  }

  private set(next: UpdateState): void {
    this.state = next;
    this.deps.emit({ ...next });
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Network failures reach the user as a sentence they can act on. The raw
 * message is still logged, so nothing is hidden from whoever debugs it.
 */
function friendly(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('econnrefused') || lower.includes('etimedout') || lower.includes('network')) {
    return 'No se pudo conectar para buscar actualizaciones. Revisá tu conexión y probá de nuevo.';
  }
  if (lower.includes('sha512') || lower.includes('checksum') || lower.includes('signature')) {
    return 'La descarga no coincide con lo publicado y se descartó. Probá de nuevo más tarde.';
  }
  return message;
}
