import type { CSSProperties, ReactNode } from 'react';
import { avatarHash, type AvatarParams } from '../../shared/avatar';

/**
 * EL DIBUJO, Y NADA MAS QUE EL DIBUJO.
 *
 * Este módulo es el ÚNICO que sabe cómo se ve un avatar. `Avatar.tsx` decide
 * el tamaño, el color del rol, el `aria-label` y el punto de estado; acá se
 * decide qué formas hay, cómo se pintan y cómo se mueven.
 *
 * ## Por qué SOLO el rostro
 *
 * Habia hombros, y con hombros los avatares se veian raros: a 32 px el
 * torso se come la mitad del disco y deja una cabeza chiquita y lejos. Sin
 * cuerpo la cara CRECE —el radio pasa de 13 a 16 en el mismo viewBox— y se
 * centra, que es lo unico que se mira a ese tamano.
 *
 * Pero los hombros eran los que llevaban el color pleno del rol, asi que la
 * identidad se muda al FONDO: el disco con el wash del rol y un anillo de 2
 * px en el color pleno, por dentro del borde. Un anillo lee el color a
 * cualquier tamano sin robarle lugar a la cara.
 *
 * ## Por qué planas
 *
 * Se probó la estética de impresión del sitio —grano, medios tonos, trazo de
 * tinta— y a 22 y 32 píxeles no se lee: una trama de puntos a ese tamaño es
 * BARRO. Las caras son planas, de trazo limpio, y el papel del sitio entra por
 * otro lado: un grano muy leve en el FONDO, que es una superficie grande y
 * quieta, donde sí se lee como papel y no como ruido.
 *
 * ## Los contratos que este módulo le debe al resto
 *
 * 1. `AvatarDefs` mete en el documento todo lo que el dibujo necesita, una
 *    sola vez: `<symbol>` y también `<filter>` —y mañana `<pattern>`,
 *    `<clipPath>` o `<mask>`—. Cada id lleva el prefijo de su variante
 *    (`av-flat-…`), así dos estilos pueden convivir sin pisarse.
 * 2. `AvatarArt` dibuja una cara. Cada pieza lleva `data-part`, que dice QUÉ
 *    es sin decir cómo se dibuja: los tests miran eso. Qué se dibuja es una
 *    promesa del producto; cómo se dibuja es una decisión de este archivo y
 *    tiene que poder cambiar sin romper una sola prueba.
 *
 * ## Por qué los ojos, las cejas y la boca NO salen del sprite
 *
 * Son las tres piezas que se mueven, y un `<use>` no puede animar el interior
 * del `<symbol>` que referencia: animarlo ahí movería a TODOS los avatares de
 * la pantalla al mismo tiempo y con la misma cara. Van inline, que es lo único
 * que permite que cada uno parpadee cuando le toca.
 */

/** Los estilos de dibujo. Hoy hay uno, terminado; el enganche queda para el que venga. */
export const AVATAR_VARIANTS = ['flat'] as const;
export type AvatarVariant = (typeof AVATAR_VARIANTS)[number];
export const DEFAULT_AVATAR_VARIANT: AvatarVariant = 'flat';

/** Qué es cada pieza, con independencia de cómo se dibuje. */
export type AvatarPart = 'bg' | 'ring' | 'head' | 'hair' | 'brows' | 'eyes' | 'mouth' | 'accessory';

/** El prefijo de ids de una variante. Dos estilos no comparten un solo id. */
export function avatarIdPrefix(variant: AvatarVariant): string {
  return `av-${variant}-`;
}

/** Los micro-movimientos. Uno por avatar, elegido por su semilla. */
export const AVATAR_MOVES = ['gaze', 'smile', 'brow'] as const;
export type AvatarMove = (typeof AVATAR_MOVES)[number];

export interface AvatarBeat {
  /** Cada cuánto parpadea, en segundos. Entre 4 y 7: más seguido es un tic. */
  blink: number;
  /** El desfase inicial. Sin esto un equipo entero parpadea al unísono. */
  delay: number;
  move: AvatarMove;
}

/**
 * El pulso de un avatar, derivado de su semilla.
 *
 * Determinista a propósito: el mismo miembro parpadea siempre con el mismo
 * ritmo, y dos miembros distintos casi nunca con el mismo. Un equipo que
 * parpadea al unísono no parece vivo, parece una animación.
 */
