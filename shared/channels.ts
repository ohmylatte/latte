/**
 * OTROS CANALES — lo que la marca ya publica, sin importar dónde.
 *
 * La fuente del ADN deja de ser "Instagram" y pasa a ser una lista de links:
 * uno o varios, de las plataformas donde la marca ya está. Este archivo es lo
 * PURO de esa idea —sin React y sin red— y lo comparten las dos orillas:
 *
 *  - `electron/` lo usa para validar lo que llega en `BrandDnaSourcesInput`
 *    antes de armar el pedido al agente;
 *  - `src/` lo usa para mostrar cada canal con su nombre e ícono mientras la
 *    persona lo pega.
 *
 * Dos reglas y ninguna más:
 *
 *  1. QUÉ entra: un link http(s) o un `@usuario`, que se interpreta como
 *     Instagram. Un dominio pelado (`instagram.com/tumarca`) entra
 *     normalizado a `https://`, porque es así como la gente lo escribe.
 *  2. QUIÉN es: el DOMINIO decide la plataforma. Nunca se pregunta a la red:
 *     el ícono de al lado sale de esta tabla y de ningún otro lado.
 */

/** Lo máximo que una persona pega en un solo build. */
export const MAX_DNA_CHANNELS = 8;

export type ChannelPlatformId =
  | 'instagram'
  | 'linkedin'
  | 'google'
  | 'tiktok'
  | 'youtube'
  | 'facebook'
  | 'x'
  | 'pinterest'
  /** Lo que Latte no reconoce: entra igual, con el ícono genérico de link. */
  | 'link';

export interface ChannelPlatform {
  id: ChannelPlatformId;
  /** Nombre propio: el mismo en todos los idiomas. */
  label: string;
}

const LABELS: Record<ChannelPlatformId, string> = {
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  google: 'Google Business Profile',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  facebook: 'Facebook',
  x: 'X',
  pinterest: 'Pinterest',
  link: 'Link',
};

/** Un `@usuario` tiene esta forma; cualquier otra cosa no es un canal. */
const HANDLE = /^@[A-Za-z0-9._-]{1,64}$/;

/**
 * Base de cada plataforma. Un host que termina en `.base` también cuenta
 * (`m.facebook.com`, `vm.tiktok.com`), pero `instagram.com.evil.example` NO
 * termina en `.instagram.com`: el dominio manda, no el resto de la URL.
 */
const HOSTS: ReadonlyArray<readonly [ChannelPlatformId, readonly string[]]> = [
  ['instagram', ['instagram.com', 'instagr.am', 'cdninstagram.com']],
  ['linkedin', ['linkedin.com', 'lnkd.in']],
  ['google', ['business.google.com', 'g.page', 'goo.gl']],
  ['tiktok', ['tiktok.com']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['facebook', ['facebook.com', 'fb.com']],
  ['x', ['x.com', 'twitter.com', 't.co']],
  ['pinterest', ['pinterest.com', 'pin.it']],
];

function isSchemeLike(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
}

/**
 * El link entendido por el navegador, ya normalizado. `null` si no es un
 * http(s) con dominio: sin credenciales (`mailto:` entra así), sin espacios y
 * con un punto en el host (`https://hola` no es ningún sitio).
 */
function channelUrl(raw: string): { url: URL; value: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const value = isSchemeLike(text) ? text : `https://${text}`;
  if (/\s/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (!url.hostname.includes('.')) return null;
    return { url, value };
  } catch {
    return null;
  }
}

/**
 * Una entrada de canal, ya en la forma del contrato: `https://…` o `@usuario`.
 * `null` si no es ni una cosa ni la otra.
 */
export function normalizeChannel(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('@')) return HANDLE.test(text) ? text : null;
  return channelUrl(text)?.value ?? null;
}

/** Lo que entra y lo que no, para poder mostrar las dos cosas en la tarjeta. */
export function splitChannelList(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const piece of text.split(/[\n,]+/)) {
    const raw = piece.trim();
    if (!raw) continue;
    const channel = normalizeChannel(raw);
    if (channel === null) {
      invalid.push(raw);
      continue;
    }
    const key = channel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (valid.length < MAX_DNA_CHANNELS) valid.push(channel);
  }
  return { valid, invalid };
}

/** El texto pegado en la lista que Latte manda al motor. */
export function parseChannelList(text: string): string[] {
  return splitChannelList(text).valid;
}

/** La plataforma de un canal, por dominio. Puro: nunca toca la red. */
function platformId(value: string): ChannelPlatformId {
  const text = value.trim();
  if (text.startsWith('@')) return HANDLE.test(text) ? 'instagram' : 'link';
  const parsed = channelUrl(text);
  if (!parsed) return 'link';
  const host = parsed.url.hostname.toLowerCase().replace(/^www\./, '');
  for (const [id, bases] of HOSTS) {
    if (bases.some((base) => host === base || host.endsWith(`.${base}`))) return id;
  }
  // `google.com` sólo cuenta cuando es Maps o un perfil de negocio: una
  // búsqueda cualquiera no es un canal de la marca.
  if ((host === 'google.com' || host.endsWith('.google.com')) && /^\/(maps|business)(\/|$)/.test(parsed.url.pathname)) return 'google';
  return 'link';
}

/** El nombre y el id de la plataforma, para el ícono de al lado del link. */
export function recognizeChannel(value: string): ChannelPlatform {
  const id = platformId(value);
  return { id, label: LABELS[id] };
}
