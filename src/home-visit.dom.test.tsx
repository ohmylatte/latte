import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CoordinationActiveRunSummary, Work } from '../shared/contracts';

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
 * R5: y una visita es un acto de LA PERSONA, no del arranque. `App` autoselecciona
 * `works[0]` al montar y al cambiar de Marca, y con F13 eso anotaba la visita
 * sola: la fila "tu equipo terminó" se consumía sin que nadie mirara nada. Por
 * eso este archivo tiene DOS Trabajos y el run terminado vive en el SEGUNDO —
 * el que la app nunca abre por su cuenta. Con la fila apuntando a `works[0]`,
 * este test pasaba por una carrera: marcaba visto el mismo Trabajo que la
 * autoselección ya había abierto, así que la aserción no distinguía entre el
 * clic y el arranque.
 *
 * La otra mitad —que con la visita anotada la fila y el run terminado
 * desaparecen— es puro cálculo y ya vive en `home-summary.test.ts`
 * ("un `done` anterior a la visita no se reporta").
 */

const SECOND_WORK_ID = 'demo-work-2';

const state = vi.hoisted(() => ({
  seen: [] as string[],
  firstWorkId: '',
  brandId: '',
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  /** Dos Trabajos: el que la app abre sola y el que sólo se abre con un clic. */
  const listWorks = async (brandId: string): Promise<Work[]> => {
    const works = await actual.browserAPI.listWorks(brandId);
    const first = works[0];
    if (!first) return works;
    state.brandId = brandId;
    state.firstWorkId = first.id;
    return [...works, { ...first, id: SECOND_WORK_ID, title: 'Campaña de invierno' }];
  };
  const finishedRun = async (): Promise<CoordinationActiveRunSummary[]> => {
    const brands = await actual.browserAPI.listBrands();
    const brand = brands[0];
    if (!brand) return [];
    return [{
      runId: 'run_terminado', workId: SECOND_WORK_ID, workTitle: 'Campaña de invierno', brandId: brand.id, brandName: brand.name,
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
      listWorks,
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

/** Espera a que la fila "tu equipo terminó" esté en pantalla y devuelve su botón. */
async function findDoneRow(container: HTMLElement): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const found = container.querySelector<HTMLButtonElement>('.home-since .home-row[data-kind="done"]');
    expect(found).not.toBeNull();
    return found as HTMLButtonElement;
  });
}

describe('F13/R5: abrir el Trabajo cuenta como visita, y sólo si lo abrió la persona', () => {
  it('montar la app no es visitar: la autoselección de works[0] no anota nada', async () => {
    state.seen = [];
    const { container } = render(<I18nProvider><App /></I18nProvider>);
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    // La fila ya está: o sea que los runs activos cargaron y el recorte de
    // coordinación del Trabajo autoseleccionado tuvo todo el tiempo del mundo.
    await findDoneRow(container);
    await new Promise((resolve) => { setTimeout(resolve, 200); });

    expect(state.seen).toEqual([]);
    expect(state.firstWorkId).not.toBe(''); // la premisa del test existe de verdad
  });

  it('la fila "tu equipo terminó" de Inicio abre ESE Trabajo y marca ESE visto', async () => {
    state.seen = [];
    const { container } = render(<I18nProvider><App /></I18nProvider>);
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    const row = await findDoneRow(container);
    expect(state.seen).toEqual([]);

    fireEvent.click(row);

    // El Trabajo quedó abierto (sus pestañas están en pantalla)...
    await waitFor(() => expect(container.querySelector('.tabs')).not.toBeNull());
    // ...y la visita quedó anotada, sin pasar por Decisiones, sobre EL Trabajo
    // que la persona abrió y sobre ningún otro.
    await waitFor(() => expect(state.seen).toEqual([SECOND_WORK_ID]));
  });
});
