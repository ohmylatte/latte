import { EFFORT_TIERS, type AcpRuntimeName, type AcpTierModels, type EffortTier } from '../../../shared/contracts';
import { ValidationError } from '../../core/errors';
import { HERMES_DEFAULT_TIER_MODELS } from '../tiers';

/**
 * EL MODELO POR NIVEL DE GROK Y HERMES, COMO LO DEJÓ AJUSTES.
 *
 * Vive en `meta` (clave/valor, sin migración), como la cara de un rol. Lo que
 * no está elegido es `null` y el perfil usa el default de Latte: Hermes, la
 * tabla de `tiers.ts`; Grok, el modelo de la cuenta (hoy ofrece uno solo), y
 * el nivel sólo mueve el esfuerzo.
 */
export const ACP_TIER_MODELS_KEY = 'acp_tier_models';

const RUNTIMES: readonly AcpRuntimeName[] = ['grok', 'hermes'];

export function acpTierModelDefaults(): AcpTierModels {
  return {
    grok: { light: null, balanced: null, deep: null },
    hermes: { ...HERMES_DEFAULT_TIER_MODELS },
  };
}

function empty(): AcpTierModels {
  return { grok: { light: null, balanced: null, deep: null }, hermes: { light: null, balanced: null, deep: null } };
}

/** Un modelo válido: `proveedor:modelo` o un id suelto, sin espacios. */
export function isAcpModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\0]/.test(value);
}

/** Lo guardado. Una fila rota o a mano no rompe nada: lo que no se entiende queda en `null`. */
export function readAcpTierModels(getMeta: (key: string) => string | null): AcpTierModels {
  const out = empty();
  const raw = getMeta(ACP_TIER_MODELS_KEY);
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    for (const runtime of RUNTIMES) {
      for (const tier of EFFORT_TIERS) {
        const value = parsed?.[runtime]?.[tier];
        if (isAcpModelId(value)) out[runtime][tier] = value;
      }
    }
  } catch { /* se queda en los defaults */ }
  return out;
}

export function writeAcpTierModel(
  getMeta: (key: string) => string | null,
  setMeta: (key: string, value: string) => void,
  runtime: unknown,
  tier: unknown,
  model: unknown,
): AcpTierModels {
  if (runtime !== 'grok' && runtime !== 'hermes') throw new ValidationError('Unknown ACP runtime');
  if (typeof tier !== 'string' || !(EFFORT_TIERS as readonly string[]).includes(tier)) throw new ValidationError('Unknown effort tier');
  const clean = typeof model === 'string' ? model.trim() : model;
  if (clean !== null && clean !== '' && !isAcpModelId(clean)) throw new ValidationError('Invalid model id');
  const next = readAcpTierModels(getMeta);
  next[runtime][tier as EffortTier] = clean ? (clean as string) : null;
  setMeta(ACP_TIER_MODELS_KEY, JSON.stringify(next));
  return next;
}

/** Lo que el adaptador de un runtime lee al abrir una conversación. */
export function tierModelReader(getMeta: (key: string) => string | null, runtime: AcpRuntimeName): (tier: EffortTier) => string | null {
  return (tier) => readAcpTierModels(getMeta)[runtime][tier];
}
