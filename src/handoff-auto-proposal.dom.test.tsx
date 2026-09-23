import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationEvent, CoordinationGateView, CoordinationRunView, HandoffRequest, HandoffTaskBridgeResult, TeamMember, Work } from '../shared/contracts';

configure({ asyncUtilTimeout: 5_000 });

/**
 * H1: EL TRASPASO SE PUENTEA SOLO Y NUNCA SE PEGA EN EL CUADRO DE TEXTO.
 *
 * Uso real (2026-09-23): el Asistente escribió `para: paid-media` y Latte
 * mostró un aviso cuyo botón PRELLENABA el borrador del chat de Paid Media
 * para que la persona lo mandara a mano. Con la coordinación prendida, Latte
 * lo convierte en propuesta apenas lo detecta —sin clic— y lo que queda en
 * pantalla es una línea "Propuesta lista · Aprobar" que lleva a la tarjeta.
 * El borrador sólo sobrevive con la coordinación apagada (el motor responde
 * `reason: null`).
 */

const HANDOFF: HandoffRequest = {
  fileName: 'para-paid-media.md', roleId: 'paid-media', roleName: 'Paid Media',
  request: 'Pedido: guía para levantar las campañas de Meta Ads', known: true,
};

const state = vi.hoisted(() => ({
  emit: null as ((event: CoordinationEvent) => void) | null,
  workId: '',
  brandId: '',
  handoffs: [] as HandoffRequest[],
  result: null as HandoffTaskBridgeResult | null,
  bridgeCalls: 0,
  run: null as CoordinationRunView | null,
  gates: [] as CoordinationGateView[],
  team: [] as TeamMember[],
}));

const assistant = (): TeamMember => ({
  id: 'mem_asistente', workId: state.workId, roleId: 'assistant', roleName: 'Asistente', initial: 'A', avatar: null,
  runtime: 'codex', model: null, accountId: null, label: 'Codex', status: 'idle', tier: 'balanced',
  usage: EMPTY_USAGE, continuedFrom: null, createdAt: '2026-09-23T09:00:00.000Z', updatedAt: '2026-09-23T09:00:00.000Z',
});

const planningRun = (): CoordinationRunView => ({
  id: 'run_h1', workId: state.workId, status: 'planning', coordinatorMemberId: 'mem_asistente',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: false, suspendReason: null, request: null, active: true,
  createdAt: '2026-09-23T09:00:00.000Z', updatedAt: '2026-09-23T09:00:00.000Z', lastEventAt: '2026-09-23T09:00:00.000Z',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0,
});

const proposalGate = (): CoordinationGateView => ({
  id: 'proposal:run_h1', kind: 'proposal', runId: 'run_h1', createdAt: '2026-09-23T09:00:00.000Z',
  proposalJson: JSON.stringify({
    plan: [{ roleId: 'paid-media', spec: HANDOFF.request }], estimatedDispatches: 3,
    membersToHire: [{ roleId: 'paid-media', why: 'Nadie hace paid-media todavía' }], rationale: HANDOFF.request,
  }),
});

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  const listWorks = async (brandId: string): Promise<Work[]> => {
    const works = await actual.browserAPI.listWorks(brandId);
    state.brandId = brandId;
    if (works[0]) state.workId = works[0].id;
    return works;
  };
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
      listWorks,
      listTeam: async () => state.team,
      listHandoffs: async () => state.handoffs,
      dismissHandoff: async () => undefined,
      acceptHandoffAsTask: async () => {
        state.bridgeCalls += 1;
        const result = state.result!;
        if (result.outcome === 'proposed') {
          // Lo que hace el motor: consume el archivo y deja el run `planning`.
          state.handoffs = [];
          state.run = planningRun();
          state.gates = [proposalGate()];
        }
        return result;
      },
      listActiveCoordinationRuns: async () => [],
      getCoordinationRun: async () => state.run,
      listCoordinationGates: async () => state.gates,
      listCoordinationLog: async () => [],
      listCoordinationHires: async () => [],
      listCoordinationMessages: async () => [],
      listOpenCoordinationAsks: async () => [],
      coordinationRuntimeSupport: async () => [],
      markCoordinationSeen: async () => new Date().toISOString(),
      onCoordinationEvent: (cb: (event: CoordinationEvent) => void) => { state.emit = cb; return () => { state.emit = null; }; },
    },
  };
});

