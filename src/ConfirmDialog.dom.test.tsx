import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * `ConfirmDialog`: the in-app replacement for `window.confirm`, used for the
 * destructive actions that used to fire straight from the native dialog
 * (Entrega 0, task 3: "Cancelar" on a team run). Same `useModalA11y` wiring
 * every other dialog gets — this file exercises the component on its own.
 */

const mount = (patch: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const result = render(<I18nProvider><ConfirmDialog
    titleId="t1" title="Cancelar este equipo" body="No se puede deshacer." confirmLabel="Cancelar equipo"
    onConfirm={onConfirm} onCancel={onCancel} {...patch} /></I18nProvider>);
  return { onConfirm, onCancel, ...result };
};

describe('ConfirmDialog', () => {
  it('is role="dialog" aria-modal, labelled by its title, and states the consequence in the body', () => {
    const { container } = mount();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('t1');
    expect(dialog.querySelector('#t1')!.textContent).toBe('Cancelar este equipo');
    expect(dialog.textContent).toContain('No se puede deshacer.');
  });

  it('labels the confirming button with the action itself, never a generic OK', () => {
    const { getByText } = mount({ confirmLabel: 'Cancelar equipo' });
    expect(getByText('Cancelar equipo').tagName).toBe('BUTTON');
  });

  it('calls onConfirm when the action button is clicked', () => {
    const { container, onConfirm, onCancel } = mount();
    fireEvent.click(container.querySelector('.danger, .primary')!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('uses the .danger button class when destructive, .primary otherwise', () => {
    const destructive = mount({ destructive: true });
    expect(destructive.container.querySelector('button.danger')).not.toBeNull();
    destructive.unmount();
    const soft = mount({ destructive: false });
    expect(soft.container.querySelector('button.primary')).not.toBeNull();
    expect(soft.container.querySelector('button.danger')).toBeNull();
  });

  it('Escape and the close button both call onCancel; clicking the confirm button never does', () => {
    const { container, onCancel } = mount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    const { container: c2, onCancel: onCancel2 } = mount();
    fireEvent.click(c2.querySelector('.modal-close')!);
    expect(onCancel2).toHaveBeenCalledTimes(1);
  });

  it('while busy: Escape does nothing, and both buttons are disabled', () => {
    const { container, onCancel, onConfirm } = mount({ busy: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    const buttons = container.querySelectorAll('button');
    buttons.forEach(b => expect(b.disabled).toBe(true));
    fireEvent.click(container.querySelector('.danger, .primary')!);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('focuses a control inside the dialog as soon as it mounts', () => {
    const { container } = mount();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
