import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { MemoryNotice } from './MemoryNotice';
import type { CoordinationMemberSupport } from '../shared/contracts';

/**
 * The memory notice (autonomous-coordination Phase 7 task 7.10): engram is
 * part of the promise, so its absence is a Brand-level fact, not a
 * per-member footnote. ONE notice per Brand on `engram_not_installed`, with
 * a link to install instructions, dismissible, returning next launch (a
 * fresh session's own React state) while the condition holds. The body says
 * what the person LOSES, not that a binary is missing.
 */

const row = (patch: Partial<CoordinationMemberSupport> = {}): CoordinationMemberSupport => ({
  memberId: 'm1', canPropose: true, memoryInjected: true, reason: null, runtimeConfirmed: true, runtimeReportsInjection: true, ...patch,
});

const mount = (support: readonly CoordinationMemberSupport[], patch: Record<string, unknown> = {}) => {
  const onDismiss = vi.fn();
  const result = render(<I18nProvider><MemoryNotice support={support} dismissed={false} onDismiss={onDismiss} {...patch} /></I18nProvider>);
  return { onDismiss, ...result };
};

describe('the memory notice (task 7.10)', () => {
  it('renders nothing when engram is present for every member', () => {
    const { container } = mount([row({ memoryInjected: true, reason: null })]);
    expect(container.querySelector('.memory-notice')).toBeNull();
  });

  it('renders exactly ONE notice for a Work with four affected members — never one per member', () => {
    const support = Array.from({ length: 4 }, (_, i) => row({ memberId: `m${i}`, memoryInjected: false, reason: 'engram_not_installed' }));
    const { container } = mount(support);
    expect(container.querySelectorAll('.memory-notice').length).toBe(1);
  });

  it('says what the person loses, never only that a binary is missing', () => {
    const { container } = mount([row({ memoryInjected: false, reason: 'engram_not_installed' })]);
    const text = container.querySelector('.memory-notice')!.textContent!;
    expect(text).toContain('arranca de cero');
    expect(text).toContain('no ve lo que los demás ya decidieron');
  });

  it('links to install instructions', () => {
    const { container } = mount([row({ memoryInjected: false, reason: 'engram_not_installed' })]);
    const link = container.querySelector('.memory-notice a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toMatch(/^https:\/\//);
  });

  it('is dismissible', () => {
    const { container, onDismiss } = mount([row({ memoryInjected: false, reason: 'engram_not_installed' })]);
    fireEvent.click(container.querySelector('.memory-notice-dismiss')!);
    expect(onDismiss).toHaveBeenCalled();
  });

  it('renders nothing once dismissed, even while the condition holds', () => {
    const { container } = mount([row({ memoryInjected: false, reason: 'engram_not_installed' })], { dismissed: true });
    expect(container.querySelector('.memory-notice')).toBeNull();
  });

  it('appears even when every member is coordination-degraded for an unrelated reason (coordination off/blocked) — memory ships independently', () => {
    const support = [
      row({ memberId: 'm1', canPropose: false, reason: 'codex_run_cap', memoryInjected: true }),
      row({ memberId: 'm2', canPropose: false, reason: 'engram_not_installed', memoryInjected: false }),
    ];
    const { container } = mount(support);
    expect(container.querySelector('.memory-notice')).not.toBeNull();
  });

  /**
   * Entrega 1C (tarea 3): en modo simple la razón de infraestructura ("falta
   * el binario «engram»") queda detrás de un detalle avanzado; el cuerpo
   * principal dice en términos de negocio que la memoria no está activa. El
   * modo avanzado no cambia — es el mismo texto de siempre, sin plegar.
   */
  it('simple mode: business wording up front, the binary/technical reason only behind an advanced detail', () => {
    const { container } = mount([row({ memoryInjected: false, reason: 'engram_not_installed' })], { mode: 'simple' });
    const notice = container.querySelector('.memory-notice')!;
    // El cuerpo principal es EXACTAMENTE la frase de negocio — ahí no puede
    // decir "binario"; la palabra sólo aparece detrás del detalle avanzado.
    const mainBody = notice.querySelector('p')!;
    expect(mainBody.textContent).toBe('La memoria de marca no está activa en este equipo. Cada miembro arranca de cero y no ve lo que los demás ya decidieron.');
    const detail = notice.querySelector('.memory-notice-detail')!;
    expect(detail).not.toBeNull();
    expect(detail.textContent).toContain('binario «engram»');
  });

  it('advanced mode: keeps today\'s exact behavior, no collapsed detail', () => {
    const { container } = mount([row({ memoryInjected: false, reason: 'engram_not_installed' })], { mode: 'advanced' });
    const notice = container.querySelector('.memory-notice')!;
    expect(notice.textContent).toContain('Falta el binario «engram»');
    expect(notice.querySelector('.memory-notice-detail')).toBeNull();
  });

  // Locale-mutating: kept LAST in the file (like the rest of this repo's i18n
  // tests), since `document.documentElement.lang` is jsdom-global per file
  // and only gets reset by leaving it for the last test to touch.
  it('renders the same notice in English, with nothing left in Spanish', async () => {
    localStorage.setItem('latte-ui-locale', 'en-US');
    const { container } = render(<I18nProvider><MemoryNotice support={[row({ memoryInjected: false, reason: 'engram_not_installed' })]} dismissed={false} onDismiss={() => {}} /></I18nProvider>);
    await waitFor(() => expect(container.querySelector('.memory-notice')?.textContent).toContain('Brand memory is not available'));
    localStorage.removeItem('latte-ui-locale');
  });
});
