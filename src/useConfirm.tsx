import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * El reemplazo de `window.confirm` (2.0 · ventana mínima, menor 7).
 *
 * `window.confirm` es síncrono y bloquea el hilo: no se puede animar, no se
 * puede enfocar con teclado y ningún lector de pantalla lo anuncia — más
 * todavía, en la app hay decisions que toman el resultado en el MISMO renglón
 * (`if (!confirm(...)) return;`), que es exactamente lo que no se puede hacer
 * con un diálogo de la app, que responde después.
 *
 * Por eso el contrato es una promesa: `confirm(request)` devuelve `true` si la
 * persona confirmó y `false` si canceló, Escape o el componente se fue del
 * medio — nunca queda un `await` colgado. El diálogo sale listo para poner en
 * el JSX con `dialog`, y es el `ConfirmDialog` compartido: mismo
 * `role="dialog"`, mismo `useModalA11y`, mismo botón con el nombre de la
 * acción.
 */

export interface ConfirmRequest {
  /** El tema, corto: va en el `<h2>` del diálogo. */
  title: string;
  /** La consecuencia, con el MISMO texto que ya decía la app. */
  body: string;
  /** El nombre de la acción ("Salir sin guardar", "Borrar"…), nunca un "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Pinta el botón de confirmar con la clase `.danger`. */
  destructive?: boolean;
  /** Mientras la acción no responde, el diálogo no se puede cerrar. */
  busy?: boolean;
}

export interface UseConfirm {
  /** Abre el diálogo y resuelve con la respuesta de la persona. */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** El diálogo para el JSX, o `null` cuando no hay nada pendiente. */
  dialog: ReactNode;
  /** Hay una confirmación abierta ahora mismo. */
  open: boolean;
}

export function useConfirm(): UseConfirm {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    setRequest(null);
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(value);
  }, []);

  const confirm = useCallback((next: ConfirmRequest) => {
    // Sólo una confirmación a la vez: si entra una con la anterior abierta,
    // la anterior se resuelve `false` en vez de quedarse colgada.
    const previous = resolver.current;
    if (previous) { resolver.current = null; previous(false); }
    return new Promise<boolean>((resolve) => { resolver.current = resolve; setRequest(next); });
  }, []);

  // Desmontar con algo abierto tampoco deja un await esperando para siempre.
  useEffect(() => () => { const pending = resolver.current; resolver.current = null; pending?.(false); }, []);

  const dialog = request ? (
    <ConfirmDialog
      titleId="confirm-request-title"
      title={request.title}
      body={request.body}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      destructive={request.destructive}
      busy={request.busy}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { confirm, dialog, open: request !== null };
}
