import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * B1.3: LA CONFIGURACION DEL EQUIPO Y EL ESTADO DE CADA MIEMBRO, EN EL PANEL.
 *
 * Estos casos salieron de `DecisionsView.dom.test.tsx`. El tope de despachos,
 * la autoridad de coordinacion, el nombre del coordinador y las dos politicas
 * de inyeccion por miembro no son decisiones de marca: son como trabaja ESTE
 * equipo, y viven al pie del panel del equipo, en modo avanzado. Las
 * aserciones son las mismas; lo que cambio es la casa y las clases.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render, screen } = await import('@testing-library/react');
const { TeamView } = await import('./TeamView');
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationDegradedReason, CoordinationMemberSupport, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campana.',
  folder: null, updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const member = (patch: Partial<TeamMember> = {}): TeamMember => ({
  id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E', avatar: null, runtime: 'opencode', model: null,
  accountId: null, label: 'OpenCode', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '', ...patch,
});
const support = (patch: Partial<CoordinationMemberSupport> = {}): CoordinationMemberSupport => ({
  memberId: 'm1', canPropose: true, memoryInjected: true, reason: null, runtimeConfirmed: true, runtimeReportsInjection: true, ...patch,
});
const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

const base: TeamViewProps = {
  work: work(), team: [member()], roles: [], mode: 'advanced', busy: false,
  selectedMemberId: null, onSelectMember: () => {},
};

beforeEach(() => { ui.locale = 'es-AR'; });

function renderAdvanced(locale: 'es-AR' | 'en-US', props: Partial<TeamViewProps> = {}) {
  ui.locale = locale;
  return render(createElement(TeamView, { ...base, ...props }));
}

/**
 * B1.3: EL BLOQUE AVANZADO SOLO EXISTE EN MODO AVANZADO.
 *
 * En simple la persona pide en el chat y aprueba en el chat: un tope de
 * despachos y un selector de autoridad ahi no la ayudan a decidir nada, le
 * compiten a la conversacion.
 */
describe('el <details> Avanzado', () => {
  it('no se renderiza en modo simple', () => {
    const { container } = renderAdvanced('es-AR', { mode: 'simple', coordinationAuthority: 'manual' });
    expect(container.querySelector('.team-advanced')).toBeNull();
  });

  it('se renderiza en modo avanzado, plegado', () => {
    const { container } = renderAdvanced('es-AR', { coordinationAuthority: 'manual' });
    const details = container.querySelector('details.team-advanced') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
  });

  it('sin Trabajo abierto no hay equipo que configurar', () => {
    const { container } = renderAdvanced('es-AR', { work: null, coordinationAuthority: 'manual' });
    expect(container.querySelector('.team-advanced')).toBeNull();
  });
});

/**
 * B1.3: LA AUTORIDAD SE PUEDE ESCRIBIR.
 *
 * `setCoordinationAuthority` existia en la IPC y Decisiones solo la LEIA: el
 * control que la cambia no estaba en ninguna pantalla.
 */
describe('el selector de autoridad', () => {
  it('cambia la autoridad por el verbo real, sin reinventarlo', () => {
    const onSetCoordinationAuthority = vi.fn();
    const { container } = renderAdvanced('es-AR', { coordinationAuthority: 'manual', onSetCoordinationAuthority });
    const select = container.querySelector('select.team-advanced-authority') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'plan' } });
    expect(onSetCoordinationAuthority).toHaveBeenCalledWith('plan');
  });

  it('sin handler no se ofrece un control que no guarda nada: se lee', () => {
    const { container } = renderAdvanced('es-AR', { coordinationAuthority: 'plan' });
    expect(container.querySelector('select.team-advanced-authority')).toBeNull();
    expect(container.querySelector('.team-advanced-authority')!.textContent).toContain('Por plan');
  });
});

/**
 * B1.3: EL ESTADO DE CADA MIEMBRO, EN UNA PALABRA AL LADO DEL NOMBRE.
 *
 * La frase larga no desaparece: se mueve al `title`. Corto no es lo mismo que
 * mudo.
 */
