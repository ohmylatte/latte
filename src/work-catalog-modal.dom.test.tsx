import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentRole, Brand, BrandDnaView, SaveOutcome, Work } from '../shared/contracts';

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
  readBrandDna: vi.fn<(brandId: string) => Promise<BrandDnaView>>(),
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return { ...actual, api: { ...actual.api, createWork: mocks.createWork, saveBrief: mocks.saveBrief, readBrandDna: mocks.readBrandDna } };
});

const { I18nProvider } = await import('./i18n');
const { WorkCatalogModal } = await import('./WorkCatalogModal');

const brand: Brand = { id: 'b1', name: 'Casa Oliva', context: 'Tono cálido', createdAt: '', archivedAt: null };
const roles: AgentRole[] = [
  { id: 'assistant', name: 'Asistente', initial: 'A', summary: '', builtin: true, tier: 'balanced', avatar: null },
  { id: 'strategist', name: 'Strategist', initial: 'S', summary: '', builtin: false, tier: 'deep', avatar: null },
];

const work = (title: string, brief = ''): Work => ({ id: 'w-' + title, brandId: brand.id, title, brief, folder: null, updatedAt: '' });

/** La ficha de una marca SIN ADN: lo que un brand nuevo trae. */
const noDna = (): BrandDnaView => ({ brandId: brand.id, draft: null, approved: null, changedSinceApproval: false, proposals: [], ideas: [], ideasUpdatedAt: null, lastSources: null });
/** La ficha con ADN aprobado: audiencia y oferta, que es lo que este tipo pregunta. */
const withDna = (): BrandDnaView => {
  const entry = <T,>(value: T) => ({ value, sources: [{ kind: 'context' as const, label: 'contexto de marca' }], assumption: false });
  return {
    ...noDna(),
    approved: {
      version: 1, approvedAt: '2026-09-01T00:00:00.000Z',
      fields: {
        tone: entry({ adjectives: ['Cálido', 'Preciso'], example: null }),
        audience: entry('Personas que eligen menos, con más intención.'),
        valueProp: entry('Objetos de diseño para la vida cotidiana.'),
        wordsYes: null, wordsNo: null, claims: null, colors: null, fonts: null,
      },
    },
  };
};

