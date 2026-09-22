/**
 * Avatares de Latte: un SISTEMA paramétrico, no un dibujo.
 *
 * "El color es el rol, la cara es la persona." El color sale del rol y vive en
 * el CSS; lo que este módulo decide es la CARA: peinado, piel, color de pelo y
 * accesorio. Se genera en la app, sin red y sin imágenes en disco.
 *
 * Todo acá es puro: la misma semilla da siempre la misma cara, en el main y en
 * el renderer. Por eso vive en `shared/` y no depende de nada.
 */

export const AVATAR_HAIRS = ['short', 'bob', 'curly', 'bun', 'long', 'beanie'] as const;
/**
 * Los accesorios, que son clichés del oficio a propósito: un equipo de
 * marketing se reconoce por sus anteojos de marco grueso, su boina, su
 * credencial de evento y sus auriculares. Doce y "ninguno".
 *
 * El criterio para entrar a esta lista es UNO: leerse a 22 píxeles. Un
 * accesorio que a ese tamaño es una mancha gris no cuenta como accesorio,
 * cuenta como suciedad, y por eso no hay lentes de sol ni estampados.
 */
export const AVATAR_ACCESSORIES = [
  'none',
  'glasses',        // anteojos finos
  'glasses-thick',  // marco grueso: el cliché del director de arte
  'glasses-round',  // redondos
  'phones',         // auriculares
  'earring',        // aro
  'lanyard',        // credencial de evento
  'scarf',          // bufanda
  'headband',       // vincha
  'beret',          // boina
  'cap',            // gorra
  'beard',          // barba corta
  'moustache',      // bigote
] as const;

export type AvatarHair = (typeof AVATAR_HAIRS)[number];
export type AvatarAccessory = (typeof AVATAR_ACCESSORIES)[number];
/** 1..4: índice de los tokens `--av-skin-N` / `--av-hair-N`. */
export type AvatarTone = 1 | 2 | 3 | 4;

/**
 * Las cuatro decisiones que hacen una cara. 6 × 4 × 4 × 13 = 1.248
 * combinaciones: mas que suficiente para que nadie se cruce con su gemelo.
 *
 * ABIERTA A PROPOSITO. El estilo de dibujo va a crecer —grano, trama, tinta,
 * vapor— y va a querer sus propios campos. Los que estan acá son el NUCLEO: lo
 * que toda cara tiene, mire como mire. Un campo nuevo se agrega opcional, la
 * forma serializada le suma un segmento al final y `parseAvatar` sigue leyendo
 * lo viejo sin enterarse; por eso el parser ignora los segmentos que no
 * conoce en vez de rechazarlos.
 */
export interface AvatarParams {
  hair: AvatarHair;
  skin: AvatarTone;
  hairColor: AvatarTone;
  accessory: AvatarAccessory;
}

const TONES: readonly AvatarTone[] = [1, 2, 3, 4];

/**
 * FNV-1a de 32 bits con avalancha final, sin dependencias.
 *
 * No es criptográfico y no pretende serlo: lo único que se le pide es que
 * reparta parejo y que dé el MISMO número en cualquier proceso. El `>>> 0`
 * mantiene el acumulador en 32 bits sin signo, y `Math.imul` hace la
 * multiplicación de 32 bits que `*` perdería en precisión de coma flotante.
 *
 * La avalancha del final NO es decoración. FNV-1a termina en una
 * multiplicación por un primo impar, y en una multiplicación el bit 0 del
 * producto sale del bit 0 de los factores: los bits BAJOS del hash casi no
 * dependen del resto de la entrada. Como acá se elige con `% 6` y `% 4` —puro
 * bit bajo—, sin mezclar, `rol-0`…`rol-99` daban 12 caras distintas en vez de
 * ~88. El finalizador de murmur3 (`fmix32`) baja la entropía de los bits altos
 * a los bajos y lo arregla.
 */