export function avatarBeat(seed: string): AvatarBeat {
  const hash = avatarHash('beat\u0000' + seed);
  return {
    blink: 4 + ((hash >>> 3) % 31) / 10,
    delay: ((hash >>> 11) % 70) / 10,
    move: AVATAR_MOVES[(hash >>> 19) % AVATAR_MOVES.length]!,
  };
}

/**
 * Cómo se pinta cada accesorio y a qué altura entra.
 *
 * `under` es lo que pasa POR DETRÁS de la cabeza: la bufanda y el cordón de
 * la credencial nacen ahí y reaparecen abajo del mentón. Todo lo demás va
 * encima. El aro va en `--rust`, que es lo que lo hace leerse como una joya
 * y no como una mancha.
 */
interface AccessoryArt { id: string; depth: 'under' | 'over'; fill?: string; stroke?: string }

const ACCESSORY: Readonly<Record<string, AccessoryArt | null>> = {
  none: null,
  glasses: { id: 'glasses', depth: 'over', stroke: 'var(--ink)' },
  'glasses-thick': { id: 'glasses-thick', depth: 'over', stroke: 'var(--ink)' },
  'glasses-round': { id: 'glasses-round', depth: 'over', stroke: 'var(--ink)' },
  phones: { id: 'phones', depth: 'over', fill: 'var(--ink)', stroke: 'var(--ink)' },
  earring: { id: 'earring', depth: 'over', fill: 'var(--rust)' },
  lanyard: { id: 'lanyard', depth: 'under', fill: 'var(--foam)', stroke: 'var(--ink)' },
  scarf: { id: 'scarf', depth: 'under', fill: 'var(--ink)' },
  headband: { id: 'headband', depth: 'over', fill: 'var(--ink)' },
  beret: { id: 'beret', depth: 'over', fill: 'var(--ink)' },
  cap: { id: 'cap', depth: 'over', fill: 'var(--ink)' },
  beard: { id: 'beard', depth: 'over', fill: `var(--av-hair-1)` },
  moustache: { id: 'moustache', depth: 'over', fill: `var(--av-hair-1)` },
};

/** El accesorio se dibuja con el color de pelo cuando es pelo: barba y bigote. */
const HAIR_COLOURED = new Set(['beard', 'moustache']);

/**
 * EL RE-ENCUADRE, en una sola linea.
 *
 * Las formas siguen dibujadas en la grilla de siempre —cabeza en (32, 28)
 * con r=13— porque estan afinadas ahi y volver a calcular quince paths a
 * mano es como se rompe un dibujo. Lo que cambia es el ENCUADRE: se lleva
 * el centro de la cara al centro del disco y se agranda.
 *
 * El 1.45 no es un gusto, es el techo: con la cabeza en r=13, el simbolo
 * que primero toca el borde es la boina, que a 1.45 llega a 30.4 de 32 y a
 * 1.50 se corta. Hay un test que recorre la geometria de CADA symbol y
 * falla si alguno se pasa, asi que subir este numero sin tocar los dibujos
 * no compila en verde: avisa cual se sale y por cuanto.
 *
 * Se lee de derecha a izquierda: llevo (32,28) al origen, escalo, y lo
 * devuelvo a (32,32).
 */
const PORTRAIT = 'translate(32 32) scale(1.45) translate(-32 -28)';

export interface AvatarArtProps {
  params: AvatarParams;
  variant?: AvatarVariant;
  /** El grano del fondo. Se apaga en los avatares chicos, donde no se ve y sólo cuesta. */
  grain?: boolean;
}

/**
 * Una cara. Devuelve el CONTENIDO de un `<svg viewBox="0 0 64 64">`: quién lo
 * envuelve, de qué tamaño y con qué color de rol no es asunto de acá.
 */
