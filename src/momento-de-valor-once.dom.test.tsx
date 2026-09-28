import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, render, screen, waitFor } from '@testing-library/react';
import type { WorkDocument } from '../shared/contracts';

configure({ asyncUtilTimeout: 5_000 });

/**
 * ENTREGA 1A (Brief 01, tarea 4): EL MOMENTO DE VALOR SE MUESTRA UNA SOLA VEZ.
 *
 * Aparece sólo cuando el Trabajo ya tiene un primer resultado real (un
 * documento que dejó `draft`), y una vez mostrado no vuelve a aparecer —ni en
 * un re-render, ni tras "reiniciar" la app— porque `useWorkMomentSeen` lo
 * anota en `localStorage`, el mismo mecanismo que ya usa `useTeamSeen`.
 */

const REVIEW_DOC: WorkDocument = {
  id: 'doc-review-1', workId: 'demo-work', kind: 'strategy', title: 'Estrategia de lanzamiento', fileName: 'strategy.md',
  status: 'review', funnelStages: [], proposedFunnelStages: [], baseDocumentId: null, baseRevisionId: null, baseFingerprint: null,
  createdAt: '', updatedAt: '',
};

const state = vi.hoisted(() => ({ hasReviewDoc: true }));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
      listBrandDocuments: async (brandId: string) => (brandId === 'demo' && state.hasReviewDoc ? [REVIEW_DOC] : actual.browserAPI.listBrandDocuments(brandId)),
    },
  };
});

const { App } = await import('./App');
const { I18nProvider } = await import('./i18n');

beforeEach(() => { localStorage.clear(); state.hasReviewDoc = true; });
afterEach(() => { vi.restoreAllMocks(); });

describe('Entrega 1A: el momento de valor aparece una sola vez por Trabajo', () => {
  it('aparece con el primer resultado real, y no una segunda vez tras "reiniciar"', async () => {
    const { unmount } = render(<I18nProvider><App /></I18nProvider>);
    expect(await screen.findByText('Tu primer resultado está listo')).toBeDefined();
    expect(screen.getByText(/1 documento esperando tu revisión/)).toBeDefined();
    // Se anota vista apenas se muestra (mismo patrón que `useTeamSeen`); se
    // espera la escritura real en `localStorage` antes de "reiniciar", en vez
    // de asumir que el efecto ya corrió por la carrera entre su commit y el
    // de la propia tarjeta.
    await waitFor(() => expect(JSON.parse(localStorage.getItem('latte.momento-de-valor.seen') ?? '[]')).toContain('demo-work'));

    // "Reiniciar la app": se desmonta y se vuelve a montar de cero. Sólo
    // `localStorage` sobrevive — igual que un reinicio real del proceso.
    unmount();
    render(<I18nProvider><App /></I18nProvider>);
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    expect(screen.queryByText('Tu primer resultado está listo')).toBeNull();
  });

  it('sin ningún documento que haya dejado el borrador, no aparece', async () => {
    state.hasReviewDoc = false;
    render(<I18nProvider><App /></I18nProvider>);
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    expect(screen.queryByText('Tu primer resultado está listo')).toBeNull();
  });
});
