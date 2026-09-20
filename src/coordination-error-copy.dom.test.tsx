import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HandoffRequest, UiLocale } from '../shared/contracts';

configure({ asyncUtilTimeout: 5_000 });

/**
 * Q8: LOS ERRORES DE COORDINACIÓN HABLAN EL IDIOMA DE LA PERSONA.
 *
 * `displayError` era `e.message`, y los mensajes del motor están escritos para
 * quien lee el código: `ASK_CLOSED` llega en castellano desde `repository.ts` y
 * `RUN_NOT_RUNNING` en inglés desde `engine.ts` — la misma pantalla, dos
 * idiomas, ninguno elegido por la persona. El código SÍ cruza la frontera IPC,
 * así que traducir es mirarlo, igual que la app ya hace con `permission.error`.
 *
 * Se entra por donde entra una persona: aceptar un pedido de la carpeta, que
 * pasa por el mismo `run()` que atrapa y muestra cualquier error del backend.
 */

const HANDOFF: HandoffRequest = {
  fileName: 'para-copywriter.md', roleId: 'copywriter', roleName: 'Copywriter',
  request: 'Escribí el copy del lanzamiento', known: true,
};

const state = vi.hoisted(() => ({
  locale: 'es-AR' as UiLocale,
  failure: null as Error | null,
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      getUiLocale: async () => state.locale,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
      listHandoffs: async () => [HANDOFF],
      dismissHandoff: async () => undefined,
      acceptHandoffAsTask: async () => { throw state.failure; },
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

const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** Abre el Trabajo y su pestaña de Decisiones, acepta el handoff y devuelve el texto del error. */
async function errorAfterAccept(failure: Error, locale: UiLocale): Promise<string> {
  cleanup(); // un test puede renderizar dos veces; sin esto `screen` busca en los dos árboles a la vez
  state.failure = failure;
  state.locale = locale;
  const { container } = render(<I18nProvider><App /></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Lanzamiento primavera' }));
  const tabs = await waitFor(() => {
    const found = container.querySelector('.tabs');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  const decisions = [...tabs.querySelectorAll('button')].find((b) => /^Decisiones|^Decisions/.test(b.textContent ?? ''));
  expect(decisions).toBeDefined();
  fireEvent.click(decisions!);
  const accept = await waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>('.decision-handoff-accept');
    expect(button).not.toBeNull();
    return button as HTMLButtonElement;
  });
  fireEvent.click(accept);
  const alert = await waitFor(() => {
    const found = container.querySelector('[role="alert"].message span');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  return alert.textContent ?? '';
}

beforeEach(() => { state.failure = null; state.locale = 'es-AR'; });

describe('Q8: un código de coordinación se lee en el idioma de la persona', () => {
  it('`ASK_CLOSED` en castellano, sin el texto crudo del motor', async () => {
    const text = await errorAfterAccept(coded('ASK_CLOSED', 'Esa pregunta ya se cerró (raw)'), 'es-AR');
    expect(text).toBe('Esa pregunta ya está cerrada: o alguien la contestó, o se le pasó el plazo.');
  });

  it('`RUN_NOT_RUNNING` en inglés cuando la persona eligió inglés', async () => {
    const text = await errorAfterAccept(coded('RUN_NOT_RUNNING', 'Only a running team can be paused (this one is done)'), 'en-US');
    expect(text).toBe('That team is not running, so there is nothing to pause.');
  });

  it('`PLAN_HAS_UNAPPROVED_ROLES` también, en los dos idiomas', async () => {
    const message = 'The plan still has tasks for roles nobody approved';
    expect(await errorAfterAccept(coded('PLAN_HAS_UNAPPROVED_ROLES', message), 'es-AR'))
      // Q6: la frase dice lo que la pantalla OFRECE de verdad. "Sacá esas
      // tareas" describía una acción que no existe en ningún lado: la persona
      // no puede editar el plan tarea por tarea. "Editar y aprobar" las saca.
      .toBe('El plan tiene tareas para roles que nadie va a poder hacer. Abrí "Editar y aprobar": esas tareas se quitan solas, y podés aprobar el resto.');
    expect(await errorAfterAccept(coded('PLAN_HAS_UNAPPROVED_ROLES', message), 'en-US'))
      .toBe('The plan has tasks for roles nobody can do. Open “Edit and approve”: those tasks are dropped for you, and you can approve the rest.');
  });

  it('un código sin traducción cae al mensaje del motor: no se tapa lo que nadie previó', async () => {
    const text = await errorAfterAccept(coded('ALGO_MUY_RARO', 'algo muy raro pasó en el fondo'), 'es-AR');
    expect(text).toBe('algo muy raro pasó en el fondo');
  });
});
