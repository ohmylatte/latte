import {
  GENERATION_SCHEMA_VERSION,
  type BrandContextPort,
  type BrandContextSnapshot,
  type GenerationContext,
  type GenerationReceipt,
  type PrepareGenerationResult,
  type SkillRef,
  type SkillResolverPort,
} from '../../shared/generationContracts';
import { GenerationContractError } from './errors';
import { hashGenerationContext, kitRefFromSnapshot, validateBrandContextSnapshot } from './canon';

export interface WorkAuthority {
  requireWork(workId: string): { id: string; brandId: string };
}

export interface PrepareGenerationDeps {
  works: WorkAuthority;
  brand: BrandContextPort;
  skills: SkillResolverPort;
  insert(receipt: GenerationReceipt): GenerationReceipt;
  pin(input: {
    generationId: string;
    work: { id: string; brandId: string };
    context: GenerationContext;
    snapshot: BrandContextSnapshot | null;
    contextJson: string;
    contextHash: string;
  }): void;
  liveMemberCount(workId: string): number;
  refreshInstructions(work: { id: string; brandId: string }): void;
  newId: () => string;
  now: () => string;
  budgetChars: number;
}

/**
 * Shared preparation flow (8 steps). Does not call the model, approve kits, or approve skills.
 * `brandId` always comes from requireWork, never from the renderer.
 */
export function prepareGeneration(deps: PrepareGenerationDeps, workId: string): PrepareGenerationResult {
  // 1. requireWork → { work, brandId } from the repository
  const work = deps.works.requireWork(workId);

  // 2–3. persisted identity/signature choice + pure resolve (inside the brand port)
  let snapshot: BrandContextSnapshot | null;
  try {
    snapshot = deps.brand.resolveForWork(work.id);
  } catch (error) {
    if (error instanceof GenerationContractError) throw error;
    throw error;
  }
  if (snapshot) {
    snapshot = validateBrandContextSnapshot(snapshot);
    if (snapshot.workId !== work.id || snapshot.brandId !== work.brandId) {
      throw new GenerationContractError('BRAND_SCOPE_MISMATCH', 'Snapshot does not belong to this work');
    }
  }

  // 4. SkillResolver: authorize brand:<brandId> and agency:local before indexing
  const skills = deps.skills.resolveApproved({ brandId: work.brandId, budgetChars: deps.budgetChars });

  const generationId = deps.newId();
  const brandContext = kitRefFromSnapshot(generationId, snapshot);
  const assembled: GenerationContext = {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    workId: work.id,
    brandId: work.brandId,
    brandContext,
    skillRefs: skills.refs,
  };

  // 5. canonicalize + hash; persist immutable receipt
  const sealed = hashGenerationContext(assembled);
  const receipt: GenerationReceipt = {
    id: generationId,
    workId: work.id,
    brandId: work.brandId,
    context: sealed.context,
    contextJson: sealed.json,
    contextHash: sealed.hash,
    createdAt: deps.now(),
  };

  // 6. project a minimum copy to .latte/generations/<id>/  (never .latte/context or .latte/skills)
  deps.pin({
    generationId,
    work,
    context: sealed.context,
    snapshot,
    contextJson: sealed.json,
    contextHash: sealed.hash,
  });
  deps.insert(receipt);

  // 7. refresh shared instructions only with zero live members; otherwise leave pending
  const live = deps.liveMemberCount(work.id);
  const pending = live > 0;
  if (!pending) deps.refreshInstructions(work);

  // 8. delivery evidence / artifact checks live in other tables; filled later, not here
  return {
    generationId,
    context: sealed.context,
    contextHash: sealed.hash,
    pending,
    instructionsRefreshed: !pending,
    excludedSkillRefs: skills.excluded,
  };
}

export function skillRefsFitBudget(refs: SkillRef[], budgetChars: number, encode: (refs: SkillRef[]) => string): {
  refs: SkillRef[];
  excluded: SkillRef[];
} {
  if (encode(refs).length <= budgetChars) return { refs, excluded: [] };
  return { refs: [], excluded: refs };
}
