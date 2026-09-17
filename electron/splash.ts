import { BrowserWindow } from 'electron';
import path from 'node:path';

/**
 * The printed splash: a cup fills, the L appears in the foam and three wisps of steam
 * rise. It reports what start-up is really doing, never a made-up progress:
 * - data       opening the database
 * - interface  the main window is loading
 * - ready      the main window can be shown
 *
 * It stays at least MIN_VISIBLE_MS once on screen, so the cup finishes instead of
 * flashing, and it never delays a start-up that was faster than the splash itself.
 * LATTE_SPLASH=0 turns it off (tests, CI, screen recordings).
 */
export type SplashStage = 'data' | 'interface' | 'ready';

export interface Splash {
  stage(stage: SplashStage): void;
  /** Shows "ready", waits out the minimum, then calls `reveal` and closes. */
  finish(reveal: () => void): void;
  /** Closes at once, for start-up failures that show their own dialog. */
  close(): void;
}

const MIN_VISIBLE_MS = 1200;
const READY_HOLD_MS = 300;

const disabled: Splash = {
  stage: () => {},
  finish: (reveal) => reveal(),
  close: () => {},
};

export function openSplash(options: { icon: string; locale: 'es' | 'en'; version: string }): Splash {
  if (process.env.LATTE_SPLASH === '0') return disabled;

  const win = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    title: 'Latte',
    icon: options.icon,
    backgroundColor: '#f6f3ed',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  let shownAt = 0;
  let current: SplashStage = 'data';
  const alive = () => !win.isDestroyed();
  const send = (stage: SplashStage) => {
    if (!alive()) return;
    // The stage is one of three fixed words; nothing from outside reaches the page.
    void win.webContents.executeJavaScript(`window.latteSplash && window.latteSplash(${JSON.stringify(stage)})`).catch(() => {});
  };

  win.once('ready-to-show', () => {
    if (!alive()) return;
    win.show();
    shownAt = Date.now();
  });
  win.webContents.on('did-finish-load', () => send(current));
  void win.loadFile(path.join(__dirname, '..', 'assets', 'splash.html'), { query: { lang: options.locale, v: options.version } });

  return {
    stage(stage) {
      current = stage;
      send(stage);
    },
    finish(reveal) {
      if (!alive() || shownAt === 0) {
        // The app was ready before the splash could appear: no splash at all.
        if (alive()) win.destroy();
        reveal();
        return;
      }
      this.stage('ready');
      const wait = Math.max(READY_HOLD_MS, MIN_VISIBLE_MS - (Date.now() - shownAt));
      setTimeout(() => {
        // Show the main window first, then close the splash, so nothing blinks in between.
        reveal();
        if (alive()) win.destroy();
      }, wait);
    },
    close() {
      if (alive()) win.destroy();
    },
  };
}
