import { translate as t } from './i18n';
import type { Work } from '../shared/contracts';
import { ALL_BRAND_SCOPE, type KnowledgeScope } from './brand-knowledge';

export function KnowledgeScopeFilter({ works, currentWorkId, value, onChange }: {
  works: Work[];
  currentWorkId: string | null;
  value: KnowledgeScope;
  onChange: (scope: KnowledgeScope) => void;
}) {
  return <div className="knowledge-scope">
    <label>
      <span>{t('knowledge.filter')}</span>
      <select aria-label={t('knowledge.filter')} value={value} onChange={e => onChange(e.target.value)}>
        <option value={ALL_BRAND_SCOPE}>{t('knowledge.allBrand')}</option>
        {works.map(w => <option key={w.id} value={w.id}>{w.title}{w.id === currentWorkId ? ` · ${t('knowledge.thisWork')}` : ''}</option>)}
      </select>
    </label>
    <p className="footnote">{t('knowledge.help')}</p>
  </div>;
}

export function KnowledgeOrigin({ workId, currentWorkId, titles }: {
  workId: string;
  currentWorkId: string | null;
  titles: Record<string, string>;
}) {
  const current = workId === currentWorkId;
  const title = titles[workId] ?? workId;
  return <em className={'knowledge-origin' + (current ? ' current' : '')} data-origin-work={workId} data-current-work={current ? 'true' : 'false'}>
    {current ? t('knowledge.delta') : t('knowledge.origin', { title })}
  </em>;
}
