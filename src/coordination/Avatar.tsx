import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { serializeAvatar, type AvatarParams } from '../../shared/avatar';
import { initialsOf } from './text';
import { roleColor } from './role-color';
import {
  AVATAR_VARIANTS,
  AvatarArt,
  AvatarDefs,
  avatarBeat,
  avatarPulse,
  DEFAULT_AVATAR_VARIANT,
  type AvatarVariant,
} from './avatar-art';

/**
 * EL AVATAR: el color es el rol, la cara es la persona.
 *
 * SVG puro armado en la app: sin red, sin imágenes en disco, sin un servicio
 * que decida cómo se ve el equipo de alguien. Las formas se montan UNA vez
 * (`<AvatarSprite/>` en `App`) y cada avatar las referencia con `<use>`, así
 * trescientos avatares en pantalla son trescientas referencias y un dibujo.
 *
 * Este archivo NO sabe dibujar, y es a propósito. Acá vive la composición: el
 * tamaño, el color del rol, el nombre accesible, la reserva, el punto de
 * estado y CUÁNDO la cara tiene derecho a moverse. Las formas y la manera de
 * pintarlas viven en `avatar-art`, que es el único que cambia si cambia el
 * estilo.
 *
 * El punto de estado NO es parte del SVG. Es un elemento aparte, como siempre:
 * el avatar dice QUIÉN, el punto dice CÓMO ESTÁ, y mezclarlos sería volver a
 * tener dos cosas diciendo lo mismo a medias.
 */

/** Las formas, una sola vez en el documento. Montalo en la raíz de la app. */
export function AvatarSprite({ variants = AVATAR_VARIANTS }: { variants?: readonly AvatarVariant[] } = {}) {
  return (
    <svg className="av-sprite" aria-hidden="true" focusable="false" data-testid="avatar-sprite">
      <AvatarDefs variants={variants} />
    </svg>
  );
}

/**
 * ¿Esta persona pidió que nada se mueva?
 *
 * Se lee en un efecto y no durante el render porque el primer render tiene que
 * ser igual en el servidor, en un test y en la app: primero se dibuja quieto,
 * y recién cuando el navegador confirma que se puede, la cara respira. Quien
 * pidió menos movimiento nunca ve el arranque animado.
 */
function useMotionAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setAllowed(!query.matches);
    apply();
    query.addEventListener?.('change', apply);
    return () => query.removeEventListener?.('change', apply);
  }, []);
  return allowed;
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
  /** El estilo de dibujo. Existe para que dos puedan convivir mientras uno reemplaza al otro. */
  variant?: AvatarVariant;
  /**
   * De dónde sale el ritmo del parpadeo. El id del miembro, cuando hay uno: es
   * lo único que distingue a dos personas con la misma cara y el mismo nombre.
   * Sin esto se usa el nombre y la cara, que ya alcanza para desincronizar.
   */
  seed?: string | null;
  /** El punto de estado, como elemento aparte. Sin esto no se dibuja ninguno. */
  status?: string | null;
  className?: string;
  /** Reemplaza la cara entera: el avatar punteado de "Sumar un rol" lleva un ícono. */
  children?: ReactNode;
}

export function Avatar({
  params,
  roleId,
  name,
  size = 'md',
  variant = DEFAULT_AVATAR_VARIANT,
  seed,
  status,
  className,
  children,
}: AvatarProps) {
  const motionAllowed = useMotionAllowed();
  const { color, wash } = roleColor(roleId);
  const classes = ['av', `av-${size}`, className].filter(Boolean).join(' ');
  /*
   * A 22px una cara mide poco más que un carácter: un parpadeo ahí no se lee
   * como vida, se lee como un parpadeo de la pantalla. Y son los avatares que
   * aparecen de a decenas —la tira de tareas, las tarjetas del chat—, o sea
   * justo donde más costaría. Los chicos están quietos.
   */
  const alive = Boolean(params) && motionAllowed && size !== 'sm';
  const grain = Boolean(params) && size !== 'sm';
  const pulse = alive && params ? avatarPulse(avatarBeat(seed || `${name}\u0000${serializeAvatar(params)}`)) : null;
  return (
    <span
      className={classes}
      style={{ '--av-color': color, '--av-wash': wash } as CSSProperties}
      data-role={roleId ?? undefined}
      data-avatar={params ? params.hair : children ? 'slot' : 'initial'}
      data-avatar-variant={params ? variant : undefined}
      role="img"
      aria-label={name}
    >
      {children ?? (params
        ? (
          <svg
            className={['av-face', pulse?.className].filter(Boolean).join(' ')}
            style={pulse?.style}
            viewBox="0 0 64 64"
            aria-hidden="true"
            focusable="false"
          >
            <AvatarArt params={params} variant={variant} grain={grain} />
          </svg>
        )
        : <span className="av-initial" aria-hidden="true">{initialsOf(name)}</span>)}
      {status ? <i className={`av-dot av-dot-${status}`} /> : null}
    </span>
  );
}
