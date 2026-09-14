import type { LearningService } from '../../learning/service';
import type { SkillResolverPort } from '../../../shared/generationContracts';

/** Maps CatalogSkillResolver via LearningService onto the generation SkillResolverPort. */
export function skillResolverAdapter(learning: LearningService): SkillResolverPort {
  return {
    resolveApproved(input: { brandId: string; budgetChars: number }) {
      const result = learning.resolveApproved(input);
      return {
        refs: result.refs.map((r) => ({ skillId: r.skillId, version: r.version, hash: r.hash })),
        excluded: result.excluded.map((r) => ({ skillId: r.skillId, version: r.version, hash: r.hash })),
      };
    },
  };
}
