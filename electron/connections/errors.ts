/**
 * Los errores de una Conexión MCP que una persona tiene que poder leer.
 *
 * Viven en su propio archivo, con su propia familia de códigos, por lo mismo
 * que existe `BRAND_ERROR_KEYS`: la frase genérica de `UNAVAILABLE` ("algo que
 * hacía falta no está disponible") es verdad y no sirve para nada cuando lo que
 * pasó es que el servidor no registra clientes solo, o que la ventana se cerró
 * antes de terminar. Cada uno de estos códigos existe porque hay un paso
 * distinto que dar.
 */
import { LatteError } from '../core/errors';

/**
 * El servidor publica `registration_endpoint` pero rechaza todo registro (el
 * caso Meta, medido en la sección 3 del brief), y la conexión no trae un
 * `clientId` guardado. No hay nada que Latte pueda hacer sola: la persona
 * tiene que traer el id de cliente de su propia app.
 */
export class ClientIdRequiredError extends LatteError {
  constructor(message: string) {
    super('CONNECTION_CLIENT_ID_REQUIRED', message);
    this.name = 'ClientIdRequiredError';
  }
}

/** La persona cerró la ventana de login sin terminar. No es un fallo: es un "ahora no". */
export class LoginCancelledError extends LatteError {
  constructor(message: string) {
    super('CONNECTION_LOGIN_CANCELLED', message);
    this.name = 'LoginCancelledError';
  }
}

/** La ventana quedó abierta sin que volviera nada. Se cierra sola para no dejar un puerto escuchando para siempre. */
export class LoginTimeoutError extends LatteError {
  constructor(message: string) {
    super('CONNECTION_LOGIN_TIMEOUT', message);
    this.name = 'LoginTimeoutError';
  }
}

/**
 * No se pudo averiguar cómo se entra a ese servidor: ni el 401 trajo
 * `WWW-Authenticate`, ni los well-known respondieron, ni en forma path-aware
 * ni en la genérica. Casi siempre es una URL equivocada.
 */
export class DiscoveryFailedError extends LatteError {
  constructor(message: string) {
    super('CONNECTION_DISCOVERY_FAILED', message);
    this.name = 'DiscoveryFailedError';
  }
}

/**
 * El `state` que volvió del navegador no es el que se mandó. Es la única
 * defensa contra que alguien más empuje un código de autorización ajeno a
 * nuestro listener de loopback, así que no se negocia: se corta.
 */
export class LoginStateMismatchError extends LatteError {
  constructor(message: string) {
    super('CONNECTION_STATE_MISMATCH', message);
    this.name = 'LoginStateMismatchError';
  }
}

/**
 * El proveedor rechazó el canje o el refresh. Lleva el `error` del servidor en
 * el mensaje porque es lo único que distingue "el código ya se usó" de "esta
 * app no existe más".
 */
export class TokenExchangeError extends LatteError {
  constructor(message: string) {
    super('CONNECTION_TOKEN_REFUSED', message);
    this.name = 'TokenExchangeError';
  }
}
