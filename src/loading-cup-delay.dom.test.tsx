import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Loading } from './brand-marks';

/**
 * M2 — "la taza que se llena".
 *
 * La regla del brief es temporal, no visual: la taza REEMPLAZA al spinner
 * sólo en esperas de más de 400 ms. Una espera corta no muestra nada — ni
 * taza, ni parpadeo—, así que el gate vive en el componente y no en cada
 * llamada: un `<Loading>` nuevo sin gate sería otra promesa rota.
 *
 * El loop de 2,6 s y su corte con movimiento reducido se prueban sobre la
 * hoja, en `microinteractions-motion.dom.test.tsx`.
 */

const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

describe('M2 — la taza que se llena', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('una espera más corta que 400 ms no muestra nada', () => {
    const { container } = render(<Loading size={32} label="Abriendo el documento…" />);
    expect(container.querySelector('.loading-cup')).toBeNull();
    act(() => { vi.advanceTimersByTime(399); });
    expect(container.querySelector('.loading-cup')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('pasados los 400 ms aparece, con role="status" y el texto de qué se carga', () => {
    const { container } = render(<Loading size={32} label="Abriendo el documento…" />);
    act(() => { vi.advanceTimersByTime(400); });
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.getAttribute('aria-label')).toBe('Abriendo el documento…');
    expect(status!.querySelector('.visually-hidden')!.textContent).toBe('Abriendo el documento…');
    expect(status!.querySelector('.loading-cup-coffee')).not.toBeNull();
  });

  it('los tres tamaños del brief: 16 en botones, 32 en paneles, 64 en vacíos', () => {
    for (const size of [16, 32, 64]) {
      const { container, unmount } = render(<Loading size={size} label={'carga ' + size} />);
      expect(container.querySelector('.loading-cup')).toBeNull();
      act(() => { vi.advanceTimersByTime(400); });
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('width')).toBe(String(size));
      expect(svg.getAttribute('height')).toBe(String(size));
      unmount();
    }
  });

  it('se va entera al desmontar: no deja temporizadores colgados', () => {
    const { container, unmount } = render(<Loading size={16} label="Guardando" />);
    unmount();
    expect(container.querySelector('.loading-cup')).toBeNull();
    // Un tick largo después de desmontar no revive la taza.
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(container.querySelector('.loading-cup')).toBeNull();
  });

  it('la hoja la anima en un loop de 2,6 s y la corta con movimiento reducido', () => {
    expect(css).toMatch(/\.loading-cup-coffee\{[^}]*animation:cup-fill 2\.6s/);
    expect(css).toMatch(/@keyframes cup-fill\{/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\{\.loading-cup-coffee\{animation:none\}\}/,
    );
  });
});
