import { LatteError } from './errors';

export const FEATURE_KEYS = {
  generation: 'feature:generation',
  brandKits: 'feature:brand-kits',
  learning: 'feature:learning',
  /** sdd/autonomous-coordination task 8.1: off by default, same as every other feature. */
  coordination: 'feature:coordination',
} as const;

export type FeatureName = keyof typeof FEATURE_KEYS;

export const FEATURE_ON = 'on';

export interface FeatureFlags {
  generation: boolean;
  brandKits: boolean;
  learning: boolean;
  coordination: boolean;
}

export function isFeatureOn(metaValue: string | null | undefined): boolean {
  return metaValue === FEATURE_ON;
}

export function featureEnabled(getMeta: (key: string) => string | null, name: FeatureName): boolean {
  return isFeatureOn(getMeta(FEATURE_KEYS[name]));
}

export function readFeatureFlags(getMeta: (key: string) => string | null): FeatureFlags {
  return {
    generation: featureEnabled(getMeta, 'generation'),
    brandKits: featureEnabled(getMeta, 'brandKits'),
    learning: featureEnabled(getMeta, 'learning'),
    coordination: featureEnabled(getMeta, 'coordination'),
  };
}

const DISABLED_MESSAGE: Record<FeatureName, string> = {
  generation: 'Generation context is disabled',
  brandKits: 'Los kits de marca están desactivados en esta instalación',
  learning: 'Learning is disabled',
  coordination: 'La coordinación de equipo está desactivada en esta instalación',
};

export class FeatureDisabledError extends LatteError {
  constructor(feature: FeatureName) {
    super('FEATURE_DISABLED', DISABLED_MESSAGE[feature]);
    this.name = 'FeatureDisabledError';
  }
}

export function requireFeature(getMeta: (key: string) => string | null, name: FeatureName): void {
  if (!featureEnabled(getMeta, name)) throw new FeatureDisabledError(name);
}
