import { translate as t } from './i18n';
import { useEffect, useState } from 'react';
import { Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { UpdateState } from '../shared/contracts';
import { api } from './browser-api';

const START: UpdateState = { phase: 'idle', version: null, percent: 0, message: '' };
/** Identity of what is being offered: dismissing one state must not hide the next. */
const key = (state: UpdateState) => `${state.phase}:${state.version ?? ''}`;

/** Only installed .deb builds need persistent manual-update guidance here. */
export function UnsupportedUpdateNotice({ state }: { state: UpdateState }) {
  if (state.phase !== 'unsupported' || state.unsupportedKind !== 'manual-install') return null;
  return <section className="update-toast" role="status" aria-live="polite">
    <p>{state.message}</p>
  </section>;
}

/**
 * The update notice.
 *
 * It never interrupts: downloading happens while you keep working, and the
 * restart is a button, never a countdown. The one thing it will not do is let
 * an update start over an unsaved document — the main process refuses, and
 * this explains why instead of failing quietly.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>(START);
  const [dismissed, setDismissed] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState('');

  useEffect(() => {
    const stop = api.onUpdateState(next => { setState(next); setBlocked(''); });
    // The state may already have moved before this mounted; asking returns it.
    void api.checkForUpdate().then(setState).catch(() => undefined);
    return stop;
  }, []);

  if (state.phase === 'unsupported') return <UnsupportedUpdateNotice state={state} />;
  const visible = state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready' || (state.phase === 'error' && state.version !== null);
  if (!visible || dismissed === key(state)) return null;

  const download = () => {
    setBusy(true);
    setBlocked('');
    void api.downloadUpdate().then(setState).catch(() => undefined).finally(() => setBusy(false));
  };
  const install = () => {
    setBusy(true);
    setBlocked('');
    void api.installUpdate()
      .then(outcome => {
        // 'installing' quits the app; 'cancelled' is an answer, not an error.
        if (outcome.status === 'unsaved') setBlocked(t('ui.auto.323'));
        else if (outcome.status === 'not-ready') setBlocked(t('ui.auto.324'));
      })
      .catch(() => setBlocked(t('ui.auto.325')))
      .finally(() => setBusy(false));
  };
  const later = () => setDismissed(key(state));
  const version = state.version ? `versión ${state.version}` : 'una nueva versión';

  return <section className={'update-toast' + (state.phase === 'ready' ? ' ready' : '')} role="status" aria-live="polite">
    <div className="update-toast-head">
      <strong>{
        state.phase === 'ready' ? t('ui.auto.326')
          : state.phase === 'downloading' ? t('ui.auto.414', { p0: version })
            : state.phase === 'error' ? t('ui.auto.327')
              : `Hay una nueva versión de Latte disponible`
      }</strong>
      <button className="icon-button" aria-label={t('ui.auto.328')} title={t('ui.auto.328')} onClick={later}><X size={15} /></button>
    </div>

    {state.phase === 'available' && <p>Latte {state.version}  {t('ui.auto.329')}</p>}
    {state.phase === 'downloading' && <>
      <p>{t('ui.auto.330')}</p>
      <div className="update-progress"><i style={{ width: `${state.percent}%` }} /></div>
    </>}
    {state.phase === 'ready' && <p><strong>{t('ui.auto.331')}</strong>  {t('ui.auto.332')} {version}  {t('ui.auto.333')}</p>}
    {state.phase === 'error' && <p>{state.message}</p>}
    {blocked && <p className="update-blocked" role="alert">{blocked}</p>}

    <div className="update-actions">
      {state.phase === 'available' && <button className="primary" disabled={busy} onClick={download}>{busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{t('ui.auto.334')}</button>}
      {state.phase === 'ready' && <button className="primary" disabled={busy} onClick={install}>{busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{t('ui.auto.415')}</button>}
      {state.phase === 'error' && <button disabled={busy} onClick={download}>{busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{t('ui.auto.372')}</button>}
      {state.phase !== 'downloading' && <button className="subtle" onClick={later}>{t('ui.auto.335')}</button>}
    </div>
  </section>;
}
