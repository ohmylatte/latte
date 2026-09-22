/**
 * El cifrado de los secretos de una Conexión (brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`, 4.3): un puerto
 * chiquito sobre `safeStorage` de Electron, para que el repositorio no
 * dependa de Electron y los tests puedan inyectar una caja de juguete.
 *
 * `safeStorage` cifra contra la sesión del sistema operativo. Si el sistema no
 * puede ofrecer ese respaldo (`isEncryptionAvailable()` en falso: una sesión
 * de Linux sin keyring, un arranque headless), **no hay fallback a texto
 * plano**. Un token de proveedor en claro en la base es exactamente lo que
 * este diseño existe para evitar, así que la caja no disponible FALLA con una
 * explicación y la conexión no se guarda (riesgo 1 de la sección 5).
 */
import { optionalRequire } from '../core/optionalRequire';
import { SecretStoreUnavailableError } from '../core/errors';

export interface SecretBox {
  /** Falso = este sistema no puede cifrar; guardar va a fallar y hay que decírselo a la persona. */
  readonly available: boolean;
  /** Por qué no está disponible. Cadena vacía cuando sí lo está. */
  readonly detail: string;
  /** Texto claro -> blob en base64, listo para una columna TEXT. */
  encrypt(plain: string): string;
  /** El inverso. Tira si el blob no es suyo o está corrupto; quien llama decide qué hacer. */
  decrypt(blob: string): string;
}

/** La caja real: `safeStorage` del proceso principal de Electron. */
export function electronSecretBox(): SecretBox {
  const loaded = optionalRequire<{ safeStorage?: { isEncryptionAvailable(): boolean; encryptString(plain: string): Buffer; decryptString(buffer: Buffer): string } }>('electron');
  const safeStorage = loaded.ok ? loaded.module.safeStorage : undefined;
  if (!safeStorage) {
    return unavailableSecretBox(loaded.ok ? 'Electron no expone safeStorage en este proceso.' : loaded.error);
  }
  let available = false;
  let detail = '';
  try {
    available = safeStorage.isEncryptionAvailable();
    if (!available) detail = 'El sistema no ofrece un almacén de secretos para cifrar las credenciales.';
  } catch (error) {
    detail = `El almacén de secretos del sistema no respondió: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!available) return unavailableSecretBox(detail);
  return {
    available: true,
    detail: '',
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, 'base64')),
  };
}

/** La caja que no puede: todo intento de guardar falla con este motivo. */
export function unavailableSecretBox(detail: string): SecretBox {
  return {
    available: false,
    detail,
    encrypt: () => { throw new SecretStoreUnavailableError(detail); },
    decrypt: () => { throw new SecretStoreUnavailableError(detail); },
  };
}

/**
 * Caja de juguete para los tests: reversible y con una marca propia, así un
 * test puede comprobar que el blob NO es el texto claro sin depender de
 * Electron. No es criptografía y no pretende serlo — jamás se usa en la app.
 */
export function memorySecretBox(): SecretBox {
  const MARK = 'latte-test-box:';
  return {
    available: true,
    detail: '',
    encrypt: (plain) => Buffer.from(`${MARK}${plain}`, 'utf8').toString('base64'),
    decrypt: (blob) => {
      const decoded = Buffer.from(blob, 'base64').toString('utf8');
      if (!decoded.startsWith(MARK)) throw new Error('blob ajeno a esta caja');
      return decoded.slice(MARK.length);
    },
  };
}
