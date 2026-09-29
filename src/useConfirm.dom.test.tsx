import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { useConfirm, type ConfirmRequest } from './useConfirm';

/**
 * `useConfirm`: el reemplazo de `window.confirm` (2.0 · ventana mínima, menor 7).
 *
 * `window.confirm` es síncrono y bloquea el hilo: no se puede animar, no se
 * puede probar con el teclado y ningún lector de pantalla lo anuncia — más
 * todavía, en la app el resultado se tomaba EN EL MISMO REGLÓN
 * (`if (!confirm(...)) return;`), que es exactamente lo que no se puede hacer
 * con un diálogo de la app, que responde después.
 *
 * Por eso el contrato es una promesa: `confirm(request)` devuelve `true` si la
 * persona confirmó y `false` si canceló, si apretó Escape, o si el componente
 * se fue del medio — nunca queda un `await` colgado. El diálogo sale listo
 * para poner en el JSX con `dialog`, y es el `ConfirmDialog` compartido.
 */

interface HarnessApi {
  request: (patch?: Partial<ConfirmRequest>) => Promise<boolean>;
  open: boolean;
}

let api: HarnessApi | null = null;

function Harness() {
  const { confirm, dialog, open } = useConfirm();
  api = {
    request: (patch) => confirm({
      title: 'Vaciar contexto',
      body: '¿Vaciar el contexto de marca? Queda en el historial y podés restaurarlo.',
      confirmLabel: 'Vaciar contexto',
      destructive: true,
      ...patch,
    }),
    open,
  };
  return <div>{dialog}</div>;
}

const waitForOpen = async (open: boolean) => waitFor(() => expect(api!.open).toBe(open));

const answer = (value: boolean) => {
  const label = value ? 'Vaciar contexto' : 'Cancelar';
  const button = [...document.querySelectorAll('[role="dialog"] button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  fireEvent.click(button!);
};

describe('useConfirm', () => {
  it('abre el diálogo con el título, la consecuencia y el botón con el nombre de la acción', async () => {
    render(<I18nProvider><Harness /></I18nProvider>);
    const request = api!.request();
    await waitForOpen(true);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('h2')!.textContent).toBe('Vaciar contexto');
    expect(dialog.textContent).toContain('¿Vaciar el contexto de marca?');
    const confirmButton = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Vaciar contexto')!;
    expect(confirmButton.className).toContain('danger');
    answer(false);
    await expect(request).resolves.toBe(false);
  });

  it('confirmar resuelve true y cierra el diálogo', async () => {
    render(<I18nProvider><Harness /></I18nProvider>);
    const request = api!.request();
    await waitForOpen(true);
    answer(true);
    await expect(request).resolves.toBe(true);
    await waitForOpen(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Escape y el botón de cerrar resuelven false sin ejecutar nada', async () => {
    render(<I18nProvider><Harness /></I18nProvider>);
    const byEscape = api!.request();
    await waitForOpen(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(byEscape).resolves.toBe(false);
    await waitForOpen(false);

    const byClose = api!.request();
    await waitForOpen(true);
    fireEvent.click(document.querySelector('.modal-close')!);
    await expect(byClose).resolves.toBe(false);
  });

  it('una petición tras otra abre de nuevo: nada queda colgado', async () => {
    render(<I18nProvider><Harness /></I18nProvider>);
    const first = api!.request();
    await waitForOpen(true);
    answer(true);
    await expect(first).resolves.toBe(true);

    const second = api!.request({ confirmLabel: 'Restaurar' });
    await waitForOpen(true);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Restaurar');
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(second).resolves.toBe(false);
  });

  it('al desmontar con una petición abierta resuelve false: ningún await queda colgado', async () => {
    const { unmount } = render(<I18nProvider><Harness /></I18nProvider>);
    const request = api!.request();
    unmount();
    await expect(request).resolves.toBe(false);
  });

  it('no llama a window.confirm en ninguna rama', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<I18nProvider><Harness /></I18nProvider>);
    const request = api!.request();
    await waitForOpen(true);
    answer(true);
    await expect(request).resolves.toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
