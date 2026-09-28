import { useState, type ReactNode } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import type {
  BrandDnaColor,
  BrandDnaEntry,
  BrandDnaField,
  BrandDnaFields,
  BrandDnaView,
  BrandDnaValue,
} from '../shared/contracts';
import { useI18n } from './i18n';

/**
 * G · la ficha del ADN: los seis bloques que la persona lee, corrige y aprueba.
 *
 * Cada bloque dice de dónde salió (la fuente, en mono chiquita) y si el dato es
 * un supuesto; el lápiz escribe con `updateBrandDnaField`, que a su vez cambia
 * la fuente a `human` y apaga el supuesto — así que lo que la persona corrige
 * deja de ser una hipótesis sin que nadie lo declare aparte.
 *
 * Presentacional: recibe la ficha y avisa. El motor, el sondeo y la escritura
 * viven en `brand-dna.ts`, compartidos por el recorrido inicial y Marca → ADN.
 */
export interface BrandDnaCardProps {
  brandName: string;
  dna: BrandDnaView | null;
  busy?: boolean;
  /** Corregir las fuentes: vuelve al paso "Traé tu marca". */
  onCorrect?: () => void;
  onApprove?: () => void;
  onEdit?: (field: BrandDnaField, value: BrandDnaValue | null) => void;
}

const splitList = (value: string): string[] => value.split(',').map((part) => part.trim()).filter(Boolean);

const HEX = /^#[0-9a-f]{3,8}$/i;
/** Only real hex colors travel: the engine rejects anything that is not #rrggbb. */
const colorsFrom = (value: string): BrandDnaColor[] =>
  splitList(value).filter((token) => HEX.test(token)).map((token) => ({ hex: token, name: null }));

/** Nada escrito = el campo vuelve a estar sin datos, no a una cadena vacía. El motor recibe el valor crudo y pone la fuente. */
const entry = (value: BrandDnaValue | null): BrandDnaValue | null =>
  value === null || (Array.isArray(value) && value.length === 0) || (typeof value === 'string' && !value.trim())
    ? null
    : value;

