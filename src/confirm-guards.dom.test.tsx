import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { api } from './browser-api';
import { I18nProvider } from './i18n';

/**
 * 2.0 · los `window.confirm` que quedaban, ahora son diálogo de la app.
 *
 * Dos comportamientos que sólo existen si se mira el flujo entero: el aviso de
 * "salir sin guardar" antes de perder un borrador, y "vaciar contexto" — que
 * antes cortaba el hilo con un diálogo nativo que ni el teclado ni un lector
 * de pantalla pueden leer. En ambos: el diálogo se abre con el TEXTO de hoy,
 * el botón de confirmar lleva el nombre de la acción, y cancelar no ejecuta
 * nada ni pierde el borrador.
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

const mount = () => render(<I18nProvider><App /></I18nProvider>);
const dialogOf = async (container: HTMLElement) => {
  const dialog = await waitFor(() => {
    const found = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(found, 'el diálogo no se abrió').not.toBeNull();
    return found!;
  });
  return dialog;
};
const buttonIn = (dialog: HTMLElement, label: string) =>
  [...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === label);

const goToContext = async (container: HTMLElement) => {
  await screen.findByRole('button', { name: 'Lanzamiento primavera' });
  fireEvent.click(screen.getByRole('button', { name: 'Contexto' }));
  const draft = await waitFor(() => {
    const area = container.querySelector<HTMLTextAreaElement>('#brand-context');
    expect(area, 'no abrió Contexto').not.toBeNull();
    return area!;
  });
  return draft;
};

describe('2.0 · salir sin guardar', () => {
  it('al abrir un trabajo con cambios sin guardar avisa, y confirmar recién ahí navega', async () => {
    const { container } = mount();
    const draft = await goToContext(container);
    fireEvent.change(draft, { target: { value: 'borrador que todavía no guardé' } });

    fireEvent.click(screen.getByRole('button', { name: 'Lanzamiento primavera' }));
    const dialog = await dialogOf(container);
    expect(dialog.textContent).toContain('Tenés cambios sin guardar. ¿Querés descartarlos?');
    expect(buttonIn(dialog, 'Salir sin guardar'), 'el botón de confirmar no nombra la acción').toBeTruthy();
    expect(buttonIn(dialog, 'Cancelar')).toBeTruthy();

    fireEvent.click(buttonIn(dialog, 'Salir sin guardar')!);
    await waitFor(() => expect(container.querySelector('.tabs')).not.toBeNull());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('cancelar cierra el diálogo, no navega y conserva el borrador', async () => {
    const { container } = mount();
    const draft = await goToContext(container);
    fireEvent.change(draft, { target: { value: 'borrador que todavía no guardé' } });

    fireEvent.click(screen.getByRole('button', { name: 'Lanzamiento primavera' }));
    const dialog = await dialogOf(container);
    fireEvent.click(buttonIn(dialog, 'Cancelar')!);

    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
    // Seguir en Contexto ES no haber navegado: la barra de pestañas sólo
    // existe dentro de un trabajo, y acá la pantalla sigue siendo ésta.
    expect(container.querySelector('#brand-context'), 'navegó igual').not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('#brand-context')!.value).toBe('borrador que todavía no guardé');
  });
});

describe('2.0 · vaciar contexto', () => {
  it('es un diálogo con la acción por nombre; recién confirmar escribe', async () => {
    const { container } = mount();
    await goToContext(container);
    const before = container.querySelector<HTMLTextAreaElement>('#brand-context')!.value;
    expect(before.trim().length, 'la marca de prueba necesita contexto para poder vaciarlo').toBeGreaterThan(0);
    const clear = vi.spyOn(api, 'clearBrandContext');

    fireEvent.click(screen.getByRole('button', { name: 'Vaciar contexto' }));
    const dialog = await dialogOf(container);
    expect(dialog.textContent).toContain('¿Vaciar el contexto de marca? Queda en el historial y podés restaurarlo.');
    expect(buttonIn(dialog, 'Vaciar contexto'), 'el botón de confirmar no nombra la acción').toBeTruthy();
    expect(dialog.querySelector('button.danger'), 'vaciar es destructivo').not.toBeNull();
    expect(clear, 'el diálogo no debería haber escrito todavía').not.toHaveBeenCalled();

    fireEvent.click(buttonIn(dialog, 'Cancelar')!);
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
    expect(clear, 'cancelar vació igual').not.toHaveBeenCalled();
    expect(container.querySelector<HTMLTextAreaElement>('#brand-context')!.value).toBe(before);

    clear.mockRestore();
  });
});
