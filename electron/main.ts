import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import type { AgentEvent, ChatEvent, InstallOutcome, UpdateState } from '../shared/contracts';
import { createBackend, type Backend } from './bootstrap';
import { errorMessage } from './core/errors';
import { ensureUserBinPath } from './core/linuxPath';
import { installProcessStreamErrorGuards } from './core/processStreams';
import {
  AGENT_EVENT_CHANNEL,
  CHAT_EVENT_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATE_CHANNEL,
  type IpcEnvelope,
} from './ipc/channels';
import { IncompatibleSchemaError } from './storage/backup';
import { UpdateController, type UpdateActivity } from './updater/controller';
import { createUpdaterEngine, decideUpdaterAvailability } from './updater/engine';
import { attachCloseGuard, attachQuitGuard, type CloseGuardHandle } from './windowClose';
import { registerIpc } from './ipc/register';
import { mainMessage } from './i18n';

installProcessStreamErrorGuards(process.stdout, process.stderr);

const uiLocale = () => backend?.repo.getMeta('ui_locale') === 'en-US' ? 'en-US' as const : 'es-AR' as const;
const mt = (key: Parameters<typeof mainMessage>[1], params?: Record<string,string|number>) => mainMessage(uiLocale(), key, params);

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? null;
/** Last state reported by the renderer; only affects the close confirmation. */
let hasUnsavedWork = false;
const PRELOAD = path.join(__dirname, 'preload.cjs');
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon-256.png');
/** First check once the app has settled, then a quiet one every few hours. */
const FIRST_CHECK_MS = 25_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;
let backend: Backend | null = null;
let unregisterIpc: (() => void) | null = null;
let updates: UpdateController | null = null;
let closeGuard: CloseGuardHandle | null = null;
/**
 * A quit that was already decided: either the user confirmed it, or there was
 * nothing to confirm. It exists so one restart is questioned exactly once, no
 * matter whether it started at the window or at the app.
 */
let quitting = false;
let backendStopped = false;

app.setName('Latte');

