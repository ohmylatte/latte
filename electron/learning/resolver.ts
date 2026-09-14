import { featureEnabled } from '../core/features';
import { skillContentHash } from './hash';
import { brandScopeKey } from './ids';
import {
  AGENCY_SCOPE_KEY,
  MAX_LEARNED_PER_TASK,
  type ResolveApprovedInput,
  type ResolveApprovedResult,
  type SkillRef,
  type SkillResolver,
} from './types';
import type { LearningRepository } from '../storage/learningRepository';

export interface SkillResolverDeps {
  learning: LearningRepository;
  /** Installation meta. Feature off must not read learning tables. */
  getMeta: (key: string) => string | null;
}

/**
 * Pure selection over the approved catalog. Generation pins the returned refs;
 * a later approval does not rewrite an in-flight generation.
 */
export class CatalogSkillResolver implements SkillResolver {
  constructor(private readonly deps: SkillResolverDeps) {}

  resolveApproved(input: ResolveApprovedInput): ResolveApprovedResult {
    if (!featureEnabled((key) => this.deps.getMeta(key), 'learning')) {
      return { refs: [], excluded: [] };
    }
    if (typeof input.brandId !== 'string' || typeof input.budgetChars !== 'number' || input.budgetChars < 0) {
      return { refs: [], excluded: [] };
    }
    const scopes = [brandScopeKey(input.brandId), AGENCY_SCOPE_KEY];
    const versions = this.deps.learning.listApprovedVersions(scopes);
    const refs: SkillRef[] = [];
    const excluded: SkillRef[] = [];
    let used = 0;
    for (const version of versions) {
      const computed = skillContentHash({
        name: version.name,
        description: version.description,
        markdown: version.markdown,
      });
      const ref: SkillRef = { skillId: version.skillId, version: version.version, hash: version.contentHash };
      if (computed !== version.contentHash) {
        excluded.push(ref);
        continue;
      }
      const size = version.markdown.length;
      const overBudget = used + size > input.budgetChars;
      const overCount = refs.length >= MAX_LEARNED_PER_TASK;
      if (overBudget || overCount) {
        excluded.push(ref);
        continue;
      }
      refs.push(ref);
      used += size;
    }
    return { refs, excluded };
  }
}
