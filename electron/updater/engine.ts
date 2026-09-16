import { optionalRequire } from '../core/optionalRequire';
import type { UpdaterEngine } from './controller';
import type { UpdateUnsupportedKind } from '../../shared/contracts';

/**
 * The slice of electron-updater's `autoUpdater` we use. Typed here instead of
 * importing the package's types so the main process still compiles (and runs)
 * when the dependency is not installed, exactly like node-pty and sql.js.
 */
interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug(message?: unknown): void;
}

interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  logger: UpdaterLogger | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface ElectronUpdaterModule {
  autoUpdater: AutoUpdaterLike;
}

export interface EngineOptions {
  /**
   * False in development and in a source checkout: there is no installed
   * application to replace, so nothing is checked.
   */
  enabled: boolean;
  /** Reason to report when `enabled` is false. */
  disabledReason: string;
  /** Classification to preserve when `enabled` is false. */
  unsupportedKind?: UpdateUnsupportedKind;
  /** Alpha channel: only when the user asked for it explicitly. */
  allowPrerelease?: boolean;
  log?: (line: string) => void;
}

export interface EngineResult {
  engine: UpdaterEngine | null;
  /** Empty when an engine was created; the honest reason otherwise. */
  reason: string;
  unsupportedKind?: UpdateUnsupportedKind;
  /** Quits and installs. No-op when there is no engine. */
  quitAndInstall: () => void;
}

export interface UpdaterAvailabilityInput {
  isPackaged: boolean;
  devServerUrl: string | null;
  platform: string;
  appImage: string | undefined;
}

export interface UpdaterAvailability {
  enabled: boolean;
  reason: string;
  unsupportedKind?: UpdateUnsupportedKind;
}

const SOURCE_UPDATER_REASON = 'Estás usando Latte desde el código fuente. Las actualizaciones automáticas vienen con el instalador.';

/** Decides update support from explicit runtime facts, without Electron or I/O. */
export function decideUpdaterAvailability(input: UpdaterAvailabilityInput): UpdaterAvailability {
  if (!input.isPackaged || input.devServerUrl !== null) {
    return { enabled: false, reason: SOURCE_UPDATER_REASON, unsupportedKind: 'source' };
  }
  if (input.platform === 'linux' && !input.appImage) {
    return {
      enabled: false,
      unsupportedKind: 'manual-install',
      reason: 'La instalación .deb no se actualiza automáticamente. Descargá la versión nueva y reinstalá Latte.',
    };
  }
  return { enabled: true, reason: '' };
}

/**
 * Wires electron-updater into the small interface the controller expects.
 *
 * Two settings carry the whole safety story:
 * `autoDownload = false`  — nothing travels the network until the user says so.
 * `autoInstallOnAppQuit = false` — closing Latte for any other reason never
 * turns into a surprise installation.
 */
export function createUpdaterEngine(options: EngineOptions): EngineResult {
  if (!options.enabled) {
    return {
      engine: null,
      reason: options.disabledReason,
      unsupportedKind: options.unsupportedKind ?? 'unavailable',
      quitAndInstall: () => {},
    };
  }
  const loaded = optionalRequire<ElectronUpdaterModule>('electron-updater');
  if (!loaded.ok) {
    return {
      engine: null,
      reason: `Esta compilación no incluye el actualizador (${loaded.error}). Descargá la nueva versión desde ohmylatte.app.`,
      unsupportedKind: 'unavailable',
      quitAndInstall: () => {},
    };
  }
  const auto = loaded.module.autoUpdater;
  if (!auto || typeof auto.checkForUpdates !== 'function') {
    return {
      engine: null,
      reason: 'electron-updater cargó pero no expone autoUpdater.',
      unsupportedKind: 'unavailable',
      quitAndInstall: () => {},
    };
  }

  auto.autoDownload = false;
  auto.autoInstallOnAppQuit = false;
  auto.allowDowngrade = false;
  auto.allowPrerelease = options.allowPrerelease === true;
  // Its default logger writes straight to `console`, unprefixed and mixed in
  // with Latte's own output. Routing it through the same log makes it clear
  // who is talking. It still formats its errors with a stack trace of its own,
  // which is left as it comes: the controller emits the short, human sentence,
  // and this stays as the diagnostic detail underneath.
  auto.logger = {
    info: (message: unknown) => options.log?.(`[latte:update] ${describe(message)}`),
    warn: (message: unknown) => options.log?.(`[latte:update] ${describe(message)}`),
    error: (message: unknown) => options.log?.(`[latte:update] ${describe(message)}`),
    debug: () => {},
  };

  const engine: UpdaterEngine = {
    onAvailable: (listener) => { auto.on('update-available', (info) => listener(versionOf(info))); },
    onNotAvailable: (listener) => { auto.on('update-not-available', () => listener()); },
    onProgress: (listener) => { auto.on('download-progress', (progress) => listener(percentOf(progress))); },
    onDownloaded: (listener) => { auto.on('update-downloaded', (info) => listener(versionOf(info))); },
    onError: (listener) => { auto.on('error', (error) => listener(error instanceof Error ? error.message : String(error))); },
    checkForUpdates: async () => { await auto.checkForUpdates(); },
    downloadUpdate: async () => { await auto.downloadUpdate(); },
  };

  return {
    engine,
    reason: '',
    // isSilent=false keeps the NSIS installer visible: a restart that shows
    // nothing for several seconds reads as a crash.
    quitAndInstall: () => auto.quitAndInstall(false, true),
  };
}

function describe(message: unknown): string {
  return message instanceof Error ? message.message : String(message);
}

function versionOf(info: unknown): string {
  if (info && typeof info === 'object' && 'version' in info) {
    const version = (info as { version: unknown }).version;
    if (typeof version === 'string') return version;
  }
  return '';
}

function percentOf(progress: unknown): number {
  if (progress && typeof progress === 'object' && 'percent' in progress) {
    const percent = (progress as { percent: unknown }).percent;
    if (typeof percent === 'number') return percent;
  }
  return 0;
}
