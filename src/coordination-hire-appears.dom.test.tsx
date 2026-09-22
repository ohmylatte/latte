import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationEvent, TeamMember, Work } from '../shared/contracts';

configure({ asyncUtilTimeout: 5_000 });

/**
 * B5.2: EL QUE CONTRATA EL MOTOR APARECE, sin que nadie toque nada.
 *
 * En la prueba real el motor contrató a paid-media, lo spawneó y le mandó su
 * tarea. En la pantalla no pasó NADA: `loadTeam` sólo corre al cambiar de
 * Trabajo y después de una acción de la persona, y las cinco lecturas que
 * `refreshWork` dispara por cada evento de coordinación no incluyen
 * `listTeam`. La persona se quedó con un miembro trabajando al que no tenía
 * pestaña ni forma de abrir — "todo ocurrió no sé dónde".
 *
 * Se entra por `App` entero, con la misma `browser-api` falsa que usan los
 * otros tests de contenedor: el punto es justamente el cableado entre el hook
 * (que sabe si el evento es de este Trabajo) y el contenedor (que es el único
 * que tiene el equipo).
 */

const state = vi.hoisted(() => ({
  /** El callback que `useCoordination` registró en el canal de eventos. */
  emit: null as ((event: CoordinationEvent) => void) | null,
  listTeamCalls: [] as string[],
  team: [] as TeamMember[],
  workId: '',
  brandId: '',
}));

const member = (id: string, roleName: string): TeamMember => ({
  id, workId: state.workId, roleId: 'paid-media', roleName, initial: 'P', avatar: null,
  runtime: 'codex', model: null, accountId: null, label: 'Codex', status: 'working', tier: 'balanced',
  usage: EMPTY_USAGE, continuedFrom: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
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
      listTeam: async (workId: string) => { state.listTeamCalls.push(workId); return state.team; },
      listActiveCoordinationRuns: async () => [],
      getCoordinationRun: async () => null,
      listCoordinationGates: async () => [],
      listCoordinationLog: async () => [],
      listCoordinationHires: async () => [],
      listCoordinationMessages: async () => [],
      listOpenCoordinationAsks: async () => [],
      coordinationRuntimeSupport: async () => [],
      onCoordinationEvent: (cb: (event: CoordinationEvent) => void) => { state.emit = cb; return () => { state.emit = null; }; },
    },
  };
});

const { App } = await import('./App');
const { I18nProvider } = await import('./i18n');

/** Monta la app, espera a que el Trabajo autoseleccionado haya cargado su equipo y deja el contador en cero. */
async function mounted(): Promise<void> {
  cleanup(); // cada test monta su propia App: sin esto el DOM del anterior sigue en pantalla
  state.emit = null;
  state.listTeamCalls = [];
  state.team = [];
  render(<I18nProvider><App /></I18nProvider>);
  await screen.findByRole('button', { name: 'Lanzamiento primavera' });
  await waitFor(() => { expect(state.workId).not.toBe(''); });
  await waitFor(() => { expect(state.listTeamCalls).toContain(state.workId); });
  await waitFor(() => { expect(state.emit).not.toBeNull(); });
  state.listTeamCalls = [];
}

describe('B5.2: una contratación del motor aparece en el equipo sin acción de la persona', () => {
  it('un evento de coordinación del Trabajo abierto recarga el equipo y dibuja la pestaña del nuevo', async () => {
    await mounted();
    // El motor contrató y spawneó: la próxima lectura del equipo lo trae.
    state.team = [member('mem_paid_media', 'Pauta Contratada')];

    act(() => { state.emit!({ brandId: state.brandId, workId: state.workId, runId: 'run_1' }); });

    await waitFor(() => { expect(state.listTeamCalls).toContain(state.workId); });
    await screen.findByText('Pauta Contratada');
  });

  it('un evento de OTRO Trabajo no recarga nada: el equipo abierto no se toca', async () => {
    await mounted();
    state.team = [member('mem_paid_media', 'Pauta Contratada')];

    act(() => { state.emit!({ brandId: state.brandId, workId: 'otro-trabajo', runId: 'run_1' }); });

    // Se le da tiempo real: la aserción es que NO pasó nada, y sin espera
    // pasaría en verde aunque la recarga estuviera en vuelo.
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(state.listTeamCalls).toEqual([]);
    expect(screen.queryByText('Pauta Contratada')).toBeNull();
  });
});
