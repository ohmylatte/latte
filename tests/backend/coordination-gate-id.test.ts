import { describe, expect, it } from 'vitest';
import { requireGateId } from '../../electron/services/validation';
import { ValidationError } from '../../electron/core/errors';

/**
 * `resolveCoordinationGate` (IPC) validated `gateId` with the generic
 * `requireId`, whose pattern (`electron/core/ids.ts`) forbids `:` — correct
 * for a real database id, which doubles as a filesystem folder name, but
 * `engine.ts`'s `listGates()` (task 6.9) builds three of its four gate kinds
 * as SYNTHETIC ids (`plan:<runId>`, `budget:<runId>`, `proposal:<runId>`),
 * never persisted as a row. Only `dispatch` gates carry a real,
 * colon-free row id.
 *
 * Discovered by task 7.14's end-to-end conversational-path test: approving
 * a `proposal` gate through the REAL IPC surface (`LatteService`, not
 * `engine.resolveGate()` called directly, which every prior gates test
 * used) threw `Invalid gateId` — meaning `plan`/`budget`/`proposal` gates
 * were NEVER actually approvable from the app, only `dispatch` gates were.
 * Fixed with a validator scoped to gate ids, not by loosening the global
 * `ID_PATTERN` other code relies on for path safety.
 */
describe('requireGateId: dispatch ids (plain) and plan/budget/proposal ids (prefixed)', () => {
  it('accepts a plain dispatch row id, same as any other entity id', () => {
    expect(requireGateId('cdp_0123456789abcdef')).toBe('cdp_0123456789abcdef');
  });

  it.each(['plan', 'budget', 'proposal'] as const)('accepts a "%s:" synthetic gate id when the inner id is valid', (prefix) => {
    const id = `${prefix}:crn_0123456789abcdef`;
    expect(requireGateId(id)).toBe(id);
  });

  it('rejects an unknown prefix', () => {
    expect(() => requireGateId('bogus:crn_0123456789abcdef')).toThrow(ValidationError);
  });

  it('rejects a synthetic id whose inner part is not a valid id', () => {
    expect(() => requireGateId('proposal:not a valid id')).toThrow(ValidationError);
  });

  it('rejects a bare invalid id', () => {
    expect(() => requireGateId('nope!')).toThrow(ValidationError);
  });

  it('rejects non-string input', () => {
    expect(() => requireGateId(42)).toThrow(ValidationError);
  });
});
