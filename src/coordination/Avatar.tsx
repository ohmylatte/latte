import type { CSSProperties, ReactNode } from 'react';
import type { AvatarParams } from '../../shared/avatar';
import { initialsOf } from './text';
import { roleColor } from './role-color';

/**
 * EL AVATAR: el color es el rol, la cara es la persona.
 *
 * SVG puro armado en la app: sin red, sin imágenes en disco, sin un servicio
 * que decida cómo se ve el equipo de alguien. La biblioteca de formas se monta
 * UNA vez (`<AvatarSprite/>` en `App`) y cada avatar la referencia con `<use>`,
 * así trescientos avatares en pantalla son trescientas referencias y un solo
 * dibujo.
 *
 * Los ids del sprite llevan el prefijo `av-` a propósito: es el único espacio
 * de nombres de `<symbol>` de la app, y el prefijo lo mantiene así aunque
 * mañana aparezca otro.
 *
 * El punto de estado NO es parte del SVG. Es un elemento aparte, como siempre:
 * el avatar dice QUIÉN, el punto dice CÓMO ESTÁ, y mezclarlos sería volver a
 * tener dos cosas diciendo lo mismo a medias.
 */

/** Las formas, una sola vez en el documento. Montalo en la raíz de la app. */
export function AvatarSprite() {
  return (
    <svg className="av-sprite" aria-hidden="true" focusable="false" data-testid="avatar-sprite">
      <defs>
        {/* El disco y el cuerpo: lo que lleva el color del rol. */}
        <symbol id="av-bg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" /></symbol>
        <symbol id="av-body" viewBox="0 0 64 64"><path d="M11 64c0-11 9-18 21-18s21 7 21 18z" /></symbol>
        <symbol id="av-head" viewBox="0 0 64 64"><circle cx="32" cy="28" r="13" /></symbol>
        {/* Cinco peinados y un gorro. */}
        <symbol id="av-hair-short" viewBox="0 0 64 64"><path d="M19 27c0-10 6-15 13-15s13 5 13 15c-2-5-7-8-13-8s-11 3-13 8z" /></symbol>
        <symbol id="av-hair-bob" viewBox="0 0 64 64"><path d="M18 30c0-11 6-17 14-17s14 6 14 17v7h-5v-7c0-3-1-5-3-7-2 3-4 4-6 4s-4-1-6-4c-2 2-3 4-3 7v7h-5z" /></symbol>
        <symbol id="av-hair-curly" viewBox="0 0 64 64">
          <circle cx="22" cy="20" r="5" /><circle cx="32" cy="15" r="6" /><circle cx="42" cy="20" r="5" />
          <circle cx="19" cy="28" r="4" /><circle cx="45" cy="28" r="4" />
          <circle cx="27" cy="16" r="4" /><circle cx="37" cy="16" r="4" />
        </symbol>
        <symbol id="av-hair-bun" viewBox="0 0 64 64"><path d="M19 27c0-10 6-15 13-15s13 5 13 15c-2-5-7-8-13-8s-11 3-13 8z" /><circle cx="32" cy="12" r="4.5" /></symbol>
        <symbol id="av-hair-long" viewBox="0 0 64 64"><path d="M17 40V28c0-10 6-16 15-16s15 6 15 16v12h-6V30c0-3-1-5-3-7-2 3-4 4-6 4s-4-1-6-4c-2 2-3 4-3 7v10z" /></symbol>
        <symbol id="av-hair-beanie" viewBox="0 0 64 64"><path d="M18 27c0-9 6-15 14-15s14 6 14 15z" /><rect x="17" y="25" width="30" height="5" rx="2.5" /></symbol>
        {/* La cara: dos puntos y una curva. Alcanza. */}
        <symbol id="av-eyes" viewBox="0 0 64 64"><circle cx="27" cy="28" r="1.7" /><circle cx="37" cy="28" r="1.7" /></symbol>
        <symbol id="av-mouth" viewBox="0 0 64 64"><path d="M29 34q3 2.5 6 0" fill="none" strokeWidth="1.6" strokeLinecap="round" /></symbol>
        {/* Los accesorios, en tinta. */}
        <symbol id="av-glasses" viewBox="0 0 64 64">
          <circle cx="27" cy="28" r="4.2" fill="none" strokeWidth="1.5" />
          <circle cx="37" cy="28" r="4.2" fill="none" strokeWidth="1.5" />
          <path d="M31.2 28h1.6" fill="none" strokeWidth="1.5" />
        </symbol>
        <symbol id="av-phones" viewBox="0 0 64 64">
          <path d="M19 29v-3c0-7 6-12 13-12s13 5 13 12v3" fill="none" strokeWidth="2" />
          <rect x="16.5" y="26" width="4.5" height="7" rx="2" />
          <rect x="43" y="26" width="4.5" height="7" rx="2" />
        </symbol>
        <symbol id="av-earring" viewBox="0 0 64 64"><circle cx="19.5" cy="33" r="1.6" /></symbol>
        {/*
          La taza del tablero. Ninguna superficie la compone todavía: entra
          acá porque es parte de la biblioteca aprobada y un `<symbol>` sin
          `<use>` no dibuja nada ni cuesta nada.
        */}
        <symbol id="av-cup" viewBox="0 0 64 64">
          <circle cx="50" cy="50" r="9" fill="var(--foam)" />
          <path d="M45 47h8v4a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3z" />
          <path d="M53 48h1.5a1.5 1.5 0 0 1 0 3H53" fill="none" strokeWidth="1.2" />
        </symbol>
      </defs>
    </svg>
  );
}

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  /**
   * La cara. `null` cae a la inicial del nombre con el color del rol: un rol
   * viejo, un miembro de un equipo guardado antes de todo esto o un fixture de
   * un test no se quedan sin avatar, se quedan sin CARA.
   */
  params?: AvatarParams | null;
  roleId?: string | null;
  /** El nombre visible, para `aria-label` y para la inicial de reserva. Nunca un id. */
  name: string;
  /** 22 · 32 · 40. El tamaño lo fija la clase, no el SVG: el dibujo llena a su huésped. */
  size?: AvatarSize;
  /** El punto de estado, como elemento aparte. Sin esto no se dibuja ninguno. */
  status?: string | null;
  className?: string;
  /** Reemplaza la cara entera: el avatar punteado de "Sumar un rol" lleva un ícono. */
  children?: ReactNode;
}

