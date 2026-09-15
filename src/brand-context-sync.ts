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
