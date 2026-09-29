import { useEffect, useState } from 'react';
import { Check, Plus, RefreshCw, X } from 'lucide-react';
import type { Brand, BrandIdentityView } from '../shared/contracts';
import type { BrandDnaView as BrandDnaViewData } from '../shared/contracts';
import { api, isDesktop } from './browser-api';
import { useI18n } from './i18n';
import { useBrandDna } from './brand-dna';
import { DNA_FIELD_KEYS } from './BrandDnaCard';
import { BrandDnaPanel } from './BrandDnaPanel';
import { BrandDnaSources } from './BrandDnaSources';

/**
 * MARCA → ADN: la ficha para quien ya usa Latte.
 *
 * Dos caminos distintos a la misma ficha: "Reconstruir con lo que ya tiene"
 * (`buildBrandDna(brand, 'existing')`, el motor leyendo contexto, documentos,
 * decisiones, memoria e identidad) y "Sumar fuentes" (la misma pantalla F del
 * recorrido inicial: web, otros canales, archivos). Las propuestas aprendidas se
 * aceptan o se descartan acá, con `resolveBrandDnaProposal`.
 *
 * A diferencia de `IdentityView`, esta pantalla es dueña de sus llamadas: el
 * sondeo del build y las escrituras son parte de lo que hay que probar, y
 * `brand-dna.ts` es el único lugar donde viven. Al cambiar la ficha avisa al
 * contenedor (`onChanged`), porque Inicio la lee para marcar "Traé tu marca".
 */
export interface BrandDnaViewProps {
  brand: Brand;
  formatDate?: (value: string) => string;
  onChanged?: (view: BrandDnaViewData) => void;
}

/**
 * Lo que cambiaría una propuesta, en una línea. `next` es una ENTRADA del ADN
 * (`{ value, sources, assumption }`), así que primero se desenvuelve y recién
 * después se narra: listas, colores, fuentes y el tono (adjetivos + ejemplo).
 */
function preview(next: unknown): string {
  if (next === null || next === undefined) return '';
  if (typeof next === 'object' && 'value' in (next as Record<string, unknown>)) {
    return preview((next as { value: unknown }).value);
  }
  const value = next;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : (item as { name?: string | null; hex?: string }).name || (item as { hex?: string }).hex || ''))
      .filter(Boolean)
      .join(', ');
  }
  const tone = value as { adjectives?: string[]; example?: string | null };
  if (Array.isArray(tone.adjectives)) return [tone.adjectives.join(', '), tone.example ?? ''].filter(Boolean).join(' · ');
  return '';
}

export function BrandDnaView(props: BrandDnaViewProps) {
  const { t } = useI18n();
  const brand = props.brand;
  const date = props.formatDate ?? ((value: string) => value.slice(0, 10));
  const state = useBrandDna(brand.id);
  const [showSources, setShowSources] = useState(false);
  const [identity, setIdentity] = useState<BrandIdentityView | null>(null);
  const [url, setUrl] = useState('');
  const [channels, setChannels] = useState('');
  const [name, setName] = useState('');

  // Inicio y la tarjeta de primeros pasos leen la ficha del contenedor: el
  // cambio hecho acá tiene que llegar ahí, no quedarse en este componente.
  useEffect(() => {
    if (state.dna) props.onChanged?.(state.dna);
  }, [state.dna]);

  useEffect(() => {
    if (!showSources) return;
    let live = true;
    void api.readBrandIdentity(brand.id).then((view) => { if (live) setIdentity(view); }).catch(() => undefined);
    return () => { live = false; };
  }, [showSources, brand.id]);

  const approved = state.dna?.approved ?? null;
  const building = Boolean(state.job && !state.job.done);
  const proposals = state.dna?.proposals ?? [];

  const rebuild = () => { void state.build('existing', null); };
  const closeSources = () => { setShowSources(false); setName(''); };
  return (
    <div className="document-scroll dna-view">
      <h1>{t('dna.title', { brand: brand.name })}</h1>
      <p className="intro">{t('dna.intro')}</p>

      <p className={'identity-state is-' + (approved ? 'approved' : 'draft')} data-state={approved ? 'approved' : 'draft'}>
        {approved ? <Check size={14} /> : <RefreshCw size={14} />}
        <span>{approved
          ? t('dna.approved', { version: approved.version, date: date(approved.approvedAt) })
          : t('dna.notApproved')}</span>
      </p>

      <div className="dna-actions">
        <button type="button" className="primary" disabled={state.busy || building} onClick={rebuild}>
          <RefreshCw size={15} aria-hidden="true" />{t('dna.rebuild')}
        </button>
        {/* Mientras las fuentes están abiertas, el cierre es UNO sólo: el del
            pie, junto a "Armar mi marca". Dos "Cancelar" en la misma pantalla
            obligan a elegir cuál de los dos es el correcto. */}
        {!showSources && (
          <button type="button" disabled={state.busy || building} onClick={() => setShowSources(true)}>
            <Plus size={15} aria-hidden="true" />{t('dna.addSources')}
          </button>
        )}
      </div>

      {showSources && (
        <BrandDnaSources
          headingLevel={2}
          brandName={brand.name}
          url={url} onUrl={setUrl}
          channels={channels} onChannels={setChannels}
          name={name} onName={setName}
          files={identity?.files ?? []}
          busy={state.busy}
          onAddFiles={isDesktop ? () => void api.addBrandIdentityFiles(brand.id).then(setIdentity).catch(() => undefined) : undefined}
          onRemoveFile={(fileId) => void api.removeBrandIdentityFile(brand.id, fileId).then(setIdentity).catch(() => undefined)}
          onBuild={(sources) => { void state.build('sources', sources).then((outcome) => { if (outcome.ok) setShowSources(false); }); }}
          footerEnd={<button type="button" onClick={closeSources}>{t('dna.card.cancel')}</button>}
        />
      )}

      {building && !showSources && <p className="dna-rebuilding" role="status">{t('dna.rebuilding')}</p>}

      <BrandDnaPanel
        brandName={brand.name}
        job={state.job}
        dna={state.dna}
        busy={state.busy}
        error={state.error}
        onApprove={() => { void state.approve(); }}
        onEdit={(field, value) => { void state.edit(field, value); }}
      />

      <section className="dna-proposals" aria-label={t('dna.proposals')}>
        <h2>{t('dna.proposals')}</h2>
        {proposals.length === 0
          ? <p className="dna-proposals-empty">{t('dna.proposals.empty')}</p>
          : <ul className="dna-proposal-list">
              {proposals.map((proposal) => (
                <li key={proposal.id} className="dna-proposal">
                  <span className="dna-proposal-field">{t(DNA_FIELD_KEYS[proposal.field])}</span>
                  <span className="dna-proposal-actions">
                    <button type="button" className="primary" disabled={state.busy} onClick={() => void state.resolve(proposal.id, true)}>
                      <Check size={14} aria-hidden="true" />{t('dna.proposal.accept')}
                    </button>
                    <button type="button" className="subtle" disabled={state.busy} onClick={() => void state.resolve(proposal.id, false)}>
                      <X size={14} aria-hidden="true" />{t('dna.proposal.discard')}
                    </button>
                  </span>
                  <span className="dna-proposal-main">
                    <span className="dna-proposal-reason">{proposal.reason}</span>
                    <span className="dna-proposal-next">{preview(proposal.next)}</span>
                    <span className="dna-proposal-source">{t('dna.card.source')} · {proposal.source.label}</span>
                  </span>
                </li>
              ))}
            </ul>}
      </section>
    </div>
  );
}