if (!app.requestSingleInstanceLock()) {
  // Only one Latte at a time: they would share the same data directory.
  // Say so, or this looks like "the app simply did not open".
  console.error('[latte] Ya hay una ventana de Latte abierta. Se trae al frente esa y esta instancia se cierra.');
  if (process.platform === 'linux') console.error("[latte] Si no la ves, tanto en la app empaquetada como desde el código fuente, ejecutá `pgrep -af 'Latte|latte'`, inspeccioná el resultado para identificar el PID exacto de Latte, ejecutá `kill <PID>` y volvé a intentar.");
  else if (process.platform === 'darwin') console.error('[latte] Si no la ves, buscá el proceso Latte en el Monitor de Actividad y terminalo, y volvé a intentar.');
  else console.error('[latte] Si no la ves, cerrá el proceso electron.exe desde el Administrador de tareas y volvé a intentar.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void start();
}

async function start(): Promise<void> {
  await app.whenReady();

  const binPath = ensureUserBinPath(process.env, process.platform);
  if (binPath.added.length > 0) {
    process.env.PATH = binPath.env.PATH;
    console.log(`[latte] PATH extendido con: ${binPath.added.join(', ')}`);
  }

  const dataDir = process.env.LATTE_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
  try {
    backend = await createBackend({
      dataDir,
      version: app.getVersion(),
      emit: emitAgentEvent,
      emitChat: emitChatEvent,
      chooseExportPath,
      chooseFolder,
      chooseFiles,
      revealPath: async (target) => { const error = await shell.openPath(target); if (error) throw new Error(error); },
      revealFile: async (target) => { shell.showItemInFolder(target); },
      confirmHtml: async (fileName) => {
        const options = { type: 'warning' as const, title: 'Abrir HTML externo', message: `¿Abrir ${fileName}?`, detail: 'El HTML puede ejecutar scripts y conectarse a Internet. Se abrirá en la aplicación externa predeterminada, no dentro de Latte. Abrilo solo si confiás en su contenido.', buttons: ['Cancelar', 'Abrir'], defaultId: 0, cancelId: 0, noLink: true };
        const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
        return result.response === 1;
      },
      openExternal: async (url) => { if (isExternalHttp(url)) await shell.openExternal(url); },
      log: (line) => console.log(line.trimEnd()),
    });
    // Persist the first automatic choice. From then on the explicit preference
    // always wins over an operating-system locale change.
    if (backend.repo.getMeta('ui_locale') === null) {
      backend.repo.setMeta('ui_locale', app.getLocale().toLowerCase().startsWith('en') ? 'en-US' : 'es-AR');
    }
  } catch (error) {
    // Opening the data is the one failure that must not end in a blank window:
    // it usually means the database belongs to a newer Latte.
    reportStartFailure(error);
    return;
  }
  console.log(`[latte] data dir: ${backend.info.dataDir}`);
  console.log(`[latte] storage: ${backend.info.engine} (${backend.info.engineReason})`);
  if (backend.info.seeded) console.log('[latte] seeded demo brand "Casa Oliva (demo)"');
  const terminal = backend.terminal.availability();
  console.log(`[latte] terminal backend: ${terminal.available ? 'node-pty ready' : `unavailable (${terminal.reason})`}`);

  hardenSession();

  // Handlers must exist before the renderer loads: its first listBrands()
  // would otherwise race the registration.
  unregisterIpc = registerIpc({
    ipcMain,
    api: backend.service,
    isTrustedSender: (sender) => mainWindow !== null && !mainWindow.isDestroyed() && sender.id === mainWindow.webContents.id,
    log: (message) => console.error(message),
  });
  // One-way state from the renderer. Same sender check as every other channel;
  // a value from anywhere else is ignored rather than trusted.
  ipcMain.on('latte:unsaved', (event, value: unknown) => {
    if (!isMainSender(event.sender.id)) return;
    hasUnsavedWork = value === true;
  });
  // Window controls. The renderer can only ask for these three things.
  ipcMain.on('latte:window', (event, action: unknown) => {
    if (!isMainSender(event.sender.id) || mainWindow === null) return;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (action === 'close') mainWindow.close();
  });
  setupUpdates();
  createWindow();
  armSmokeExit();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

/**
 * Updates are opt-in at every step: Latte checks, tells you, and waits. It
 * downloads only when you ask and restarts only when you confirm. Running from
 * source there is no installed application to replace, so nothing is checked
 * and the renderer is told exactly that.
 */
function setupUpdates(): void {
  const availability = decideUpdaterAvailability({
    isPackaged: app.isPackaged,
    devServerUrl: DEV_SERVER_URL,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
  });
  const { engine, reason, unsupportedKind, quitAndInstall } = createUpdaterEngine({
    enabled: availability.enabled,
    disabledReason: availability.reason,
    unsupportedKind: availability.unsupportedKind,
    // Alpha builds are published as normal releases so the direct download and
    // the updater agree; the pre-release channel stays behind an explicit opt-in.
    allowPrerelease: process.env.LATTE_UPDATE_PRERELEASE === '1',
    log: (line) => console.log(line),
  });
  updates = new UpdateController({
    engine,
    unsupportedReason: reason,
    unsupportedKind,
    emit: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(UPDATE_STATE_CHANNEL, state);
    },
    hasUnsavedWork: () => hasUnsavedWork,
    activity: () => ({ chats: backend?.hub.liveCount() ?? 0, terminals: backend?.terminal.liveCount() ?? 0 }),
    confirmInstall,
    beginInstall: () => {
      // The user just said yes to this exact restart. Asking again on the way
      // out would be the app doubting an answer it already has.
      quitting = true;
      closeGuard?.allowClose();
      quitAndInstall();
    },
    installFailed: () => {
      quitting = false;
      closeGuard?.requireConfirmation();
    },
    log: (line) => console.error(line),
  });

  const controller = updates;
  const respond = <T>(sender: number, produce: () => Promise<T> | T): Promise<IpcEnvelope<T>> => Promise.resolve()
    .then(async () => {
      if (!isMainSender(sender)) return { ok: false as const, code: 'FORBIDDEN', message: 'Untrusted IPC sender' };
      return { ok: true as const, value: await produce() };
    })
    .catch((error: unknown) => ({ ok: false as const, code: 'INTERNAL', message: errorMessage(error) }));

  ipcMain.handle(UPDATE_CHECK_CHANNEL, (event): Promise<IpcEnvelope<UpdateState>> => respond(event.sender.id, () => controller.check()));
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, (event): Promise<IpcEnvelope<UpdateState>> => respond(event.sender.id, () => controller.download()));
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, (event): Promise<IpcEnvelope<InstallOutcome>> => respond(event.sender.id, () => controller.install()));

  if (!engine) return;
  // unref: a pending check must never be the reason the app stays alive.
  setTimeout(() => { void controller.check(); }, FIRST_CHECK_MS).unref();
  setInterval(() => { void controller.check(); }, CHECK_INTERVAL_MS).unref();
}

