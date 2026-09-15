export const ALL_BRAND_SCOPE = 'all';
export type KnowledgeScope = typeof ALL_BRAND_SCOPE | string;

export function inKnowledgeScope<T extends { workId: string }>(items: T[], scope: KnowledgeScope): T[] {
  return scope === ALL_BRAND_SCOPE ? items : items.filter((item) => item.workId === scope);
}

export function workTitles(works: ReadonlyArray<{ id: string; title: string }>): Record<string, string> {
  return Object.fromEntries(works.map((work) => [work.id, work.title]));
}
