import { describe, expect, it } from 'vitest';
import { validateAssetBytes } from '../../electron/branding/publish';
import { MINIMAL_PNG } from './helpers';

const EVIL_SVG = Buffer.from('<svg onload="alert(1)"><script>alert(1)</script></svg>');
const CLEAN_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');

describe('validateAssetBytes', () => {
  it('rejects an SVG payload disguised as a PNG and accepts a clean SVG or real PNG', () => {
    expect(validateAssetBytes(EVIL_SVG, 'logo.png')).toBe(false);
    expect(validateAssetBytes(EVIL_SVG, 'logo.svg')).toBe(false);
    expect(validateAssetBytes(CLEAN_SVG, 'logo.svg')).toBe(true);
    expect(validateAssetBytes(MINIMAL_PNG, 'logo.png')).toBe(true);
  });
});
