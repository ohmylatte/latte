import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HomeView, type HomeViewProps } from './HomeView';
import { I18nProvider } from './i18n';
import type { Brand, BrandDnaView, Decision, DocumentState, WorkDocument } from '../shared/contracts';

/**
 * Inicio · la caja "¿Qué querés hacer hoy…?" y la tarjeta Primeros pasos.
 *
 * Se monta `HomeView` completo (no `HomeStart` aislado) porque lo que hay que
 * probar es el cableado: la clasificación contra el catálogo, el envío que
 * delega en el contenedor, y que los cuatro pasos salgan de datos reales y la
 * tarjeta se vaya cuando los cuatro están.
 *
 * Las props nuevas son ADITIVAS: sin ellas Inicio es el de siempre, que es lo
 * que ya prueban los tests viejos de esta superficie.
 */

const brand = (patch: Partial<Brand> = {}): Brand => ({ id: 'b1', name: 'Casa Oliva', context: 'Tono cálido.', createdAt: '', archivedAt: null, ...patch });
const work = () => ({ id: 'w1', title: 'Lanzamiento', updatedAt: '2026-09-01T00:00:00.000Z' });
const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Estrategia', fileName: 'estrategia.md',
  status: 'draft', funnelStages: [], proposedFunnelStages: [], baseDocumentId: null,
  baseRevisionId: null, baseFingerprint: null, createdAt: '', updatedAt: '', ...patch,
});
const decision = (): Decision => ({
  id: 'd1', workId: 'w1', text: 'Elegimos un tono cercano', rationale: '', alternativesRejected: [],
  evidenceRefs: [], status: 'approved',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '', decidedAt: '', ...{},
});

const fields = {
  tone: { value: { adjectives: ['Cercano', 'Preciso'], example: 'Diseño que acompaña.' }, sources: [], assumption: false },
  audience: { value: 'Personas que eligen menos, con más intención.', sources: [], assumption: false },
  valueProp: { value: 'Objetos de diseño para la vida cotidiana.', sources: [], assumption: false },
  wordsYes: null, wordsNo: null, claims: null, colors: null, fonts: null,
};

const dna = (patch: Partial<BrandDnaView> = {}): BrandDnaView => ({
  brandId: 'b1',
  draft: fields,
  approved: { version: 1, approvedAt: '2026-09-20T10:00:00.000Z', fields },
  changedSinceApproval: false,
  proposals: [],
  ...patch,
});

const handlers = () => ({
  onOpenWork: vi.fn(), onOpenDecisions: vi.fn(), onOpenCoordination: vi.fn(), onOpenDocument: vi.fn(),
  onOpenContext: vi.fn(), onNewWork: vi.fn(), onAddBrand: vi.fn(),
  onStartWork: vi.fn(), onGoTo: vi.fn(), onCloseFirstSteps: vi.fn(),
});

const props = (patch: Partial<HomeViewProps> = {}): HomeViewProps => ({
  brand: brand(),
  works: [],
  documents: [],
  decisions: [],
  states: {} as Readonly<Record<string, DocumentState>>,
  checking: false,
  liveWorkIds: [],
  pendingContextProposals: 0,
  formatDate: () => 'hace un rato',
  dna: null,
  roles: [],
  funnelOpened: false,
  firstStepsClosed: false,
  ...handlers(),
  ...patch,
});

const mount = (input: HomeViewProps) => render(<I18nProvider><HomeView {...input} /></I18nProvider>);
const box = () => screen.getByLabelText('Contale qué querés lograr.') as HTMLTextAreaElement;

