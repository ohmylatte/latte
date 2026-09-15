export const ALL_BRAND_SCOPE = 'all';
export type KnowledgeScope = typeof ALL_BRAND_SCOPE | string;

type BriefLike = { id: string; workId: string; kind: string; fileName: string };

export function inKnowledgeScope<T extends { workId: string }>(items: T[], scope: KnowledgeScope): T[] {
  return scope === ALL_BRAND_SCOPE ? items : items.filter((item) => item.workId === scope);
}

export function workTitles(works: ReadonlyArray<{ id: string; title: string }>): Record<string, string> {
  return Object.fromEntries(works.map((work) => [work.id, work.title]));
}

export function workBrief<T extends BriefLike>(documents: readonly T[], workId: string): T | undefined {
  return documents.find((d) => d.workId === workId && d.kind === 'brief' && d.fileName === 'brief.md');
}

/** When the operational work changes, open that work's brief. Later clicks stay explicit. */
export function selectWorkBrief(selected: Record<string, string>, brandId: string, workId: string, documents: readonly BriefLike[]): Record<string, string> {
  const brief = workBrief(documents, workId);
  if (!brief || selected[brandId] === brief.id) return selected;
  return { ...selected, [brandId]: brief.id };
}

export function documentOriginTitle(selectedWorkId: string | undefined, currentWorkTitle: string, titles: Record<string, string>): string {
  if (!selectedWorkId) return currentWorkTitle;
  return titles[selectedWorkId] ?? currentWorkTitle;
}
