import type { Brand } from '../shared/contracts';

/** How the Contexto editor reacts when a turn ends and Brand.context changed on disk. */
export function resolveRemoteBrandContext(input: {
  draft: string;
  persisted: string;
  previousPersisted: string;
  dirty: boolean;
}): { draft: string; notice: boolean } {
  if (!input.dirty) return { draft: input.persisted, notice: false };
  const remoteChanged = input.persisted !== input.previousPersisted;
  return { draft: input.draft, notice: remoteChanged };
}

/** Drop a late brand fetch if the user already selected another brand. */
export function applyFetchedBrand(input: {
  selectedId: string | null;
  fetched: Brand;
  previousPersisted: string;
  draft: string;
  dirty: boolean;
  forceContext?: boolean;
}): { applied: false } | { applied: true; brand: Brand; draft: string; notice: boolean } {
  if (input.selectedId !== input.fetched.id) return { applied: false };
  if (input.forceContext) return { applied: true, brand: input.fetched, draft: input.fetched.context, notice: false };
  const next = resolveRemoteBrandContext({
    draft: input.draft,
    persisted: input.fetched.context,
    previousPersisted: input.previousPersisted,
    dirty: input.dirty,
  });
  return { applied: true, brand: input.fetched, ...next };
}