describe('Inicio · la caja', () => {
  it('pregunta por la marca, con la marca en su fragmento', () => {
    const { container } = mount(props());
    const title = container.querySelector('.home-ask-title')!;
    expect(title.textContent).toContain('¿Qué querés hacer hoy con');
    expect(title.querySelector('.home-ask-brand')!.textContent).toBe('Casa Oliva');
  });

  it('clasifica lo que se escribe contra el catálogo, con el rol del catálogo', () => {
    const { container } = mount(props());
    fireEvent.change(box(), { target: { value: 'Armame una campaña para primavera' } });
    expect(container.textContent).toContain('Se arma como Campaña nueva con Estratega');
    // El camino rápido sigue estando para lo que el catálogo no reconoce.
    fireEvent.change(box(), { target: { value: 'charlemos de la marca un rato' } });
    expect(container.textContent).toContain('Se arma como Empezar libremente con Asistente');
    expect(screen.getByRole('button', { name: /Ver todos los tipos de trabajo/ })).toBeDefined();
  });

  it('envía el texto como pedido y limpia la caja', () => {
    const input = props();
    mount(input);
    fireEvent.change(box(), { target: { value: 'Armame una campaña para primavera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(input.onStartWork).toHaveBeenCalledTimes(1);
    expect(input.onStartWork).toHaveBeenCalledWith('Armame una campaña para primavera');
    expect(box().value).toBe('');
    // Con la caja vacía no hay nada que enviar.
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('una sugerencia rellena la caja con el tipo y el dato del ADN', () => {
    const { container } = mount(props({ dna: dna() }));
    const suggestions = [...container.querySelectorAll<HTMLButtonElement>('.home-suggest')];
    expect(suggestions).toHaveLength(4);
    expect(suggestions[0].querySelector('strong')!.textContent).toBe('Campaña nueva');
    expect(suggestions[0].querySelector('small')!.textContent).toBe('Personas que eligen menos, con más intención.');
    fireEvent.click(suggestions[0]);
    expect(box().value).toBe('Campaña nueva: Personas que eligen menos, con más intención.');
  });

  it('la línea de la caja dice el ADN y las decisiones reales de la marca', () => {
    const withDna = mount(props({ dna: dna(), decisions: [decision()] }));
    expect(withDna.container.textContent).toContain('ADN de Casa Oliva · 1 decisiones');
    withDna.unmount();

    const { container } = mount(props({ dna: null }));
    expect(container.textContent).toContain('Tu marca todavía no tiene ADN armado.');
    fireEvent.click(screen.getByRole('button', { name: 'Traé tu marca' }));
  });

  it('sin ADN, "Traé tu marca" lleva al ADN de la marca', () => {
    const input = props({ dna: null });
    mount(input);
    fireEvent.click(screen.getByRole('button', { name: 'Traé tu marca' }));
    expect(input.onGoTo).toHaveBeenCalledWith('dna');
  });

  it('sin las props nuevas, Inicio es el de siempre', () => {
    const input = props();
    const loose = input as unknown as Record<string, unknown>;
    delete loose.onStartWork;
    delete loose.onGoTo;
    const { container } = mount(input);
    expect(container.querySelector('.home-start')).toBeNull();
    expect(container.querySelector('.first-steps')).toBeNull();
  });
});

describe('Inicio · Primeros pasos', () => {
  it('cada paso se marca con su dato real y el progreso lo cuenta', () => {
    const { container } = mount(props({ dna: dna(), works: [work()] }));
    const card = container.querySelector('.first-steps')!;
    expect(card.querySelector('.first-steps-count')!.textContent).toBe('2 de 4');
    const steps = [...card.querySelectorAll('.first-step')];
    expect(steps.map((step) => step.getAttribute('data-done'))).toEqual(['true', 'true', 'false', 'false']);
    // El color no es la única señal: cada paso también dice su estado.
    expect(steps[0].querySelector('.first-step-state')!.textContent).toBe('Listo');
    expect(steps[2].querySelector('.first-step-state')!.textContent).toBe('Pendiente');
    // Y los pendientes ofrecen el gesto que los cumple.
    expect(steps[2].querySelector('button')!.getAttribute('aria-label')).toBe('Probalo · Aprobá una pieza');
  });

  it('con los cuatro hechos la tarjeta no se dibuja', () => {
    const { container } = mount(props({
      dna: dna(),
      works: [work()],
      documents: [doc({ status: 'approved' })],
      funnelOpened: true,
    }));
    expect(container.querySelector('.first-steps')).toBeNull();
  });

  it('cerrada por la persona no vuelve a aparecer', () => {
    const { container } = mount(props({ firstStepsClosed: true }));
    expect(container.querySelector('.first-steps')).toBeNull();
  });

  it('el botón de cerrar avisa al contenedor, que es quien lo persiste', () => {
    const input = props();
    const { container } = mount(input);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(input.onCloseFirstSteps).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.first-steps')).not.toBeNull();
  });

  it('"Probalo" de cada paso lleva a la pantalla donde eso se hace', () => {
    const input = props({ dna: null, works: [] });
    const { container } = mount(input);
    const tries = [...container.querySelectorAll<HTMLButtonElement>('.first-step-try')];
    expect(tries.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Probalo · Traé tu marca',
      'Probalo · Pedí tu primer trabajo',
      'Probalo · Aprobá una pieza',
      'Probalo · Mirá qué cubre tu embudo',
    ]);
    fireEvent.click(tries[0]);
    expect(input.onGoTo).toHaveBeenCalledWith('dna');
    fireEvent.click(tries[1]);
    expect(input.onNewWork).toHaveBeenCalledTimes(1);
    fireEvent.click(tries[3]);
    expect(input.onGoTo).toHaveBeenCalledWith('funnel');
  });

  it('"Aprobá una pieza" abre la pieza que pide revisión', () => {
    const input = props({
      dna: dna(),
      // Sin documento aprobado el paso sigue pendiente, y en revisión está 'x'.
      documents: [doc({ id: 'x', status: 'review' })],
    });
    const { container } = mount(input);
    const tries = [...container.querySelectorAll<HTMLButtonElement>('.first-step-try')];
    fireEvent.click(tries[1]);
    expect(input.onOpenDocument).toHaveBeenCalledWith('x');
  });
});
