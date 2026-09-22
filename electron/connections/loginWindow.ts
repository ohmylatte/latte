/**
 * La ventana de login real: una `BrowserWindow` propia, **no el navegador del
 * sistema** (brief 4.3).
 *
 * El motivo es de producto, no técnico: el redirect vuelve a `127.0.0.1`, y un
 * navegador del sistema deja a la persona mirando una pestaña huérfana sin
 * saber si tiene que volver a la app. Una ventana que Latte abre es una ventana
 * que Latte cierra sola en cuanto el código llegó.
 *
 * Vive aislado del resto del módulo a propósito: es el ÚNICO archivo de
 * `connections/` que toca Electron, así que todo lo demás se prueba sin
 * levantar una ventana.
 */
import { optionalRequire } from '../core/optionalRequire';
import type { LoginWindow, LoginWindowOpener } from './login';

interface BrowserWindowLike {
  loadURL(url: string): Promise<void>;
  on(event: 'closed', listener: () => void): void;
  destroy(): void;
  isDestroyed(): boolean;
  webContents: { session: { clearStorageData?: () => Promise<void> } };
}

interface ElectronModule {
  BrowserWindow: new (options: Record<string, unknown>) => BrowserWindowLike;
}

/**
 * `partition` efímera (`sesión` sin prefijo `persist:`): la cookie de sesión del
 * proveedor muere con la ventana. Latte guarda el token que emitió el AS, no la
 * sesión web del navegador; dejar esa sesión viva sería guardar una credencial
 * que nadie decidió guardar.
 *
 * Sin `nodeIntegration` y con `contextIsolation`, igual que la ventana
 * principal: acá se carga HTML de un tercero.
 */
export function createLoginWindowOpener(log?: (line: string) => void): LoginWindowOpener {
  return async (url: string, hooks: { onClosed: () => void }): Promise<LoginWindow> => {
    const loaded = optionalRequire<ElectronModule>('electron');
    if (!loaded.ok) throw new Error(`No se pudo abrir la ventana de login: ${loaded.error}`);
    const window = new loaded.module.BrowserWindow({
      width: 520,
      height: 720,
      title: 'Entrar',
      autoHideMenuBar: true,
      webPreferences: {
        partition: `connection-login-${Date.now()}`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    let closedByUs = false;
    window.on('closed', () => {
      // Cerrarla nosotros al terminar NO es una cancelación: sin esta guarda,
      // un login exitoso terminaba rechazando por "la persona cerró la ventana"
      // justo después de haber canjeado el código.
      if (!closedByUs) hooks.onClosed();
    });
    try {
      await window.loadURL(url);
    } catch (error) {
      log?.(`[connections-login] la ventana no pudo cargar: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      close: () => {
        closedByUs = true;
        if (!window.isDestroyed()) window.destroy();
      },
    };
  };
}
