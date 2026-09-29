import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Brand, BrandDnaBuildJob, BrandDnaBuildStep } from '../shared/contracts';
import { resetBrandDnaPreview, setBrandDnaPreviewStepMs } from './browser-api';
import { I18nProvider } from './i18n';
import { BrandDnaPanel } from './BrandDnaPanel';
import { BrandDnaView } from './BrandDnaView';

/**
 * K1 · LOS PASOS DEL BUILD EN LA PANTALLA.
 *
 * Tres promesas del encargo, probadas donde viven:
 *
 * 1. Sólo se ven los pasos que se pidieron — `sources` con la web son DOS
 *    filas, sin una sola "Omitido".
 * 2. Lo que el motor escribe para sí mismo (`detail`) no se muestra: va en un
 *    "Ver detalle" plegado, y mientras el paso corre la fila habla de negocio.
 * 3. Un build que no cambia en tres minutos lo DICE, con "Reintentar" y
 *    "Cancelar" — con reloj falso, para que el test dure milisegundos.
 */

const brand: Brand = { id: 'b1', name: 'Casa Oliva', context: '', createdAt: '2026-09-01T00:00:00.000Z', archivedAt: null };

const mountView = () => render(
  <I18nProvider><BrandDnaView brand={brand} formatDate={(value) => value.slice(0, 10)} /></I18nProvider>,
);

const mountPanel = (job: BrandDnaBuildJob, extra: { stale?: boolean; onRetry?: () => void; onCancel?: () => void } = {}) => render(
  <I18nProvider>
    <BrandDnaPanel brandName={brand.name} job={job} dna={null} stale={extra.stale} onRetry={extra.onRetry} onCancel={extra.onCancel} />
  </I18nProvider>,
);

const keysOf = (container: HTMLElement) => [...container.querySelectorAll('.dna-step')].map((step) => step.getAttribute('data-key'));

