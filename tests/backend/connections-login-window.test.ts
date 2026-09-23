import { describe, expect, it, vi } from 'vitest';
import { createLoginWindowOpener } from '../../electron/connections/loginWindow';

/**
 * LA VENTANA DE LOGIN LLEVA EL ICONO DE LATTE.
 *
 * La ventana principal lo pone (`electron/main.ts`), la de login no: el popup
 * de "Iniciar sesion con Google" aparecia con el icono por defecto de Electron,
 * que en la barra de tareas es literalmente otra aplicacion. Y lo mismo la
 * ventana HIJA que el proveedor abre desde ahi, que nace de
 * `setWindowOpenHandler` y no hereda nada de su padre.
 *
 * `BrowserWindow` es un doble: ningun test abre una ventana de verdad.
 */

const opened: Array<Record<string, unknown>> = [];
let openHandler: ((details: { url: string }) => unknown) | null = null;

class FakeBrowserWindow {
  webContents = {
    session: {},
    setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => { openHandler = handler; },
  };
  constructor(options: Record<string, unknown>) { opened.push(options); }
  async loadURL(): Promise<void> { /* nada que cargar: no hay red en un test */ }
  on(): void { /* el cierre no participa de esta prueba */ }
  destroy(): void {}
  isDestroyed(): boolean { return false; }
}

vi.mock('../../electron/core/optionalRequire', () => ({
  optionalRequire: () => ({ ok: true, module: { BrowserWindow: FakeBrowserWindow } }),
}));

const ICON = '/ruta/al/icono/de/latte.ico';

describe('la ventana de login de una Conexion', () => {
  it('se abre con el icono de Latte', async () => {
    opened.length = 0;
    const open = createLoginWindowOpener(undefined, ICON);
    await open('https://proveedor.example/authorize', { onClosed: () => {} });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.icon).toBe(ICON);
  });

  /** El popup de "Iniciar sesion con Google" nace de acá, y con el mismo icono. */
  it('le pasa el mismo icono a las ventanas hijas que abre el proveedor', async () => {
    opened.length = 0;
    openHandler = null;
    const open = createLoginWindowOpener(undefined, ICON);
    await open('https://proveedor.example/authorize', { onClosed: () => {} });
    expect(openHandler).not.toBeNull();
    const decision = openHandler!({ url: 'https://accounts.google.example/o/oauth2/auth' }) as {
      action: string; overrideBrowserWindowOptions?: Record<string, unknown>;
    };
    expect(decision.action).toBe('allow');
    expect(decision.overrideBrowserWindowOptions?.icon).toBe(ICON);
  });

  /** Sin icono configurado no se inventa una ruta: la ventana se abre igual. */
  it('sin icono no pone la clave', async () => {
    opened.length = 0;
    const open = createLoginWindowOpener();
    await open('https://proveedor.example/authorize', { onClosed: () => {} });
    expect(opened[0]!.icon).toBeUndefined();
  });
});
