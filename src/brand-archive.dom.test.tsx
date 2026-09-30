import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { catalogs, I18nProvider } from './i18n';
import { browserAPI } from './browser-api';

configure({ asyncUtilTimeout: 5_000 });

/**
 * "Archivar marca" volvió (regresión de bb78a67: la vista Contexto nueva se
 * quedó sin el botón y `archiveSelectedBrand` quedó huérfana). Vive donde la
 * busca quien hace marketing: en el "⋯" al lado del selector de marca, y
 * como acción tranquila al final de Marca › Contexto. Pregunta con el diálogo
 * de la app, nunca con `window.confirm`, y se deshace desde "Marcas archivadas".
 */

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: false,
    api: { ...actual.browserAPI, getOnboardingComplete: async () => true, getOnboardingDraft: async () => null },
  };
});

const es = catalogs['es-AR'];
const DEMO = 'Casa Oliva · Ejemplo';
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? '');
const brandSelect = () => screen.getByRole('combobox', { name: es['ui.auto.031'] }) as HTMLSelectElement;
const optionNames = () => [...brandSelect().options].map((o) => o.textContent);

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mountWithTwoBrands() {
  await browserAPI.createBrand('Norte');
  const confirmSpy = vi.spyOn(window, 'confirm');
  render(<I18nProvider><App /></I18nProvider>);
  await waitFor(() => expect(optionNames()).toEqual([DEMO, 'Norte']));
  await waitFor(() => expect(brandSelect().value).toBe('demo'));
  return { confirmSpy };
}

describe('Archivar marca', () => {
  it('se archiva desde el "⋯" del selector, con el diálogo de la app, y se restaura desde Marcas archivadas', async () => {
    const { confirmSpy } = await mountWithTwoBrands();

    fireEvent.click(screen.getByRole('button', { name: fill(es['brand.menu'], { name: DEMO }) }));
    fireEvent.click(screen.getByRole('menuitem', { name: es['brand.archive'] }));

    const dialog = screen.getByRole('dialog', { name: fill(es['brand.archiveTitle'], { name: DEMO }) });
    expect(within(dialog).getByText(es['brand.archiveConfirm'])).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: es['brand.archiveAction'] }));

    // La marca sale de la lista y se abre la siguiente.
    await waitFor(() => expect(optionNames()).toEqual(['Norte']));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(fill(es['brand.archived'], { name: DEMO }))).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect((await browserAPI.listArchivedBrands()).map((b) => b.name)).toEqual([DEMO]);

    // Y vuelve desde "Marcas archivadas", en el mismo "⋯", con su contador.
    fireEvent.click(screen.getByRole('button', { name: fill(es['brand.menu'], { name: 'Norte' }) }));
    fireEvent.click(screen.getByRole('menuitem', { name: `${es['brand.archivedToggle']}1` }));
    fireEvent.click(screen.getByRole('button', { name: fill(es['brand.restoreNamed'], { name: DEMO }) }));
    await waitFor(() => expect(optionNames()).toEqual(expect.arrayContaining([DEMO, 'Norte'])));
    expect(screen.getByText(fill(es['brand.restored'], { name: DEMO }))).toBeTruthy();
    expect(await browserAPI.listArchivedBrands()).toEqual([]);
  });

  it('también está al final de Marca › Contexto; cancelar no archiva nada', async () => {
    await mountWithTwoBrands();
    fireEvent.click(screen.getByRole('button', { name: es['ui.auto.035'] }));
    const quiet = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('.context-archive button');
      expect(button).not.toBeNull();
      return button!;
    });
    expect(quiet.textContent).toBe(es['brand.archive']);

    fireEvent.click(quiet);
    const dialog = screen.getByRole('dialog', { name: fill(es['brand.archiveTitle'], { name: DEMO }) });
    fireEvent.click(within(dialog).getByRole('button', { name: es['ui.auto.241'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await browserAPI.listArchivedBrands()).toEqual([]);

    fireEvent.click(quiet);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: es['brand.archiveAction'] }));
    await waitFor(() => expect(optionNames()).toEqual(['Norte']));
  });

  it('archivar la última marca deja Inicio con "agregar marca"', async () => {
    render(<I18nProvider><App /></I18nProvider>);
    await waitFor(() => expect(brandSelect().value).toBe('demo'));
    fireEvent.click(screen.getByRole('button', { name: fill(es['brand.menu'], { name: DEMO }) }));
    fireEvent.click(screen.getByRole('menuitem', { name: es['brand.archive'] }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: es['brand.archiveAction'] }));
    await waitFor(() => expect(optionNames()).toEqual([es['ui.auto.032']]));
    expect(screen.queryByRole('button', { name: fill(es['brand.menu'], { name: DEMO }) })).toBeNull();
    expect(document.querySelector('main')?.textContent).toContain(es['ui.auto.033'].trim());
  });

  it('la copy dice qué pasa, sin tranquilizar por negación', () => {
    for (const locale of ['es-AR', 'en-US'] as const) {
      for (const key of ['brand.archiveConfirm', 'brand.archived', 'brand.archiveTitle', 'brand.restored'] as const) {
        expect(catalogs[locale][key], `${locale} ${key}`).not.toMatch(/\bno borra|nada se borr|nunca|not delete|nothing was deleted|never/i);
      }
    }
  });
});
