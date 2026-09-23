import type { ReactNode } from 'react';
import type { AvatarParams } from '../../shared/avatar';
import { Avatar } from './Avatar';
import type { MemberDot } from './member-line';

/**
 * C2: LA ANATOMÍA, UNA SOLA VEZ.
 *
 * Criterio 1: estado (avatar con punto) · nombre · qué hace ahora · cuándo.
 * Criterio 4: la fila ES la acción — un `<button>` entero, sin un "Abrir chat"
 * repetido tres veces al costado.
 *
 * Vive acá y no en cada pantalla porque la dibujan TRES: la lista del modo
 * Equipo, las pestañas de miembro del rail chat y el vacío sin run. Si cada
 * una la escribiera por su cuenta, "la misma anatomía" sería una intención,
 * no un hecho.
 */

/** El punto de estado. `none` es para el avatar de una tarea o un archivo, que no tiene estado propio. */
export type DotState = MemberDot | 'none';

export function CoordAvatar({ name, dot = 'none', small = false, roleId, avatar, children }: {
  name: string;
  dot?: DotState;
  /** El avatar chico: el dueño de una tarea en la tira, el autor de un archivo. */
  small?: boolean;
  roleId?: string;
  /**
   * La cara, ya resuelta por quien sabe de quién es: `avatarOfMember` para
   * una persona, `avatarOfRole` para un puesto. Sin esto cae a la inicial,
   * que es lo que ve un fixture viejo y lo que veía todo esto hasta ayer.
   */
  avatar?: AvatarParams | null;
  /** Reemplaza la cara: el avatar punteado de "Sumar un rol" lleva un ícono. */
  children?: ReactNode;
}) {
  /*
   * La ANATOMÍA no se mueve: el punto sigue siendo `coord-dot`, con sus
   * clases y su significado, y sigue estando afuera del SVG. Lo único que
   * cambió adentro es que donde había una inicial ahora hay una cara.
   */
  return <Avatar
    className={'coord-av' + (small ? ' coord-av-s' : '')}
    size={small ? 'sm' : 'md'}
    name={name}
    roleId={roleId}
    params={children ? null : avatar}
    dot={dot !== 'none' ? <i className={'coord-dot coord-dot-' + dot} /> : undefined}
  >{children}</Avatar>;
}

/** La hora, en monoespaciada y a la derecha. `''` no dibuja nada: una fila sin hora no lleva una columna vacía. */
export function CoordTime({ at, label }: { at: string | null | undefined; label: string }) {
  if (!label) return null;
  return <time className="coord-time" dateTime={at ?? undefined}>{label}</time>;
}

export interface CoordRowProps {
  /** El nombre visible. Nunca un id. */
  name: string;
  dot?: DotState;
  roleId?: string;
  /** La cara de quien es esta fila. Ver `CoordAvatar`. */
  avatar?: AvatarParams | null;
  /** Un ícono chico al lado del nombre: el coordinador lleva `Users`. */
  nameIcon?: ReactNode;
  /**
   * Reemplaza la cara. Una fila que no es una PERSONA no tiene inicial que
   * mostrar: una conexión lleva el ícono de su alcance, y el punto de estado
   * sigue estando donde estaba.
   */
  icon?: ReactNode;
  /** Qué hace ahora, en una línea. */
  line: string;
  /** La línea habla de algo que te espera: se lee en el acento. */
  urgent?: boolean;
  /** La hora ya formateada. Se calla cuando hay badge: son la misma columna. */
  time?: string;
  at?: string | null;
  /** Cuántas cosas te está esperando este miembro. Con una o más, reemplaza la hora. */
  badge?: number;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** El texto entero, para cuando la línea se recorta. Recortar no es callar. */
  title?: string;
  className?: string;
}

export function CoordRow(props: CoordRowProps) {
  const badge = props.badge ?? 0;
  return <button
    type="button"
    className={'coord-row' + (props.selected ? ' is-selected' : '') + (props.className ? ' ' + props.className : '')}
    aria-pressed={props.selected}
    disabled={props.disabled}
    onClick={props.onClick}
    title={props.title ?? props.line}
  >
    <CoordAvatar name={props.name} dot={props.dot ?? 'none'} roleId={props.roleId} avatar={props.avatar}>{props.icon}</CoordAvatar>
    <span className="coord-row-text">
      <span className="coord-row-top">
        <span className="coord-row-name">{props.name}{props.nameIcon}</span>
        {badge > 0
          ? <span className="coord-badge">{badge}</span>
          : <CoordTime at={props.at} label={props.time ?? ''} />}
      </span>
      {/* El acento significa VIVO; el fallo tiene su propio color. Nunca los
          dos: una fila que fallo no esta esperandote nada. */}
      <span className={'coord-row-line' + (props.urgent ? ' is-urgent' : props.dot === 'failed' ? ' is-failed' : '')}>{props.line}</span>
    </span>
  </button>;
}
