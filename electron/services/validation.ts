import { ValidationError } from '../core/errors';
import { assertId } from '../core/paths';
import { isValidId } from '../core/ids';

export const LIMITS = {
  name: 120,
  title: 160,
  context: 60_000,
  brief: 60_000,
  /** A description of the output, not a second brief: it rides every instruction file. */
  expectedOutput: 2_000,
  document: 2_000_000,
  decision: 4_000,
  memory: 20_000,
  terminalChunk: 64 * 1024,
  chatMessage: 100_000,
} as const;

/** OpenCode request ids (per_..., que_...): opaque but bounded and printable. */
export function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ValidationError('Invalid request id');
  return value;
}

export function requireText(value: unknown, name: string, max: number, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  if (value.includes('\0')) throw new ValidationError(`${name} contains a NUL byte`);
  if (value.length > max) throw new ValidationError(`${name} is too long (max ${max} characters)`);
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed.length === 0) throw new ValidationError(`${name} cannot be empty`);
  return value;
}

export function requireLabel(value: unknown, name: string, max: number): string {
  const text = requireText(value, name, max).trim().replace(/\s+/g, ' ');
  if (/[\r\n]/.test(text)) throw new ValidationError(`${name} cannot span lines`);
  return text;
}

export function requireId(value: unknown, name: string): string {
  assertId(value, name);
  return value;
}

/**
 * A coordination gate id (task 7.14 discovery): `engine.ts`'s `listGates()`
 * builds three of its four gate kinds as SYNTHETIC ids never persisted as a
 * row — `plan:<runId>`, `budget:<runId>`, `proposal:<runId>` — because there
 * is nothing to select by primary key for a gate derived from the run's own
 * state. Only a `dispatch` gate carries a real row id (`ID_PATTERN`, no
 * colon). The generic `requireId` rejected the other three outright, which
 * meant `resolveCoordinationGate` could approve a dispatch gate through IPC
 * but never a plan, budget or proposal gate — validated narrowly here
 * instead of loosening `ID_PATTERN`, which doubles as a filesystem-path
 * safety net for every other entity id in the app.
 */
export function requireGateId(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('gateId must be a string');
  const prefixed = value.match(/^(plan|budget|proposal):(.+)$/);
  if (prefixed) {
    if (!isValidId(prefixed[2])) throw new ValidationError('Invalid gateId');
    return value;
  }
  if (!isValidId(value)) throw new ValidationError('Invalid gateId');
  return value;
}

/**
 * El texto con el que la persona EDITA antes de aprobar un gate de
 * coordinación: el prompt de un despacho, o el JSON de la propuesta editada.
 *
 * Llegaba sin validar de ninguna clase hasta `hub.send`, o sea hasta un
 * agente levantado: un megabyte entraba entero, y una cadena vacía se
 * despachaba como "edición" pisando la especificación de la tarea. El tope es
 * el mismo que el repo le aplica al otro texto libre que la persona escribe y
 * que termina en un runtime, el mensaje de chat.
 */
export function requireEditedPrompt(value: unknown): string {
  return requireText(value, 'editedPrompt', LIMITS.chatMessage);
}

/** Brand context and rationale may include newlines and tabs, never other C0/C1 controls. */
export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

export function assertNoControlChars(value: string, name: string): void {
  if (hasControlChars(value)) {
    throw new ValidationError(`${name} contains control characters`);
  }
}

/** Trim + NFC + control-char check used by updateBrand and brand-context proposals. */
export function requireCleanContext(value: unknown, name: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  if (value.includes('\0')) throw new ValidationError(`${name} contains a NUL byte`);
  const clean = value.trim().normalize('NFC');
  if (!options.allowEmpty && clean.length === 0) throw new ValidationError(`${name} cannot be empty`);
  if (clean.length > LIMITS.context) throw new ValidationError(`${name} is too long (max ${LIMITS.context} characters)`);
  assertNoControlChars(clean, name);
  return clean;
}

export function requireInt(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ValidationError(`${name} must be an integer`);
  if (value < min || value > max) throw new ValidationError(`${name} must be between ${min} and ${max}`);
  return value;
}
