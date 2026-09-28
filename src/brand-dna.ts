import { useCallback, useEffect, useState } from 'react';
import type {
  BrandDnaBuildJob,
  BrandDnaBuildMode,
  BrandDnaField,
  BrandDnaFields,
  BrandDnaSourcesInput,
  BrandDnaView,
} from '../shared/contracts';
import { api } from './browser-api';
import { translate } from './i18n';

const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * El resultado de una escritura. `ok: false` además deja el mensaje en
 * `state.error`, para la pantalla que sólo quiere mostrarlo; el recorrido
 * inicial lo necesita explícito porque vive en un alerta propio con reintento.
 */
export type BrandDnaOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * El motor del ADN desde la interfaz: leer, arrancar un build, observarlo y
 * escribir.
 *
 * Dos superficies lo usan —el paso "Traé tu marca" del recorrido inicial y
 * Marca → ADN— y no pueden permitirse dos implementaciones del sondeo: un build
 * se lee con `readBrandDnaBuildJob` cada ~1 s hasta que `done`, y recién ahí la
 * ficha vuelve a cargarse. Acá vive una sola vez, con estado explícito y sin un
 * intervalo que sobreviva a la pantalla que lo abrió.
 */
export interface BrandDnaState {
  /** El build en vuelo, o null. `done` cierra el sondeo y recarga la ficha. */
  job: BrandDnaBuildJob | null;
  /** La ficha: borrador, versión aprobada y propuestas pendientes. */
  dna: BrandDnaView | null;
  /** El último fallo, en el idioma de la persona. */
  error: string | null;
  /** Hay una escritura en vuelo (leer, editar, aprobar, construir). */
  busy: boolean;
  clearError: () => void;
  /** Recarga la ficha de la marca. */
  load: () => Promise<BrandDnaView | null>;
  /**
   * Arranca el motor y queda mirando el job hasta que termina. `target` sólo
   * existe para el recorrido inicial, que puede CREAR la marca y construir en
   * el mismo gesto: sin él, el `brandId` capturado por el callback sería el
   * anterior (vacío) y el build no arrancaría nunca.
   */
  build: (mode: BrandDnaBuildMode, sources: BrandDnaSourcesInput | null, target?: string) => Promise<BrandDnaOutcome<BrandDnaBuildJob>>;
  /** Edita un campo del borrador; la ficha que vuelve ya trae el cambio. */
  edit: (field: BrandDnaField, value: BrandDnaFields[BrandDnaField]) => Promise<void>;
  /** Aprueba la versión vigente. */
  approve: () => Promise<BrandDnaOutcome<BrandDnaView>>;
  /** Acepta o descarta una propuesta aprendida. */
  resolve: (proposalId: string, accept: boolean) => Promise<void>;
}

export function useBrandDna(brandId: string | null): BrandDnaState {
  const [job, setJob] = useState<BrandDnaBuildJob | null>(null);
  const [dna, setDna] = useState<BrandDnaView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<BrandDnaView | null> => {
    if (!brandId) { setDna(null); return null; }
    const view = await api.readBrandDna(brandId);
    setDna(view);
    return view;
  }, [brandId]);

  // Una marca distinta es otra ficha: el build anterior deja de ser relevante.
  // El guard por `brandId` es lo que permite crear la marca EN el paso "Armar
  // mi marca" sin que este efecto borre el job que acaba de arrancar.
  useEffect(() => {
    setJob((previous) => (previous && brandId && previous.brandId === brandId ? previous : null));
    setError(null);
    void load().catch((e) => setError(displayError(e)));
  }, [brandId, load]);

  // El sondeo: ~1 s por lectura, sólo mientras el build no terminó. Las deps
  // son el ID y el `done`, no el objeto: con el objeto el efecto se rearmaría
  // con cada lectura y el intervalo se volvería un bucle apretado.
  const jobId = job?.jobId ?? null;
  const jobDone = job?.done ?? true;
  useEffect(() => {
    if (!jobId || jobDone) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await api.readBrandDnaBuildJob(jobId);
        if (stopped) return;
        setJob(next);
        if (next.done) await load().catch(() => undefined);
      } catch (e) {
        if (stopped) return;
        setError(displayError(e));
        setJob((previous) => (previous && !previous.done ? { ...previous, done: true, outcome: 'failed', reason: 'UNAVAILABLE' } : previous));
      }
    };
    const timer = setInterval(() => void tick(), 1000);
    void tick();
    return () => { stopped = true; clearInterval(timer); };
  }, [jobId, jobDone, load]);

  const build = useCallback(async (mode: BrandDnaBuildMode, sources: BrandDnaSourcesInput | null, target?: string): Promise<BrandDnaOutcome<BrandDnaBuildJob>> => {
    const id = target ?? brandId;
    if (!id) { const error = translate('dna.build.failed'); setError(error); return { ok: false, error }; }
    setBusy(true);
    setError(null);
    try {
      const started = await api.buildBrandDna(id, mode, sources);
      setJob(started);
      // La marca recién creada todavía no es la del hook: se lee directo con el
      // id con el que se arrancó, y el efecto de la marca se hace cargo en cuanto
      // el estado la tenga.
      if (id === brandId) await load().catch(() => undefined);
      else await api.readBrandDna(id).then(setDna).catch(() => undefined);
      return { ok: true, value: started };
    } catch (e) {
      const error = displayError(e);
      setError(error);
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  }, [brandId, load]);

  const edit = useCallback(async (field: BrandDnaField, value: BrandDnaFields[BrandDnaField]): Promise<void> => {
    if (!brandId) return;
    setBusy(true);
    setError(null);
    try {
      setDna(await api.updateBrandDnaField(brandId, field, value));
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  }, [brandId]);

  const approve = useCallback(async (): Promise<BrandDnaOutcome<BrandDnaView>> => {
    if (!brandId) { const error = translate('dna.build.failed'); setError(error); return { ok: false, error }; }
    setBusy(true);
    setError(null);
    try {
      const view = await api.approveBrandDna(brandId);
      setDna(view);
      return { ok: true, value: view };
    } catch (e) {
      const error = displayError(e);
      setError(error);
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  }, [brandId]);

  const resolve = useCallback(async (proposalId: string, accept: boolean): Promise<void> => {
    if (!brandId) return;
    setBusy(true);
    setError(null);
    try {
      setDna(await api.resolveBrandDnaProposal(brandId, proposalId, accept));
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  }, [brandId]);

  return {
    job, dna, error, busy,
    clearError: useCallback(() => setError(null), []),
    load, build, edit, approve, resolve,
  };
}
