import type { KeyboardEvent } from 'react';

/**
 * 2.0 · la tira de pestañas del trabajo, con el teclado.
 *
 * A la ventana mínima (1024 x 700) las siete pestañas miden 720 px y la
 * columna central tiene 479: la tira scrollea, y un scroll sólo sirve si se
 * llega a todo lo que esconde. `Tab` ya llega — cada pestaña sigue siendo un
 * `<button>` nativo, sin `tabindex="-1"`, y el navegador la trae a la vista
 * al enfocarla. Las flechas son el otro camino, el del que no quiere saltar
 * siete veces: derecha/izquierda avanzan y vuelven, `Home`/`End` van a los
 * extremos, y en los extremos ENVUELVEN para que ninguna quede inalcanzable.
 *
 * Sólo se toman las cuatro teclas de movimiento, y sólo cuando el foco ya
 * está en la tira: el handler vive en el contenedor, así que un evento que no
 * pasa por ahí no se entera.
 */

const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

export function tabsKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (!MOVE_KEYS.has(event.key)) return;
  const strip = event.currentTarget;
  const buttons = [...strip.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  // El foco no está en ninguna pestaña: la tecla es de otro control.
  if (current < 0) return;
  event.preventDefault();
  const last = buttons.length - 1;
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? last
    : event.key === 'ArrowRight' ? (current >= last ? 0 : current + 1)
    : (current <= 0 ? last : current - 1);
  // `focus()` también mete la pestaña a la vista dentro del scroll.
  buttons[next]?.focus();
}
