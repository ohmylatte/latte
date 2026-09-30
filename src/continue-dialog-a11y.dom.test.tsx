import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { TeamPanel } from './TeamPanel';
import { EMPTY_USAGE, type AgentRole, type TeamMember } from '../shared/contracts';

/**
 * `ContinueDialog` ("Continuar con otro agente") used to trap Escape with a
 * hand-rolled `onKeyDown` on the dialog itself, and had no focus trap at all.
 * Entrega 0 (task 1) moves it onto the shared `useModalA11y` hook — this was
 * previously untested, so this file covers it directly.
 */

const roles: AgentRole[] = [
  { id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Decide', builtin: false, tier: 'deep', avatar: null },
];
const seated: TeamMember = {
  id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E', avatar: null,
  runtime: 'opencode', model: null, accountId: null, label: 'OpenCode', status: 'idle',
  tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
};

const panel = () => render(<TeamPanel
  work={{ id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', folder: null, updatedAt: '' }}
  team={[seated]} chats={{}} selectedId="m1" roles={roles}
  primaryLabel="OpenCode" primaryDetail="Listo" primaryReady checking={false}
  primaryRuntime="opencode" primaryAccountId={null} primaryModel={null}
  choices={[]} busy={false} isDesktop
  onSelect={() => {}} onAdd={async () => {}} onOpen={async () => {}} onPause={async () => {}}
  onFinish={async () => {}} onRestart={async () => {}} onContinue={async () => {}}
  handoffs={[]} onAcceptHandoff={async () => {}} onDismissHandoff={async () => {}}
  onRemove={async () => {}} onProviders={() => {}} onRecheck={() => {}} onModel={() => {}} onTier={() => {}}
  onError={() => {}} onAttachFiles={async () => []} untracked={[]} onAdoptFile={() => {}}
  permissions="ask" permissionBusy={false} onPermissions={() => {}}
  mode="simple"
/>);

describe('ContinueDialog picks up the shared modal a11y', () => {
  it('opens as role="dialog" aria-modal, labelled by "continue-title"', () => {
    const { container } = panel();
    fireEvent.click(container.querySelector('[aria-label="Continuar con otro agente"]')!);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('continue-title');
  });

  it('focuses a control inside the dialog on open, and Escape closes it (no edits made yet, so no confirm)', () => {
    const { container } = panel();
    fireEvent.click(container.querySelector('[aria-label="Continuar con otro agente"]')!);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Tab from the last control wraps to the first — the trap the hand-rolled onKeyDown never had', () => {
    const { container } = panel();
    fireEvent.click(container.querySelector('[aria-label="Continuar con otro agente"]')!);
    const dialog = container.querySelector('[role="dialog"]')!;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea'))
      .filter(el => !(el instanceof HTMLButtonElement && el.disabled));
    controls[controls.length - 1]!.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(controls[0]);
  });
});