/**
 * Cómo se pinta cada accesorio, tal cual el tablero: los anteojos son puro
 * trazo, los auriculares trazan el arco y rellenan las cápsulas, y el aro es
 * el único que no va en tinta — va en `--rust`, que es lo que lo hace leerse
 * como una joya y no como una mancha.
 */
const ACCESSORY: Readonly<Record<string, { id: string; fill?: string; stroke?: string } | null>> = {
  none: null,
  glasses: { id: 'av-glasses', stroke: 'var(--ink)' },
  phones: { id: 'av-phones', fill: 'var(--ink)', stroke: 'var(--ink)' },
  earring: { id: 'av-earring', fill: 'var(--rust)' },
};

export function Avatar({ params, roleId, name, size = 'md', status, className, children }: AvatarProps) {
  const { color, wash } = roleColor(roleId);
  const style = { '--av-color': color, '--av-wash': wash } as CSSProperties;
  const classes = ['av', `av-${size}`, className].filter(Boolean).join(' ');
  const accessory = params ? ACCESSORY[params.accessory] ?? null : null;
  return (
    <span
      className={classes}
      style={style}
      data-role={roleId ?? undefined}
      data-avatar={params ? params.hair : children ? 'slot' : 'initial'}
      role="img"
      aria-label={name}
    >
      {children ?? (params
        ? (
          <svg className="av-face" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
            <use href="#av-bg" fill="var(--av-wash)" />
            <use href="#av-body" fill="var(--av-color)" />
            <use href="#av-head" fill={`var(--av-skin-${params.skin})`} />
            <use href={`#av-hair-${params.hair}`} fill={`var(--av-hair-${params.hairColor})`} />
            <use href="#av-eyes" fill="var(--ink)" />
            <use href="#av-mouth" stroke="var(--ink)" />
            {accessory && <use href={`#${accessory.id}`} fill={accessory.fill} stroke={accessory.stroke} />}
          </svg>
        )
        : <span className="av-initial" aria-hidden="true">{initialsOf(name)}</span>)}
      {status ? <i className={`av-dot av-dot-${status}`} /> : null}
    </span>
  );
}
