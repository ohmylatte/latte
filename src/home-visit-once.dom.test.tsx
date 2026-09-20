import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Brand, Work } from '../shared/contracts';

configure({ asyncUtilTimeout: 5_000 });

/**
 * Q3: UNA VISITA SE ANOTA UNA SOLA VEZ, Y POR UN ACTO DE LA PERSONA.
 *
 * `humanOpenedWorkRef` se escribía cuando un Trabajo se abría a propósito y NO
 * se limpiaba nunca: la línea era `if (requested) ref.current = requested.id`,
 * sin `else`. Volver a la Marca por la barra lateral autoselecciona `list[0]`,
 * que puede ser justamente ese Trabajo, y entonces `markSeen` disparaba con la
 * persona mirando Inicio — sin haber abierto nada. Se comía la fila "tu equipo
 * terminó", que es la novedad que existe para avisarle.
 *
 * Dos cambios, el mismo principio: la ref se PISA en cada cambio de Marca (una
 * navegación que no pidió ese Trabajo lo dice escribiendo `null`), y se CONSUME
 * al marcar, así que un acto explícito vale por una visita y no por todas las
 * que vengan después.
 */

const OTHER_BRAND_ID = 'demo-2';

const state = vi.hoisted(() => ({ seen: [] as string[], firstWorkId: '' }));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  /** Dos Marcas, una con el Trabajo de demo y otra con el suyo. */
  const listBrands = async (): Promise<Brand[]> => {
    const brands = await actual.browserAPI.listBrands();
    const first = brands[0]!;
    return [first, { ...first, id: OTHER_BRAND_ID, name: 'Otra marca' }];
  };
  const listWorks = async (brandId: string): Promise<Work[]> => {
    const works = await actual.browserAPI.listWorks(brandId === OTHER_BRAND_ID ? 'demo' : brandId);
    const first = works[0];
    if (!first) return [];
    if (brandId === OTHER_BRAND_ID) return [{ ...first, id: 'otro-trabajo', brandId, title: 'Campaña de invierno' }];
    state.firstWorkId = first.id;
    return works;
  };
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
      listBrands,
      listWorks,
      getCoordinationRun: async () => null,
      listCoordinationGates: async () => [],
      listCoordinationLog: async () => [],
      listCoordinationHires: async () => [],
      listOpenCoordinationAsks: async () => [],
      listActiveCoordinationRuns: async () => [],
      coordinationRuntimeSupport: async () => [],
      markCoordinationSeen: async (workId: string) => { state.seen.push(workId); return new Date().toISOString(); },
    },
  };
});

const { App } = await import('./App');
const { I18nProvider } = await import('./i18n');

/** Deja correr todo lo encolado: el recorte de coordinación carga en varios ticks. */
const quiesce = () => new Promise((resolve) => { setTimeout(resolve, 200); });

beforeEach(() => { state.seen = []; });

describe('Q3: la visita se consume, y la autoselección al volver a una Marca no la repite', () => {
  it('abrir → cambiar de Marca → volver: NO se vuelve a anotar; abrir otra vez sí', async () => {
    render(<I18nProvider><App /></I18nProvider>);
    const work = await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    expect(state.firstWorkId).not.toBe(''); // la premisa del test existe de verdad

    // 1. Un acto de la persona: abre el Trabajo. Se anota una visita.
    fireEvent.click(work);
    await waitFor(() => expect(state.seen).toEqual([state.firstWorkId]));

    // 2. Se va a la otra Marca. Su Trabajo lo elige la app sola: no es visita.
    const picker = document.querySelector('.brand-picker select') as HTMLSelectElement;
    expect(picker).not.toBeNull();
    fireEvent.change(picker, { target: { value: OTHER_BRAND_ID } });
    await quiesce();
    expect(state.seen).toEqual([state.firstWorkId]);

    // 3. Y vuelve a la primera por el selector de Marca. `list[0]` es EL MISMO
    // Trabajo de antes, y eso no es haberlo abierto.
    fireEvent.change(picker, { target: { value: 'demo' } });
    await quiesce();
    expect(state.seen).toEqual([state.firstWorkId]);

    // 4. Ahora sí lo abre con un clic: esa es otra visita.
    fireEvent.click(await screen.findByRole('button', { name: 'Lanzamiento primavera' }));
    await waitFor(() => expect(state.seen).toEqual([state.firstWorkId, state.firstWorkId]));
  });
});
