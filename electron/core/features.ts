import { LatteError } from './errors';

export const FEATURE_KEYS = {
  generation: 'feature:generation',
  brandKits: 'feature:brand-kits',
  learning: 'feature:learning',
  /**
   * 1.2.0 (R1): ENCENDIDA por defecto. La coordinación dejó de ser un
   * experimento a escondidas y es la forma en que el equipo trabaja, así que
   * una instalación nueva la trae puesta. La fila `meta` sigue mandando
   * cuando existe: guardar `off` la apaga, y ese `off` se respeta.
   */
  coordination: 'feature:coordination',
} as const;

export type FeatureName = keyof typeof FEATURE_KEYS;

export const FEATURE_ON = 'on';
export const FEATURE_OFF = 'off';

/**
 * Qué significa "la fila `meta` no existe" para cada feature.
 *
 * Hasta 1.1.0 la respuesta era siempre `false`, y por eso `isFeatureOn` (que
 * mira un valor suelto, sin saber de qué feature es) alcanzaba. Desde 1.2.0
 * `coordination` llega prendida, así que el default depende de la feature y
 * la ausencia de la fila ya no se puede leer sin nombre.
 */
export const FEATURE_DEFAULTS: Record<FeatureName, boolean> = {
  generation: false,
  brandKits: false,
  learning: false,
  coordination: true,
};

export interface FeatureFlags {
  generation: boolean;
  brandKits: boolean;
  learning: boolean;
  coordination: boolean;
}

export function isFeatureOn(metaValue: string | null | undefined): boolean {
  return metaValue === FEATURE_ON;
}

/**
 * La fila ausente cae en el default de la feature; una fila presente manda, y
 * CUALQUIER valor que no sea `on` (incluido el `off` explícito que escribe el
 * interruptor de Ajustes) apaga. Esto último es lo mismo que hacía
 * `isFeatureOn`: no se ensancha lo que cuenta como "prendida".
 */
export function featureEnabled(getMeta: (key: string) => string | null, name: FeatureName): boolean {
  const stored = getMeta(FEATURE_KEYS[name]);
  if (stored === null || stored === undefined) return FEATURE_DEFAULTS[name];
  return isFeatureOn(stored);
}

export function readFeatureFlags(getMeta: (key: string) => string | null): FeatureFlags {
  return {
    generation: featureEnabled(getMeta, 'generation'),
    brandKits: featureEnabled(getMeta, 'brandKits'),
    learning: featureEnabled(getMeta, 'learning'),
    coordination: featureEnabled(getMeta, 'coordination'),
  };
}

/**
 * O2: ESTO ES TEXTO DE LOG, no la frase que lee la persona.
 *
 * Es lo único que se escribe acá porque un `Error` necesita un `message`, y
 * este módulo no conoce el idioma de la interfaz. Lo que la pantalla muestra
 * cuando `FEATURE_DISABLED` cruza IPC es la clave i18n que
 * `COORDINATION_ERROR_KEYS` le asigna, en los dos idiomas — antes no había
 * ninguna y esta frase, en castellano fijo, era lo que se veía.
 */
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
