import { translate as t } from './i18n';
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { AgentSkill, FeatureFlags, LatteAPI, SkillCandidate } from '../shared/contracts';
import { api, isDesktop } from './browser-api';
import { skillSummary } from './pack-i18n';

const FLAGS_OFF: FeatureFlags = { generation: false, brandKits: false, learning: false, coordination: false };

export async function loadSkillsViewState(client: Pick<LatteAPI, 'featureFlags' | 'listSkills' | 'listSkillCandidates'>): Promise<{
  learningOn: boolean;
  skills: AgentSkill[];
  candidates: SkillCandidate[];
}> {
  const [flags, skills] = await Promise.all([
    client.featureFlags().catch(() => FLAGS_OFF),
    client.listSkills(),
  ]);
  const candidates = flags.learning ? await client.listSkillCandidates() : [];
  return { learningOn: flags.learning, skills, candidates };
}

/**
 * Skills Latte ships: how every agent writes, in every work.
 *
 * A role is who does the job; a skill is the craft everyone shares. They are on
 * by default on purpose — quality that each person has to discover and switch
 * on is quality almost nobody gets. The switch exists so you can turn one off,
 * not so you have to turn it on.
 *
 * They travel in the work's instruction file, written once per conversation,
 * not in the prompt charged on every message.
 */
export function SkillsView({ onError, onNotice }: { onError: (text: string) => void; onNotice: (text: string) => void }) {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [candidates, setCandidates] = useState<SkillCandidate[]>([]);
  const [learningOn, setLearningOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let live = true;
    loadSkillsViewState(api)
      .then((state) => {
        if (!live) return;
        setLearningOn(state.learningOn);
        setSkills(state.skills);
        setCandidates(state.candidates);
      })
      .catch(e => { if (live) onError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const refreshInbox = async () => setCandidates(await api.listSkillCandidates());

  const toggle = async (skill: AgentSkill) => {
    setBusy(skill.id);
    try {
      setSkills(await api.setSkillEnabled(skill.id, !skill.enabled));
      onNotice(skill.enabled
        ? t('ui.auto.392', { p0: skill.name })
        : t('ui.auto.393', { p0: skill.name }));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const decide = async (candidate: SkillCandidate, decision: 'approve' | 'reject') => {
    setBusy(candidate.id);
    try {
      const input = { candidateId: candidate.id, expectedRevision: candidate.revision, expectedHash: candidate.contentHash, requestId: crypto.randomUUID() };
      if (decision === 'approve') {
        const approved = await api.approveSkillCandidate(input);
        onNotice(t('learning.approved', { name: approved.name }));
      } else {
        await api.rejectSkillCandidate(input);
        onNotice(t('learning.rejected'));
      }
      await refreshInbox();
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: string }).code) : '';
      onError(code === 'CONFLICT' ? t('learning.conflict') : e instanceof Error ? e.message : String(e));
      try { await refreshInbox(); } catch { /* keep the last list */ }
    } finally {
      setBusy('');
    }
  };

  const promote = async (candidate: SkillCandidate) => {
    setBusy(candidate.id);
    try {
      await api.promoteSkillCandidate({ candidateId: candidate.id, requestId: crypto.randomUUID() });
      onNotice(t('learning.promoted'));
      await refreshInbox();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  return <SkillsViewContent
    learningOn={learningOn}
    skills={skills}
    candidates={candidates}
    loading={loading}
    busy={busy}
    onToggle={toggle}
    onDecide={decide}
    onPromote={promote}
  />;
}

export function SkillsViewContent(props: {
  learningOn: boolean;
  skills: AgentSkill[];
  candidates: SkillCandidate[];
  loading: boolean;
  busy: string;
  onToggle: (skill: AgentSkill) => void;
  onDecide: (candidate: SkillCandidate, decision: 'approve' | 'reject') => void;
  onPromote: (candidate: SkillCandidate) => void;
}) {
  const { learningOn, skills, candidates, loading, busy, onToggle, onDecide, onPromote } = props;
  return <section className="settings-section">
    <h2>{t('ui.auto.394')}</h2>
    <p className="settings-lead">{t('ui.auto.263')}</p>
    {!isDesktop && <p className="profile-disclaimer">{t('ui.auto.264')}</p>}
    {loading && <p className="footnote">{t('ui.auto.395')}</p>}
    {!loading && skills.length === 0 && <p className="footnote">{t('ui.auto.396')}</p>}
    <div className="skill-list">
      {skills.map(skill => <div key={skill.id} className={'skill-card' + (skill.enabled ? ' on' : '')}>
        <Sparkles size={17} />
        <div>
          <strong>{skill.name}<small>{skill.enabled ? t('ui.auto.397') : t('ui.auto.398')}</small></strong>
          <p>{skillSummary(skill)}</p>
        </div>
        <button aria-pressed={skill.enabled} disabled={busy === skill.id} onClick={() => onToggle(skill)}>
          {skill.enabled ? t('ui.auto.399') : t('ui.auto.400')}
        </button>
      </div>)}
    </div>
    {skills.length > 0 && <p className="footnote">{t('ui.auto.265')}</p>}
    {learningOn && <>
      <h2>{t('learning.inbox')}</h2>
      <p className="settings-lead">{t('learning.lead')}</p>
      {candidates.some(c => c.duplicateSpend) && <p className="footnote">{t('learning.spend')}</p>}
      {!loading && candidates.length === 0 && <p className="footnote">{t('learning.empty')}</p>}
      <div className="skill-list">
        {candidates.map(candidate => <div key={candidate.id} className="skill-card">
          <Sparkles size={17} />
          <div>
            <strong>{candidate.name}<small>{candidate.scopeKey}</small></strong>
            <p>{candidate.description}</p>
          </div>
          <button disabled={busy === candidate.id} onClick={() => onDecide(candidate, 'approve')}>{t('learning.approve')}</button>
          <button disabled={busy === candidate.id} onClick={() => onDecide(candidate, 'reject')}>{t('learning.reject')}</button>
          <button disabled={busy === candidate.id} onClick={() => onPromote(candidate)}>{t('learning.promote')}</button>
        </div>)}
      </div>
    </>}
  </section>;
}
