import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { I18nProvider } from './i18n';

/**
 * 2.0 · la tira de pestañas a 1024 px.
 *
 * A la ventana mínima las siete pestañas miden 720 px y el espacio es 479: dos
 * quedaban FUERA del borde y ninguna se alcanzaba con el teclado. La solución
 * es scroll horizontal, y un scroll sólo sirve si se llega a todo lo que
 * esconde — con Tab (cada pestaña sigue siendo un botón nativo, sin
 * `tabindex="-1"`) y con las flechas dentro de la tira.
 */

configure({ asyncUtilTimeout: 5_000 });

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
    },
  };
});

/** Cada pestaña de la tira, con la de los contadores por su rótulo base. */
const TABS = ['Resumen', 'Trabajo', 'Evidencia', 'Documentos', 'Embudo', 'Decisiones', 'Resultados'];

const tab = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.tabs button')]
    .find((button) => button.textContent?.startsWith(name)) as HTMLButtonElement;

async function enterWork(container: HTMLElement) {
  await screen.findByRole('button', { name: 'Lanzamiento primavera' });
  fireEvent.click(container.querySelector<HTMLButtonElement>('.home-continue .home-row')!);
  await waitFor(() => expect(container.querySelector('.tabs')).not.toBeNull());
}

describe('2.0 · la tira de pestañas con el teclado', () => {
  it('las siete pestañas están, en orden, y ninguna sale del orden de Tab', async () => {
    const { container } = mount();
    await enterWork(container);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.tabs button')];
    expect(buttons.map((b) => b.textContent?.trim().split(' ')[0])).toEqual(TABS);
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('tabindex'), `${button.textContent} quedó fuera del orden de Tab`).toBeNull();
      expect(button.disabled).toBe(false);
    }
  });

  it('las flechas mueven el foco dentro de la tira, y envuelven en los extremos', async () => {
    const { container } = mount();
    await enterWork(container);
    const strip = container.querySelector<HTMLElement>('.tabs')!;
    const first = tab(container, 'Resumen');

    first.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(document.activeElement, 'ArrowRight no avanzó').toBe(tab(container, 'Trabajo'));
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab(container, 'Evidencia'));
    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    expect(document.activeElement, 'ArrowLeft no volvió').toBe(tab(container, 'Trabajo'));

    // Desde la primera, la izquierda va a la última: ninguna queda inalcanzable.
    tab(container, 'Resumen').focus();
    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab(container, 'Resultados'));

    fireEvent.keyDown(strip, { key: 'Home' });
    expect(document.activeElement, 'Home no llevó al principio').toBe(tab(container, 'Resumen'));
    fireEvent.keyDown(strip, { key: 'End' });
    expect(document.activeElement, 'End no llevó al final').toBe(tab(container, 'Resultados'));
  });

  it('las pestañas que estaban fuera del borde quedan enfocables: se puede llegar a Decisiones y Resultados', async () => {
    const { container } = mount();
    await enterWork(container);
    for (const name of ['Embudo', 'Decisiones', 'Resultados']) {
      const button = tab(container, name);
      expect(button, `falta la pestaña ${name}`).toBeTruthy();
      button.focus();
      expect(document.activeElement, `${name} no acepta el foco`).toBe(button);
      fireEvent.click(button);
      await waitFor(() => expect(tab(container, name).className).toContain('selected'));
    }
  });

  it('las flechas sólo se toman dentro de la tira: ajenas a ella siguen siendo del usuario', async () => {
    const { container } = mount();
    await enterWork(container);
    const first = tab(container, 'Resumen');
    first.focus();
    // El teclado sólo pasa por la tira cuando el foco está en una de sus filas.
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(document.activeElement, 'la tira robó una tecla que no era suya').toBe(first);
    fireEvent.keyDown(document.body, { key: 'End' });
    expect(document.activeElement).toBe(first);
  });
});

function mount() {
  return render(<I18nProvider><App /></I18nProvider>);
}