export function BrandDnaCard(props: BrandDnaCardProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<BrandDnaField | null>(null);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');

  const fields = props.dna?.draft ?? null;
  const approved = props.dna?.approved ?? null;
  const changed = Boolean(props.dna?.changedSinceApproval);
  const canApprove = Boolean(fields) && !props.busy && Boolean(props.onApprove);

  const open = (field: BrandDnaField) => {
    setEditing(field);
    setFirst(readFirst(fields, field));
    setSecond(readSecond(fields, field));
  };

  const save = async () => {
    if (!editing || !props.onEdit) return;
    const field = editing;
    setEditing(null);
    if (field === 'tone') {
      const adjectives = splitList(first);
      await props.onEdit(field, adjectives.length === 0 && !second.trim() ? null : { adjectives, example: second.trim() || null });
      return;
    }
    if (field === 'wordsYes' || field === 'wordsNo') return;
    if (field === 'audience' || field === 'valueProp') { await props.onEdit(field, entry(first.trim())); return; }
    if (field === 'colors') { await props.onEdit(field, entry(colorsFrom(first))); return; }
    await props.onEdit(field, entry(splitList(first)));
  };

  /** El bloque "Palabras" edita las DOS listas: son una sola pregunta. */
  const saveWords = async () => {
    if (!props.onEdit) return;
    setEditing(null);
    await props.onEdit('wordsYes', entry(splitList(first)));
    await props.onEdit('wordsNo', entry(splitList(second)));
  };

  const block = (field: BrandDnaField, body: ReactNode) => {
    const label = t(DNA_FIELD_KEYS[field]);
    const data = (fields?.[field] ?? null) as BrandDnaEntry<unknown> | null;
    const sources = (data?.sources ?? []).map((source) => source.label).filter(Boolean);
    return (
      <section className="dna-block" key={field} data-field={field}>
        <header className="dna-block-head">
          <h3>{label}</h3>
          {props.onEdit && (
            <button type="button" className="icon-button" disabled={props.busy}
              aria-label={t('dna.card.edit', { field: label })} title={t('dna.card.edit', { field: label })}
              onClick={() => (editing === field ? setEditing(null) : open(field))}><Pencil size={14} /></button>
          )}
        </header>
        {editing === field ? (
          <div className="dna-edit">
            {editors[field]}
            <div className="dna-edit-actions">
              <button type="button" className="primary" disabled={props.busy} onClick={() => void (field === 'wordsYes' ? saveWords() : save())}><Check size={14} />{t('dna.card.save')}</button>
              <button type="button" className="subtle" disabled={props.busy} onClick={() => setEditing(null)}><X size={14} />{t('dna.card.cancel')}</button>
            </div>
          </div>
        ) : body}
        {sources.length > 0 && <p className="dna-block-source">{t('dna.card.source')} · {sources.join(' · ')}</p>}
        {data?.assumption && <span className="chip" data-tone="assumption">{t('dna.assumption')}</span>}
      </section>
    );
  };

  const editors: Record<BrandDnaField, ReactNode> = {
    tone: <>
      <label className="field-label" htmlFor="dna-edit-tone">{t('dna.edit.adjectives')}</label>
      <input id="dna-edit-tone" value={first} onChange={(e) => setFirst(e.target.value)} />
      <label className="field-label" htmlFor="dna-edit-example">{t('dna.edit.example')}</label>
      <input id="dna-edit-example" value={second} onChange={(e) => setSecond(e.target.value)} />
    </>,
    audience: <textarea id="dna-edit-audience" aria-label={t('dna.field.audience')} rows={3} value={first} onChange={(e) => setFirst(e.target.value)} />,
    valueProp: <textarea id="dna-edit-value" aria-label={t('dna.field.valueProp')} rows={3} value={first} onChange={(e) => setFirst(e.target.value)} />,
    wordsYes: <>
      <label className="field-label" htmlFor="dna-edit-yes">{t('dna.field.wordsYes')}</label>
      <input id="dna-edit-yes" value={first} onChange={(e) => setFirst(e.target.value)} placeholder={t('dna.edit.list')} />
      <label className="field-label" htmlFor="dna-edit-no">{t('dna.field.wordsNo')}</label>
      <input id="dna-edit-no" value={second} onChange={(e) => setSecond(e.target.value)} placeholder={t('dna.edit.list')} />
    </>,
    wordsNo: null,
    claims: null,
    colors: <input id="dna-edit-colors" aria-label={t('dna.field.colors')} value={first} onChange={(e) => setFirst(e.target.value)} placeholder={t('dna.edit.colors')} />,
    fonts: <input id="dna-edit-fonts" aria-label={t('dna.field.fonts')} value={first} onChange={(e) => setFirst(e.target.value)} placeholder={t('dna.edit.fonts')} />,
  };

  const empty = <p className="dna-block-empty">{t('dna.field.empty')}</p>;

  const tone = fields?.tone ?? null;
  const audience = fields?.audience ?? null;
  const valueProp = fields?.valueProp ?? null;
  const wordsYes = fields?.wordsYes ?? null;
  const wordsNo = fields?.wordsNo ?? null;
  const colors = fields?.colors ?? null;
  const fonts = fields?.fonts ?? null;

  return (
    <article className="dna-card" aria-label={t('dna.title', { brand: props.brandName })}>
      <header className="dna-card-head">
        <h2 className="dna-card-brand">{props.brandName}</h2>
        <span className="chip" data-tone={approved && !changed ? 'approved' : 'proposal'}>
          {approved && !changed ? t('dna.card.approved') : t('dna.card.proposed')}
        </span>
        <div className="dna-card-actions">
          {props.onCorrect && <button type="button" className="subtle" disabled={props.busy} onClick={props.onCorrect}>{t('dna.card.correct')}</button>}
          {props.onApprove && (
            <button type="button" className="primary" disabled={!canApprove} onClick={props.onApprove}>
              <Check size={15} aria-hidden="true" />{t('dna.card.approve')}
            </button>
          )}
        </div>
      </header>
      {approved && (
        <p className="dna-card-meta">
          {t('dna.card.version', { version: approved.version, date: approved.approvedAt.slice(0, 10) })}
          {changed && <> · {t('dna.card.changed')}</>}
        </p>
      )}

      <div className="dna-grid">
        {block('tone', tone
          ? <>
              <p className="dna-chips">{tone.value.adjectives.map((word) => <span className="chip" key={word} data-tone="plain">{word}</span>)}</p>
              {tone.value.example && <p className="dna-example">{tone.value.example}</p>}
            </>
          : empty)}

        {block('audience', audience ? <p className="dna-text">{audience.value}</p> : empty)}

        {block('valueProp', valueProp ? <p className="dna-text">{valueProp.value}</p> : empty)}

        {block('wordsYes', wordsYes || wordsNo
          ? <>
              {wordsYes && <p className="dna-word-group"><span className="dna-word-label">{t('dna.field.wordsYes')}</span>
                {wordsYes.value.map((word) => <span className="chip" key={word} data-tone="plain">{word}</span>)}</p>}
              {wordsNo && <p className="dna-word-group"><span className="dna-word-label">{t('dna.field.wordsNo')}</span>
                {wordsNo.value.map((word) => <span className="chip" key={word} data-tone="avoid">{word}</span>)}</p>}
            </>
          : empty)}

        {block('colors', colors
          ? <p className="dna-colors">{colors.value.map((color, index) => color.hex
              ? <span className="dna-color" key={color.hex + index} style={{ background: color.hex }} title={color.name ?? color.hex}>
                  <span className="sr-only">{color.name ?? color.hex}</span>
                </span>
              : <span className="chip" data-tone="plain" key={(color.name ?? '') + index}>{color.name}</span>)}</p>
          : empty)}

        {block('fonts', fonts
          ? <p className="dna-fonts">{fonts.value.map((font) => <span key={font}>{font}</span>)}</p>
          : empty)}
      </div>
    </article>
  );
}