/**
 * The confirmation before a restart. It says what is lost and what is not,
 * because "se reiniciará" alone does not tell anyone whether their agents,
 * their terminals or their versions are at risk.
 */
function confirmInstall(activity: UpdateActivity, version: string): boolean {
  const live = [
    activity.chats > 0 ? `${activity.chats} ${activity.chats === 1 ? 'conversación' : 'conversaciones'}` : null,
    activity.terminals > 0 ? mt(activity.terminals === 1 ? 'terminalOne' : 'terminalMany', { count: activity.terminals }) : null,
  ].filter((part): part is string => part !== null).join(mt('and'));
  return ask({
    type: 'question',
    buttons: ['Reiniciar e instalar', 'Más tarde'],
    defaultId: 1,
    cancelId: 1,
    title: mt('updateTitle', { version }),
    message: 'Guardá tus documentos antes de continuar.',
    detail: live
      ? `Latte se cierra para instalar la actualización. Se detienen ${live} en curso. Tus documentos guardados, tus versiones y tus decisiones no se tocan.`
      : 'Latte se cierra para instalar la actualización. Tus documentos guardados, tus versiones y tus decisiones no se tocan.',
    noLink: true,
  });
}

/** The unsaved-work confirmation, shared by the window close and the app quit. */
function confirmDiscardUnsaved(): boolean {
  return ask({
    type: 'warning',
    buttons: [mt('closeAnyway'), mt('cancel')],
    defaultId: 1,
    cancelId: 1,
    title: mt('unsavedTitle'),
    message: 'Tenés cambios sin guardar en un documento.',
    detail: 'Si cerrás ahora, se pierden. Las conversaciones abiertas y las versiones ya guardadas no se ven afectadas.',
    noLink: true,
  });
}

function ask(options: Electron.MessageBoxSyncOptions): boolean {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  return (win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options)) === 0;
}

/**
 * Stops the backend once and only once. Both the window and the app can lead
 * to a quit; whichever gets here first does the work.
 */
function stopBackend(): void {
  if (backendStopped) return;
  backendStopped = true;
  unregisterIpc?.();
  unregisterIpc = null;
  backend?.service.shutdown();
  backend = null;
}

function reportStartFailure(error: unknown): void {
  const incompatible = error instanceof IncompatibleSchemaError;
  console.error(`[latte] no se pudo abrir el espacio de trabajo: ${errorMessage(error)}`);
  dialog.showErrorBox(
    incompatible ? 'Tus datos son de una versión más nueva de Latte' : 'Latte no pudo abrir tus datos',
    incompatible
      ? `${errorMessage(error)}\n\nNo se abrió ni se modificó nada. Instalá la versión más reciente de Latte y volvé a intentar.`
      : `${errorMessage(error)}\n\nTus datos siguen en disco, tal como estaban.`,
  );
  quitting = true;
  app.quit();
}

function isMainSender(senderId: number): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && senderId === mainWindow.webContents.id;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Latte',
    icon: APP_ICON,
    backgroundColor: '#f5f0e8',
    autoHideMenuBar: true,
    show: false,
    // The app draws its own title bar. 'hidden' keeps the native frame
    // behaviour (snap, resize, rounded corners) without the system bar.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());
  const sendState = () => {
    if (!win.isDestroyed()) win.webContents.send('latte:window-state', { maximized: win.isMaximized() });
  };
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);
  win.webContents.on('did-finish-load', sendState);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  closeGuard = attachCloseGuard(win, {
    hasUnsavedWork: () => hasUnsavedWork,
    confirm: confirmDiscardUnsaved,
    // Answering here settles the quit that follows: 'before-quit' must not ask
    // the same question a second time.
    onConfirmed: () => { quitting = true; },
  });

  // The renderer never opens windows or navigates away. External http(s)
  // links go to the system browser; everything else is dropped.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttp(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedDocument(url)) return;
    event.preventDefault();
    if (isExternalHttp(url)) void shell.openExternal(url);
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }
}

