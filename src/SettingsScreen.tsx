import { translate as t } from './i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, HardDrive, Info, Plug, Sparkles, Wrench } from 'lucide-react';
import type { AppInfo } from '../shared/contracts';
import { api, isDesktop } from './browser-api';
import { ProvidersView } from './ProvidersView';
import { ProfilesView } from './ProfilesView';
import { SkillsView } from './SkillsView';
import { ToolsView } from './ToolsView';
import { useI18n } from './i18n';

export type SettingsSection = 'agents' | 'profiles' | 'skills' | 'tools' | 'workspace' | 'language';

/**
 * Settings is its own screen, not a document view: no work breadcrumb, no
 * Brief/Decisiones tabs, no export, no versions footer and no team panel.
 * Opening or closing it never writes anything; the workspace state stays in
 * App and comes back untouched.
 */
export function SettingsScreen({ onProfileDirtyChange, controls, section, onSection, onClose, onChanged, onNotice, onError, notice, error, onDismiss, terminal, workId, onReopenOnboarding }: {
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
      <button className={section === 'tools' ? 'selected' : ''} onClick={() => navigate('tools')}><Wrench size={16} />{t('settings.tools')}</button>
      <button className={section === 'workspace' ? 'selected' : ''} onClick={() => navigate('workspace')}><HardDrive size={16} />{t('settings.workspace')}</button>
      <button className={section === 'language' ? 'selected' : ''} onClick={() => navigate('language')}><Info size={16} />{t('settings.language')}</button>
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
      {section === 'tools' && <ToolsView onNotice={onNotice} onError={onError} workId={workId} />}
      {section === 'workspace' && <WorkspaceSection onError={onError} onReopenOnboarding={onReopenOnboarding} />}
      {section === 'language' && <LanguageSection />}
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
      <div><dt>{t('settings.version')}</dt><dd>{info ? `Latte ${info.version} · ALPHA` : '—'}</dd></div>
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
