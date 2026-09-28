import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Brand, BrandDnaProposal, BrandDnaView as BrandDnaData } from '../shared/contracts';
import { resetBrandDnaPreview, setBrandDnaPreviewStepMs } from './browser-api';
import { I18nProvider } from './i18n';
import { BrandDnaView } from './BrandDnaView';

/**
 * MARCA → ADN.
 *
 * El doble de la vista previa arma el build y deja un ADN de demo, pero nunca
 * GENERA propuestas (en el escritorio las escribe el motor), así que éstas se
 * inyectan en el `readBrandDna` y se descuentan en el `resolve` — todo lo demás
 * (reconstruir, editar, aprobar) corre contra el doble REAL, que es el que
 * garantiza el contrato.
 */
const injected = vi.hoisted(() => ({
  proposals: [] as BrandDnaProposal[],
  resolve: [] as Array<{ proposalId: string; accept: boolean }>,
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    api: {
      ...actual.browserAPI,
      readBrandDna: async (brandId: string) => {
        const view: BrandDnaData = await actual.browserAPI.readBrandDna(brandId);
        return { ...view, proposals: [...injected.proposals] };
      },
      resolveBrandDnaProposal: async (brandId: string, proposalId: string, accept: boolean) => {
        injected.resolve.push({ proposalId, accept });
        injected.proposals = injected.proposals.filter((proposal) => proposal.id !== proposalId);
        const view: BrandDnaData = await actual.browserAPI.readBrandDna(brandId);
        return { ...view, proposals: [...injected.proposals] };
      },
    },
  };
});

const brand: Brand = { id: 'b1', name: 'Casa Oliva', context: '', createdAt: '2026-09-01T00:00:00.000Z', archivedAt: null };

const proposal: BrandDnaProposal = {
  id: 'p1',
  field: 'audience',
  next: 'Personas que eligen menos, con más intención.',
  reason: 'La aprobaste en el brief de primavera.',
  source: { kind: 'document', label: 'brief de primavera' },
  createdAt: '2026-09-20T10:00:00.000Z',
};

const mount = (onChanged?: (view: BrandDnaData) => void) =>
  render(<I18nProvider><BrandDnaView brand={brand} formatDate={(value) => value.slice(0, 10)} onChanged={onChanged} /></I18nProvider>);

/** Construye con lo que la marca ya tiene y espera la ficha. */
async function rebuild(container: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: /Reconstruir con lo que ya tiene/ }));
  await waitFor(() => expect(container.querySelectorAll('.dna-step').length).toBeGreaterThan(1));
  await waitFor(() => expect(container.querySelector('.dna-card')).not.toBeNull(), { timeout: 5_000 });
  return container.querySelector('.dna-card') as HTMLElement;
}

beforeEach(() => {
  localStorage.clear();
  setBrandDnaPreviewStepMs(0);
  resetBrandDnaPreview();
  injected.proposals = [];
  injected.resolve = [];
});

afterEach(() => { cleanup(); });

