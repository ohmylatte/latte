import { translate as t } from './i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, HardDrive, Info, Plug, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { AppInfo, CoordinationGlobalBudgetView } from '../shared/contracts';
import { api, isDesktop } from './browser-api';
import { ProvidersView } from './ProvidersView';
import { ProfilesView } from './ProfilesView';
import { SkillsView } from './SkillsView';
import { ConnectionsView } from './ConnectionsView';
import { useI18n } from './i18n';
import type { LatteMode } from './TeamPanel';

export type SettingsSection = 'agents' | 'profiles' | 'skills' | 'connections' | 'workspace' | 'language' | 'advanced';

/**
 * Settings is its own screen, not a document view: no work breadcrumb, no
 * Brief/Decisiones tabs, no export, no versions footer and no team panel.
 * Opening or closing it never writes anything; the workspace state stays in
 * App and comes back untouched.
 */
export function SettingsScreen({ onProfileDirtyChange, controls, section, onSection, onClose, onChanged, onNotice, onError, notice, error, onDismiss, terminal, workId, onReopenOnboarding, mode, onModeChange }: {
  /** Window controls: Settings is a full screen, so it needs them too. */
  controls: ReactNode;
  onProfileDirtyChange: (dirty:boolean)=>void;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  onChanged: () => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
  notice: string;
  error: string;
  onDismiss: () => void;
  /** The raw CLI console: an escape hatch, so it lives here and not in the work. */
  terminal?: ReactNode;
  workId?: string | null;
  /** Re-opens the first-run onboarding after it was completed. */
  onReopenOnboarding?: () => void;
  /** Interface density: `simple` hides the inline technical controls. */
  mode: LatteMode;
  onModeChange: (mode: LatteMode) => void;
}) {
  const { t } = useI18n();
  const [profileDirty,setProfileDirty]=useState(false);
  const canLeave=()=>!profileDirty||window.confirm(t('settings.unsavedProfile'));
  const navigate=(next:SettingsSection)=>{if(next===section)return;if(canLeave()){setProfileDirty(false);onSection(next);}};
  useEffect(()=>{onProfileDirtyChange(profileDirty);},[profileDirty]);
  useEffect(()=>()=>onProfileDirtyChange(false),[]);
  return <div className="settings-shell">
    <header className="settings-topbar">
      <button className="settings-back" onClick={()=>{if(canLeave())onClose();}}><ArrowLeft size={16} />{t('settings.back')}</button>
      <h1>{t('settings.title')}</h1>
      <span className="settings-scope">{t('settings.scope')}</span>
      {controls}
    </header>
    <nav className="settings-nav" aria-label={t('settings.nav')}>
      <button className={section === 'agents' ? 'selected' : ''} onClick={() => navigate('agents')}><Plug size={16} />{t('settings.agents')}</button>
      <button className={section === 'profiles' ? 'selected' : ''} onClick={() => navigate('profiles')}><Info size={16} />{t('settings.profiles')}</button>
      <button className={section === t('ui.auto.390') ? 'selected' : ''} onClick={() => navigate('skills')}><Sparkles size={16} />{t('settings.skills')}</button>
      <button className={section === 'connections' ? 'selected' : ''} onClick={() => navigate('connections')}><Plug size={16} />{t('settings.connections')}</button>
      <button className={section === 'workspace' ? 'selected' : ''} onClick={() => navigate('workspace')}><HardDrive size={16} />{t('settings.workspace')}</button>
      <button className={section === 'language' ? 'selected' : ''} onClick={() => navigate('language')}><Info size={16} />{t('settings.language')}</button>
      <button className={section === 'advanced' ? 'selected' : ''} onClick={() => navigate('advanced')}><SlidersHorizontal size={16} />{t('settings.advanced')}</button>
    </nav>
    <main className="settings-main">
      {(error || notice) && <div role={error ? 'alert' : 'status'} className={'message ' + (error ? 'error' : '')}><span>{error || notice}</span><button aria-label={t('settings.dismiss')} onClick={onDismiss}>×</button></div>}
      {section === 'agents' && <section className="settings-section">
        <h2>{t('settings.agents')}</h2>
        <p className="settings-lead">{t('settings.agentsLead')}</p>
        <ProvidersView onChanged={onChanged} onNotice={onNotice} onError={onError} />
        {terminal}
      </section>}
      {section === 'profiles' && <ProfilesView onChanged={onChanged} onError={onError} onNotice={onNotice} onDirtyChange={setProfileDirty} />}
      {section === t('ui.auto.390') && <SkillsView onNotice={onNotice} onError={onError} />}
      {/* TODAS las conexiones, globales y de marca: son una cosa técnica, y lo técnico vive acá. */}
      {section === 'connections' && <ConnectionsView onNotice={onNotice} onError={onError} />}
      {section === 'workspace' && <WorkspaceSection onError={onError} onReopenOnboarding={onReopenOnboarding} />}
      {section === 'language' && <LanguageSection />}
      {section === 'advanced' && <><ModeSection mode={mode} onModeChange={onModeChange} /><CoordinationSwitchSection onError={onError} /><CoordinationGlobalBudgetSection onError={onError} /></>}
    </main>
  </div>;
}

