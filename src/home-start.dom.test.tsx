import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HomeView, type HomeViewProps } from './HomeView';
import { I18nProvider } from './i18n';
import type { Brand, BrandDnaIdea, BrandDnaView, Decision, DocumentState, WorkDocument } from '../shared/contracts';

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
  ideas: [],
  ideasUpdatedAt: null,
  lastSources: null,
  ...patch,
});

const agentIdea = (patch: Partial<BrandDnaIdea> = {}): BrandDnaIdea => ({
  id: 'idea-1',
  title: 'Lanzamiento de la colección de otoño',
  why: 'La colección nueva todavía no tiene campaña.',
  workTypeId: 'campaign-new',
  basedOn: [{ kind: 'document', label: 'brief de primavera' }],
  createdAt: '2026-09-27',
  ...patch,
});

/** Una idea cuyo TIPO no está en el título: sólo el forzado puede hacer que la línea lo diga. */
const auditIdea = (): BrandDnaIdea => agentIdea({
  id: 'idea-auditoria',
  title: 'Revisá las últimas piezas contra el ADN',
  why: 'Dos piezas usan palabras que la marca no usa.',
  workTypeId: 'paid-media-audit',
  basedOn: [{ kind: 'identity', label: 'ADN v1' }],
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

  it('sin ideas del agente, las de respaldo salen del ADN y nada más', () => {
    const { container } = mount(props({ dna: dna() }));
    const items = [...container.querySelectorAll<HTMLButtonElement>('.home-suggest')];
    // Sin fecha comercial ni estación: sólo lo que el ADN de ESTA marca dice.
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThanOrEqual(4);
    const titles = items.map((item) => item.querySelector('strong')!.textContent ?? '');
    expect(titles).toContain('Llevá tu propuesta a cada pieza');
    expect(titles.some((label) => label.startsWith('Contenido de temporada:'))).toBe(false);
    expect(titles.some((label) => /Día de la Madre|Black Friday|Hot Sale/.test(label))).toBe(false);
    // Las de respaldo no llevan la marca de las del agente.
    expect(container.querySelector('.home-ideas-tag')).toBeNull();
    expect(container.querySelector('.home-ideas-head')).toBeNull();
  });

  it('con ideas del agente se muestran ESAS, con la marca discreta y su motivo', () => {
    const { container } = mount(props({ dna: dna({ ideas: [agentIdea()] }) }));
    const items = [...container.querySelectorAll<HTMLButtonElement>('.home-suggest')];
    expect(items).toHaveLength(1);
    expect(items[0]!.querySelector('strong')!.textContent).toBe('Lanzamiento de la colección de otoño');
    expect(items[0]!.querySelector('small')!.textContent).toBe('La colección nueva todavía no tiene campaña.');
    expect(items[0]!.querySelector('.home-ideas-tag')!.textContent).toBe('Idea de Latte');
    // Las del agente reemplazan a las de respaldo, no se suman.
    expect(container.textContent).not.toContain('Contenido de temporada:');
  });

  it('tocar una idea llena la caja con el título y se arma con el TIPO de la idea', () => {
    const input = props({ dna: dna({ ideas: [auditIdea()] }) });
    mount(input);
    const item = [...document.querySelectorAll<HTMLButtonElement>('.home-suggest')][0]!;
    fireEvent.click(item);
    expect(box().value).toBe('Revisá las últimas piezas contra el ADN');
    // El tipo de la IDEA manda, aunque las palabras del título no lo digan.
    expect(document.querySelector('.home-ask-classify')!.textContent).toContain('Se arma como Análisis de paid media');
    // Y el envío cumple lo que la línea mostró.
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(input.onStartWork).toHaveBeenCalledWith('Revisá las últimas piezas contra el ADN', 'paid-media-audit');
    expect(box().value).toBe('');
  });

  it('reescribir la caja suelta el tipo de la idea y vuelve a clasificar por palabras', () => {
    const input = props({ dna: dna({ ideas: [auditIdea()] }) });
    mount(input);
    fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('.home-suggest')][0]!);
    fireEvent.change(box(), { target: { value: 'Armame una campaña para primavera' } });
    expect(document.querySelector('.home-ask-classify')!.textContent).toContain('Se arma como Campaña nueva');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(input.onStartWork).toHaveBeenCalledWith('Armame una campaña para primavera');
  });

  it('sin IA el botón de ideas se deshabilita con su motivo en una línea', () => {
    const { container } = mount(props({ onRefreshIdeas: vi.fn(), ideasReady: false }));
    const head = container.querySelector('.home-ideas-head')!;
    const button = screen.getByRole('button', { name: /Actualizar ideas/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('Escribir ideas necesita un agente de IA.');
    // El encabezado de sección: título a la izquierda, el botón chico a su derecha
    // y el motivo como línea de la misma caja, nunca suelto arriba de la grilla.
    expect(head.querySelector('.home-ideas-title')!.textContent).toBe('Ideas para empezar');
    expect([...head.children].map((child) => child.className)).toEqual(['home-ideas-title', 'subtle home-ideas-refresh', 'home-ideas-note']);
    expect(head.querySelector('.home-ideas-note')!.textContent).toBe('Escribir ideas necesita un agente de IA.');
    // Y también como tooltip del botón que no se puede apretar.
    expect(button.title).toBe('Escribir ideas necesita un agente de IA.');
  });

  it('con el botón disponible el encabezado queda sólo con su título', () => {
    const { container } = mount(props({ onRefreshIdeas: vi.fn(), ideasReady: true }));
    const head = container.querySelector('.home-ideas-head')!;
    expect([...head.children].map((child) => child.className)).toEqual(['home-ideas-title', 'subtle home-ideas-refresh']);
    expect(head.querySelector('.home-ideas-note')).toBeNull();
  });

  it('con ideas en vuelo el botón muestra el estado honesto y no se aprieta de nuevo', () => {
    const onRefreshIdeas = vi.fn();
    const job = {
      jobId: 'bdj_live', brandId: 'b1', mode: 'ideas' as const,
      steps: [{ key: 'compose' as const, state: 'running' as const, detail: null }],
      done: false, outcome: null, reason: null,
    };
    mount(props({ onRefreshIdeas, ideasReady: true, ideasJob: job }));
    const button = screen.getByRole('button', { name: /Actualizando las ideas/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onRefreshIdeas).not.toHaveBeenCalled();
  });

  it('un build que falló dice el código, y el botón vuelve a estar disponible', () => {
    const onRefreshIdeas = vi.fn();
    const { container } = mount(props({
      onRefreshIdeas,
      ideasReady: true,
      ideasJob: {
        jobId: 'bdj_failed', brandId: 'b1', mode: 'ideas' as const,
        steps: [{ key: 'compose' as const, state: 'failed' as const, detail: 'No se pudo componer (NOT_INSTALLED)' }],
        done: true, outcome: 'failed', reason: 'NOT_INSTALLED',
      },
    }));
    expect(container.textContent).toContain('No se pudieron actualizar las ideas (NOT_INSTALLED).');
    const button = screen.getByRole('button', { name: /Actualizar ideas/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onRefreshIdeas).toHaveBeenCalledTimes(1);
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
    // El color no es la única señal: distingue la tilde/círculo, y el estado
    // sigue en el árbol para lectores de pantalla aunque no se pinte.
    expect(steps[0].querySelector('.first-step-state')!.textContent).toBe('Listo');
    expect(steps[0].querySelector('.first-step-state')!.className).toContain('visually-hidden');
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
