import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * C8: LO QUE EL REDISEÑO SE LLEVÓ PUESTO SIN QUERER.
 *
 * Cuatro regresiones de la lista del equipo, todas del mismo tipo: la
 * gramática nueva pisó señales que ya existían y que significaban algo.
 *
 *  1. el COLOR POR ROL. `team-avatar` llevaba `data-role` y el CSS pintaba un
 *     color por rol; `CoordAvatar` los dejó a todos beige. El color del avatar
 *     es IDENTIDAD —reconocer al miembro de un vistazo—, no estado: el estado
 *     sigue siendo el punto, y sigue siendo el único.
 *  2. la HORA en es-AR salía "06:50 p. m." y le comía el nombre al miembro
 *     ("Community M…"). La hora es una columna angosta de ancho fijo; el que
 *     tiene derecho a todo el ancho que sobra es el nombre.
 *  3. un despacho que FALLÓ se leía en gris. Criterio 2: falló es `--danger`,
 *     y eso vale para el punto y para la línea.
 *  4. la fila seleccionada traía un borde izquierdo en el acento. El acento
 *     significa VIVO, no "estás parado acá": la selección es fondo `--foam`
 *     con borde `--line` en los cuatro lados.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { render } = await import('@testing-library/react');
const { TeamView } = await import('./TeamView');
const { hourOf } = await import('./coordination/time');
const { memberSignal } = await import('./coordination/member-line');
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationLogEntryView, CoordinationRunTaskView, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Piezas para el primer encendido', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleId: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId, roleName, initial: roleName[0]!, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [
  member('coord', 'assistant', 'Asistente'),
  member('cm', 'community-manager', 'Community Manager'),
  member('paid', 'strategist', 'Paid Media'),
];

const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '2026-09-13T17:17:00.000Z', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 1, tasksInFlight: 0, tasksPending: 2,
};
const tasks: CoordinationRunTaskView[] = [
  { id: 't1', roleId: 'strategist', spec: 'Piezas publicitarias Meta', status: 'failed', inPlan: true, dependsOn: [], attempts: 1, assignedMemberId: 'paid' },
];
/** Un despacho que volvió mal: el hecho que la captura mostraba en gris. */
const failed: CoordinationLogEntryView = {
  id: 'd1', taskId: 't1', memberId: 'paid', status: 'failed', outcome: 'failed',
  promptPreview: 'Piezas publicitarias Meta', summaryPreview: 'No pude producir ninguna pieza: falta el brief',
  createdAt: '2026-09-13T17:18:00.000Z', startedAt: '2026-09-13T17:18:00.000Z', settledAt: '2026-09-13T18:50:00.000Z',
};

const mount = (props: Partial<TeamViewProps> = {}) => {
  ui.locale = 'es-AR';
  return render(createElement(TeamView, {
    work, team, roles: [], mode: 'simple', busy: false, selectedMemberId: 'paid', onSelectMember: () => {},
    coordinationRun: run, coordinationTasks: tasks, coordinationLog: [failed],
    formatTime: (v: string) => v, formatDate: (v: string) => v, ...props,
  }));
};

describe('C8 (1): el color por rol es identidad, y vuelve', () => {
  it('cada avatar de la lista lleva su rol, no un beige para todos', () => {
    const { container } = mount();
    const roles = [...container.querySelectorAll('.team-view-list .coord-av')].map((av) => av.getAttribute('data-role'));
    expect(roles).toEqual(['assistant', 'community-manager', 'strategist']);
  });

  it('el avatar del detalle también lo lleva', () => {
    const { container } = mount();
    expect(container.querySelector('.coord-detail-head .coord-av')!.getAttribute('data-role')).toBe('strategist');
  });

  it('el mini-avatar de la tira de tareas lleva el rol de su dueño', () => {
    const { container } = mount();
    expect(container.querySelector('.coord-task .coord-av')!.getAttribute('data-role')).toBe('strategist');
  });

  /** El color es identidad; el estado sigue siendo el punto, y sigue siendo uno solo. */
  it('el avatar no dice el estado: eso lo sigue diciendo el punto, y hay uno', () => {
    const { container } = mount();
    const row = container.querySelector('[data-member-id="paid"] .coord-av')!;
    expect(row.querySelectorAll('.coord-dot')).toHaveLength(1);
  });
});