function WorkspaceSection({ onError, onReopenOnboarding }: { onError: (text: string) => void; onReopenOnboarding?: () => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => { void api.appInfo().then(setInfo).catch(e => onError(e instanceof Error ? e.message : String(e))); }, []);
  return <section className="settings-section">
    <h2>{t('settings.workspace')}</h2>
    <p className="settings-lead">{t('settings.workspaceLead')}</p>
    <dl className="settings-facts">
      <div><dt>{t('settings.dataFolder')}</dt><dd><code>{info?.dataDir ?? (isDesktop ? t('settings.loading') : t('settings.webStorage'))}</code></dd></div>
      <div><dt>{t('settings.database')}</dt><dd>{info ? t('ui.auto.391', { p0: info.engine, p1: info.engineReason ? ` · ${info.engineReason}` : '' }) : '—'}</dd></div>
      <div><dt>{t('settings.pack')}</dt><dd>{info?.pack ?? '—'}{info && info.packRoles > 0 ? ` · ${t('common.roles',{count:info.packRoles})}` : ''}</dd></div>
      <div><dt>{t('settings.version')}</dt><dd>{info ? `Latte ${info.version}` : '—'}</dd></div>
    </dl>
    {onReopenOnboarding && <div style={{ marginTop: 20 }}><button onClick={onReopenOnboarding}><Sparkles size={14} />{t('settings.reopenOnboarding')}</button></div>}
    <p className="footnote"><Info size={13} /> {t('settings.filesHelp')}</p>
  </section>;
}

function LanguageSection() {
  const { locale, contentLocale, setLocale, setContentLocale, t } = useI18n();
  return <section className="settings-section">
    <h2>{t('settings.language')}</h2>
    <div className="settings-facts">
      <label>{t('settings.uiLanguage')}<select value={locale} onChange={e => void setLocale(e.target.value as 'es-AR'|'en-US')}><option value="es-AR">{t('settings.spanish')}</option><option value="en-US">{t('settings.english')}</option></select></label>
      <label>{t('settings.contentLanguage')}<select value={contentLocale} onChange={e => void setContentLocale(e.target.value as 'es-AR'|'en-US')}><option value="es-AR">{t('settings.spanish')}</option><option value="en-US">{t('settings.english')}</option></select></label>
    </div>
    <p className="footnote">{t('settings.languageHelp')}</p>
  </section>;
}

/**
 * The one place to switch interface density. It is a display preference, not a
 * workspace view, so it lives in Ajustes and never as an inline toggle in the
 * team panel: the compact controls disappear there but permissions never do.
 */
function ModeSection({ mode, onModeChange }: { mode: LatteMode; onModeChange: (mode: LatteMode) => void }) {
  const { t } = useI18n();
  return <section className="settings-section">
    <h2>{t('settings.advanced')}</h2>
    <p className="settings-lead">{t('settings.advancedLead')}</p>
    <div className="settings-facts">
      <label>{t('settings.modeLabel')}<select value={mode} onChange={e => onModeChange(e.target.value as LatteMode)}><option value="simple">{t('settings.modeSimple')}</option><option value="advanced">{t('settings.modeAdvanced')}</option></select></label>
    </div>
    <p className="footnote">{t('settings.modeHelp')}</p>
  </section>;
}

/**
 * El interruptor de emergencia de la coordinación (1.2.0, R1).
 *
 * Desde 1.2.0 la coordinación llega PRENDIDA, así que esto no es el switch
 * que la estrena: es el que la apaga. Vive en Avanzado, al lado del tope de
 * despachos, porque es la misma clase de control — algo que casi nadie toca
 * y que, cuando hace falta tocar, tiene que estar donde se lo busca.
 *
 * Lee y escribe la MISMA fila `meta` que gatea el motor, nunca una copia en
 * el renderer: si la escritura falla, el switch vuelve a lo que el backend
 * confirmó, no a lo que la persona clickeó.
 */