const { App } = await import('./App');
const { I18nProvider } = await import('./i18n');

function reset(result: HandoffTaskBridgeResult): void {
  cleanup();
  state.emit = null;
  state.handoffs = [HANDOFF];
  state.result = result;
  state.bridgeCalls = 0;
  state.run = null;
  state.gates = [];
  state.team = [];
}

async function mounted(): Promise<HTMLElement> {
  const { container } = render(<I18nProvider><App /></I18nProvider>);
  await screen.findByRole('button', { name: 'Lanzamiento primavera' });
  await waitFor(() => { expect(state.workId).not.toBe(''); });
  state.team = [assistant()];
  return container;
}

/** Ningún cuadro de texto de la app tiene el pedido pegado. */
function noDraftAnywhere(container: HTMLElement): void {
  for (const box of container.querySelectorAll('textarea')) expect(box.value).not.toContain('Meta Ads');
}

describe('H1: con la coordinación prendida el traspaso se vuelve propuesta sin clic', () => {
  it('se puentea solo, no prellena nada y deja una línea que lleva a la tarjeta de propuesta', async () => {
    reset({ bridged: true, task: null, outcome: 'proposed', reason: null });
    const container = await mounted();

    // Sin un solo clic: lo detectó y lo puenteó.
    await waitFor(() => { expect(state.bridgeCalls).toBe(1); });
    // El motor avisa (touch → evento) y la pantalla se refresca.
    await waitFor(() => { expect(state.emit).not.toBeNull(); });
    act(() => { state.emit!({ brandId: state.brandId, workId: state.workId, runId: 'run_h1' }); });

    const line = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('.doc-banner.handoff-proposed');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(line.textContent).toContain('Propuesta lista');
    expect(line.textContent).toContain('Paid Media');
    noDraftAnywhere(container);
    // El aviso viejo, con su botón de "abrir conversación", no está.
    expect(container.querySelector('.doc-banner.handoff:not(.handoff-proposed)')).toBeNull();

    fireEvent.click(line.querySelector('button')!);
    await waitFor(() => {
      const title = container.querySelector('.coord-card-title');
      expect(title?.textContent).toBe('Propuesta del equipo');
    });
    noDraftAnywhere(container);
  });

  it('cuando no se puede puentear, el aviso dice por qué y NO ofrece el borrador', async () => {
    reset({ bridged: false, task: null, outcome: null, reason: 'RUN_ALREADY_ACTIVE' });
    const container = await mounted();

    await waitFor(() => { expect(state.bridgeCalls).toBe(1); });
    const banner = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('.doc-banner.handoff');
      expect(found).not.toBeNull();
      // M3: el motivo, en palabras; nunca el código del motor.
      expect(found!.textContent).toContain('Ya hay una propuesta pendiente en este trabajo');
      expect(found!.textContent).not.toContain('RUN_ALREADY_ACTIVE');
      return found!;
    });
    // El único camino adelante es reintentar el puente o descartar.
    const primary = banner.querySelector<HTMLButtonElement>('button.primary');
    expect(primary?.textContent).not.toMatch(/conversaci/i);
    noDraftAnywhere(container);
  });

  it('con la coordinación apagada (motivo nulo) el aviso de siempre vuelve, con su borrador a pedido', async () => {
    reset({ bridged: false, task: null, outcome: null, reason: null });
    const container = await mounted();

    await waitFor(() => { expect(state.bridgeCalls).toBe(1); });
    const banner = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('.doc-banner.handoff');
      expect(found).not.toBeNull();
      return found!;
    });
    // Nada se prellenó solo: el borrador es a pedido, como antes.
    noDraftAnywhere(container);
    expect(banner.querySelector('button.primary')).not.toBeNull();
  });
});
