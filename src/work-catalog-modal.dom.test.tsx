import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentRole, Brand, SaveOutcome, Work } from '../shared/contracts';

/**
 * ENTREGA 1A (Brief 01, tarea 3): "NUEVO TRABAJO" USA EL CATÁLOGO.
 *
 * El modal reutiliza `work-catalog.ts`/`onboarding-flow.ts` — la MISMA capa
 * que ya prueba `OnboardingGate.dom.test.tsx` — así que acá sólo se prueba lo
 * propio del modal: que arma el trabajo + brief con esos datos y llama a
 * `onCreated` con el rol recomendado, y que "Empezar libremente" sigue siendo
 * el camino rápido de sólo título.
 */

const mocks = vi.hoisted(() => ({
  createWork: vi.fn<(brandId: string, title: string) => Promise<Work>>(),
  saveBrief: vi.fn<(workId: string, brief: string) => Promise<SaveOutcome>>(),
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return { ...actual, api: { ...actual.api, createWork: mocks.createWork, saveBrief: mocks.saveBrief } };
});

const { I18nProvider } = await import('./i18n');
const { WorkCatalogModal } = await import('./WorkCatalogModal');

const brand: Brand = { id: 'b1', name: 'Casa Oliva', context: 'Tono cálido', createdAt: '', archivedAt: null };
const roles: AgentRole[] = [
  { id: 'assistant', name: 'Asistente', initial: 'A', summary: '', builtin: true, tier: 'balanced', avatar: null },
  { id: 'strategist', name: 'Strategist', initial: 'S', summary: '', builtin: false, tier: 'deep', avatar: null },
];

const work = (title: string, brief = ''): Work => ({ id: 'w-' + title, brandId: brand.id, title, brief, folder: null, updatedAt: '' });

beforeEach(() => {
  mocks.createWork.mockReset();
  mocks.saveBrief.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

function mount(handlers: Partial<{ onCreated: (w: Work, options: { recommendedRoleId: string | null; brief: string }) => void; onClose: () => void; onError: (m: string) => void }> = {}) {
  const onCreated = vi.fn<(w: Work, options: { recommendedRoleId: string | null; brief: string }) => void>(handlers.onCreated);
  const onClose = handlers.onClose ?? vi.fn();
  const onError = handlers.onError ?? vi.fn();
  const view = render(<I18nProvider><WorkCatalogModal brand={brand} roles={roles} busy={false} onClose={onClose} onCreated={onCreated} onError={onError} /></I18nProvider>);
  return { view, onCreated, onClose, onError };
}

describe('WorkCatalogModal: "Nuevo trabajo" usa el catálogo', () => {
  it('muestra los grupos de intención y "Empezar libremente" aparte', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Planificar' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Reportar' })).toBeDefined();
    expect(screen.getByRole('button', { name: /Campaña nueva/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Empezar libremente/ })).toBeDefined();
  });

  it('QA: el eyebrow dice "Nuevo trabajo", no el genérico del modal viejo', () => {
    const { view } = mount();
    expect(view.getByText('Nuevo trabajo')).toBeDefined();
    expect(view.queryByText('TU ESTUDIO, CON ORDEN')).toBeNull();
  });

  it('QA: "Empezar libremente" vive en el encabezado, alcanzable sin scrollear la grilla', () => {
    const { view } = mount();
    const freeform = screen.getByRole('button', { name: /Empezar libremente/ });
    expect(view.container.querySelector('.modal-head')!.contains(freeform)).toBe(true);
    // Una sola aparición: no se repite adentro de la grilla de intenciones.
    expect(screen.getAllByRole('button', { name: /Empezar libremente/ })).toHaveLength(1);
  });

  it('QA: los grupos de intención usan la grilla de dos columnas del modal, no el auto-fill de pantalla completa', () => {
    const { view } = mount();
    const groups = view.container.querySelector('.onboarding-groups');
    expect(groups?.classList.contains('work-catalog-groups')).toBe(true);
  });

  it('bloquea el paso de preguntas hasta responder la requerida', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Campaña nueva/ }));
    expect(screen.getByRole('heading', { name: 'Campaña nueva' })).toBeDefined();
    const cont = screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
  });

  it('arma el trabajo con el brief compuesto y el rol recomendado, y avisa con onCreated', async () => {
    const created = work('Campaña nueva');
    mocks.createWork.mockResolvedValue(created);
    mocks.saveBrief.mockResolvedValue({ status: 'saved', document: {} as never, fingerprint: 'f1', work: { ...created, brief: '# Campaña nueva\n\n## Objetivo\n\nLanzar la cosecha 2026' } });
    const { onCreated } = mount();

    fireEvent.click(screen.getByRole('button', { name: /Campaña nueva/ }));
    fireEvent.change(screen.getByPlaceholderText('¿Qué querés lograr?'), { target: { value: 'Lanzar la cosecha 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    expect(await screen.findByRole('heading', { name: 'Objetivo' })).toBeDefined();
    // El rol recomendado de "Campaña nueva" es `strategist` (work-catalog.ts),
    // mostrado traducido (Entrega 1A, `roleLabel`): "Estratega", no "Strategist".
    const roleSelect = screen.getByDisplayValue('Estratega') as HTMLSelectElement;
    expect(roleSelect.value).toBe('strategist');

    fireEvent.click(screen.getByRole('button', { name: /Empezar trabajo/ }));

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(mocks.createWork).toHaveBeenCalledWith('b1', 'Campaña nueva');
    const [savedWorkId, savedBrief] = mocks.saveBrief.mock.calls[0]!;
    expect(savedWorkId).toBe(created.id);
    expect(savedBrief).toContain('Lanzar la cosecha 2026');
    const [, options] = onCreated.mock.calls[0]!;
    expect(options).toMatchObject({ recommendedRoleId: 'strategist' });
    expect(options.brief).toContain('Lanzar la cosecha 2026');
  });

  it('"Empezar libremente" sigue siendo el camino rápido de sólo título: sin rol ni brief', async () => {
    const created = work('Investigación de audiencia');
    mocks.createWork.mockResolvedValue(created);
    const { onCreated } = mount();

    fireEvent.click(screen.getByRole('button', { name: /Empezar libremente/ }));
    fireEvent.change(screen.getByPlaceholderText('Ej. Investigación de audiencia'), { target: { value: 'Investigación de audiencia' } });
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo trabajo' }));

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(mocks.createWork).toHaveBeenCalledWith('b1', 'Investigación de audiencia');
    expect(mocks.saveBrief).not.toHaveBeenCalled();
    const [, options] = onCreated.mock.calls[0]!;
    expect(options).toEqual({ recommendedRoleId: null, brief: '' });
  });

  it('"Volver" y el cierre no crean nada', () => {
    const { onClose, onCreated } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Campaña nueva/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
    expect(screen.getByRole('heading', { name: '¿En qué querés trabajar?' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(mocks.createWork).not.toHaveBeenCalled();
  });
});
