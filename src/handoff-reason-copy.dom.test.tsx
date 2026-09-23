import { describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_USAGE } from '../shared/contracts';
import type { HandoffRequest, HandoffTaskBridgeResult, TeamMember, Work } from '../shared/contracts';

configure({ asyncUtilTimeout: 5_000 });

/**
 * M3: CERO CÓDIGOS EN PANTALLA.
 *
 * El motivo de un traspaso que no se puenteó viajaba tal cual del motor al
 * aviso: la persona leía `RUN_ALREADY_ACTIVE`. Cada código conocido se dibuja
 * como frase; uno desconocido —o una excepción— dice "No se pudo proponer:"
 * con el detalle en gris, y nunca el código. El aviso "en cola" del puente con
 * run vivo, igual.
 */

const HANDOFF: HandoffRequest = {
  fileName: 'para-paid-media.md', roleId: 'paid-media', roleName: 'Paid Media',
  request: 'Guía para levantar las campañas de Meta Ads', known: true,
};

const state = vi.hoisted(() => ({
  workId: '',
  handoffs: [] as HandoffRequest[],
  bridge: (async () => { throw new Error('unset'); }) as () => Promise<HandoffTaskBridgeResult>,
  calls: 0,
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  const listWorks = async (brandId: string): Promise<Work[]> => {
    const works = await actual.browserAPI.listWorks(brandId);
    if (works[0]) state.workId = works[0].id;
    return works;
  };
  const assistant = (): TeamMember => ({
    id: 'mem_asistente', workId: state.workId, roleId: 'assistant', roleName: 'Asistente', initial: 'A', avatar: null,
    runtime: 'codex', model: null, accountId: null, label: 'Codex', status: 'idle', tier: 'balanced',
    usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
  });
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
      listWorks,
      listTeam: async () => [assistant()],
      listHandoffs: async () => state.handoffs,
      dismissHandoff: async () => undefined,
      acceptHandoffAsTask: async () => { state.calls += 1; return state.bridge(); },
      listActiveCoordinationRuns: async () => [],
      getCoordinationRun: async () => null,
      listCoordinationGates: async () => [],
      listCoordinationLog: async () => [],
      listCoordinationHires: async () => [],
      listCoordinationMessages: async () => [],
      listOpenCoordinationAsks: async () => [],
      coordinationRuntimeSupport: async () => [],
    },
  };
});

const { App } = await import('./App');
const { I18nProvider } = await import('./i18n');

/** Ninguna palabra del texto es un código de motor. */
function noCodes(text: string): void {
  const codes = text.split(/[\s—:;().,«»"'¿?¡!]+/).filter((word) => /^[A-Z_]{6,}$/.test(word));
  expect(codes, `código crudo en pantalla: «${text}»`).toEqual([]);
}

async function bannerFor(bridge: () => Promise<HandoffTaskBridgeResult>): Promise<{ banner: HTMLElement; container: HTMLElement }> {
  cleanup();
  state.handoffs = [HANDOFF];
  state.bridge = bridge;
  state.calls = 0;
  const { container } = render(<I18nProvider><App /></I18nProvider>);
  await screen.findByRole('button', { name: 'Lanzamiento primavera' });
  await waitFor(() => { expect(state.calls).toBe(1); });
  const banner = await waitFor(() => {
    const found = container.querySelector<HTMLElement>('.doc-banner.handoff');
    expect(found).not.toBeNull();
    expect(found!.querySelector('.handoff-reason')).not.toBeNull();
    return found!;
  });
  return { banner, container };
}

const held = (reason: string) => async (): Promise<HandoffTaskBridgeResult> => ({ bridged: false, task: null, outcome: null, reason });

describe('M3: los motivos de un puente que no se hizo son frases', () => {
  it.each([
    ['RUN_ALREADY_ACTIVE', 'Ya hay una propuesta pendiente en este trabajo'],
    ['RUN_NOT_ACTIVE', 'El equipo no está en marcha'],
    ['ROLE_NOT_APPROVED', 'Ese rol no está aprobado para este trabajo'],
  ])('%s se dibuja como frase', async (code, phrase) => {
    const { banner } = await bannerFor(held(code));
    expect(banner.querySelector('.handoff-reason')!.textContent).toContain(phrase);
    expect(banner.textContent).not.toContain(code);
    noCodes(banner.textContent ?? '');
  });

  it('UNKNOWN_ROLE se dibuja como frase', async () => {
    const { banner } = await bannerFor(held('UNKNOWN_ROLE'));
    expect(banner.querySelector('.handoff-reason')!.textContent).toContain('Ese rol no existe');
    noCodes(banner.textContent ?? '');
  });

  it('un código que la pantalla no conoce: "No se pudo proponer", sin el código', async () => {
    const { banner } = await bannerFor(held('SOMETHING_NEW_AND_ODD'));
    expect(banner.querySelector('.handoff-reason')!.textContent).toContain('No se pudo proponer');
    noCodes(banner.textContent ?? '');
  });

  it('cuando el motor tira: "No se pudo proponer:" y su mensaje en gris', async () => {
    const { banner } = await bannerFor(async () => { throw Object.assign(new Error('se cayó la base a mitad de camino'), { code: 'WEIRD_FAILURE' }); });
    const reason = banner.querySelector('.handoff-reason')!;
    expect(reason.textContent).toContain('No se pudo proponer:');
    expect(reason.querySelector('.handoff-reason-detail')!.textContent).toBe('se cayó la base a mitad de camino');
    noCodes(banner.textContent ?? '');
  });

  it('el aviso "en cola" del puente con run vivo tampoco muestra el código', async () => {
    cleanup();
    state.handoffs = [HANDOFF];
    state.calls = 0;
    state.bridge = async () => ({ bridged: true, task: { id: 'ctk_1', roleId: 'paid-media', spec: 'x', status: 'ready' }, outcome: 'not_dispatched', reason: 'BUDGET_EXCEEDED' });
    const { container } = render(<I18nProvider><App /></I18nProvider>);
    const notice = await waitFor(() => {
      const found = container.querySelector('[role="status"].message span');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(notice.textContent).toContain('presupuesto');
    expect(notice.textContent).not.toContain('BUDGET_EXCEEDED');
    noCodes(notice.textContent ?? '');
  });
});
