import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { I18nProvider, formatMessage } from './i18n';
import { ActiveTeamsStrip } from './ActiveTeamsStrip';
import type { CoordinationActiveRunSummary } from '../shared/contracts';

/**
 * LA TIRA DE EQUIPOS ACTIVOS, CON LA ANATOMÍA DE FILA DE LA SUPERFICIE DE EQUIPO.
 *
 * La tira es un sidebar strip bajo el `<select>` de marca en `src/App.tsx`,
 * alimentado por `listActiveCoordinationRuns()`. OBSERVA y NAVEGA: tocar una
 * fila abre el modo Equipo de ese Trabajo, donde viven los controles de
 * verdad. Nunca aprueba ni rechaza nada — la separación
 * propose/approve/execute/verify de `AGENTS.md`.
 *
 * H2: Y NO CRECE HASTA EL INFINITO.
 *
 * Pintaba cada equipo en CUATRO renglones (marca / trabajo / estado / conteo),
 * sin tope y con los runs ya terminados adentro: con tres o cuatro equipos
 * empujaba "Inicio" fuera de la pantalla. Tres decisiones:
 *
 *  1. un renglón por equipo (dos líneas como máximo: trabajo, y la marca
 *     abajo), con el estado como SEÑAL —un punto— y el conteo en mono;
 *  2. sólo lo VIVO. Un run `done` o `cancelled` no es un equipo activo: su
 *     lugar es Inicio, que es donde se cuenta lo que pasó. D18 los había
 *     metido acá para que Inicio pudiera decir "tu equipo terminó"; esa
 *     fuente sigue trayéndolos —`listActiveCoordinationRuns` en el servicio
 *     agrega el último run terminado de cada Trabajo— y la tira los filtra.
 *     El contrato IPC no se toca;
 *  3. tope de tres, y una línea "y N más" que lleva a Inicio.
 */

const run = (patch: Partial<CoordinationActiveRunSummary> = {}): CoordinationActiveRunSummary => ({
  runId: 'run1', workId: 'w1', workTitle: 'Lanzamiento', brandId: 'b1', brandName: 'Casa Oliva',
  status: 'running', dispatchesUsed: 3, maxDispatches: 10, pendingGates: 0, budgetInvalid: false, updatedAt: '2026-09-02T00:00:00.000Z', lastEventAt: '2026-09-02T00:00:00.000Z', lastSeenAt: null, ...patch,
});

const mount = (runs: readonly CoordinationActiveRunSummary[], onOpen = vi.fn(), onOpenHome = vi.fn()) =>
  ({ onOpen, onOpenHome, ...render(<I18nProvider><ActiveTeamsStrip runs={runs} onOpen={onOpen} onOpenHome={onOpenHome} /></I18nProvider>) });

const rows = (c: HTMLElement) => [...c.querySelectorAll('.active-teams-strip-row')];

describe('la tira de equipos activos: el vacío y la navegación', () => {
  it('con la lista vacía no se dibuja nada — nunca un cero', () => {
    const { container } = mount([]);
    expect(container.querySelector('.active-teams-strip')).toBeNull();
  });

  it('con cero equipos VIVOS tampoco: una sección que sólo tiene runs cerrados no es "equipos activos"', () => {
    const { container } = mount([run({ status: 'done' }), run({ runId: 'r2', status: 'cancelled' })]);
    expect(container.querySelector('.active-teams-strip')).toBeNull();
  });

  it('el título de la sección se queda', () => {
    const { container } = mount([run()]);
    expect(container.querySelector('.document-kicker')!.textContent).toBe('EQUIPOS ACTIVOS');
  });

  it('tocar una fila abre ESE trabajo: la tira no aprueba ni rechaza nada', () => {
    const onOpen = vi.fn();
    const oneRun = run({ runId: 'run-xyz' });
    const { container } = mount([oneRun], onOpen);
    fireEvent.click(rows(container)[0]!);
    expect(onOpen).toHaveBeenCalledWith(oneRun);
    const strip = container.querySelector('.active-teams-strip')!;
    expect(strip.textContent).not.toContain('Aprobar');
    expect(strip.textContent).not.toContain('Rechazar');
  });
});

