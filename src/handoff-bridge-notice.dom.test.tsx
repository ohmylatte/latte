import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HandoffRequest, HandoffTaskBridgeResult } from '../shared/contracts';

configure({ asyncUtilTimeout: 5_000 });

/**
 * Q1: EL AVISO DEL HANDOFF PUENTEADO TIENE TRES FRASES, NO DOS.
 *
 * `acceptHandoffAsTask` devolvía `dispatched: result.dispatch != null`, y
 * `startDispatch` devuelve una fila `pending_approval` cuando la autoridad
 * gatea — que es el modo por DEFECTO (`manual`) y también `plan`. O sea: la
 * pantalla decía "Tarea creada para {role} y despachada al equipo" mientras la
 * tarea estaba esperando que la persona la aprobara. Anunciar un despacho que
 * no pasó es exactamente lo que este cambio no puede hacer.
 *
 * Tres estados del motor, tres frases: salió / espera tu aprobación en
 * Decisiones / quedó en cola con su razón.
 */

const HANDOFF: HandoffRequest = {
  fileName: 'para-copywriter.md', roleId: 'copywriter', roleName: 'Copywriter',
  request: 'Escribí el copy del lanzamiento', known: true,
};

const state = vi.hoisted(() => ({
  result: null as HandoffTaskBridgeResult | null,
  handoffs: [] as HandoffRequest[],
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
      listHandoffs: async () => state.handoffs,
      dismissHandoff: async () => undefined,
      acceptHandoffAsTask: async () => state.result!,
      getCoordinationRun: async () => null,
      listCoordinationGates: async () => [],
      listCoordinationLog: async () => [],
      listCoordinationHires: async () => [],
      listOpenCoordinationAsks: async () => [],
      listActiveCoordinationRuns: async () => [],
      coordinationRuntimeSupport: async () => [],
      markCoordinationSeen: async () => new Date().toISOString(),
    },
  };
});

const { App } = await import('./App');
const { I18nProvider } = await import('./i18n');

/** Abre el Trabajo de la marca de demo y su pestaña de Decisiones, y devuelve el botón de aceptar el handoff. */
async function openAcceptButton(container: HTMLElement): Promise<HTMLButtonElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Lanzamiento primavera' }));
  const tabs = await waitFor(() => {
    const found = container.querySelector('.tabs');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  const decisions = [...tabs.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Decisiones'));
  expect(decisions).toBeDefined();
  fireEvent.click(decisions!);
  return waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>('.decision-handoff-accept');
    expect(button).not.toBeNull();
    return button as HTMLButtonElement;
  });
}

async function noticeAfterAccept(result: HandoffTaskBridgeResult): Promise<string> {
  state.result = result;
  const { container } = render(<I18nProvider><App /></I18nProvider>);
  const accept = await openAcceptButton(container);
  fireEvent.click(accept);
  const message = await waitFor(() => {
    const found = container.querySelector('[role="status"].message span');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  return message.textContent ?? '';
}

const task = { id: 'ctk_1', roleId: 'copywriter', spec: 'Escribí el copy del lanzamiento', status: 'dispatched' };

beforeEach(() => { state.handoffs = [HANDOFF]; state.result = null; });

describe('Q1: el aviso del handoff puenteado distingue los tres finales', () => {
  it('despachada de verdad: lo dice, y sólo entonces', async () => {
    const text = await noticeAfterAccept({ bridged: true, task, outcome: 'dispatched', reason: null });
    expect(text).toContain('despachada al equipo');
  });

  it('esperando una aprobación: NO dice despachada, y manda a Decisiones', async () => {
    const text = await noticeAfterAccept({ bridged: true, task, outcome: 'pending_approval', reason: null });
    expect(text).not.toContain('despachada al equipo');
    expect(text).toContain('Copywriter');
    expect(text).toContain('aprobación');
    expect(text).toContain('Decisiones');
  });

  it('en cola: NO dice despachada, y trae la razón del motor', async () => {
    const text = await noticeAfterAccept({ bridged: true, task, outcome: 'not_dispatched', reason: 'BUDGET_EXCEEDED' });
    expect(text).not.toContain('despachada al equipo');
    expect(text).toContain('BUDGET_EXCEEDED');
  });
});
