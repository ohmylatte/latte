/**
 * 3 · Fechas comerciales, estación y país: PURO, sin reloj ni zona horaria.
 *
 * Lo usan las dos puntas: el renderer para las ideas de respaldo de Inicio, y
 * el backend para el archivo de insumos que lee el agente. El día se calcula
 * con calendario (3er domingo de mayo, día después del 4º jueves de noviembre)
 * y la ventana es las PRÓXIMAS 6 SEMANAS desde una fecha dada: nada de "más o
 * menos cerca", y nada de adivinar el año.
 *
 * Los nombres de las fechas y las estaciones viven acá (y no en i18n) porque
 * el backend también los escribe, en el idioma del contenido de la marca:
 * una sola fuente que las dos pantallas comparten.
 */

export type CommercialCountry = 'AR' | 'US';

export type CommercialDateId =
  | 'valentines'
  | 'mothers-day'
  | 'fathers-day'
  | 'childrens-day'
  | 'hot-sale'
  | 'black-friday'
  | 'cyber-monday'
  | 'christmas';

export type Season = 'summer' | 'autumn' | 'winter' | 'spring';

/** Las próximas 6 semanas, exactas: de hoy (inclusive) a hoy + 42 días. */
export const COMMERCIAL_DATE_WINDOW_DAYS = 42;

const AR_DATES: readonly CommercialDateId[] = ['valentines', 'mothers-day', 'fathers-day', 'childrens-day', 'hot-sale', 'black-friday', 'cyber-monday', 'christmas'];
const US_DATES: readonly CommercialDateId[] = ['valentines', 'mothers-day', 'fathers-day', 'black-friday', 'cyber-monday', 'christmas'];

export function countryOf(locale: string): CommercialCountry {
  return locale === 'en-US' ? 'US' : 'AR';
}

export function commercialDateIds(country: CommercialCountry): readonly CommercialDateId[] {
  return country === 'US' ? US_DATES : AR_DATES;
}

/** El N-ésimo weekday (0 = domingo) del mes (1-12) de ese año. */
export function nthWeekdayDay(year: number, month: number, weekday: number, nth: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstOccurrence = 1 + ((weekday - first + 7) % 7);
  return firstOccurrence + (nth - 1) * 7;
}

/** Acción de Gracias (4º jueves de noviembre): de ahí salen Black Friday y Cyber Monday. */
export function thanksgivingDay(year: number): number {
  return nthWeekdayDay(year, 11, 4, 4);
}

/**
 * El día exacto de una fecha comercial EN ESE AÑO. El país sólo importa para
 * la Madre (mes distinto por hemisferio); `hot-sale` es el único aproximado:
 * la feria se mueve, se marca y se dice.
 */
export function commercialDateOn(year: number, id: CommercialDateId, country: CommercialCountry): { month: number; day: number; approximate: boolean } {
  switch (id) {
    case 'valentines': return { month: 2, day: 14, approximate: false };
    case 'mothers-day': return mothersDayOn(year, country);
    case 'fathers-day': return { month: 6, day: nthWeekdayDay(year, 6, 0, 3), approximate: false };
    case 'childrens-day': return { month: 8, day: nthWeekdayDay(year, 8, 0, 3), approximate: false };
    case 'hot-sale': return { month: 5, day: 15, approximate: true };
    case 'black-friday': return { month: 11, day: thanksgivingDay(year) + 1, approximate: false };
    case 'cyber-monday': return { month: 11, day: thanksgivingDay(year) + 4, approximate: false };
    case 'christmas': return { month: 12, day: 25, approximate: false };
  }
}

/** Día de la Madre: distinto hemisferio, distinto mes (3er domingo de octubre en AR, 2º de mayo en US). */
export function mothersDayOn(year: number, country: CommercialCountry): { month: number; day: number; approximate: boolean } {
  return country === 'US'
    ? { month: 5, day: nthWeekdayDay(year, 5, 0, 2), approximate: false }
    : { month: 10, day: nthWeekdayDay(year, 10, 0, 3), approximate: false };
}

function isoToUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoOfUtc(utc: number): string {
  const date = new Date(utc);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

export interface CommercialDateOccurrence {
  id: CommercialDateId;
  /** `YYYY-MM-DD`: exacta para esa ocurrencia. */
  date: string;
  /** El único aproximado es Hot Sale, y lo dice. */
  approximate: boolean;
}

/**
 * Las fechas del país dentro de la ventana [desde, desde + 6 semanas], con su
 * fecha EXACTA calculada para el año que corresponde: si la de este año pasó,
 * la ocurrencia es la del año que viene (y entonces queda fuera de la ventana).
 */
export function upcomingCommercialDates(country: CommercialCountry, fromIso: string): CommercialDateOccurrence[] {
  const from = isoToUtc(fromIso);
  const until = from + COMMERCIAL_DATE_WINDOW_DAYS * 86_400_000;
  const year = Number(fromIso.slice(0, 4));
  const out: CommercialDateOccurrence[] = [];
  for (const id of commercialDateIds(country)) {
    const on = commercialDateOn(year, id, country);
    let occurrence = Date.UTC(year, on.month - 1, on.day);
    if (occurrence < from) {
      const nextYear = year + 1;
      const next = commercialDateOn(nextYear, id, country);
      occurrence = Date.UTC(nextYear, next.month - 1, next.day);
    }
    if (occurrence >= from && occurrence <= until) out.push({ id, date: isoOfUtc(occurrence), approximate: on.approximate });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Días enteros hasta una fecha (`YYYY-MM-DD`): 0 es hoy. */
export function daysUntil(fromIso: string, dateIso: string): number {
  return Math.round((isoToUtc(dateIso) - isoToUtc(fromIso)) / 86_400_000);
}

/** Estación meteorológica del país para el mes de la fecha. Hemisferio sur vs norte. */
export function seasonOn(country: CommercialCountry, fromIso: string): Season {
  const month = Number(fromIso.slice(5, 7));
  const south = country === 'AR';
  if (month === 12 || month === 1 || month === 2) return south ? 'summer' : 'winter';
  if (month >= 3 && month <= 5) return south ? 'autumn' : 'spring';
  if (month >= 6 && month <= 8) return south ? 'winter' : 'summer';
  return south ? 'spring' : 'autumn';
}

const NAMES_ES: Record<CommercialDateId, string> = {
  'valentines': 'San Valentín',
  'mothers-day': 'Día de la Madre',
  'fathers-day': 'Día del Padre',
  'childrens-day': 'Día del Niño',
  'hot-sale': 'Hot Sale',
  'black-friday': 'Black Friday',
  'cyber-monday': 'Cyber Monday',
  'christmas': 'Navidad',
};
const NAMES_EN: Record<CommercialDateId, string> = {
  'valentines': "Valentine's Day",
  'mothers-day': "Mother's Day",
  'fathers-day': "Father's Day",
  'childrens-day': "Children's Day",
  'hot-sale': 'Hot Sale',
  'black-friday': 'Black Friday',
  'cyber-monday': 'Cyber Monday',
  'christmas': 'Christmas',
};

export function commercialDateName(id: CommercialDateId, locale: string): string {
  return locale === 'en-US' ? NAMES_EN[id] : NAMES_ES[id];
}

export function countryLabel(country: CommercialCountry, locale: string): string {
  if (country === 'US') return locale === 'en-US' ? 'United States' : 'Estados Unidos';
  return 'Argentina';
}

export function seasonLabel(season: Season, locale: string): string {
  const es: Record<Season, string> = { summer: 'verano', autumn: 'otoño', winter: 'invierno', spring: 'primavera' };
  const en: Record<Season, string> = { summer: 'summer', autumn: 'autumn', winter: 'winter', spring: 'spring' };
  return locale === 'en-US' ? en[season] : es[season];
}

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Fecha larga, a mano y sin `toLocaleDateString`: el mismo texto en cualquier
 * máquina, en los dos idiomas que Latte usa. (`2026-10-18` → "domingo 18 de
 * octubre de 2026" / "Sunday, October 18, 2026".)
 */
export function fullDateLabel(iso: string, locale: string): string {
  const utc = isoToUtc(iso);
  const date = new Date(utc);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const weekday = date.getUTCDay();
  if (locale === 'en-US') return `${WEEKDAYS_EN[weekday]}, ${MONTHS_EN[month]} ${day}, ${year}`;
  return `${WEEKDAYS_ES[weekday]} ${day} de ${MONTHS_ES[month]} de ${year}`;
}
