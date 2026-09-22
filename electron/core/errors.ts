/** Errors that are safe to surface to the renderer verbatim. */
export class LatteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LatteError';
    this.code = code;
  }
}

export class ValidationError extends LatteError {
  constructor(message: string) {
    super('VALIDATION', message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends LatteError {
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export class UnavailableError extends LatteError {
  constructor(message: string) {
    super('UNAVAILABLE', message);
    this.name = 'UnavailableError';
  }
}

export class ConflictError extends LatteError {
  constructor(message: string) {
    super('CONFLICT', message);
    this.name = 'ConflictError';
  }
}

/**
 * El sistema no ofrece dónde cifrar un secreto (`safeStorage.isEncryptionAvailable()`
 * en falso, o Electron sin `safeStorage`). Vive acá y no en `storage/secretBox.ts`
 * porque no es un problema del almacén: es una capacidad del sistema operativo
 * que cualquier módulo que tenga que guardar una credencial va a encontrarse, y
 * la persona necesita leer la misma frase venga de donde venga.
 */
export class SecretStoreUnavailableError extends LatteError {
  constructor(message: string) {
    super('SECRET_STORE_UNAVAILABLE', message);
    this.name = 'SecretStoreUnavailableError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