describe('el estado compacto por miembro', () => {
  const wired = (row: CoordinationMemberSupport) => renderAdvanced('es-AR', {
    coordinationRun: run(), coordinationSupport: [row],
    coordinationHires: [{ memberId: 'm1', roleId: 'strategist', roleName: 'Estratega', hiredAt: '2026-09-01T00:00:00.000Z' }],
  });
  const badge = (container: HTMLElement) => container.querySelector('.team-member-state') as HTMLElement;

  it('confirmado por el runtime: "conectado"', () => {
    const { container } = wired(support({ runtimeConfirmed: true }));
    expect(badge(container).getAttribute('data-state')).toBe('connected');
    expect(badge(container).textContent).toBe('conectado');
  });

  it('pedido y todavia sin confirmar: "arrancando", nunca "conectado"', () => {
    const { container } = wired(support({ runtimeConfirmed: false, runtimeReportsInjection: true }));
    expect(badge(container).getAttribute('data-state')).toBe('starting');
    expect(badge(container).title).toContain('todavia no confirmo'.replace('todavia', 'todavía').replace('confirmo', 'confirmó'));
  });

  it('un runtime que no puede informar NUNCA no dice "todavia": dice que no informa', () => {
    const { container } = wired(support({ runtimeConfirmed: false, runtimeReportsInjection: false }));
    expect(badge(container).getAttribute('data-state')).toBe('unconfirmed');
    expect(badge(container).title).toContain('no informa la conexión');
  });

  it('degradado: se nombra el motivo, corto al lado del nombre y entero en el title', () => {
    const { container } = wired(support({ canPropose: false, reason: 'codex_run_cap' }));
    expect(badge(container).getAttribute('data-state')).toBe('uncoordinated');
    expect(badge(container).textContent).toContain('sin coordinar');
    expect(badge(container).textContent).toContain('tope de Codex por equipo');
    expect(badge(container).title).toBe('Este equipo llegó al tope de miembros de Codex coordinados por corrida: despacha en modo manual.');
  });

  it('cada uno de los trece motivos trae su propia frase corta, sin repetirse', () => {
    const reasons: CoordinationDegradedReason[] = [
      'claude_below_floor', 'codex_run_cap', 'codex_global_cap', 'codex_process_ceiling',
      'opencode_run_cap', 'opencode_global_cap', 'grok_run_cap', 'grok_global_cap', 'hermes_run_cap', 'hermes_global_cap',
      'engram_not_installed', 'runtime_refused_injection', 'coordination_server_unavailable',
    ];
    const labels = reasons.map((reason) => {
      const { container, unmount } = wired(support({ canPropose: false, reason }));
      const text = badge(container).textContent ?? '';
      unmount();
      return text;
    });
    expect(new Set(labels).size).toBe(reasons.length);
  });

  it('sin `coordinationSupport` no se inventa un estado', () => {
    const { container } = renderAdvanced('es-AR', {
      coordinationRun: run(),
      coordinationHires: [{ memberId: 'm1', roleId: 'strategist', roleName: 'Estratega', hiredAt: '2026-09-01T00:00:00.000Z' }],
    });
    expect(container.querySelector('.team-member-state')).toBeNull();
  });
});