/**
 * Dev/CI smoke: LATTE_SMOKE_EXIT_MS=8000 runs the real app (main + preload +
 * renderer) for that long, prints renderer console errors and exits 0/1.
 */
function armSmokeExit(): void {
  const ms = Number(process.env.LATTE_SMOKE_EXIT_MS ?? '');
  if (!Number.isFinite(ms) || ms <= 0 || !mainWindow) return;
  const errors: string[] = [];
  let loaded = false;
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  mainWindow.webContents.on('did-finish-load', () => { loaded = true; });
  mainWindow.webContents.on('did-fail-load', (_e, code, description) => errors.push(`did-fail-load ${code} ${description}`));
  setTimeout(() => {
    console.log(`[latte:smoke] renderer loaded=${loaded} consoleErrors=${errors.length}`);
    for (const error of errors) console.log(`[latte:smoke] error: ${error.slice(0, 300)}`);
    process.exitCode = loaded && errors.length === 0 ? 0 : 1;
    app.quit();
  }, ms);
}

function hardenSession(): void {
  const ses = session.defaultSession;

  // Deny everything by default; copying terminal output is the one thing we allow.
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  ses.setPermissionCheckHandler((_webContents, permission) => permission === 'clipboard-sanitized-write');

  const csp = buildCsp();
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

function buildCsp(): string {
  if (DEV_SERVER_URL) {
    const origin = new URL(DEV_SERVER_URL).origin;
    const ws = origin.replace(/^http/, 'ws');
    // Vite's dev client and the React fast-refresh preamble are inline scripts;
    // this relaxed policy exists only in development.
    return [
      `default-src 'self' ${origin}`,
      `script-src 'self' 'unsafe-inline' ${origin}`,
      `style-src 'self' 'unsafe-inline' ${origin}`,
      `img-src 'self' data: blob: ${origin}`,
      `font-src 'self' data: ${origin}`,
      `connect-src 'self' ${origin} ${ws}`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
    ].join('; ');
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ');
}

function isExternalHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return !DEV_SERVER_URL || parsed.origin !== new URL(DEV_SERVER_URL).origin;
  } catch {
    return false;
  }
}

function isAllowedDocument(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (DEV_SERVER_URL) return parsed.origin === new URL(DEV_SERVER_URL).origin;
    return parsed.protocol === 'file:';
  } catch {
    return false;
  }
}

function emitAgentEvent(event: AgentEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(AGENT_EVENT_CHANNEL, event);
}

function emitChatEvent(event: ChatEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(CHAT_EVENT_CHANNEL, event);
}

async function chooseExportPath(suggestedFileName: string): Promise<string | null> {
  const options = {
    title: mt('exportTitle'),
    defaultPath: path.join(app.getPath('documents'), suggestedFileName),
    filters: [
      { name: mt('originalFormat'), extensions: [path.extname(suggestedFileName).slice(1) || 'md'] },
      { name: mt('allFiles'), extensions: ['*'] },
    ],
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

/** File picker for bringing the client's own material into a work folder. */
async function chooseFiles(title: string): Promise<string[]> {
  const options = { title: mt('importTitle'), properties: ['openFile' as const, 'multiSelections' as const, 'dontAddToRecent' as const], buttonLabel: mt('importButton') };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

/** Folder picker for pointing a work at an existing folder. */
async function chooseFolder(title: string): Promise<string | null> {
  const options = { title: mt('folderTitle'), properties: ['openDirectory' as const, 'dontAddToRecent' as const], buttonLabel: mt('folderButton') };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

attachQuitGuard(app, {
  hasUnsavedWork: () => hasUnsavedWork,
  confirm: confirmDiscardUnsaved,
  isDecided: () => quitting,
  decide: () => {
    quitting = true;
    // Whoever asked, asked for both: the window must not repeat the question.
    closeGuard?.allowClose();
  },
  stop: stopBackend,
});
