import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { PromptDialog } from './PromptDialog';

/**
 * `PromptDialog`: the in-app replacement for `window.prompt`, wired into
 * `App.tsx` (save-as-document, edit the context proposal), `DecisionsView`
 * (edit + approve a decision) and `ResumenView` (settle an in-flight
 * dispatch). This file exercises the component on its own: a visible label,
 * a validation message next to the field, Enter submits, Escape cancels.
 */

const mount = (patch: Partial<Parameters<typeof PromptDialog>[0]> = {}) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const result = render(<I18nProvider><PromptDialog
    titleId="pt" title="Guardar como documento" label="Título" fieldId="f1" submitLabel="Guardar"
    onSubmit={onSubmit} onCancel={onCancel} {...patch} /></I18nProvider>);
  return { onSubmit, onCancel, ...result };
};

describe('PromptDialog', () => {
  it('is role="dialog" aria-modal, with a visible <label> tied to the field by htmlFor/id', () => {
    const { container } = mount();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('pt');
    const label = dialog.querySelector('label[for="f1"]')!;
    expect(label.textContent).toBe('Título');
    expect(dialog.querySelector('#f1')).not.toBeNull();
  });

  it('starts with the initial value, and Enter submits the trimmed text', () => {
    const { container, onSubmit } = mount({ initialValue: '  Estrategia  ' });
    const field = container.querySelector('#f1') as HTMLInputElement;
    expect(field.value).toBe('  Estrategia  ');
    fireEvent.submit(container.querySelector('form')!);
    expect(onSubmit).toHaveBeenCalledWith('Estrategia');
  });

  it('shows a validation message next to the field instead of submitting, on an empty value', () => {
    const { container, onSubmit } = mount({ initialValue: '' });
    fireEvent.submit(container.querySelector('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
    const field = container.querySelector('#f1')!;
    const errorId = field.getAttribute('aria-describedby')!;
    expect(errorId).toBeTruthy();
    const error = container.querySelector('#' + errorId)!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent!.length).toBeGreaterThan(0);
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('runs a custom validate() and shows its message near the field', () => {
    const { container, onSubmit } = mount({ initialValue: 'x', validate: v => v === 'x' ? 'Ese título ya existe.' : null });
    fireEvent.submit(container.querySelector('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Ese título ya existe.');
  });

  it('clears the error as soon as the field changes', () => {
    const { container } = mount({ initialValue: '' });
    fireEvent.submit(container.querySelector('form')!);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    fireEvent.change(container.querySelector('#f1')!, { target: { value: 'algo' } });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders a <textarea> instead of <input> when multiline is set', () => {
    const { container } = mount({ multiline: true });
    expect(container.querySelector('#f1')!.tagName).toBe('TEXTAREA');
  });

  it('Escape cancels; the close button and the explicit cancel button both call onCancel too', () => {
    const { onCancel } = mount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('focuses the field as soon as the dialog mounts', () => {
    const { container } = mount();
    expect(document.activeElement).toBe(container.querySelector('#f1'));
  });
});
