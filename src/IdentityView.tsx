import { Check, FilePlus, FileText, Image, Palette, ShieldOff, Trash2, Type, Users } from 'lucide-react';
import type { BrandIdentityFileView, BrandIdentityView } from '../shared/contracts';
import { translate as t } from './i18n';

/**
 * MARCA → IDENTIDAD (E4). "Necesitamos un harness, no un CMS."
 *
 * Latte no renderiza ni impone plantillas: la identidad de la marca es un
 * recurso. Acá la persona trae los archivos (logo, manuales, paleta), le pide
 * al equipo que extraiga `IDENTIDAD.md`, y aprueba. Con la identidad aprobada,
 * cada trabajo de la marca la recibe en `identidad/` y el revisor verifica que
 * lo que va al cliente la aplique.
 *
 * Cargar el kit es tarea del equipo; aprobarlo es de la persona: por eso el
 * único botón primario es "Aprobar". Presentacional: no habla con
 * `browser-api`, y sin un handler no ofrece el botón que lo usaría. Nunca
 * muestra una ruta: cada archivo se lee por el nombre con que se trajo.
 */
export interface IdentityViewProps {
  brandName: string;
  identity: BrandIdentityView | null;
  busy: boolean;
  formatDate?: (value: string) => string;
  onAddFiles?: () => void;
  onRemoveFile?: (fileId: string) => void;
  onApprove?: () => void;
  onRevoke?: () => void;
  onExtract?: () => void;
  /** La línea de lo que pasó con el último pedido al equipo, ya redactada por el contenedor. */
  extractionNote?: string | null;
}

function FileIcon({ file }: { file: BrandIdentityFileView }) {
  if (file.identityDoc) return <Palette size={14} />;
  if (file.kind === 'logo') return <Image size={14} />;
  if (file.kind === 'font') return <Type size={14} />;
  return <FileText size={14} />;
}

function sizeOf(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function IdentityView(props: IdentityViewProps) {
  const identity = props.identity;
  const state = identity?.state ?? 'empty';
  const files = identity?.files ?? [];
  const date = props.formatDate ?? ((value: string) => value.slice(0, 10));
  const stateLine = state === 'approved' && identity?.approved
    ? (identity.changedSinceApproval
      ? t('identity.state.approvedChanged', { version: identity.approved.version })
      : t('identity.state.approved', { version: identity.approved.version, date: date(identity.approved.approvedAt) }))
    : state === 'revoked' ? t('identity.state.revoked')
      : state === 'draft' ? t('identity.state.draft')
        : t('identity.state.empty');
  const canApprove = files.length > 0 && (state !== 'approved' || Boolean(identity?.changedSinceApproval));

  return <div className="document-scroll identity-view">
    <h1>{t('identity.title', { brand: props.brandName })}</h1>
    <p className="intro">{t('identity.intro')}</p>
    <p className={'identity-state is-' + state} data-state={state}>
      {state === 'approved' ? <Check size={14} /> : state === 'revoked' ? <ShieldOff size={14} /> : <Palette size={14} />}
      <span>{stateLine}</span>
    </p>
    <ul className="roster-list identity-files" aria-label={t('identity.files')}>
      {files.length === 0 && <li className="roster-empty">{t('identity.empty')}</li>}
      {files.map((file) => <li key={file.id} className={'coord-row roster-row identity-file' + (file.usable ? '' : ' is-retired')} data-file-id={file.id}>
        <span className="identity-file-icon" aria-hidden="true"><FileIcon file={file} /></span>
        <span className="coord-row-text">
          <span className="coord-row-top"><span className="coord-row-name">{file.name}</span></span>
          <span className="coord-row-line">{file.identityDoc
            ? t('identity.file.doc')
            : !file.usable ? t('identity.file.unusable')
              : `${t(`identity.kind.${file.kind}` as 'identity.kind.logo')} · ${sizeOf(file.bytes)}`}</span>
        </span>
        {props.onRemoveFile && <span className="roster-actions">
          <button type="button" className="icon-button" disabled={props.busy}
            aria-label={t('identity.file.remove', { name: file.name })} title={t('identity.file.remove', { name: file.name })}
            onClick={() => props.onRemoveFile!(file.id)}><Trash2 size={14} /></button>
        </span>}
      </li>)}
    </ul>
    {!identity?.hasIdentityDoc && files.length > 0 && <p className="identity-hint">{t('identity.noDoc')}</p>}
    {props.extractionNote && <p className="identity-note" role="status">{props.extractionNote}</p>}
    <div className="identity-actions">
      {props.onApprove && <button type="button" className="primary" disabled={props.busy || !canApprove} onClick={props.onApprove}>
        <Check size={14} />{t('identity.approve')}
      </button>}
      {props.onAddFiles && <button type="button" disabled={props.busy} onClick={props.onAddFiles}><FilePlus size={14} />{t('identity.addFiles')}</button>}
      {props.onExtract && <button type="button" disabled={props.busy || files.filter((f) => !f.identityDoc).length === 0} onClick={props.onExtract}>
        <Users size={14} />{t('identity.extract')}
      </button>}
      {props.onRevoke && state === 'approved' && <button type="button" className="subtle" disabled={props.busy} onClick={props.onRevoke}>
        <ShieldOff size={14} />{t('identity.revoke')}
      </button>}
    </div>
    <p className="identity-footnote">{t('identity.footnote')}</p>
  </div>;
}