beforeEach(() => {
  mocks.createWork.mockReset();
  mocks.saveBrief.mockReset();
  mocks.readBrandDna.mockReset();
  mocks.readBrandDna.mockResolvedValue(noDna());
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
  it('muestra los cuatro bloques del catálogo y "Empezar libremente" aparte', () => {
    mount();
    for (const block of ['Planificar', 'Producir', 'Operar y optimizar', 'Medir y reportar']) {
      expect(screen.getByRole('heading', { name: block })).toBeDefined();
    }
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

  it('QA1: usa el MISMO componente de catálogo que el onboarding, sin subtítulo', () => {
    const { view } = mount();
    expect(view.container.querySelector('.catalog-blocks')).not.toBeNull();
    expect(view.container.querySelector('.catalog-blocks')!.querySelectorAll('.catalog-block')).toHaveLength(4);
    expect(view.container.querySelector('.modal-body .intro')).toBeNull();
  });

  it('QA1: cada opción es una fila compacta y clickeable, sin texto de descripción', () => {
    const { view } = mount();
    const row = screen.getByRole('button', { name: 'Campaña nueva' });
    expect(row.classList.contains('catalog-row')).toBe(true);
    expect(row.querySelector('small')).toBeNull();
    // La descripción queda como tooltip de una línea, no como texto visible.
    expect(row.getAttribute('title')).toBeTruthy();
    expect(view.container.querySelector('.onboarding-card')).toBeNull();
  });

  it('QA1: el pie de "Nuevo trabajo" alcanza los tipos nuevos del catálogo', async () => {
    const created = work('Comparar períodos');
    mocks.createWork.mockResolvedValue(created);
    mocks.saveBrief.mockResolvedValue({ status: 'saved', document: {} as never, fingerprint: 'f1', work: created });
    const { onCreated } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Comparar períodos' }));
    expect(screen.getByRole('heading', { name: 'Comparar períodos' })).toBeDefined();
    // Sin la descripción repetida debajo del título.
    expect(screen.queryByText(/Mismo indicador/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('¿Qué período miramos?'), { target: { value: 'Septiembre 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0]![1]).toMatchObject({ recommendedRoleId: 'analyst' });
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

  /**
   * Onboarding 2.0 · LAS PREGUNTAS NO PIDEN LO QUE EL ADN YA SABE.
   *
   * Con ADN aprobado, audiencia y oferta salen de la ficha y quedan colapsadas
   * en "Usar lo del ADN · Editar"; sin ADN se preguntan exactamente como
   * siempre. La fuente se nombra mientras el valor siga siendo el del ADN.
   */
  describe('las preguntas que el ADN ya sabe', () => {
    const openCampaign = async () => {
      fireEvent.click(screen.getByRole('button', { name: /Campaña nueva/ }));
      await screen.findByRole('heading', { name: 'Campaña nueva' });
    };
    const dnaBlock = async (): Promise<HTMLDetailsElement> =>
      ((await screen.findByText('Usar lo del ADN · Editar')).closest('details') as HTMLDetailsElement) ?? (() => { throw new Error('sin bloque de ADN'); })();

    it('con ADN, completa audiencia y oferta y las deja colapsadas con su fuente', async () => {
      mocks.readBrandDna.mockResolvedValue(withDna());
      mount();
      await openCampaign();
      const block = await dnaBlock();
      expect(block.open).toBe(false);

      const inputs = [...block.querySelectorAll('input')];
      expect(inputs.map((i) => i.placeholder)).toEqual(['¿A quién le hablamos?', '¿Qué ofrecemos?']);
      expect(inputs[0].value).toBe('Personas que eligen menos, con más intención.');
      expect(inputs[1].value).toBe('Objetos de diseño para la vida cotidiana.');
      for (const label of block.querySelectorAll('label')) expect(label.textContent).toContain('del ADN de la marca');

      // La requerida sigue siendo de la persona, fuera del bloque.
      expect(block.contains(screen.getByPlaceholderText('¿Qué querés lograr?'))).toBe(false);
      const cont = screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement;
      expect(cont.disabled).toBe(true);

      // Y con la requerida llena, el brief ya trae lo del ADN en vez de un supuesto.
      fireEvent.change(screen.getByPlaceholderText('¿Qué querés lograr?'), { target: { value: 'Lanzar la cosecha 2026' } });
      fireEvent.click(cont);
      expect(await screen.findByRole('heading', { name: 'Audiencia' })).toBeDefined();
      expect(screen.getByText('Personas que eligen menos, con más intención.')).toBeDefined();
      expect(screen.getByText('Objetos de diseño para la vida cotidiana.')).toBeDefined();
      expect(screen.queryByText('Audiencia: la propongo a partir de la marca.')).toBeNull();
    });

    it('sin ADN, se pregunta como siempre y no hay bloque que colapsar', async () => {
      mount();
      await openCampaign();
      await vi.waitFor(() => expect(mocks.readBrandDna).toHaveBeenCalledWith('b1'));
      expect(screen.queryByText('Usar lo del ADN · Editar')).toBeNull();
      expect((screen.getByPlaceholderText('¿A quién le hablamos?') as HTMLInputElement).value).toBe('');
      expect((screen.getByPlaceholderText('¿Qué ofrecemos?') as HTMLInputElement).value).toBe('');
      expect((screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('editar un valor del ADN lo vuelve de la persona: la fuente deja de nombrarlo', async () => {
      mocks.readBrandDna.mockResolvedValue(withDna());
      mount();
      await openCampaign();
      const block = await dnaBlock();
      const [audienceLabel, offerLabel] = [...block.querySelectorAll('label')];
      expect(audienceLabel.textContent).toContain('del ADN de la marca');

      const audience = block.querySelector('input[placeholder="¿A quién le hablamos?"]') as HTMLInputElement;
      fireEvent.change(audience, { target: { value: 'Pastas caseras de barrio' } });

      expect(audience.value).toBe('Pastas caseras de barrio');
      expect(audienceLabel.textContent).not.toContain('del ADN de la marca');
      // La que no se tocó sigue siendo del ADN.
      expect(offerLabel.textContent).toContain('del ADN de la marca');
    });
  });
});
