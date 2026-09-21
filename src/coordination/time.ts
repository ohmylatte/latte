/**
 * C1: LA HORA, EN MONO Y A LA DERECHA.
 *
 * El criterio 1 dice "cuándo" al final de cada fila, y el mockup lo dibuja
 * como `18:48` en monoespaciada. Una fecha completa ("13/9/26, 18:48") no cabe
 * en esa columna y además contesta una pregunta que nadie hizo: lo que la
 * persona quiere saber de una fila viva es la HORA.
 *
 * Puro y sin React. El locale entra por parámetro — este módulo no importa
 * `i18n` para poder probarse sin montar nada.
 */

/** `18:48`. Una fecha que no se puede leer devuelve '' — nunca `Invalid Date` en pantalla. */
export function hourOf(value: string | null | undefined, locale = 'es-AR'): string {
  if (!value) return '';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Cuántos minutos pasaron desde `value`, contra `now`. Negativo nunca: un
 * reloj adelantado no puede producir "hace -3 min".
 */
export function minutesSince(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / 60000));
}

/** Cuántos minutos FALTAN hasta `value`. `0` es "ya venció", que es un hecho, no un hueco. */
export function minutesUntil(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - now) / 60000));
}