describe('the coordination settings summary (additive, Phase 2 of autonomous-coordination)', () => {
  it('sin autoridad cableada no se dibuja un selector de algo que nadie leyó', () => {
    const { container } = renderAdvanced('es-AR');
    const section = container.querySelector('.team-advanced')!;
    expect(section).not.toBeNull();
    expect(section.querySelector('.team-advanced-authority')).toBeNull();
    // Lo que SÍ se dice sin nada cableado es lo honesto de cada campo: un
    // presupuesto sin configurar y un coordinador sin asignar son hechos, no
    // huecos.
    expect(section.querySelector('.team-advanced-budget')).not.toBeNull();
    expect(section.querySelector('.team-advanced-coordinator')).not.toBeNull();
  });

  it('renders a read-only summary of authority, budget and coordinator grant, offering no control, without touching the other two settings', () => {
    const { container } = renderAdvanced('es-AR', {
      coordinationAuthority: 'auto',
      coordinationBudget: { state: 'set', budget: { maxDispatches: 10, unlimitedConfirmedAt: null } },
      coordinatorGrant: 'm1',
      team: [member({ id: 'm1', roleId: 'strategist', roleName: 'Estratega' })],
    });
    const section = container.querySelector('.team-advanced');
    expect(section).not.toBeNull();
    expect(section!.querySelector('select')).toBeNull();
    expect(section!.querySelector('button')).toBeNull();
    expect(section!.textContent).toContain('Automático');
    expect(section!.textContent).toContain('10');
    expect(section!.textContent).toContain('Estratega');
  });

  it('shows the unset/no-coordinator state honestly instead of inventing a value', () => {
    const { container } = renderAdvanced('es-AR', {
      coordinationAuthority: 'manual',
      coordinationBudget: { state: 'unset' },
      coordinatorGrant: null,
    });
    const section = container.querySelector('.team-advanced');
    expect(section!.textContent).toContain('Sin presupuesto configurado');
    expect(section!.textContent).toContain('Sin coordinador asignado');
  });

  // Crítico 8, nivel Trabajo: `invalid` llegaba como `null` y se leía "sin
  // presupuesto configurado" — que manda a la persona a buscar un campo vacío
  // que en realidad tiene bytes rotos adentro, mientras cada despacho se
  // deniega contra esos mismos bytes.
  it('un presupuesto ILEGIBLE se dice con su propia frase, nunca como "sin presupuesto configurado"', () => {
    const { container } = renderAdvanced('es-AR', {
      coordinationAuthority: 'manual',
      coordinationBudget: { state: 'invalid' },
      coordinatorGrant: null,
    });
    const line = container.querySelector('.team-advanced-budget')!;
    expect(line).not.toBeNull();
    expect(line.textContent).not.toContain('Sin presupuesto configurado');
    expect(line.textContent).toContain('no se pudo leer');
  });

  it('el mismo presupuesto ilegible en inglés, sin nada en castellano', () => {
    const { container } = renderAdvanced('en-US', {
      coordinationAuthority: 'manual',
      coordinationBudget: { state: 'invalid' },
      coordinatorGrant: null,
    });
    const line = container.querySelector('.team-advanced-budget')!;
    expect(line.textContent).toContain('could not be read');
    expect(line.textContent).not.toContain('no se pudo leer');
  });

  it('renders the same summary in English, with nothing left in Spanish', () => {
    const { container } = renderAdvanced('en-US', {
      coordinationAuthority: 'plan',
      coordinationBudget: { state: 'set', budget: { maxDispatches: null, unlimitedConfirmedAt: '2026-01-01T00:00:00.000Z' } },
      coordinatorGrant: null,
    });
    const section = container.querySelector('.team-advanced');
    expect(section!.textContent).toContain('By plan');
    expect(section!.textContent).toContain('No dispatch limit');
    expect(section!.textContent).toContain('No coordinator assigned');
    expect(section!.textContent).not.toContain('Sin');
  });
});


/**
 * Degraded badges (additive, autonomous-coordination Phase 7 task 7.9):
 * per-member coordination/memory status from `coordinationRuntimeSupport`.
 * Coordination and memory are two INDEPENDENT injection policies (task
 * 6.29) — a coordination-degraded member still shows memory as available,
 * and vice versa. Never silent, never a capability presented as working.
 */
