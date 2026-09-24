import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * MARCA → EQUIPO (brief `docs/briefs/2026-09-23-equipo-de-marca.md`, bloque 5).
 *
 * El plantel de la marca con sus caras, en la anatomía de fila del equipo y
 * sin párrafos. Los retirados se ven en gris y se traen de vuelta con
 * "Convocar"; quitar es un ícono; sumar un rol es la misma fila punteada que
 * en el modo Equipo y abre el mismo diálogo, sin la frase de "cada rol abre su
 * conversación" —acá no se abre ninguna—. Y "Sumar un rol" en un TRABAJO
 * muestra primero a los de la marca que todavía no están en él.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render, waitFor } = await import('@testing-library/react');
const { BrandTeamView } = await import('./BrandTeamView');
const { RolePicker } = await import('./TeamPanel');
import type { AgentRole, BrandMember, Work } from '../shared/contracts';

const person = (id: string, roleId: string, roleName: string, patch: Partial<BrandMember> = {}): BrandMember => ({
  id, brandId: 'b1', roleId, roleName, initial: roleName[0]!, avatar: 'bob.2.4.phones', runtime: 'claude', model: null, accountId: null,
  label: 'Claude Code', tier: 'balanced', workIds: [], coordinator: false, lastCalledAt: '2026-09-01T00:00:00.000Z', retiredAt: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento' } as Work;
const roster = [
  person('bm_old', 'analyst', 'Analyst', { retiredAt: '2026-09-20T00:00:00.000Z', workIds: ['w0'] }),
  person('bm_here', 'strategist', 'Strategist', { workIds: ['w1', 'w2'] }),
  person('bm_two', 'reviewer', 'Reviewer', { workIds: ['w0', 'w2'] }),
  person('bm_new', 'researcher', 'Researcher'),
];
const roles: AgentRole[] = [
  { id: 'assistant', name: 'Asistente', initial: 'A', summary: '', builtin: true, tier: 'balanced', avatar: null },
  { id: 'reviewer', name: 'Reviewer', initial: 'R', summary: '', builtin: false, tier: 'balanced', avatar: null },
];
const picker = {
  roles, choices: [], primaryLabel: 'Claude Code', primaryDetail: '', primaryReady: true, checking: false, isDesktop: true,
  onProviders: () => {}, onRecheck: () => {}, submitLabel: 'Sumar al equipo', lead: null,
};

describe('Marca → Equipo', () => {
  it('una fila por persona, con su cara; los activos arriba y los retirados en gris, al final', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(BrandTeamView, { brandName: 'Casa', roster, work, busy: false, onCallUp: () => {}, onRetire: () => {} }));
    expect(container.querySelector('h1')!.textContent).toBe('El equipo de Casa');
    const rows = [...container.querySelectorAll('.roster-row')];
    expect(rows.map((r) => r.getAttribute('data-member-id'))).toEqual(['bm_here', 'bm_two', 'bm_new', 'bm_old']);
    expect(rows.every((r) => r.querySelector('.av-face'))).toBe(true);
    expect(rows.map((r) => r.querySelector('.coord-row-line')!.textContent)).toEqual([
      'Claude Code · en este trabajo', 'Claude Code · en 2 trabajos', 'Claude Code · sin convocar', 'Retirado',
    ]);
    expect(rows[3]!.classList.contains('is-retired')).toBe(true);
    expect(rows.slice(0, 3).some((r) => r.classList.contains('is-retired'))).toBe(false);
    // Sin párrafos: la fila dice lo que hay que saber.
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('"Convocar" trae al trabajo abierto (retirados incluidos); quien ya está no lo ofrece; quitar es un ícono de los activos', () => {
    ui.locale = 'es-AR';
    const called: string[] = [];
    const retired: string[] = [];
    const { container } = render(createElement(BrandTeamView, { brandName: 'Casa', roster, work, busy: false, onCallUp: (id: string) => called.push(id), onRetire: (id: string) => retired.push(id) }));
    const row = (id: string) => container.querySelector(`[data-member-id="${id}"]`)!;
    expect(row('bm_here').querySelector('.roster-call')).toBeNull();
    const retiredCall = row('bm_old').querySelector('.roster-call') as HTMLButtonElement;
    expect(retiredCall.textContent).toBe('Convocar');
    expect(retiredCall.title).toBe('Convocar a Lanzamiento');
    fireEvent.click(retiredCall);
    fireEvent.click(row('bm_new').querySelector('.roster-call')!);
    expect(called).toEqual(['bm_old', 'bm_new']);
    // Un retirado ya está fuera: no se lo vuelve a quitar.
    expect(row('bm_old').querySelector('[aria-label^="Quitar"]')).toBeNull();
    fireEvent.click(row('bm_two').querySelector('[aria-label="Quitar a Reviewer del equipo"]')!);
    expect(retired).toEqual(['bm_two']);
  });

  it('sin un trabajo abierto, "Convocar" se ve pero dice por qué no anda', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(BrandTeamView, { brandName: 'Casa', roster, work: null, busy: false, onCallUp: () => {} }));
    const button = container.querySelector('[data-member-id="bm_new"] .roster-call') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Abrí un trabajo para convocar');
  });

  it('sumar un rol abre el mismo diálogo, sin la frase de "abre su conversación", y suma sin convocar', async () => {
    ui.locale = 'es-AR';
    const added: unknown[][] = [];
    const { container, getByRole } = render(createElement(BrandTeamView, {
      brandName: 'Casa', roster: [], work, busy: false, picker,
      onAdd: async (...args: unknown[]) => { added.push(args); },
    }));
    expect(container.querySelector('.roster-empty')!.textContent).toMatch(/^Nadie todavía/);
    fireEvent.click(container.querySelector('.coord-add')!);
    const dialog = getByRole('dialog');
    expect(dialog.querySelector('#roster-add-title')!.textContent).toBe('Sumar al equipo de la marca');
    expect(dialog.querySelector('.agent-explanation')).toBeNull();
    fireEvent.click(dialog.querySelector('[role="radio"][aria-checked="false"]')!);
    fireEvent.click([...dialog.querySelectorAll('button.primary')].find((b) => b.textContent === 'Sumar al equipo')!);
    await waitFor(() => expect(added).toEqual([['reviewer', { tier: 'balanced' }]]));
  });

  it('en inglés', () => {
    ui.locale = 'en-US';
    const { container } = render(createElement(BrandTeamView, { brandName: 'Casa', roster, work, busy: false, onCallUp: () => {}, onRetire: () => {} }));
    expect(container.querySelector('h1')!.textContent).toBe('The Casa team');
    expect(container.querySelector('[data-member-id="bm_two"] .coord-row-line')!.textContent).toBe('Claude Code · on 2 works');
    expect(container.querySelector('[data-member-id="bm_old"] .roster-call')!.textContent).toBe('Call up');
  });
});

