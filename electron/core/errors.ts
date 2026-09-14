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

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