describe('H2 (a): la anatomía de la fila — estado · nombre · una línea · cuándo', () => {
  it('cada fila es un `<button>`, uno solo por equipo: la fila ES la acción', () => {
    const { container } = mount([run(), run({ runId: 'r2', workId: 'w2', workTitle: 'Otro' })]);
    for (const li of container.querySelectorAll('.active-teams-strip li')) {
      expect(li.querySelectorAll('button')).toHaveLength(1);
      expect(li.querySelector('button')!.className).toContain('active-teams-strip-row');
    }
  });

  it('un punto de estado, el trabajo en una línea, la marca como segunda, y el conteo en mono', () => {
    const { container } = mount([run({ workTitle: 'Lanzamiento', brandName: 'Casa Oliva', dispatchesUsed: 3, maxDispatches: 10 })]);
    const row = rows(container)[0]!;
    expect(row.querySelector('.active-teams-strip-dot')).not.toBeNull();
    expect(row.querySelector('.active-teams-strip-work')!.textContent).toBe('Lanzamiento');
    expect(row.querySelector('.active-teams-strip-brand')!.textContent).toBe('Casa Oliva');
    expect(row.querySelector('.active-teams-strip-budget')!.textContent).toBe('3/10');
  });

  /** Dos líneas por fila: el trabajo y la marca. Ni un renglón más. */
  it('el estado ya no es un renglón de texto: es el punto, y la palabra queda para quien no lo ve', () => {
    const { container } = mount([run()]);
    const row = rows(container)[0]!;
    const status = row.querySelector('.active-teams-strip-status')!;
    expect(status.className).toContain('visually-hidden');
    expect(status.textContent).toBe('En curso');
  });

  it('un equipo que te necesita lo dice con el acento, no con otro renglón visible', () => {
    const { container } = mount([run({ pendingGates: 2 })]);
    const row = rows(container)[0]!;
    expect(row.querySelector('.active-teams-strip-dot')!.getAttribute('data-tone')).toBe('needs');
    expect(row.querySelector('.active-teams-strip-gates')!.className).toContain('visually-hidden');
  });

  it('el tono del punto distingue en curso, suspendido y lo que te necesita', () => {
    const tone = (patch: Partial<CoordinationActiveRunSummary>) =>
      rows(mount([run(patch)]).container)[0]!.querySelector('.active-teams-strip-dot')!.getAttribute('data-tone');
    expect(tone({ status: 'running' })).toBe('live');
    expect(tone({ status: 'planning' })).toBe('live');
    expect(tone({ status: 'suspended' })).toBe('idle');
    // Te necesita gana: es lo único de la fila que pide algo de la persona.
    expect(tone({ status: 'suspended', pendingGates: 1 })).toBe('needs');
  });

  it('un presupuesto ilegible NO se dibuja como "∞": eso sería la mentira que el `null` produce', () => {
    const { container } = mount([run({ budgetInvalid: true, maxDispatches: null })]);
    expect(container.querySelector('.active-teams-strip-budget')!.textContent).toBe('Presupuesto ilegible');
  });

  it('sin tope, el infinito es honesto', () => {
    const { container } = mount([run({ maxDispatches: null, dispatchesUsed: 4 })]);
    expect(container.querySelector('.active-teams-strip-budget')!.textContent).toBe('4/∞');
  });
});

describe('H2 (b): sólo lo vivo, y como mucho tres', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => run({ runId: 'r' + i, workId: 'w' + i, workTitle: 'Trabajo ' + i }));

  it('un run cancelado no aparece: su lugar es Inicio', () => {
    const { container } = mount([run({ runId: 'vivo' }), run({ runId: 'muerto', workId: 'w2', status: 'cancelled' })]);
    expect(rows(container)).toHaveLength(1);
    expect(container.querySelector('.active-teams-strip-work')!.textContent).toBe('Lanzamiento');
  });

  it('un run terminado tampoco', () => {
    const { container } = mount([run({ runId: 'vivo' }), run({ runId: 'listo', workId: 'w2', status: 'done' })]);
    expect(rows(container)).toHaveLength(1);
  });

  it('los tres estados vivos sí: planning, running y suspended', () => {
    const { container } = mount([
      run({ runId: 'a', workId: 'wa', status: 'planning' }),
      run({ runId: 'b', workId: 'wb', status: 'running' }),
      run({ runId: 'c', workId: 'wc', status: 'suspended' }),
    ]);
    expect(rows(container)).toHaveLength(3);
  });

  it('cinco equipos vivos: tres filas y una línea "y 2 más"', () => {
    const { container } = mount(many(5));
    expect(rows(container)).toHaveLength(3);
    expect(container.querySelector('.active-teams-strip-more')!.textContent).toBe('y 2 más');
  });

  it('con tres o menos no hay línea de más: no se inventa un resto que no existe', () => {
    const { container } = mount(many(3));
    expect(container.querySelector('.active-teams-strip-more')).toBeNull();
  });

  it('los terminados no cuentan para el "y N más"', () => {
    const { container } = mount([...many(3), run({ runId: 'x', workId: 'wx', status: 'done' })]);
    expect(container.querySelector('.active-teams-strip-more')).toBeNull();
  });

  it('"y N más" lleva a Inicio, que es donde están todos', () => {
    const onOpenHome = vi.fn();
    const { container } = mount(many(4), vi.fn(), onOpenHome);
    fireEvent.click(container.querySelector('.active-teams-strip-more')!);
    expect(onOpenHome).toHaveBeenCalled();
  });

  it('la copia existe en los dos idiomas, con el plural de cada uno', () => {
    expect(formatMessage('es-AR', 'coordination.teams.more', { count: 2 })).toBe('y 2 más');
    expect(formatMessage('es-AR', 'coordination.teams.more', { count: 1 })).toBe('y 1 más');
    expect(formatMessage('en-US', 'coordination.teams.more', { count: 2 })).toBe('and 2 more');
    expect(formatMessage('en-US', 'coordination.teams.more', { count: 1 })).toBe('and 1 more');
  });
});
