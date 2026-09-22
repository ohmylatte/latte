import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { avatarFor, avatarVariants, parseAvatar, serializeAvatar, type AvatarParams } from '../../shared/avatar';
import { translate as t } from '../i18n';
import { Avatar } from './Avatar';

/**
 * ELEGIR LA CARA DE UN ROL.
 *
 * Ocho caras del mismo color, porque el color ya lo decidió el rol: lo único
 * que se elige acá es la persona. "Otras ocho" vuelve a tirar la semilla.
 *
 * La primera opción NUNCA es una sorpresa: es la que el rol ya tiene —la que
 * se autogeneró al escribir el id, o la que quedó guardada de antes—. Quien
 * abre a editar un rol y no quiere tocar la cara la encuentra ahí, elegida, y
 * no tiene que reconocerla entre ocho.
 */
export function AvatarPicker({ roleId, name, value, onChange, disabled }: {
  /** El id del rol: de acá salen la semilla y el color. */
  roleId: string;
  /** El nombre visible, para el `aria-label` de cada cara. */
  name: string;
  /** El avatar actual, serializado. `null` = todavía no eligió nadie. */
  value: string | null;
  onChange: (avatar: string) => void;
  disabled?: boolean;
}) {
  /*
   * La tanda. Cambiarla es cambiar la semilla, y la semilla es el id del rol
   * más el número de tanda: determinista, así volver a la tanda anterior
   * devuelve exactamente las mismas ocho caras.
   */
  const [round, setRound] = useState(0);
  const current: AvatarParams = avatarFor(value, roleId);
  const chosen = serializeAvatar(current);
  const options = useMemo(() => {
    const fresh = avatarVariants(round === 0 ? roleId : `${roleId}#tanda-${round}`, 8);
    // La cara que el rol YA tiene va primera y no se pierde entre las nuevas:
    // "otras ocho" ofrece otras, no te saca la tuya.
    const rest = fresh.filter((params) => serializeAvatar(params) !== chosen).slice(0, 7);
    return [current, ...rest];
  }, [roleId, round, chosen]);

  return (
    <fieldset className="av-picker" disabled={disabled}>
      <legend>{t('avatar.legend')}</legend>
      <div className="av-picker-grid" role="radiogroup" aria-label={t('avatar.legend')}>
        {options.map((params, index) => {
          const serialized = serializeAvatar(params);
          const selected = serialized === chosen;
          return (
            <button
              key={serialized}
              type="button"
              className={'av-pick' + (selected ? ' is-chosen' : '')}
              role="radio"
              aria-checked={selected}
              aria-pressed={selected}
              aria-label={t('avatar.option', { p0: index + 1, p1: options.length })}
              data-avatar-value={serialized}
              onClick={() => onChange(serialized)}
            >
              <Avatar params={params} roleId={roleId} name={name} size="lg" />
            </button>
          );
        })}
      </div>
      <div className="av-picker-foot">
        <p className="footnote">{t('avatar.hint')}</p>
        <button type="button" className="av-reroll" onClick={() => setRound((n) => n + 1)}>
          <RefreshCw size={14} />{t('avatar.reroll')}
        </button>
      </div>
    </fieldset>
  );
}

/** Lo que se manda a guardar: la elección si es legible, si no la que deriva el id. */
export function avatarToSave(value: string | null, roleId: string): string {
  return serializeAvatar(parseAvatar(value) ?? avatarFor(null, roleId));
}