function CoordinationSwitchSection({ onError }: { onError: (text: string) => void }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => { void api.getCoordinationEnabled().then(setEnabled).catch(e => onError(e instanceof Error ? e.message : String(e))); }, []);
  const toggle = (next: boolean) => {
    setSaving(true);
    void api.setCoordinationEnabled(next)
      .then(setEnabled)
      .catch(e => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };
  return <section className="settings-section coordination-switch">
    <h2>{t('settings.coordination')}</h2>
    <div className="settings-facts">
      <label>
        <input className="coordination-switch-input" type="checkbox" role="switch" checked={enabled} disabled={saving} onChange={e => toggle(e.target.checked)} />
        {t('settings.coordination')}
      </label>
    </div>
    <p className="footnote">{t('settings.coordinationHelp')}</p>
  </section>;
}

/**
 * The optional app-wide coordination dispatch cap (autonomous-coordination
 * Phase 7 task 7.13): advanced settings only, progressive disclosure. Unset
 * shows the same honest "no budget configured" sentence Decisiones already
 * uses for a Work's own budget — never an invented default. The primary
 * flow (starting or approving a run) never routes through this: it is
 * reachable only from here, and setting it never applies retroactively to a
 * run already in flight.
 */
function CoordinationGlobalBudgetSection({ onError }: { onError: (text: string) => void }) {
  const { t } = useI18n();
  // Tres estados, no dos: "nunca se configuró" y "los bytes guardados no se
  // pueden leer" son cosas distintas, y la segunda NO se dibuja como "sin
  // tope" — el camino de despacho deniega contra esos mismos bytes.
  const [budget, setBudget] = useState<CoordinationGlobalBudgetView>({ state: 'unset' });
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { void api.getCoordinationGlobalBudget().then(setBudget).catch(e => onError(e instanceof Error ? e.message : String(e))); }, []);
  const save = () => {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isInteger(parsed) || parsed <= 0) return;
    setSaving(true);
    void api.setCoordinationGlobalBudget({ maxDispatches: parsed })
      .then(next => { setBudget(next ? { state: 'set', budget: next } : { state: 'unset' }); setDraft(''); })
      .catch(e => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };
  // Un tope que no se puede sacar es una trampa, no un ajuste: el validador
  // rechaza todo valor que signifique "sin tope", asi que sin este boton la
  // persona quedaba encerrada con el numero que puso.
  const clear = () => {
    setSaving(true);
    void api.setCoordinationGlobalBudget(null)
      .then(next => { setBudget(next ? { state: 'set', budget: next } : { state: 'unset' }); setDraft(''); })
      .catch(e => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };
  return <section className="settings-section coordination-global-budget">
    <h2>{t('coordination.globalBudget.kicker')}</h2>
    <p className="settings-lead">{t('coordination.globalBudget.help')}</p>
    <p className="coordination-global-budget-value">
      {budget.state === 'invalid'
        ? t('coordination.globalBudget.invalid')
        : budget.state === 'unset'
          ? t('coordination.budget.unset')
          : budget.budget.maxDispatches == null
            ? t('coordination.budget.unlimited')
            : t('coordination.budget.limited', { count: budget.budget.maxDispatches })}
    </p>
    <div className="settings-facts">
      <label>{t('coordination.globalBudget.setLabel')}
        <input className="coordination-global-budget-input" type="number" min={1} value={draft} onChange={e => setDraft(e.target.value)} />
      </label>
      <button className="coordination-global-budget-save" disabled={saving || !draft.trim()} onClick={save}>{t('coordination.globalBudget.save')}</button>
      {/* `budget == null` era un guard MUERTO: quedó de cuando el getter
          devolvía `CoordinationBudget | null`. Desde que devuelve la vista de
          tres estados, ese objeto nunca es `null`, así que la condición era
          siempre falsa y el botón ofrecía sacar un tope que no existía.
          `invalid` SÍ lo habilita: ése es justo el estado del que hay que
          poder salir. */}
      <button className="coordination-global-budget-clear" disabled={saving || budget.state === 'unset'} onClick={clear}>{t('coordination.globalBudget.clear')}</button>
    </div>
  </section>;
}
