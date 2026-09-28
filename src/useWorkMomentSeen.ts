import { useCallback, useState } from 'react';

/**
 * ENTREGA 1A: EL MOMENTO DE VALOR SE MUESTRA UNA SOLA VEZ POR TRABAJO.
 *
 * Mismo patrón que `useTeamSeen.ts` (H1): vive entero en el renderer, se
 * guarda en `localStorage` para que un reinicio no lo repita, y CADA acceso va
 * en `try/catch` porque un storage caído no puede romper la conversación — sin
 * él, la tarjeta simplemente vuelve a aparecer.
 */
export const WORK_MOMENT_SEEN_STORAGE_KEY = 'latte.momento-de-valor.seen';

/** Igual que en `useTeamSeen`: un tope para que una instalación vieja no arrastre miles de ids. */
const MAX_REMEMBERED = 50;

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(WORK_MOMENT_SEEN_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function write(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(WORK_MOMENT_SEEN_STORAGE_KEY, JSON.stringify(ids.slice(-MAX_REMEMBERED)));
  } catch {
    /* Sin storage la tarjeta vuelve tras reiniciar: molesto, nunca roto. */
  }
}

export interface WorkMomentSeen {
  /** `true` cuando el momento de valor de este Trabajo ya se mostró. */
  seen: (workId: string | null | undefined) => boolean;
  /** Anota que ya se mostró. Idempotente. */
  markSeen: (workId: string | null | undefined) => void;
}

export function useWorkMomentSeen(): WorkMomentSeen {
  const [ids, setIds] = useState<readonly string[]>(read);
  const markSeen = useCallback((workId: string | null | undefined) => {
    if (!workId) return;
    setIds((prev) => {
      if (prev.includes(workId)) return prev;
      const next = [...prev, workId].slice(-MAX_REMEMBERED);
      write(next);
      return next;
    });
  }, []);
  const seen = useCallback((workId: string | null | undefined) => Boolean(workId) && ids.includes(workId!), [ids]);
  return { seen, markSeen };
}