describe('los pasos del ADN · sólo lo que se pidió', () => {
  beforeEach(() => {
    localStorage.clear();
    setBrandDnaPreviewStepMs(0);
    resetBrandDnaPreview();
  });
  afterEach(() => { cleanup(); });

  it('en modo sources con sólo la web se ven dos pasos: la web y la ficha, sin "Omitido"', async () => {
    const { container } = mountView();
    fireEvent.click(screen.getByRole('button', { name: /Sumar fuentes/ }));
    fireEvent.change(screen.getByPlaceholderText('https://tuweb.com'), { target: { value: 'https://casoliva.com.ar' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Armar mi marca/ })); });

    expect(keysOf(container)).toEqual(['web', 'compose']);
    expect(container.textContent).not.toContain('Omitido');
    expect(container.querySelectorAll('[data-state="skipped"]')).toHaveLength(0);
    // Cada fila se narra con palabra, no sólo con color.
    expect(container.querySelectorAll('.dna-step-state').length).toBe(2);
    for (const state of container.querySelectorAll('.dna-step-state')) expect(state.textContent).toBeTruthy();
  });

  it('el detalle del motor queda plegado tras "Ver detalle", y mientras corre la fila habla de negocio', () => {
    const job: BrandDnaBuildJob = {
      jobId: 'bdj_test',
      brandId: brand.id,
      mode: 'sources',
      steps: [
        { key: 'web', state: 'pending', detail: 'El agente tiene que leer https://casoliva.com.ar' },
        { key: 'compose', state: 'running', detail: 'El equipo está componiendo el ADN' },
      ],
      done: false,
      outcome: null,
      reason: null,
    };
    const { container } = mountPanel(job);

    expect(keysOf(container)).toEqual(['web', 'compose']);
    expect(container.querySelector('.dna-step-label')!.textContent, 'el agente lee la web mientras arma la ficha').toBe('Leyendo tu web');
    expect(container.textContent, 'el detalle no se muestra por defecto').not.toContain('El agente tiene que leer');
    expect(container.textContent, 'el paso que corre se narra en negocio').toContain('Armando la ficha');

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
    expect(container.textContent).toContain('El agente tiene que leer https://casoliva.com.ar');
    expect(container.textContent).toContain('El equipo está componiendo el ADN');
    expect(screen.getByRole('button', { name: 'Ocultar detalle' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Ocultar detalle' }));
    expect(container.textContent).not.toContain('El agente tiene que leer');
  });

  it('mientras la ficha corre hay señal de vida: la taza se mueve, el reloj avanza y las fuentes pendientes se ven en curso', () => {
    vi.useFakeTimers();
    try {
      const job: BrandDnaBuildJob = {
        jobId: 'bdj_vida',
        brandId: brand.id,
        mode: 'sources',
        steps: [
          { key: 'web', state: 'pending', detail: null },
          { key: 'channels', state: 'pending', detail: null },
          { key: 'files', state: 'done', detail: null },
          { key: 'compose', state: 'running', detail: null },
        ],
        done: false,
        outcome: null,
        reason: null,
      };
      const { container } = mountPanel(job);

      const states = [...container.querySelectorAll('.dna-step')].map((row) => row.getAttribute('data-state'));
      expect(states, 'la web y los canales se leen durante la ficha').toEqual(['running', 'running', 'done', 'running']);
      expect(container.textContent).not.toContain('Pendiente');
      expect(container.querySelectorAll('.dna-step-mark.is-running .loading-cup').length, 'cada paso en curso lleva la taza').toBe(3);

      const elapsed = () => container.querySelector('[data-key="compose"] .dna-step-elapsed')?.textContent;
      expect(elapsed()).toBe(' · 0:00');
      act(() => { vi.advanceTimersByTime(65_000); });
      expect(elapsed(), 'el reloj avanza').toBe(' · 1:05');
    } finally {
      vi.useRealTimers();
    }
  });

  it('en modo ideas el paso único se llama como lo que hace, nunca "La ficha"', () => {
    const ideasJob = (state: BrandDnaBuildStep['state']): BrandDnaBuildJob => ({
      jobId: 'bdj_ideas',
      brandId: brand.id,
      mode: 'ideas',
      steps: [{ key: 'compose', state, detail: null }],
      done: state === 'done',
      outcome: state === 'done' ? 'updated' : null,
      reason: null,
    });

    const pending = mountPanel(ideasJob('pending'));
    expect(keysOf(pending.container)).toEqual(['compose']);
    expect(pending.container.querySelector('.dna-step-label')!.textContent).toBe('Ideas');
    cleanup();

    const running = mountPanel(ideasJob('running'));
    expect(running.container.querySelector('.dna-step-label')!.textContent).toBe('Escribiendo ideas');
  });

  it('un fallo se explica por código, en palabras, y ofrece Reintentar', () => {
    const job: BrandDnaBuildJob = {
      jobId: 'bdj_fallo',
      brandId: brand.id,
      mode: 'sources',
      steps: [
        { key: 'web', state: 'skipped', detail: 'Sin URL para leer' },
        { key: 'compose', state: 'failed', detail: 'No se pudo componer (NOT_INSTALLED)' },
      ],
      done: true,
      outcome: 'failed',
      reason: 'NOT_INSTALLED',
    };
    const onRetry = vi.fn();
    const { container } = mountPanel(job, { onRetry });

    expect(container.querySelector('.dna-build-status')!.textContent).toContain('La construcción terminó con un problema.');
    expect(container.textContent).toContain('Conectá una IA para armar la ficha.');
    expect(container.textContent, 'el código queda para el detalle técnico').not.toContain('NOT_INSTALLED');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('un build demorado ofrece Reintentar y Cancelar, y los dos actúan', () => {
    const job: BrandDnaBuildJob = {
      jobId: 'bdj_quieto',
      brandId: brand.id,
      mode: 'sources',
      steps: [{ key: 'compose', state: 'running', detail: null }],
      done: false,
      outcome: null,
      reason: null,
    };
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    mountPanel(job, { stale: true, onRetry, onCancel });

    expect(screen.getByText('Está tardando más de lo normal.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('si el build no cambia en 3 minutos, el aviso SOLO aparece con el reloj falso', async () => {
    // Un paso que tarda diez minutos: el build no cambia de estado en toda la
    // prueba, que avanza el reloj 180.001 ms de un saque.
    setBrandDnaPreviewStepMs(600_000);
    vi.useFakeTimers();
    try {
      const { container } = mountView();
      fireEvent.click(screen.getByRole('button', { name: /Sumar fuentes/ }));
      fireEvent.change(screen.getByPlaceholderText('https://tuweb.com'), { target: { value: 'https://casoliva.com.ar' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Armar mi marca/ })); });
      expect(keysOf(container)).toEqual(['web', 'compose']);
      expect(screen.queryByText('Está tardando más de lo normal.')).toBeNull();

      // Dos minutos y medio: todavía no.
      act(() => { vi.advanceTimersByTime(150_000); });
      expect(screen.queryByText('Está tardando más de lo normal.')).toBeNull();

      // Pasó el minuto y medio que falta: ahí sí, con las dos salidas.
      act(() => { vi.advanceTimersByTime(30_001); });
      expect(screen.getByText('Está tardando más de lo normal.')).toBeDefined();
      expect(screen.getByRole('button', { name: 'Reintentar' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDefined();

      // Y se apaga en cuanto el build cambia de estado: el primer paso arranca
      // a los 600 s del reloj falso, y lo recoge el sondeo de 1 s — por eso el
      // act es ASÍNCRONO: deja correr esos microtareas antes de mirar.
      await act(async () => { vi.advanceTimersByTime(430_000); });
      expect(screen.queryByText('Está tardando más de lo normal.')).toBeNull();
    } finally {
      vi.useRealTimers();
      setBrandDnaPreviewStepMs(0);
      cleanup();
    }
  });
});