describe('coordination support badges (additive, autonomous-coordination Phase 7 task 7.9)', () => {
  it('does not render when the caller has not wired support state', () => {
    const { container } = renderAdvanced('es-AR');
    expect(container.querySelector('.team-support')).toBeNull();
  });

  it('renders nothing for an empty list — zero rows is never a zero', () => {
    const { container } = renderAdvanced('es-AR', { coordinationSupport: [] });
    expect(container.querySelector('.team-support')).toBeNull();
  });

  it('renders one row per member, resolved to its display name — never a raw id', () => {
    const { container } = renderAdvanced('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1' })],
    });
    const row = container.querySelector('.team-support-row')!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('Estratega');
  });

  it('a coordination-degraded member still shows memory as available — the two policies are independent', () => {
    const { container } = renderAdvanced('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: false, reason: 'codex_run_cap', memoryInjected: true })],
    });
    const row = container.querySelector('.team-support-row')!;
    expect(row.textContent).toContain('tope de miembros de Codex coordinados por corrida');
    expect(row.textContent).toContain('Memoria disponible');
  });

  it('vice versa: a memory-degraded member (engram missing) still shows coordination as unrestricted', () => {
    const { container } = renderAdvanced('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: 'engram_not_installed', memoryInjected: false })],
    });
    const row = container.querySelector('.team-support-row')!;
    expect(row.textContent).toContain('Falta el binario de Engram');
    expect(row.textContent).toContain('Sin restricciones para coordinar');
  });

  it('each of the six degraded reasons renders its own distinct, honest sentence', () => {
    const reasons: Array<[CoordinationDegradedReason, string]> = [
      ['claude_below_floor', 'anterior a la mínima soportada'],
      ['codex_run_cap', 'tope de miembros de Codex coordinados por corrida'],
      ['codex_global_cap', 'tope de procesos de Codex coordinados en toda la app'],
      ['codex_process_ceiling', 'tope total de procesos de Codex en toda la app'],
      ['opencode_run_cap', 'tope de miembros de OpenCode coordinados por corrida'],
      ['opencode_global_cap', 'tope de procesos de OpenCode coordinados en toda la app'],
      ['grok_run_cap', 'tope de miembros de Grok coordinados por corrida'],
      ['grok_global_cap', 'tope de procesos de Grok coordinados en toda la app'],
      ['hermes_run_cap', 'tope de miembros de Hermes coordinados por corrida'],
      ['hermes_global_cap', 'tope de procesos de Hermes coordinados en toda la app'],
      ['engram_not_installed', 'Falta el binario de Engram'],
    ];
    for (const [reason, phrase] of reasons) {
      const { container, unmount } = renderAdvanced('es-AR', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', canPropose: false, reason, memoryInjected: reason !== 'engram_not_installed' })],
      });
      expect(container.querySelector('.team-support-row')!.textContent, reason).toContain(phrase);
      unmount();
    }
  });

  it('a member with neither degradation shows both as available, never silent', () => {
    const { container } = renderAdvanced('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: null, memoryInjected: true })],
    });
    const row = container.querySelector('.team-support-row')!;
    expect(row.textContent).toContain('Sin restricciones para coordinar');
    expect(row.textContent).toContain('Memoria disponible');
  });

  it('task 8.1: canPropose false with NO reason (the coordination feature flag itself is off) is never rendered as "available" — that would be a silent failure', () => {
    const { container } = renderAdvanced('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: false, reason: null, memoryInjected: true })],
    });
    const row = container.querySelector('.team-support-row')!;
    expect(row.textContent).not.toContain('Sin restricciones para coordinar');
    expect(row.textContent).toContain('desactivada en esta instalación');
    // Memory is unaffected -- the two policies stay independent even in this new state.
    expect(row.textContent).toContain('Memoria disponible');
  });

  // Crítico 7 (c): hasta acá "sin restricciones para coordinar" se mostraba
  // igual para un miembro cuyo runtime confirmó la inyección y para uno cuyo
  // runtime nunca pudo decir nada. Latte escribió el archivo: eso es lo único
  // que se sabía, y se leía como si el servidor estuviera andando.
  it('un reclamo SIN confirmar del runtime no se muestra como conectado', () => {
    const { container } = renderAdvanced('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: null, memoryInjected: true, runtimeConfirmed: false })],
    });
    const row = container.querySelector('.team-support-row')!;
    expect(row.textContent).not.toContain('Sin restricciones para coordinar');
    expect(row.textContent).toContain('El runtime todavía no confirmó');
    // La memoria del mismo miembro tampoco se puede afirmar: la confirmación
    // es una sola, y viene del mismo reporte.
    expect(row.textContent).not.toContain('Memoria disponible');
    expect(row.textContent).toContain('sin confirmar');
  });

  it('el mismo estado sin confirmar, en inglés, sin nada en castellano', () => {
    const { container } = renderAdvanced('en-US', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: null, memoryInjected: true, runtimeConfirmed: false })],
    });
    expect(container.textContent).toContain('The runtime has not confirmed');
    expect(container.textContent).not.toContain('El runtime todavía no confirmó');
  });

  /**
   * Los TRES estados de la confirmación, que hasta acá eran dos. "Sin
   * confirmar" promete que la confirmación puede llegar; para un runtime que
   * no tiene forma de informarla nunca —OpenCode: su servidor no expone
   * ningún endpoint que liste servidores MCP— esa frase deja a la persona
   * esperando algo que no va a pasar. `runtimeReportsInjection` separa
   * "todavía no" de "nunca", y ninguno de los dos habilita decir "conectado".
   */
  describe('confirmado / sin confirmar / no informa: los tres estados, nunca dos', () => {
    const notReporting = { canPropose: true, reason: null, memoryInjected: true, runtimeConfirmed: false, runtimeReportsInjection: false } as const;

    it('CONFIRMADO: el runtime habló, y recién ahí se afirma que anda', () => {
      const { container } = renderAdvanced('es-AR', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: null, memoryInjected: true, runtimeConfirmed: true, runtimeReportsInjection: true })],
      });
      const row = container.querySelector('.team-support-row')!;
      expect(row.textContent).toContain('Sin restricciones para coordinar');
      expect(row.textContent).toContain('Memoria disponible');
      expect(row.textContent).not.toContain('no informa la conexión');
    });

    it('SIN CONFIRMAR: el runtime puede hablar y todavía no lo hizo', () => {
      const { container } = renderAdvanced('es-AR', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: null, memoryInjected: true, runtimeConfirmed: false, runtimeReportsInjection: true })],
      });
      const row = container.querySelector('.team-support-row')!;
      expect(row.textContent).toContain('El runtime todavía no confirmó');
      expect(row.textContent).toContain('sin confirmar');
      expect(row.textContent).not.toContain('no informa la conexión');
      expect(row.textContent).not.toContain('Sin restricciones para coordinar');
      expect(row.textContent).not.toContain('Memoria disponible');
    });

    it('NO INFORMA: el runtime no tiene forma de confirmar, y se dice así — nunca "todavía"', () => {
      const { container } = renderAdvanced('es-AR', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', ...notReporting })],
      });
      const row = container.querySelector('.team-support-row')!;
      const coordination = row.querySelector('.team-support-coordination')!.textContent ?? '';
      const memory = row.querySelector('.team-support-memory')!.textContent ?? '';
      expect(coordination).toContain('Este runtime no informa la conexión');
      expect(memory).toContain('no informa la conexión');
      // Ni la promesa de que va a llegar...
      expect(row.textContent).not.toContain('todavía no confirmó');
      // ...ni la afirmación de que anda.
      expect(row.textContent).not.toContain('Sin restricciones para coordinar');
      expect(row.textContent).not.toContain('Memoria disponible');
    });

    it('NO INFORMA, en inglés, sin nada en castellano', () => {
      const { container } = renderAdvanced('en-US', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', ...notReporting })],
      });
      expect(container.textContent).toContain('This runtime does not report the connection');
      expect(container.textContent).toContain('Memory requested; this runtime does not report the connection');
      expect(container.textContent).not.toContain('no informa la conexión');
      expect(container.textContent).not.toContain('has not confirmed');
    });

    it('un runtime que no informa PERO ya está degradado dice su degradación, no la falta de reporte', () => {
      // `canPropose:false` gana: la razón concreta explica más que "no
      // informa", y decir las dos a la vez sería ruido.
      const { container } = renderAdvanced('es-AR', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', canPropose: false, reason: 'codex_process_ceiling', memoryInjected: false, runtimeConfirmed: false, runtimeReportsInjection: false })],
      });
      const row = container.querySelector('.team-support-row')!;
      expect(row.textContent).toContain('tope total de procesos de Codex');
      expect(row.textContent).not.toContain('Este runtime no informa la conexión');
    });
  });

  it('renders the same badges in English, with nothing left in Spanish', () => {
    const { container } = renderAdvanced('en-US', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: false, reason: 'engram_not_installed', memoryInjected: false })],
    });
    expect(container.textContent).toContain('The Engram binary is missing');
    expect(container.textContent).not.toContain('Falta el binario de Engram');
  });
});
