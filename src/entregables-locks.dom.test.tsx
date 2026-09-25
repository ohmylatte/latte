import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * E5: LOS CANDADOS DE ENTREGABLES E IDENTIDAD.
 *
 *  1. Ninguna superficie muestra rutas completas: ni la tira, ni el detalle,
 *     ni lo producido, ni Marca → Identidad.
 *  2. La marca "para el cliente" aparece SÓLO en tareas `client`.
 *  3. Todo el copy nuevo está en castellano y en inglés, y no es el mismo
 *     texto por olvido.
 *  4. El CSS nuevo habla sólo en tokens y sobre el piso tipográfico.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { cleanup, render } = await import('@testing-library/react');
const { TeamView } = await import('./TeamView');
const { RunOutput } = await import('./coordination/TeamOutcome');
const { IdentityView } = await import('./IdentityView');
const { catalogs } = await import('./i18n');
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationLogEntryView, CoordinationRunTaskView, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

afterEach(() => cleanup());

const work: Work = { id: 'w1', brandId: 'b1', title: 'Ayulem', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Asistente'), member('writer', 'Redactor'), member('reviewer', 'Revisor')];
const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 1, tasksFailed: 0, tasksInFlight: 1, tasksPending: 0, ...patch,
});
const task = (id: string, title: string, patch: Partial<CoordinationRunTaskView> = {}): CoordinationRunTaskView =>
  ({ id, roleId: 'writer', spec: title, title, status: 'done', inPlan: true, dependsOn: [], attempts: 1, assignedMemberId: 'writer', ...patch });
const DEEP = ['borradores/propuesta-mayorista.pdf', 'borradores/identidad/IDENTIDAD.md', 'entregables/.versiones/propuesta (20260925).pdf'];
const log: CoordinationLogEntryView[] = [{
  id: 'd1', taskId: 't1', memberId: 'writer', status: 'reported', outcome: 'succeeded',
  promptPreview: 'Escribí la propuesta', summaryPreview: 'Lista.', files: DEEP,
  createdAt: '2026-09-25T10:00:00.000Z', startedAt: '2026-09-25T10:00:00.000Z', settledAt: '2026-09-25T11:00:00.000Z',
} as CoordinationLogEntryView];

const PATH_LIKE = /(?:^|[\s(])(?:\.{0,2}\/)?(?:borradores|entregables|identidad|assets|brand-kits)\/|[A-Za-z]:\\/;

describe('E5 (1): ninguna superficie muestra una ruta', () => {
  it('la tira, el detalle y lo producido', () => {
    ui.locale = 'es-AR';
    const view = render(createElement(TeamView, {
      work, team, roles: [], mode: 'advanced', busy: false, selectedMemberId: 'writer', onSelectMember: () => {},
      coordinationRun: run(), coordinationTasks: [task('t1', 'Propuesta para Vane', { audience: 'client' })], coordinationLog: log,
      coordinationReview: true, onSetCoordinationReview: () => {},
      formatTime: (v: string) => v, formatDate: (v: string) => v,
    }));
    expect(view.container.textContent).not.toMatch(PATH_LIKE);
    cleanup();
    const output = render(createElement(RunOutput, { run: run({ status: 'done', active: false }), team, log, formatTime: (v: string) => v, now: Date.parse('2026-09-25T12:00:00.000Z') }));
    expect(output.container.textContent).not.toMatch(PATH_LIKE);
    expect([...output.container.querySelectorAll('.coord-file')].map((f) => f.textContent)).toEqual(['propuesta-mayorista.pdf', 'IDENTIDAD.md', 'propuesta (20260925).pdf']);
  });

  it('Marca → Identidad', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(IdentityView, {
      brandName: 'Ayulem', busy: false, onApprove: () => {}, onAddFiles: () => {}, onExtract: () => {}, onRemoveFile: () => {},
      identity: {
        brandId: 'b1', state: 'draft', hasIdentityDoc: true, approved: null, changedSinceApproval: false, revokedAt: null,
        files: [{ id: 'identidad', name: 'IDENTIDAD.md', kind: 'reference', usable: true, bytes: 900, identityDoc: true }],
      },
    }));
    expect(container.textContent).not.toMatch(PATH_LIKE);
  });
});

describe('E5 (2): la marca "para el cliente" sólo en tareas para el cliente', () => {
  it('con todo interno no hay una sola', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(TeamView, {
      work, team, roles: [], mode: 'simple', busy: false, selectedMemberId: 'writer', onSelectMember: () => {},
      coordinationRun: run(), coordinationTasks: [task('t1', 'Análisis'), task('t2', 'Investigación', { audience: 'internal' })], coordinationLog: log,
      formatTime: (v: string) => v, formatDate: (v: string) => v,
    }));
    expect(container.querySelectorAll('.coord-task')).toHaveLength(2);
    expect(container.querySelectorAll('.coord-audience')).toHaveLength(0);
  });

  it('con una para el cliente, una sola marca en la tira', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(TeamView, {
      work, team, roles: [], mode: 'simple', busy: false, selectedMemberId: null, onSelectMember: () => {},
      coordinationRun: run(), coordinationTasks: [task('t1', 'Análisis'), task('t2', 'Propuesta', { audience: 'client' })],
      formatTime: (v: string) => v, formatDate: (v: string) => v,
    }));
    expect(container.querySelectorAll('.coord-tasks .coord-audience')).toHaveLength(1);
    expect(container.querySelector('.coord-task[data-audience="client"] .coord-task-title')!.textContent).toBe('Propuesta');
  });
});

describe('E5 (3): el copy nuevo, en los dos idiomas', () => {
  /** Coinciden a propósito: la misma palabra en los dos idiomas. */
  const SAME_IN_BOTH = new Set(['identity.kind.logo']);
  const prefixes = ['identity.', 'coord.audience.', 'coord.proposal.editAudience', 'team.advanced.review'];

  it('cada clave está en los dos, con texto propio', () => {
    const es = catalogs['es-AR'] as Record<string, string>;
    const en = catalogs['en-US'] as Record<string, string>;
    const keys = Object.keys(es).filter((key) => prefixes.some((p) => key.startsWith(p)));
    expect(keys.length).toBeGreaterThan(25);
    expect(Object.keys(en).filter((key) => prefixes.some((p) => key.startsWith(p))).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(es[key]!.trim().length, key).toBeGreaterThan(0);
      if (SAME_IN_BOTH.has(key)) expect(es[key], key).toBe(en[key]);
      else expect(es[key], `${key} tiene el mismo texto en los dos idiomas`).not.toBe(en[key]);
    }
  });
});

describe('E5 (4): el CSS nuevo', () => {
  const lines = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8').split(/\r?\n/);
  const rules = lines.filter((line) => {
    const brace = line.indexOf('{');
    return brace >= 0 && /\.(coord-audience|identity-[\w-]+|team-advanced-review[\w-]*|team-card-edit-audience)/.test(line.slice(0, brace));
  });

  it('existe, sin hex sueltos y sin --text-xs', () => {
    expect(rules.length).toBeGreaterThan(8);
    expect(rules.filter((rule) => /#[0-9a-fA-F]{3,8}\b/.test(rule))).toEqual([]);
    expect(rules.filter((rule) => rule.includes('--text-xs'))).toEqual([]);
  });
});
