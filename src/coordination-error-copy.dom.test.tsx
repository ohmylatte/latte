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
 *
 * Q6: Y LOS ERRORES SON DE VERDAD. Este test fabricaba sus códigos a mano
 * (`Object.assign(new Error(...), { code })`), así que seguía en verde aunque
 * el motor no tirara ese código por ningún lado — que es exactamente lo que
 * pasaba con `INVALID_ARGUMENT`. Ahora los dos primeros salen del backend real:
 * se provoca el error llamando al método de servicio que la interfaz llama, y
 * el objeto que se muestra es el mismo que tiró el motor.
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

/**
 * Los errores REALES, provocados por el backend de verdad a través de los
 * mismos métodos de `LatteService` que la interfaz llama por IPC. Lo que se le
 * muestra a la persona más abajo es este objeto, con el `code` que el motor le
 * puso — no uno inventado por el test.
 */
async function realBackendErrors(): Promise<{ askClosed: Error; runNotRunning: Error }> {
  const { makeBackend, fakeCoordinationHub } = await import('../tests/backend/helpers');
  const { FEATURE_KEYS, FEATURE_ON } = await import('../electron/core/features');
  const b = await makeBackend();
  try {
    fakeCoordinationHub(b, []);
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(work.id, { maxDispatches: 10 });

    // ASK_CLOSED: contestar dos veces la misma pregunta, por el método que la
    // pantalla de Decisiones usa cuando la persona aprieta "Responder".
    const run = await b.service.startCoordinationRun(work.id);
    const ask = b.service.coordinationEngine.ask({ workId: work.id, runId: run.id, memberId: 'mem_a', role: 'worker' }, '¿Con qué tono?', 60);
    await b.service.answerCoordinationAsk(ask.id, 'Cercano');
    const askClosed = await b.service.answerCoordinationAsk(ask.id, 'Formal').then(() => null, (e: Error) => e);
    expect(askClosed).not.toBeNull();
    expect((askClosed as { code?: string }).code).toBe('ASK_CLOSED');

    // RUN_NOT_RUNNING: pausar un run `planning`, que es lo que pasa si la
    // persona aprieta "Pausar" con una propuesta todavía sin resolver.
    const second = await b.service.createWork(brand.id, 'Otro');
    await b.service.setCoordinationBudget(second.id, { maxDispatches: 5 });
    const planning = await b.service.coordinationEngine.requestCoordination(
      { workId: second.id, runId: null, memberId: 'mem_p', role: 'worker' },
      { plan: [{ roleId: 'role_a', spec: 'a' }], membersToHire: [{ roleId: 'role_a', why: 'no hay nadie' }], estimatedDispatches: 3, rationale: 'porque sí' },
    );
    const runNotRunning = await b.service.pauseCoordinationRun(planning.id).then(() => null, (e: Error) => e);
    expect(runNotRunning).not.toBeNull();
    expect((runNotRunning as { code?: string }).code).toBe('RUN_NOT_RUNNING');

    return { askClosed: askClosed as Error, runNotRunning: runNotRunning as Error };
  } finally {
    b.cleanup();
  }
}

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
  it('`ASK_CLOSED`, tal como lo tira el motor, en castellano y sin su texto crudo', async () => {
    const { askClosed } = await realBackendErrors();
    const raw = askClosed.message;

    const text = await errorAfterAccept(askClosed, 'es-AR');

    expect(text).toBe('Esa pregunta ya está cerrada: o alguien la contestó, o se le pasó el plazo.');
    expect(text).not.toBe(raw); // y el mensaje del motor no se filtra a la pantalla
  });

  it('`RUN_NOT_RUNNING`, tal como lo tira el motor, en inglés cuando la persona eligió inglés', async () => {
    const { runNotRunning } = await realBackendErrors();

    const text = await errorAfterAccept(runNotRunning, 'en-US');

    expect(text).toBe('That team is not running, so there is nothing to pause.');
    expect(text).not.toBe(runNotRunning.message);
  });

  it('`PLAN_HAS_UNAPPROVED_ROLES` también, en los dos idiomas', async () => {
    const message = 'The plan still has tasks for roles nobody approved';
    expect(await errorAfterAccept(coded('PLAN_HAS_UNAPPROVED_ROLES', message), 'es-AR'))
      // Q6: la frase dice lo que la pantalla OFRECE de verdad. "Sacá esas
      // tareas" describía una acción que no existe en ningún lado: la persona
      // no puede editar el plan tarea por tarea. "Editar y aprobar" las saca.
      //
      // O12: y la segunda oración es nueva. Con el plan ENTERO huérfano no
      // queda nada que aprobar, así que "Editar y aprobar" tampoco sirve: la
      // frase tenía que nombrar la única salida que hay ahí.
      .toBe('El plan tiene tareas para roles que nadie va a poder hacer. Abrí "Editar y aprobar": esas tareas se quitan solas, y podés aprobar el resto. Si no queda ninguna, rechazá y pedí una propuesta nueva.');
    expect(await errorAfterAccept(coded('PLAN_HAS_UNAPPROVED_ROLES', message), 'en-US'))
      .toBe('The plan has tasks for roles nobody can do. Open “Edit and approve”: those tasks are dropped for you, and you can approve the rest. If none are left, discard it and ask for a new proposal.');
  });

  it('un código sin traducción cae al mensaje del motor: no se tapa lo que nadie previó', async () => {
    const text = await errorAfterAccept(coded('ALGO_MUY_RARO', 'algo muy raro pasó en el fondo'), 'es-AR');
    expect(text).toBe('algo muy raro pasó en el fondo');
  });
});

