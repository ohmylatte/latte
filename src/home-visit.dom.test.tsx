import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CoordinationActiveRunSummary } from '../shared/contracts';

configure({ asyncUtilTimeout: 5_000 });

/**
 * F13: una "visita" es ABRIR EL TRABAJO, no abrir Decisiones.
 *
 * `markSeen` corría sólo con `view === 'decisions'`, y la fila "tu equipo
 * terminó" de Inicio abre el TRABAJO. O sea que la única forma de sacarse esa
 * fila de encima era, después de abrir el Trabajo, acordarse de entrar a
 * Decisiones: hasta entonces la novedad seguía ahí y el run terminado seguía
 * en la tira, para siempre. La visita se anota cuando el recorte de
 * coordinación del Trabajo ABIERTO terminó de cargar, en cualquier vista —
 * sigue sin anotarse en el mismo tick del clic, que es lo que haría que todo
 * lo que llega después naciera ya visto.
 *
 * La otra mitad —que con la visita anotada la fila y el run terminado
 * desaparecen— es puro cálculo y ya vive en `home-summary.test.ts`
 * ("un `done` anterior a la visita no se reporta").
 */

const state = vi.hoisted(() => ({
  seen: [] as string[],
  workId: '',
  brandId: '',
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  const finishedRun = async (): Promise<CoordinationActiveRunSummary[]> => {
    const brands = await actual.browserAPI.listBrands();
    const brand = brands[0];
    if (!brand) return [];
    const works = await actual.browserAPI.listWorks(brand.id);
    const work = works[0];
    if (!work) return [];
    state.brandId = brand.id;
    state.workId = work.id;
    return [{
      runId: 'run_terminado', workId: work.id, workTitle: work.title, brandId: brand.id, brandName: brand.name,
      status: 'done', dispatchesUsed: 3, maxDispatches: 10, pendingGates: 0, budgetInvalid: false,
      updatedAt: '2026-09-02T00:00:00.000Z', lastEventAt: '2026-09-02T00:00:00.000Z',
      // Nunca se registró una visita: la fila aparece sí o sí.
      lastSeenAt: null,
    }];
  };
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
      listActiveCoordinationRuns: finishedRun,
      getCoordinationRun: async () => null,
      listCoordinationGates: async () => [],
      listCoordinationLog: async () => [],
      listCoordinationHires: async () => [],
      listOpenCoordinationAsks: async () => [],
      coordinationRuntimeSupport: async () => [],
      markCoordinationSeen: async (workId: string) => { state.seen.push(workId); return new Date().toISOString(); },
    },
  };
});

const { App } = await import('./App');
const { I18nProvider } = await import('./i18n');

describe('F13: abrir el Trabajo cuenta como visita', () => {
  it('la fila "tu equipo terminó" de Inicio abre el Trabajo y marca visto', async () => {
    state.seen = [];
    const { container } = render(<I18nProvider><App /></I18nProvider>);
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });

    const row = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('.home-since .home-row[data-kind="done"]');
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    // Antes de abrir nada, ninguna visita: la tarjeta de Inicio no es una visita.
    expect(state.seen).toEqual([]);

    fireEvent.click(row);

    // El Trabajo quedó abierto (sus pestañas están en pantalla)...
    await waitFor(() => expect(container.querySelector('.tabs')).not.toBeNull());
    // ...y la visita quedó anotada, sin pasar por Decisiones.
    await waitFor(() => expect(state.seen).toContain(state.workId));
  });
});
