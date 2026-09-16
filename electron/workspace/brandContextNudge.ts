/**
 * Who drafts an empty brand context, and why nobody else should.
 *
 * Brand context is shared by every work of a brand. When it is empty, three
 * works of the same brand would each tell their agent to draft it, and the
 * human would answer the same questions three times. This pure predicate
 * elects ONE work to carry the draft nudge and tells the others, precisely,
 * why they must not: the agent that is told to stop without a reason asks
 * anyway.
 *
 * Pure: no repository, no disk, no Electron. The caller passes the facts.
 */

/** How hard the instruction file asks for a draft. `none` is a deliberate stop. */
export type BrandContextNudgeForm = 'full' | 'short' | 'none';

/** Why the draft nudge is suppressed. Null only when the nudge is emitted. */
export type BrandContextNudgeReason = 'pending' | 'inherited' | 'owner-elsewhere' | 'context-exists';

export interface BrandContextNudge {
  form: BrandContextNudgeForm;
  reason: BrandContextNudgeReason | null;
}

/**
 * The work that owns the empty-context draft: the lowest work id.
 *
 * `repo.listWorks` is ordered by `updated_at DESC`, so the election sorts
 * explicitly instead of trusting the list order. Ids are random hex, so the
 * owner is stable but arbitrary; the human-facing view shows who it is.
 */
export function electBrandContextOwner(works: readonly { id: string }[]): string | null {
  if (works.length === 0) return null;
  return works
    .map((work) => work.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
}

export interface BrandContextNudgeInput {
  /** `brand.context` as persisted. */
  context: string;
  /** A brand-context proposal is waiting for the human. */
  hasPendingProposal: boolean;
  /**
   * Other works of this brand already left durable knowledge.
   *
   * Compute this with `hasInheritedContent` (decisions or artifacts), never with
   * `hasBrandMemory` ("a sibling work exists"). Feeding it the existence check
   * made this `true` for every brand with two or more works, which suppressed
   * the nudge on all of them: the brand whose works have all left nothing is
   * exactly the brand that needs one of them to draft the context.
   */
  hasInheritedMemory: boolean;
  /** The work whose instruction file is being rendered. */
  workId: string;
  /** The elected owner, or null when the brand has no works. */
  ownerWorkId: string | null;
}

/**
 * The policy, most specific first: context already written beats a pending
 * proposal beats inherited memory beats "another work owns this". Only the
 * elected work of a brand with nothing at all gets the full nudge.
 */
export function brandContextNudge(input: BrandContextNudgeInput): BrandContextNudge {
  if (input.context.trim().length > 0) return { form: 'none', reason: 'context-exists' };
  if (input.hasPendingProposal) return { form: 'none', reason: 'pending' };
  if (input.hasInheritedMemory) return { form: 'none', reason: 'inherited' };
  if (input.ownerWorkId === null || input.workId !== input.ownerWorkId) return { form: 'none', reason: 'owner-elsewhere' };
  return { form: 'full', reason: null };
}