describe('Marca → Equipo: el coordinador habitual', () => {
  const withHabitual = roster.map((m) => (m.id === 'bm_here' ? { ...m, coordinator: true } : m));
  const button = (c: HTMLElement, id: string) => c.querySelector(`[data-member-id="${id}"] .roster-coordinate`) as HTMLButtonElement | null;

  it('un botón por persona activa; el habitual lo tiene apretado y lleva el ícono al lado del nombre', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(BrandTeamView, { brandName: 'Casa', roster: withHabitual, work, busy: false, onSetCoordinator: () => {} }));
    expect(button(container, 'bm_here')!.getAttribute('aria-pressed')).toBe('true');
    expect(button(container, 'bm_here')!.getAttribute('aria-label')).toBe('Strategist coordina los trabajos de la marca');
    expect(button(container, 'bm_two')!.getAttribute('aria-pressed')).toBe('false');
    expect(button(container, 'bm_two')!.getAttribute('aria-label')).toBe('Que Reviewer coordine los trabajos de la marca');
    // Un retirado no coordina nada: primero hay que convocarlo.
    expect(button(container, 'bm_old')).toBeNull();
    expect(container.querySelector('[data-member-id="bm_here"] .coord-row-coordinator')).not.toBeNull();
    expect(container.querySelector('[data-member-id="bm_two"] .coord-row-coordinator')).toBeNull();
  });

  it('elegir a otra persona la nombra; volver a tocar al habitual deja a la marca sin habitual', () => {
    ui.locale = 'es-AR';
    const chosen: Array<string | null> = [];
    const { container } = render(createElement(BrandTeamView, { brandName: 'Casa', roster: withHabitual, work, busy: false, onSetCoordinator: (id: string | null) => { chosen.push(id); } }));
    fireEvent.click(button(container, 'bm_two')!);
    fireEvent.click(button(container, 'bm_here')!);
    expect(chosen).toEqual(['bm_two', null]);
  });

  it('sin handler no se ofrece', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(BrandTeamView, { brandName: 'Casa', roster: withHabitual, work, busy: false }));
    expect(container.querySelector('.roster-coordinate')).toBeNull();
  });

  it('en inglés', () => {
    ui.locale = 'en-US';
    const { container } = render(createElement(BrandTeamView, { brandName: 'Casa', roster: withHabitual, work, busy: false, onSetCoordinator: () => {} }));
    expect(button(container, 'bm_here')!.getAttribute('aria-label')).toBe("Strategist coordinates this brand's works");
    expect(button(container, 'bm_two')!.getAttribute('aria-label')).toBe("Make Reviewer coordinate this brand's works");
    ui.locale = 'es-AR';
  });
});

