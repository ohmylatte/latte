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
  // `hourCycle: 'h23'` y no el default del locale: en es-AR el default da
  // "06:50 p. m." --once caracteres para decir lo que "18:50" dice en cinco--
  // y esos seis de mas salian del ancho del NOMBRE del miembro, que es lo
  // unico de la fila que no se puede recortar sin perder de quien se habla.
  return at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
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

/**
 * Cuántos días de CALENDARIO (local) separan `value` de `now`: 0 es hoy, 1
 * es ayer. No son bloques de 24 h: las 23:19 de ayer, vistas a las 9, son
 * "ayer" aunque hayan pasado menos de diez horas.
 */
export function daysAgo(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.max(0, Math.round((startOf(today) - startOf(at)) / 86400000));
}

/**
 * H2: LA HORA DICE DE QUÉ DÍA ES.
 *
 * `hourOf` sola, sobre algo de ayer, se leía como de hoy: "18:50" a las 9 de
 * la mañana es una hora que todavía no pasó. Hoy es la hora; ayer, "ayer
 * 18:50"; antes, la fecha corta y la hora. La palabra "ayer" entra por
 * parámetro, como el locale: este módulo no importa `i18n`.
 */
export function whenOf(value: string | null | undefined, options: { now?: number; locale?: string; yesterday?: string; hour?: (value: string) => string } = {}): string {
  const days = daysAgo(value, options.now);
  if (days === null || !value) return '';
  const locale = options.locale ?? 'es-AR';
  const hour = options.hour ? options.hour(value) : hourOf(value, locale);
  if (days === 0) return hour;
  if (days === 1) return `${options.yesterday ?? 'ayer'} ${hour}`;
  return `${new Date(value).toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${hour}`;
}
