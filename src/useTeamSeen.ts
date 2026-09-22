import { useCallback, useState } from 'react';

/**
 * H1: QUÉ RUNS YA MOSTRARON SU EQUIPO, ANOTADO POR RUN.
 *
 * La línea "Plan aprobado · el equipo trabaja" es un AVISO: existe para llevar
 * a la persona al equipo una vez. En cuanto abre el modo Equipo de ese
 * Trabajo, el aviso ya hizo su trabajo y se va — y no vuelve para ESE run,
 * porque volver sería avisar de algo que ya pasó.
 *
 * Vive entero en el renderer: el backend no tiene por qué enterarse de qué
 * miró la persona para dibujar una línea. Se guarda en `localStorage` para que
 * un reinicio no reviva un aviso viejo; si el storage no está (modo privado,
 * un test sin jsdom, una política del sistema), el estado de React alcanza y
 * la línea simplemente vuelve a aparecer después de reiniciar. Por eso CADA
 * acceso va en `try/catch`: un storage caído no puede romper el chat.
 */
export const TEAM_SEEN_STORAGE_KEY = 'latte.coordination.team-seen';

/**
 * Un tope, porque esto se escribe una vez por run y nunca se borra solo: sin
 * él, una instalación vieja arrastra miles de ids que ya no existen. Se
 * conservan los ÚLTIMOS, que son los únicos que pueden tener una línea viva.
 */
const MAX_REMEMBERED = 50;

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(TEAM_SEEN_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Una fila ilegible NO es "no vio nada raro": se descarta entera y se
    // empieza de cero, que es el estado honesto (el aviso vuelve una vez).
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function write(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(TEAM_SEEN_STORAGE_KEY, JSON.stringify(ids.slice(-MAX_REMEMBERED)));
  } catch {
    /* Sin storage el aviso vuelve tras reiniciar: molesto, nunca roto. */
  }
}

export interface TeamSeen {
  /** `true` cuando la persona ya abrió el equipo de ESTE run. */
  seen: (runId: string | null | undefined) => boolean;
  /** Anota que el equipo de este run ya se abrió. Idempotente. */
  markSeen: (runId: string | null | undefined) => void;
}

export function useTeamSeen(): TeamSeen {
  const [ids, setIds] = useState<readonly string[]>(read);
  const markSeen = useCallback((runId: string | null | undefined) => {
    if (!runId) return;
    setIds((prev) => {
      if (prev.includes(runId)) return prev;
      const next = [...prev, runId].slice(-MAX_REMEMBERED);
      write(next);
      return next;
    });
  }, []);
  const seen = useCallback((runId: string | null | undefined) => Boolean(runId) && ids.includes(runId!), [ids]);
  return { seen, markSeen };
}
