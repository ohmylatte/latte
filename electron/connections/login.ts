/**
 * El login completo de una Conexión, de punta a punta y en un solo lugar:
 * descubrir, resolver el `client_id`, abrir la ventana, esperar el redirect en
 * loopback, verificar el `state` y canjear el código.
 *
 * La ventana entra por un puerto (`LoginWindowOpener`) para que este módulo no
 * importe Electron: los tests corren el flujo entero contra el servidor de
 * juguete con una "ventana" que es un `fetch` que sigue el 302. La ventana real
 * vive en `loginWindow.ts`.
 *
 * **Ninguna prueba completa un login con una cuenta real.** El servidor de
 * juguete es hermético y vive en `tests/fakes/toyOAuth.ts`.
 */
import { LoginCancelledError, LoginStateMismatchError, LoginTimeoutError, TokenExchangeError } from './errors';
import { startLoopbackCallback, type LoopbackCallback } from './loopback';
import {
  authorizeUrl,
  createPkce,
  createState,
  defaultFetch,
  discoverAuthServer,
  exchangeCode,
  resolveClientId,
  statesMatch,
  type DiscoveredAuthServer,
  type FetchLike,
} from './oauth';
import type { ConnectionTokens } from '../storage/connectionsRepository';

/** Lo que Latte necesita de una ventana de login, y nada más. */
export interface LoginWindow {
  /** La cierra. Idempotente: se llama siempre, haya salido bien o mal. */
  close(): void;
}

/**
 * Abre la ventana en esa URL. `onClosed` se invoca si la persona la cierra a
 * mano — que es la cancelación, no un error.
 */
export type LoginWindowOpener = (url: string, hooks: { onClosed: () => void }) => Promise<LoginWindow>;

export interface LoginDeps {
  openLoginWindow: LoginWindowOpener;
  fetchFn?: FetchLike;
  now?: () => number;
  /** Cuánto se espera un redirect antes de cerrar la ventana y soltar el puerto. */
  timeoutMs?: number;
  /** Sólo para los tests: un temporizador que no depende del reloj real. */
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
  log?: (line: string) => void;
  clientName?: string;
}

export interface LoginRequest {
  /** La URL del servidor MCP. Lo único que la persona escribe. */
  resourceUrl: string;
  /** El `clientId` ya guardado en la conexión: cuando existe, se saltea el registro dinámico. */
  clientId?: string | null;
  /** Obligatorio sólo cuando el redirect está pre-registrado en una app propia. */
  preferredPort?: number;
}

export interface LoginOutcome {
  tokens: ConnectionTokens;
  discovery: DiscoveredAuthServer;
  /** True cuando el `client_id` salió de un registro dinámico y hay que guardarlo. */
  clientIdFromRegistration: boolean;
}

export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const realTimer = (fn: () => void, ms: number): { cancel: () => void } => {
  const handle = setTimeout(fn, ms);
  // `unref` no existe en todos los entornos donde esto se prueba.
  (handle as unknown as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(handle) };
};

export async function runConnectionLogin(request: LoginRequest, deps: LoginDeps): Promise<LoginOutcome> {
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? realTimer;

  const discovery = await discoverAuthServer(request.resourceUrl, fetchFn);

  // El listener se levanta ANTES de registrar el cliente: con un puerto
  // efímero, el `redirect_uri` no existe hasta que el sistema operativo dio el
  // puerto, y es ese redirect exacto el que hay que registrar.
  let loopback: LoopbackCallback;
  try {
    loopback = await startLoopbackCallback({ preferredPort: request.preferredPort, log: deps.log });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TokenExchangeError(`No se pudo abrir el puerto local que recibe la vuelta del login: ${reason}`);
  }

  try {
    const { clientId, fromRegistration } = await resolveClientId(discovery, loopback.redirectUri, request.clientId ?? null, fetchFn, deps.clientName);
    const pkce = createPkce();
    const state = createState();
    const target = authorizeUrl({ discovery, clientId, redirectUri: loopback.redirectUri, challenge: pkce.challenge, state });

    // Las tres formas de terminar compiten: el redirect, la ventana cerrada y
    // el reloj. La primera que llegue manda, y las otras dos se limpian en el
    // `finally` de abajo.
    let onClosed: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onClosed = () => reject(new LoginCancelledError('Se cerró la ventana antes de terminar de entrar.'));
    });
    let onTimeout: () => void = () => {};
    const timedOut = new Promise<never>((_, reject) => {
      onTimeout = () => reject(new LoginTimeoutError('La ventana de login estuvo abierta demasiado tiempo sin volver.'));
    });
    const window = await deps.openLoginWindow(target, { onClosed });
    const timer = setTimer(() => onTimeout(), deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);

    let redirect;
    try {
      redirect = await Promise.race([loopback.received, cancelled, timedOut]);
    } finally {
      timer.cancel();
      try { window.close(); } catch { /* ya cerrada */ }
    }

    if (redirect.error) {
      throw new TokenExchangeError(`El proveedor no autorizó la entrada (${redirect.error})${redirect.errorDescription ? `: ${redirect.errorDescription}` : ''}.`);
    }
    if (!redirect.code) throw new TokenExchangeError('El proveedor volvió sin código de autorización.');
    // El `state` se verifica SIEMPRE, y antes de tocar el código: es lo único
    // que separa "esto vuelve de mi pedido" de "alguien empujó un código ajeno
    // a mi puerto local".
    if (!redirect.state || !statesMatch(state, redirect.state)) {
      throw new LoginStateMismatchError('La vuelta del login no corresponde a este pedido, así que no se usó.');
    }

    const tokens = await exchangeCode({
      discovery,
      clientId,
      code: redirect.code,
      verifier: pkce.verifier,
      redirectUri: loopback.redirectUri,
      fetchFn,
      now,
    });
    return { tokens, discovery, clientIdFromRegistration: fromRegistration };
  } finally {
    loopback.close();
  }
}