describe('Marca → ADN', () => {
  it('sin ADN: lo dice y ofrece los dos caminos, sin prometer una versión aprobada', () => {
    const { container } = mount();
    expect(container.querySelector('.dna-view')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'ADN de Casa Oliva' })).toBeDefined();
    expect(screen.getByText('Todavía no hay una versión aprobada.')).toBeDefined();
    expect(screen.getByText('Esta marca todavía no tiene ADN.')).toBeDefined();
    expect(screen.getByRole('button', { name: /Reconstruir con lo que ya tiene/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Sumar fuentes/ })).toBeDefined();
  });

  it('reconstruye con lo que ya tiene: pasos reales y la ficha cuando termina', async () => {
    const { container } = mount();
    const card = await rebuild(container);
    // Los pasos del modo `existing`, narrados con palabra.
    const keys = [...container.querySelectorAll('.dna-step')].map((step) => step.getAttribute('data-key'));
    expect(keys).toEqual(['context', 'documents', 'decisions', 'memory', 'compose']);
    for (const state of container.querySelectorAll('.dna-step-state')) expect(state.textContent).toBeTruthy();
    expect(card.textContent).toContain('Casa Oliva');
    expect(card.textContent).toContain('Propuesta');
    expect(screen.getByRole('heading', { name: 'Audiencia' })).toBeDefined();
  });

  it('edita un campo con el lápiz y el cambio vuelve a la ficha, con fuente humana', async () => {
    const { container } = mount();
    await rebuild(container);
    fireEvent.click(screen.getByRole('button', { name: 'Editar Audiencia' }));
    const editor = await screen.findByRole('textbox', { name: 'Audiencia' });
    fireEvent.change(editor, { target: { value: 'Marcas que cuidan lo que fabrican.' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar/ }));
    await waitFor(() => expect(container.textContent).toContain('Marcas que cuidan lo que fabrican.'));
    // `updateBrandDnaField` cambia la fuente a `human`: el dato dejó de ser de
    // otra cosa y de ser supuesto.
    await waitFor(() => expect(container.textContent).toContain('Fuente · vos'));
    // El campo que tocó la persona dejó de ser supuesto (los demás siguen siéndolo).
    expect(container.querySelector('[data-field="audience"] [data-tone="assumption"]')).toBeNull();
  });

  it('acepta una propuesta aprendida y la saca de la lista', async () => {
    injected.proposals = [proposal];
    const { container } = mount();
    expect(await screen.findByText('La aprobaste en el brief de primavera.')).toBeDefined();
    expect(container.textContent).toContain('Personas que eligen menos, con más intención.');
    fireEvent.click(screen.getByRole('button', { name: /Aceptar/ }));
    await waitFor(() => expect(screen.getByText('Aún no hay propuestas para revisar.')).toBeDefined());
    expect(injected.resolve).toEqual([{ proposalId: 'p1', accept: true }]);
  });

  it('descarta una propuesta sin aplicarla', async () => {
    injected.proposals = [proposal];
    mount();
    await screen.findByText('La aprobaste en el brief de primavera.');
    fireEvent.click(screen.getByRole('button', { name: /Descartar/ }));
    await waitFor(() => expect(screen.getByText('Aún no hay propuestas para revisar.')).toBeDefined());
    expect(injected.resolve).toEqual([{ proposalId: 'p1', accept: false }]);
  });

  it('abre "Sumar fuentes" —la misma F del recorrido— y arranca el build', async () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Sumar fuentes/ }));
    expect(await screen.findByRole('heading', { name: 'Traé tu marca' })).toBeDefined();
    // La vista previa no tiene disco: la tarjeta lo dice en vez de ofrecer un
    // botón que no haría nada.
    expect(screen.getByText('Necesita la app de escritorio.')).toBeDefined();
    fireEvent.change(screen.getByPlaceholderText('https://tuweb.com'), { target: { value: 'https://casoliva.com.ar' } });
    fireEvent.click(screen.getByRole('button', { name: /Armar mi marca/ }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Traé tu marca' })).toBeNull());
    await waitFor(() => expect(container.querySelectorAll('.dna-step').length).toBeGreaterThan(1));
    await waitFor(() => expect(container.querySelector('.dna-card')).not.toBeNull(), { timeout: 5_000 });
    const keys = [...container.querySelectorAll('.dna-step')].map((step) => step.getAttribute('data-key'));
    expect(keys).toEqual(['web', 'compose']);
  });

  it('avisa al contenedor cuando la ficha cambia, para que Inicio la lea', async () => {
    const onChanged = vi.fn();
    const { container } = mount(onChanged);
    await rebuild(container);
    expect(onChanged).toHaveBeenCalled();
    const last = onChanged.mock.calls[onChanged.mock.calls.length - 1]![0] as BrandDnaData;
    expect(last.brandId).toBe('b1');
    expect(last.draft).not.toBeNull();
  });
});