/**
 * N2 (ronda 7): `FEATURE_DISABLED` NO ES DE COORDINACIÓN.
 *
 * `displayError` es el formateador de errores de TODA la app, y la ronda 6 le
 * puso a `FEATURE_DISABLED` una frase que hablaba de coordinación. El mismo
 * código lo tiran cuatro features: `requireFeature('brandKits')` en
 * `branding/service.ts`, generación en `latteService`, aprendizaje, y
 * coordinación. Quien abría un kit de marca con su flag apagado leía "La
 * coordinación de equipo está apagada": una explicación falsa de un hecho
 * verdadero.
 *
 * Los dos errores de abajo salen del backend REAL, por los dos caminos
 * distintos, y los dos tienen que leerse con la MISMA frase neutra.
 *
 * N3: y esa frase no promete Ajustes, porque no hay ningún interruptor en
 * ninguna pantalla.
 */
async function realFeatureDisabled(): Promise<{ fromBrandKits: Error; fromCoordination: Error }> {
  const { makeBackend, fakeCoordinationHub } = await import('../tests/backend/helpers');
  const { FEATURE_KEYS, FEATURE_ON } = await import('../electron/core/features');
  const b = await makeBackend();
  try {
    fakeCoordinationHub(b, []);
    // Kits de marca: el flag viene apagado de fábrica y la pantalla llama a
    // este mismo método. Cero coordinación en este camino.
    const fromBrandKits = await b.service.readAgencyProfile().then(() => null, (e: Error) => e);
    expect(fromBrandKits).not.toBeNull();
    expect((fromBrandKits as { code?: string }).code).toBe('FEATURE_DISABLED');

    // Coordinación: reanudar con el interruptor bajo (O4). Mismo código,
    // distinta feature — y por eso mismo, misma frase.
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(work.id, { maxDispatches: 10 });
    const run = await b.service.startCoordinationRun(work.id);
    await b.service.pauseCoordinationRun(run.id);
    b.repo.setMeta(FEATURE_KEYS.coordination, 'off');
    const fromCoordination = await b.service.resumeCoordinationRun(run.id).then(() => null, (e: Error) => e);
    expect(fromCoordination).not.toBeNull();
    expect((fromCoordination as { code?: string }).code).toBe('FEATURE_DISABLED');

    return { fromBrandKits: fromBrandKits as Error, fromCoordination: fromCoordination as Error };
  } finally {
    b.cleanup();
  }
}

describe('N2: los códigos genéricos se leen con una frase de toda la app', () => {
  it('`FEATURE_DISABLED` desde los kits de marca no habla de equipos ni promete Ajustes', async () => {
    const { fromBrandKits } = await realFeatureDisabled();

    const text = await errorAfterAccept(fromBrandKits, 'es-AR');

    expect(text).toBe('Esta función está apagada en esta instalación.');
    expect(text).not.toMatch(/coordinaci|equipo|tarea/i);
    expect(text).not.toMatch(/Ajustes/i);
    expect(text).not.toBe(fromBrandKits.message);
  });

  it('el mismo `FEATURE_DISABLED` desde `resumeCoordinationRun` se lee igual: el código es genérico', async () => {
    const { fromCoordination } = await realFeatureDisabled();

    expect(await errorAfterAccept(fromCoordination, 'es-AR')).toBe('Esta función está apagada en esta instalación.');
    expect(await errorAfterAccept(fromCoordination, 'en-US')).toBe('This feature is switched off in this installation.');
  });

  it('en inglés tampoco manda a Settings', async () => {
    const { fromBrandKits } = await realFeatureDisabled();
    const text = await errorAfterAccept(fromBrandKits, 'en-US');
    expect(text).toBe('This feature is switched off in this installation.');
    expect(text).not.toMatch(/Settings/i);
  });

  it('`NOT_FOUND`, `CONFLICT`, `UNAVAILABLE` y `VALIDATION` tampoco nombran equipos ni tareas', async () => {
    for (const code of ['NOT_FOUND', 'CONFLICT', 'UNAVAILABLE', 'VALIDATION']) {
      const text = await errorAfterAccept(coded(code, 'raw'), 'es-AR');
      expect(text, code).not.toBe('raw'); // tiene frase propia
      expect(text, code).not.toMatch(/equipo|tarea|coordinaci/i);
    }
  });
});