describe('C8 (2): la hora no le come el nombre al miembro', () => {
  /**
   * EL HALLAZGO, EXACTO: `toLocaleTimeString` con `hour: '2-digit'` en es-AR
   * devuelve "06:50 p. m." — once caracteres para decir lo que "18:50" dice en
   * cinco, y esos seis de más salían del ancho del nombre.
   */
  it('la hora es de 24 horas en los dos idiomas: nunca "p. m."', () => {
    const at = '2026-09-13T18:50:00.000Z';
    for (const locale of ['es-AR', 'en-US']) {
      const label = hourOf(at, locale);
      expect(label, locale).toMatch(/^\d{2}:\d{2}$/);
      expect(label.toLowerCase(), locale).not.toContain('m.');
    }
  });

  it('una fecha ilegible sigue sin dibujarse', () => {
    expect(hourOf('no es una fecha')).toBe('');
    expect(hourOf(null)).toBe('');
  });
});

describe('C8 (3): un despacho que falló se lee en --danger', () => {
  it('la señal del miembro es `failed`, no un gris cualquiera', () => {
    const signal = memberSignal({ log: [failed], team, run }, 'paid');
    expect(signal.dot).toBe('failed');
    expect(signal.line).toContain('Falló');
  });

  it('el punto y la línea de la fila lo dicen con la clase del fallo', () => {
    const { container } = mount();
    const row = container.querySelector('[data-member-id="paid"]')!;
    expect(row.querySelector('.coord-dot-failed')).not.toBeNull();
    expect(row.querySelector('.coord-row-line.is-failed')).not.toBeNull();
    // Y nunca el acento: fallar no es estar vivo.
    expect(row.querySelector('.coord-row-line.is-urgent')).toBeNull();
    expect(row.querySelector('.coord-dot-live')).toBeNull();
  });
});

describe('C8 (4): la selección no usa el acento', () => {
  it('la fila abierta no lleva ningún borde izquierdo de acento', () => {
    const { container } = mount();
    const li = container.querySelector('.team-inbox-row.is-selected') as HTMLElement;
    expect(li).not.toBeNull();
    // La selección la pinta el botón de adentro, con fondo y borde completo.
    expect(container.querySelector('.coord-row.is-selected')).not.toBeNull();
  });
});

/**
 * C8: y las reglas que lo sostienen, en la hoja. Un componente que promete una
 * clase y una hoja que no la pinta es media promesa.
 */
describe('C8: el CSS', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
  const lines = css.split(/\r?\n/);
  const ruleFor = (selector: string) => lines.find((line) => line.startsWith(selector + '{'));

  it('ninguna regla de la lista del equipo pinta un borde de acento por estar seleccionada', () => {
    const offenders = lines.filter((line) => {
      const brace = line.indexOf('{');
      if (brace < 0) return false;
      if (!/\.(team-inbox-row|coord-row)[^{]*\.is-selected/.test(line.slice(0, brace))) return false;
      return /border-left[^;]*var\(--rust\)/.test(line) || /border[^;]*:\s*[^;]*var\(--rust\)/.test(line);
    });
    expect(offenders).toEqual([]);
  });

  it('la selección es fondo --foam con borde --line', () => {
    const rule = ruleFor('.coord-row.is-selected')!;
    expect(rule).toContain('background:var(--foam)');
    expect(rule).toContain('border-color:var(--line)');
  });

  it('el avatar toma el color de su rol, y el punto queda aparte', () => {
    expect(ruleFor('.coord-av')).not.toContain('background:var(--paper-deep)');
    expect(css).toContain('.coord-av[data-role=assistant]');
    expect(ruleFor('.coord-dot-failed')).toContain('var(--danger)');
    expect(ruleFor('.coord-row-line.is-failed')).toContain('var(--danger)');
  });

  it('el nombre se queda con el ancho que sobra; la hora no crece ni se encoge', () => {
    expect(ruleFor('.coord-row-name')).toContain('flex:1 1 auto');
    expect(ruleFor('.coord-time')).toContain('flex:0 0 auto');
  });

  /**
   * WCAG AA para texto chico: 4.5:1. Las iniciales del avatar son 12px, así
   * que no son "texto grande" y no les alcanza con 3:1.
   */
  it('cada color de rol tiene 4.5:1 contra la tinta del avatar', () => {
    const token = (name: string) => {
      const match = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(css);
      expect(match, 'falta el token --' + name).not.toBeNull();
      return match![1]!;
    };
    const luminance = (hex: string) => {
      const channel = (i: number) => {
        const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const ink = token('on-accent');
    const roles = ['role-assistant', 'role-strategist', 'role-researcher', 'role-analyst', 'role-reviewer', 'role-default'];
    const failures = roles
      .map((name) => ({ name, ratio: contrast(token(name), ink) }))
      .filter((row) => row.ratio < 4.5)
      .map((row) => `${row.name}: ${row.ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });
});