/** La etiqueta de cada bloque, también para listas que no son la ficha. */
export const DNA_FIELD_KEYS: Record<BrandDnaField, 'dna.field.tone' | 'dna.field.audience' | 'dna.field.valueProp' | 'dna.field.words' | 'dna.field.colors' | 'dna.field.fonts'> = {
  tone: 'dna.field.tone',
  audience: 'dna.field.audience',
  valueProp: 'dna.field.valueProp',
  wordsYes: 'dna.field.words',
  wordsNo: 'dna.field.words',
  claims: 'dna.field.valueProp',
  colors: 'dna.field.colors',
  fonts: 'dna.field.fonts',
};

function readFirst(fields: BrandDnaFields | null, field: BrandDnaField): string {
  const data = fields?.[field];
  if (!data) return '';
  if (field === 'tone') return (data as BrandDnaEntry<{ adjectives: string[] }>).value.adjectives.join(', ');
  if (field === 'audience' || field === 'valueProp') return String((data as BrandDnaEntry<string>).value);
  if (field === 'colors') return (data as BrandDnaEntry<BrandDnaColor[]>).value.map((c) => c.hex || c.name || '').join(', ');
  if (field === 'wordsYes') return (data as BrandDnaEntry<string[]>).value.join(', ');
  if (field === 'wordsNo') return '';
  return (data as BrandDnaEntry<string[]>).value.join(', ');
}

function readSecond(fields: BrandDnaFields | null, field: BrandDnaField): string {
  if (field === 'tone') return fields?.tone?.value.example ?? '';
  if (field === 'wordsNo') return fields?.wordsNo?.value.join(', ') ?? '';
  return '';
}