export function avatarHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
    // El char code puede pasar de 255 (acentos, emoji): el byte alto también entra.
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * La cara de una semilla. Determinista: `avatarFromSeed('x')` vale lo mismo
 * hoy, mañana y en el otro proceso.
 *
 * Cada decisión usa un hash propio (la semilla con un prefijo distinto) en vez
 * de repartirse los bits de uno solo: así dos semillas parecidas no comparten
 * los bits altos y el peinado no queda correlacionado con el tono de piel.
 */
export function avatarFromSeed(seed: string): AvatarParams {
  const text = String(seed ?? '');
  const pick = <T>(salt: string, options: readonly T[]): T => options[avatarHash(salt + '\u0000' + text) % options.length];
  return {
    hair: pick('hair', AVATAR_HAIRS),
    skin: pick('skin', TONES),
    hairColor: pick('hairColor', TONES),
    accessory: pick('accessory', AVATAR_ACCESSORIES),
  };
}

/**
 * `n` caras distintas entre sí para la misma semilla: lo que la grilla de
 * "elegí una" muestra. La primera es siempre `avatarFromSeed(seed)`, así lo
 * que se autogeneró al crear el rol queda como primera opción.
 *
 * Camina semillas derivadas (`seed#1`, `seed#2`, …) descartando repetidas.
 * Con mas de mil combinaciones y `n` chico la caminata termina enseguida; el tope de
 * intentos existe para que nunca pueda colgarse, no porque se espere llegar.
 */
export function avatarVariants(seed: string, n = 8): AvatarParams[] {
  const wanted = Math.max(0, Math.min(64, Math.floor(n)));
  const out: AvatarParams[] = [];
  const seen = new Set<string>();
  for (let step = 0; out.length < wanted && step < wanted * 200; step += 1) {
    const params = avatarFromSeed(step === 0 ? seed : `${seed}#${step}`);
    const key = serializeAvatar(params);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(params);
  }
  return out;
}

/** Compacto y legible a ojo: `bob.2.4.phones`. Es lo que se guarda en el rol. */
export function serializeAvatar(params: AvatarParams): string {
  return `${params.hair}.${params.skin}.${params.hairColor}.${params.accessory}`;
}

/**
 * La vuelta. Tolerante por diseño: lo que viene del disco o de un frontmatter
 * escrito a mano puede ser cualquier cosa, y "cualquier cosa" es `null`, no una
 * excepción. Quien llama decide el fallback (casi siempre `avatarFromSeed`).
 */
export function parseAvatar(value: unknown): AvatarParams | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().toLowerCase().split('.');
  // Cuatro segmentos o MAS. Los de mas son de una version que sabe algo que
  // esta no: se ignoran, y la cara se dibuja con el nucleo. Lo contrario
  // —rechazar— le borraria el avatar a alguien por abrir una version anterior.
  if (parts.length < 4) return null;
  const [hair, skin, hairColor, accessory] = parts;
  if (!isHair(hair) || !isAccessory(accessory)) return null;
  const skinTone = toTone(skin);
  const hairTone = toTone(hairColor);
  if (skinTone === null || hairTone === null) return null;
  return { hair, skin: skinTone, hairColor: hairTone, accessory };
}

function isHair(value: string): value is AvatarHair {
  return (AVATAR_HAIRS as readonly string[]).includes(value);
}

function isAccessory(value: string): value is AvatarAccessory {
  return (AVATAR_ACCESSORIES as readonly string[]).includes(value);
}

function toTone(value: string): AvatarTone | null {
  return value === '1' || value === '2' || value === '3' || value === '4' ? (Number(value) as AvatarTone) : null;
}

/**
 * El avatar de un rol, ya resuelto: lo elegido si es válido, y si no la cara
 * que le toca a su id. Ningún rol se queda sin cara, y por eso nada hay que
 * migrar: un rol viejo sin `avatar` deriva el suyo de su propio id.
 */
export function avatarFor(stored: string | null | undefined, seed: string): AvatarParams {
  return parseAvatar(stored) ?? avatarFromSeed(seed);
}
