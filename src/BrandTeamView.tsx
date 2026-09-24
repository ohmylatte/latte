import { useState } from 'react';
import { Trash2, UserPlus, X } from 'lucide-react';
import { parseAvatar } from '../shared/avatar';
import type { BrandMember, TeamMemberOptions, Work } from '../shared/contracts';
import { translate as t } from './i18n';
import { CoordAvatar } from './coordination/anatomy';
import { RolePicker, type RolePickerProps } from './TeamPanel';

/**
 * MARCA → EQUIPO: EL PLANTEL (brief `docs/briefs/2026-09-23-equipo-de-marca.md`, 5).
 *
 * Quién trabaja para esta marca, con su cara: la misma persona que un trabajo
 * convoca y que la coordinación trae al aprobar un alta. Estar acá no corre
 * nada; convocar abre su hilo en el trabajo abierto.
 *
 * La fila es la del equipo —avatar · nombre · qué es ahora— con sus acciones
 * al costado, porque acá la fila no abre nada: no hay un hilo de marca que
 * leer. Los retirados (nadie los convocó en un tiempo, o alguien los quitó) se
 * ven en gris y se traen de vuelta convocándolos. Presentacional: no habla con
 * `browser-api`, y sin un handler no ofrece el botón que lo usaría.
 */
export interface BrandTeamViewProps {
  brandName: string;
  roster: readonly BrandMember[];
  /** El trabajo abierto: a dónde convoca "Convocar". Sin trabajo no se ofrece. */
  work: Work | null;
  busy: boolean;
  onCallUp?: (brandMemberId: string) => void;
  onRetire?: (brandMemberId: string) => void;
  /** Sumar al plantel sin convocar: el mismo diálogo que "Sumar un rol". Sin esto no se ofrece. */
  onAdd?: (roleId: string, options: TeamMemberOptions | null) => Promise<void>;
  /** Lo que el diálogo de alta necesita saber de los agentes. */
  picker?: Omit<RolePickerProps, 'onAdd' | 'onCancel' | 'canCancel' | 'busy'>;
}

export function BrandTeamView(props: BrandTeamViewProps) {
  const [adding, setAdding] = useState(false);
  const active = props.roster.filter((m) => m.retiredAt === null);
  const retired = props.roster.filter((m) => m.retiredAt !== null);
  const workId = props.work?.id ?? null;

  const row = (member: BrandMember) => {
    const here = workId !== null && member.workIds.includes(workId);
    // Qué es ahora, en una línea: con qué agente trabaja y dónde está.
    const where = here ? t('roster.line.here')
      : member.workIds.length > 0 ? t('roster.line.works', { count: member.workIds.length })
        : t('roster.line.idle');
    const line = member.retiredAt !== null ? t('roster.retired') : `${member.label} · ${where}`;
    return <li key={member.id} className={'coord-row roster-row' + (member.retiredAt !== null ? ' is-retired' : '')} data-member-id={member.id}>
      <CoordAvatar name={member.roleName} roleId={member.roleId} avatar={parseAvatar(member.avatar)} />
      <span className="coord-row-text">
        <span className="coord-row-top"><span className="coord-row-name">{member.roleName}</span></span>
        <span className="coord-row-line" title={line}>{line}</span>
      </span>
      <span className="roster-actions">
        {props.onCallUp && !here && <button type="button" className="subtle roster-call" disabled={props.busy || workId === null}
          title={props.work ? t('roster.callUpTo', { work: props.work.title }) : t('roster.callUpNeedsWork')}
          onClick={() => props.onCallUp!(member.id)}>{t('roster.callUp')}</button>}
        {props.onRetire && member.retiredAt === null && <button type="button" className="icon-button" disabled={props.busy}
          aria-label={t('roster.remove', { name: member.roleName })} title={t('roster.remove', { name: member.roleName })}
          onClick={() => props.onRetire!(member.id)}><Trash2 size={14} /></button>}
      </span>
    </li>;
  };

  return <div className="document-scroll brand-team-view">
    <h1>{t('roster.title', { brand: props.brandName })}</h1>
    <ul className="roster-list" aria-label={t('roster.list')}>
      {props.roster.length === 0 && <li className="roster-empty">{t('roster.empty')}</li>}
      {active.map(row)}
      {retired.map(row)}
      {props.onAdd && props.picker && <li className="team-inbox-row coord-add-row">
        <button type="button" className="coord-row coord-add" disabled={props.busy} onClick={() => setAdding(true)}>
          <CoordAvatar name="" dot="none"><UserPlus size={14} /></CoordAvatar>
          <span className="coord-row-text"><span className="coord-row-name">{t('coord.empty.addRole')}</span></span>
        </button>
      </li>}
    </ul>
    {adding && props.onAdd && props.picker && <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !props.busy) setAdding(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="roster-add-title" className="modal">
        <div className="modal-head"><div><h2 id="roster-add-title">{t('roster.addTitle')}</h2></div><button className="modal-close" aria-label={t('ui.auto.001')} onClick={() => setAdding(false)}><X size={20} /></button></div>
        <div className="modal-body"><RolePicker {...props.picker} busy={props.busy} canCancel={false} onCancel={() => setAdding(false)}
          onAdd={async (roleId, options) => { await props.onAdd!(roleId, options); setAdding(false); }} /></div>
      </section>
    </div>}
  </div>;
}