export function AvatarArt({ params, variant = DEFAULT_AVATAR_VARIANT, grain = false }: AvatarArtProps): ReactNode {
  const p = avatarIdPrefix(variant);
  const accessory = ACCESSORY[params.accessory] ?? null;
  const hairColour = `var(--av-hair-${params.hairColor})`;
  const accessoryFill = accessory && HAIR_COLOURED.has(accessory.id) ? hairColour : accessory?.fill;
  const piece = (art: AccessoryArt) => (
    <use data-part="accessory" data-accessory={params.accessory} href={`#${p}${art.id}`} fill={accessoryFill} stroke={art.stroke} />
  );
  return (
    <>
      <use data-part="bg" href={`#${p}bg`} fill="var(--av-wash)" filter={grain ? `url(#${p}grain)` : undefined} />
      <g className="av-portrait" transform={PORTRAIT}>
        {accessory?.depth === 'under' && piece(accessory)}
        <use data-part="head" href={`#${p}head`} fill={`var(--av-skin-${params.skin})`} />
        <use data-part="hair" href={`#${p}hair-${params.hair}`} fill={hairColour} />
        {/* Dos trazos, nada más: una ceja con volumen a 22px es un borrón. */}
        <g data-part="brows" className="av-brows" fill="none" stroke="var(--ink)" strokeWidth="1.1" strokeLinecap="round">
          <path d="M24.4 23.8q2.6-1.1 5.2 0" />
          <path d="M34.4 23.8q2.6-1.1 5.2 0" />
        </g>
        <g data-part="eyes" className="av-eyes" fill="var(--ink)">
          <ellipse className="av-eye" cx="27" cy="28" rx="1.7" ry="1.7" />
          <ellipse className="av-eye" cx="37" cy="28" rx="1.7" ry="1.7" />
        </g>
        <path
          data-part="mouth"
          className="av-mouth"
          d="M29 34q3 2.5 6 0"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        {accessory?.depth === 'over' && piece(accessory)}
      </g>
      {/*
        El anillo ES el rol: sin hombros, es lo unico que lleva el color
        pleno. Va ULTIMO para que sea un aro limpio y no un aro mordido por
        un peinado, y por DENTRO del borde (r=31 con trazo de 2) para que no
        se lo coma el redondeo del huesped.
      */}
      <circle data-part="ring" cx="32" cy="32" r="31" fill="none" stroke="var(--av-color)" strokeWidth="2" />
    </>
  );
}

/**
 * El pulso, como estilo y clase de ESTA cara.
 *
 * Va inline y no en la hoja porque cada avatar tiene el suyo: el período del
 * parpadeo y el desfase salen de la semilla. Las reglas —qué se anima y cómo—
 * viven en `styles.css`; acá sólo se dicen los números, y se dicen sobre el
 * elemento, que es lo único que no se le escapa al de al lado. Un `<style>`
 * dentro del SVG no se limita a su SVG: le pondría el ritmo del último avatar
 * montado a todos los demás.
 *
 * El micro-movimiento arranca a mitad del ciclo del parpadeo y dura el doble,
 * así nunca se superponen. Una cara que parpadea y sonríe al mismo tiempo no
 * parece viva, parece rota.
 */
export function avatarPulse(beat: AvatarBeat): { className: string; style: CSSProperties } {
  return {
    className: `av-alive av-move-${beat.move}`,
    style: {
      '--av-blink': `${beat.blink.toFixed(2)}s`,
      '--av-blink-delay': `${beat.delay.toFixed(2)}s`,
      '--av-move': `${(beat.blink * 2).toFixed(2)}s`,
      '--av-move-delay': `${(beat.delay + beat.blink / 2).toFixed(2)}s`,
    } as CSSProperties,
  };
}

/**
 * LAS FORMAS. Planas, de trazo limpio, pensadas para leerse a 22 píxeles.
 *
 * Todas comparten `viewBox="0 0 64 64"`, cabeza en (32, 28) con r=13 y hombros
 * que arrancan en y=46. Una forma nueva que no respete esa grilla va a quedar
 * flotando: no hay magia, hay un sistema de coordenadas.
 */