describe('"Sumar un rol" en un trabajo: el plantel primero', () => {
  const base = { ...picker, busy: false, canCancel: false, onCancel: () => {}, submitLabel: undefined, lead: undefined };

  it('arriba los de la marca, elegido el primero: el botón CONVOCA a esa persona', async () => {
    ui.locale = 'es-AR';
    const calls: string[] = [];
    const adds: unknown[][] = [];
    const people = [person('bm_new', 'researcher', 'Researcher'), person('bm_old', 'analyst', 'Analyst', { retiredAt: '2026-09-20T00:00:00.000Z' })];
    const { container } = render(createElement(RolePicker, {
      ...base, roster: people, onCallUp: async (id: string) => { calls.push(id); }, onAdd: async (...a: unknown[]) => { adds.push(a); },
    }));
    const sections = [...container.querySelectorAll('.role-picker-section')].map((n) => n.textContent);
    expect(sections).toEqual(['Del equipo de la marca', 'Nuevo en la marca']);
    const cards = [...container.querySelectorAll('.role-list-roster .role-card')];
    expect(cards.map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(cards[1]!.classList.contains('is-retired')).toBe(true);
    expect(cards[1]!.textContent).toContain('Retirado');
    // La identidad es de la persona: ni esfuerzo ni agente que elegir.
    expect(container.querySelector('#member-runtime')).toBeNull();
    fireEvent.click(container.querySelector('button.primary')!);
    await waitFor(() => expect(calls).toEqual(['bm_new']));
    expect(adds).toEqual([]);
  });

  it('elegir un rol de abajo suma a alguien NUEVO a la marca', async () => {
    ui.locale = 'es-AR';
    const adds: unknown[][] = [];
    const { container } = render(createElement(RolePicker, {
      ...base, roster: [person('bm_new', 'reviewer', 'Reviewer')], onCallUp: async () => {}, onAdd: async (...a: unknown[]) => { adds.push(a); },
    }));
    const roleCards = [...container.querySelectorAll('.role-list:not(.role-list-roster) .role-card')];
    fireEvent.click(roleCards[1]!);
    expect(container.querySelector('#member-runtime')).not.toBeNull();
    fireEvent.click(container.querySelector('button.primary')!);
    await waitFor(() => expect(adds).toEqual([['reviewer', { tier: 'balanced', newInBrand: true }]]));
  });

  it('sin plantel, el diálogo de siempre', async () => {
    ui.locale = 'es-AR';
    const adds: unknown[][] = [];
    const { container } = render(createElement(RolePicker, { ...base, onAdd: async (...a: unknown[]) => { adds.push(a); } }));
    expect(container.querySelector('.role-picker-section')).toBeNull();
    expect(container.querySelector('.agent-explanation')).not.toBeNull();
    fireEvent.click(container.querySelector('button.primary')!);
    await waitFor(() => expect(adds).toEqual([['assistant', { tier: 'balanced' }]]));
  });
});
