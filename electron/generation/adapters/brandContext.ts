import { LatteError } from '../../core/errors';
import type { BrandingService } from '../../branding/service';
import type { WorkBrandContextView } from '../../../shared/contracts';
import type { BrandContextPort, BrandContextSnapshot } from '../../../shared/generationContracts';

/**
 * Maps BrandingService.resolveForWork onto the generation BrandContextPort.
 * `null` only for explicit-neutral with no signature (and when kits are disabled).
 */
export function brandContextAdapter(branding: BrandingService): BrandContextPort {
  return {
    resolveForWork(workId: string): BrandContextSnapshot | null {
      let view: WorkBrandContextView;
      try {
        view = branding.resolveForWork(workId);
      } catch (error) {
        if (error instanceof LatteError && error.code === 'FEATURE_DISABLED') return null;
        throw error;
      }
      return snapshotFromView(view);
    },
    pinAssets(snapshot: BrandContextSnapshot) {
      return branding.collectPinAssets(snapshot);
    },
  };
}

export function snapshotFromView(view: WorkBrandContextView): BrandContextSnapshot | null {
  const snapshot = view.snapshot;
  const hasInputs = snapshot.sourceKit !== null || snapshot.signature !== null;
  if (!hasInputs) return null;
  return {
    schemaVersion: 1,
    workId: snapshot.workId,
    brandId: snapshot.brandId,
    choice: { identity: snapshot.choice.identity, signature: snapshot.choice.signature },
    identity: snapshot.identity,
    sourceKit: snapshot.sourceKit
      ? { kitId: snapshot.sourceKit.kitId, version: snapshot.sourceKit.version, hash: snapshot.sourceKit.hash }
      : null,
    rules: snapshot.rules,
    assets: snapshot.assets.map((a) => ({ id: a.id, hash: a.hash })),
    signature: snapshot.signature
      ? {
          agencyRevision: snapshot.signature.agencyRevision,
          hash: snapshot.signature.hash,
          publicName: snapshot.signature.publicName,
          website: snapshot.signature.website,
          logo: snapshot.signature.logo
            ? { id: snapshot.signature.logo.id, hash: snapshot.signature.logo.hash }
            : null,
        }
      : null,
    warnings: [...snapshot.warnings],
  };
}