function FlatSymbols() {
  const p = avatarIdPrefix('flat');
  return (
    <>
      <symbol id={`${p}bg`} viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" /></symbol>
      <symbol id={`${p}head`} viewBox="0 0 64 64"><circle cx="32" cy="28" r="13" /></symbol>

      {/* Cinco peinados y un gorro: el gorro OCUPA el lugar del pelo. */}
      <symbol id={`${p}hair-short`} viewBox="0 0 64 64"><path d="M19 27c0-10 6-15 13-15s13 5 13 15c-2-5-7-8-13-8s-11 3-13 8z" /></symbol>
      <symbol id={`${p}hair-bob`} viewBox="0 0 64 64"><path d="M18 30c0-11 6-17 14-17s14 6 14 17v7h-5v-7c0-3-1-5-3-7-2 3-4 4-6 4s-4-1-6-4c-2 2-3 4-3 7v7h-5z" /></symbol>
      <symbol id={`${p}hair-curly`} viewBox="0 0 64 64">
        <circle cx="22" cy="20" r="5" /><circle cx="32" cy="15" r="6" /><circle cx="42" cy="20" r="5" />
        <circle cx="19" cy="28" r="4" /><circle cx="45" cy="28" r="4" />
        <circle cx="27" cy="16" r="4" /><circle cx="37" cy="16" r="4" />
      </symbol>
      <symbol id={`${p}hair-bun`} viewBox="0 0 64 64"><path d="M19 27c0-10 6-15 13-15s13 5 13 15c-2-5-7-8-13-8s-11 3-13 8z" /><circle cx="32" cy="12" r="4.5" /></symbol>
      <symbol id={`${p}hair-long`} viewBox="0 0 64 64"><path d="M17 40V28c0-10 6-16 15-16s15 6 15 16v12h-6V30c0-3-1-5-3-7-2 3-4 4-6 4s-4-1-6-4c-2 2-3 4-3 7v10z" /></symbol>
      <symbol id={`${p}hair-beanie`} viewBox="0 0 64 64"><path d="M18 27c0-9 6-15 14-15s14 6 14 15z" /><rect x="17" y="25" width="30" height="5" rx="2.5" /></symbol>

      {/* Anteojos: tres marcos que a 22px se distinguen por el GROSOR y la forma. */}
      <symbol id={`${p}glasses`} viewBox="0 0 64 64">
        <circle cx="27" cy="28" r="4.2" fill="none" strokeWidth="1.5" />
        <circle cx="37" cy="28" r="4.2" fill="none" strokeWidth="1.5" />
        <path d="M31.2 28h1.6M22.8 28l-3.6-1.4M41.2 28l3.6-1.4" fill="none" strokeWidth="1.5" strokeLinecap="round" />
      </symbol>
      <symbol id={`${p}glasses-thick`} viewBox="0 0 64 64">
        <rect x="21.6" y="23.6" width="10.2" height="8.8" rx="2.4" fill="none" strokeWidth="2.6" />
        <rect x="32.2" y="23.6" width="10.2" height="8.8" rx="2.4" fill="none" strokeWidth="2.6" />
        <path d="M19.4 25.8l2.2.6M44.6 25.8l-2.2.6" fill="none" strokeWidth="2.6" strokeLinecap="round" />
      </symbol>
      <symbol id={`${p}glasses-round`} viewBox="0 0 64 64">
        <circle cx="26.6" cy="28" r="4.8" fill="none" strokeWidth="1.1" />
        <circle cx="37.4" cy="28" r="4.8" fill="none" strokeWidth="1.1" />
        <path d="M31.4 28h1.2M21.8 27.2l-3 -1M42.2 27.2l3 -1" fill="none" strokeWidth="1.1" strokeLinecap="round" />
      </symbol>

      <symbol id={`${p}phones`} viewBox="0 0 64 64">
        <path d="M19 29v-3c0-7 6-12 13-12s13 5 13 12v3" fill="none" strokeWidth="2" />
        <rect x="16.5" y="26" width="4.5" height="7" rx="2" />
        <rect x="43" y="26" width="4.5" height="7" rx="2" />
      </symbol>
      <symbol id={`${p}earring`} viewBox="0 0 64 64"><circle cx="19.5" cy="33" r="1.8" /></symbol>

      {/*
        La credencial y la bufanda cuelgan, y con mas zoom son las primeras
        que se caen del disco: todo lo que baja del menton se aleja del
        centro el doble de rapido que lo que crece a los costados.

        Subidas y acortadas para el encuadre de 1.45. El limite util sobre el
        eje es y=49.4 en la grilla de origen; con el ancho que tienen, ambas
        cierran cerca de 30 de 32.
      */}
      <symbol id={`${p}lanyard`} viewBox="0 0 64 64">
        <path d="M25.5 36l5.4 6M38.5 36l-5.4 6" fill="none" strokeWidth="1.5" strokeLinecap="round" />
        <rect x="28.8" y="41.6" width="6.4" height="6.4" rx="1" strokeWidth="1.1" />
        <path d="M30.4 44h3.2" fill="none" strokeWidth="1" strokeLinecap="round" />
      </symbol>
      <symbol id={`${p}scarf`} viewBox="0 0 64 64">
        <path d="M22.5 40.4q9.5 5.2 19 0v4.2q-9.5 5.2-19 0z" />
        <path d="M36.6 44h3.4l-.6 3.5h-3.1z" />
      </symbol>
      {/* La vincha: una banda sobre la frente, de sien a sien. */}
      <symbol id={`${p}headband`} viewBox="0 0 64 64"><path d="M19.6 23.4q12.4-7.6 24.8 0l-1.3 3.2q-11.1-6.6-22.2 0z" /></symbol>
      {/* La boina: inclinada, con su cabito. La inclinación ES la boina. */}
      <symbol id={`${p}beret`} viewBox="0 0 64 64">
        <path d="M18.5 22.6q1-10.6 13.5-10.6 13.5 0 14.8 6.4 0.5 2.6-3.4 3.2-11.4 1.8-24.9 1z" />
        <circle cx="45.4" cy="14.6" r="2" />
      </symbol>
      {/* La gorra: domo y visera. La visera es lo que la hace gorra y no gorro. */}
      <symbol id={`${p}cap`} viewBox="0 0 64 64">
        <path d="M19 22.4q0-10.4 13-10.4t13 10.4z" />
        <path d="M44 19.6q7.4 0.6 8.6 4.6-4.6 1.4-9.2 0.6z" />
      </symbol>
      {/* Barba corta: sigue la mandíbula, nunca tapa la boca. */}
      <symbol id={`${p}beard`} viewBox="0 0 64 64">
        <path d="M20.4 28.6q0 12.4 11.6 12.4t11.6-12.4q-1.8 6-5 6.4-2 3.2-6.6 3.2t-6.6-3.2q-3.2-0.4-5-6.4z" />
      </symbol>
      {/* Bigote: dos curvas bajo la nariz, arriba de la boca. */}
      <symbol id={`${p}moustache`} viewBox="0 0 64 64">
        <path d="M32 31.4q-2-2.2-5-1.6-2.4 0.5-2.4 2.1 0 1.6 2.4 1.6 3.4 0 5-2.1z" />
        <path d="M32 31.4q2-2.2 5-1.6 2.4 0.5 2.4 2.1 0 1.6-2.4 1.6-3.4 0-5-2.1z" />
      </symbol>

      {/*
        EL PAPEL. Un grano muy leve, y SOLO en el fondo: es la superficie
        grande y quieta del avatar, la única donde una textura se lee como
        papel y no como suciedad. Sobre una cara de 13px de radio sería barro.
        Opacidad 0.07, bien por debajo del techo de 0.08.
      */}
      <filter id={`${p}grain`} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="noise" />
        <feColorMatrix in="noise" type="saturate" values="0" result="grey" />
        <feComponentTransfer in="grey" result="soft">
          <feFuncA type="linear" slope="0.07" intercept="0" />
        </feComponentTransfer>
        <feComposite in="soft" in2="SourceGraphic" operator="in" result="grain" />
        <feMerge>
          <feMergeNode in="SourceGraphic" />
          <feMergeNode in="grain" />
        </feMerge>
      </filter>
    </>
  );
}

/**
 * Todo lo que el dibujo necesita en el documento, una sola vez.
 *
 * `<defs>` acepta `<pattern>`, `<filter>`, `<clipPath>` y `<mask>` además de
 * `<symbol>` — el grano de acá ya es un `<filter>`. Lo único que se le pide a
 * cualquier cosa que entre es que su id arranque con `avatarIdPrefix(variant)`;
 * hay un test que lo verifica sobre TODOS los ids, no sólo sobre los
 * `<symbol>`, así que el día que aparezca un `<pattern>` sin prefijo se entera
 * solo.
 */
export function AvatarDefs({ variants = AVATAR_VARIANTS }: { variants?: readonly AvatarVariant[] } = {}): ReactNode {
  const wanted = new Set(variants);
  return <defs>{wanted.has('flat') && <FlatSymbols />}</defs>;
}
