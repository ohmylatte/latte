import type { ReactNode } from 'react';
import { ArrowLeft, AtSign, Check, FilePlus, Globe, Sparkles, Trash2, Upload } from 'lucide-react';
import type { BrandDnaSourcesInput, BrandIdentityFileView } from '../shared/contracts';
import { Loading } from './brand-marks';
import { useI18n } from './i18n';

/**
 * F · "Traé tu marca": las tres fuentes con las que el motor arranca.
 *
 * La misma pantalla vive en dos lugares — el paso nuevo del recorrido inicial y
 * Marca → ADN ("Sumar fuentes") — porque es literalmente la misma decisión:
 * qué le doy a Latte para que arme el ADN. Por eso es un componente propio y
 * no JSX duplicado en el gate.
 *
 * Presentacional: recibe las fuentes como valor y avisa. Nunca toca
 * `browser-api`: los archivos los trae el contenedor con
 * `addBrandIdentityFiles`, que en la vista previa no existe — y ahí la tarjeta
 * lo dice en vez de ofrecer un botón que no haría nada.
 */
export interface BrandDnaSourcesProps {
  /** La marca que va a recibir el ADN; `null` todavía no existe y se pide el nombre. */
  brandName: string | null;
  url: string;
  instagram: string;
  /** Sólo cuando no hay marca todavía: el nombre con el que se va a crear. */
  name: string;
  onName: (value: string) => void;
  onUrl: (value: string) => void;
  onInstagram: (value: string) => void;
  files: readonly BrandIdentityFileView[];
  busy?: boolean;
  /** Escritorio: abre el selector de archivos. En la vista previa, no se ofrece. */
  onAddFiles?: () => void;
  onRemoveFile?: (fileId: string) => void;
  onBuild: (sources: BrandDnaSourcesInput) => void;
  /** Enlaces discretos del recorrido inicial: los caminos que ya existían. */
  onSkip?: () => void;
  onDemo?: () => void;
  onBack?: () => void;
  /** Botón de pie distinto (Marca → ADN cierra en vez de volver). */
  footerEnd?: ReactNode;
  /** Nivel del título: el recorrido inicial no tiene otro h1 en pantalla. */
  headingLevel?: 1 | 2;
}

export function BrandDnaSources(props: BrandDnaSourcesProps) {
  const { t } = useI18n();
  const files = props.files;
  const hasSource = props.url.trim().length > 0 || props.instagram.trim().length > 0 || files.length > 0;
  const needsName = !props.brandName && !props.name.trim();
  const canBuild = hasSource && !needsName && !props.busy;
  const Heading = (props.headingLevel ?? 1) === 2 ? 'h2' : 'h1';

  const build = () => {
    if (!canBuild) return;
    props.onBuild({
      url: props.url.trim() || null,
      instagram: props.instagram.trim().replace(/^@+/, '') || null,
      useIdentityFiles: files.length > 0,
    });
  };

  return (
    <section className="dna-sources" aria-label={t('dna.sources.title')}>
      <Heading>{t('dna.sources.title')}</Heading>
      <p className="intro">{t('dna.sources.lead')}</p>

      {props.brandName
        ? <p className="dna-sources-for">{t('dna.sources.for', { brand: props.brandName })}</p>
        : <div className="onboarding-context-field">
            <label className="field-label" htmlFor="dna-source-name">{t('dna.sources.name')}</label>
            <input id="dna-source-name" maxLength={120} value={props.name} onChange={(e) => props.onName(e.target.value)} />
          </div>}

      <div className="dna-source-grid">
        <div className="dna-source-card">
          <span className="dna-source-icon" aria-hidden="true"><Globe size={18} /></span>
          <label className="field-label" htmlFor="dna-source-url">{t('dna.sources.web')}</label>
          <input id="dna-source-url" inputMode="url" value={props.url} placeholder={t('dna.sources.webPlaceholder')} onChange={(e) => props.onUrl(e.target.value)} />
        </div>

        <div className="dna-source-card">
          <span className="dna-source-icon" aria-hidden="true"><AtSign size={18} /></span>
          <label className="field-label" htmlFor="dna-source-instagram">{t('dna.sources.instagram')}</label>
          <input id="dna-source-instagram" value={props.instagram} placeholder={t('dna.sources.instagramPlaceholder')} onChange={(e) => props.onInstagram(e.target.value)} />
          <small>{t('dna.sources.instagramNote')}</small>
        </div>

        <div className="dna-source-card">
          <span className="dna-source-icon" aria-hidden="true"><FilePlus size={18} /></span>
          <span className="field-label" id="dna-source-files-label">{t('dna.sources.files')}</span>
          {props.onAddFiles
            ? <button type="button" className="dna-drop" aria-labelledby="dna-source-files-label" disabled={props.busy} onClick={props.onAddFiles}>
                <Upload size={16} aria-hidden="true" />{t('dna.sources.filesHint')}
              </button>
            : <p className="dna-drop is-off">{t('dna.sources.filesWeb')}</p>}
          {files.length === 0
            ? <small>{t('dna.sources.filesEmpty')}</small>
            : <ul className="dna-source-files">
                {files.map((file) => (
                  <li key={file.id}>
                    <Check size={14} aria-hidden="true" />
                    <span>{file.name}</span>
                    {props.onRemoveFile && (
                      <button type="button" className="icon-button" disabled={props.busy}
                        aria-label={t('identity.file.remove', { name: file.name })}
                        title={t('identity.file.remove', { name: file.name })}
                        onClick={() => props.onRemoveFile!(file.id)}><Trash2 size={13} /></button>
                    )}
                  </li>
                ))}
              </ul>}
        </div>
      </div>

      {!hasSource && <p className="onboarding-note" role="status">{t('dna.sources.needSource')}</p>}
      {!props.brandName && !props.name.trim() && hasSource && <p className="onboarding-note" role="status">{t('dna.sources.needName')}</p>}

      <div className="onboarding-footer">
        {props.onBack && <button type="button" disabled={props.busy} onClick={props.onBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>}
        <span className="spacer" />
        <button type="button" className="primary dna-build-cta" disabled={!canBuild} onClick={build}>
          {props.busy ? <Loading size={16} /> : <Sparkles size={15} aria-hidden="true" />}{t('dna.sources.build')}
        </button>
        {props.footerEnd}
      </div>

      {(props.onSkip || props.onDemo) && (
        <div className="dna-source-links">
          {props.onSkip && <button type="button" className="subtle" disabled={props.busy} onClick={props.onSkip}>{t('dna.sources.skip')}</button>}
          {props.onDemo && <button type="button" className="subtle" disabled={props.busy} onClick={props.onDemo}><Sparkles size={14} aria-hidden="true" />{t('onboarding.brand.tourDemo')}</button>}
        </div>
      )}
    </section>
  );
}
