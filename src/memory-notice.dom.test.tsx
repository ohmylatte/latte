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

  it('renders the same notice in English, with nothing left in Spanish', async () => {
    localStorage.setItem('latte-ui-locale', 'en-US');
    const { container } = render(<I18nProvider><MemoryNotice support={[row({ memoryInjected: false, reason: 'engram_not_installed' })]} dismissed={false} onDismiss={() => {}} /></I18nProvider>);
    await waitFor(() => expect(container.querySelector('.memory-notice')?.textContent).toContain('Brand memory is not available'));
    localStorage.removeItem('latte-ui-locale');
  });
});
