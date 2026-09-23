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
  webContents: {
    session: { clearStorageData?: () => Promise<void> };
    /** Las ventanas hijas que abre el proveedor: el popup de "Iniciar sesión con Google" es una. */
    setWindowOpenHandler?: (handler: (details: { url: string }) => unknown) => void;
  };
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
export function createLoginWindowOpener(
  log?: (line: string) => void,
  /**
   * El MISMO `APP_ICON` que la ventana principal, pasado desde `main.ts`.
   *
   * Viaja como parámetro y no se calcula acá: en desarrollo cada módulo corre
   * desde su propia carpeta y en distribución todo esto es un solo bundle, así
   * que un `__dirname` local daría dos rutas distintas para el mismo archivo.
   *
   * Sin él la ventana se abre igual, con el icono por defecto de Electron: no
   * se inventa una ruta a un archivo que puede no estar.
   */
  icon?: string | null,
): LoginWindowOpener {
  return async (url: string, hooks: { onClosed: () => void }): Promise<LoginWindow> => {
    const loaded = optionalRequire<ElectronModule>('electron');
    if (!loaded.ok) throw new Error(`No se pudo abrir la ventana de login: ${loaded.error}`);
    const window = new loaded.module.BrowserWindow({
      width: 520,
      height: 720,
      title: 'Entrar',
      autoHideMenuBar: true,
      ...(icon ? { icon } : {}),
      webPreferences: {
        partition: `connection-login-${Date.now()}`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    /**
     * El popup del proveedor ("Iniciar sesión con Google") es una ventana
     * HIJA, y una ventana hija no hereda nada de su padre: nace con el icono
     * por defecto de Electron salvo que se le diga el suyo acá. Se le pasa el
     * mismo, que es lo que hace que las dos se vean como una sola aplicación
     * en la barra de tareas.
     */
    window.webContents.setWindowOpenHandler?.(() => ({
      action: 'allow',
      ...(icon ? { overrideBrowserWindowOptions: { icon } } : {}),
    }));
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
