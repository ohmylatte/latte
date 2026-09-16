import type { BrandContextMode } from './contracts';

/** Append adds a section after a blank line; replace overwrites. Shared by service, preview stub and UI. */
export function composeBrandContext(current: string, text: string, mode: BrandContextMode): string {
  if (mode === 'append' && current.trim().length > 0) return `${current.replace(/\s+$/u, '')}\n\n${text}`;
  return text;
}

export const BRAND_CONTEXT_INPUT_KEYS = ['text', 'rationale', 'mode', 'clientRequestId'] as const;
export const BRAND_CONTEXT_INPUT_KEY_SET: ReadonlySet<string> = new Set(BRAND_CONTEXT_INPUT_KEYS);
