import { describe, expect, it } from 'vitest';
import { dnaBuildSpec } from '../../electron/branding/dna';

/**
 * El ADN se escribe en el idioma del contenido de la marca. El chequeo de
 * marca compara `wordsNo` palabra por palabra: un ADN en inglés para una marca
 * que escribe en castellano no encontraría nunca "oferta".
 */
describe('dnaBuildSpec · idioma del ADN', () => {
  const base = { jobId: 'bdj_1', brandName: 'Casa Oliva', mode: 'existing' as const, url: null, instagram: null, prepared: [] };

  it('pide el ADN en castellano rioplatense para una marca en es-AR', () => {
    const spec = dnaBuildSpec({ ...base, language: 'es-AR' });
    expect(spec).toContain('Spanish (Argentina)');
    expect(spec).toContain('literal words');
    expect(spec).not.toContain('English (United States)');
  });

  it('pide el ADN en inglés para una marca en en-US', () => {
    const spec = dnaBuildSpec({ ...base, language: 'en-US' });
    expect(spec).toContain('English (United States)');
    expect(spec).not.toContain('Spanish (Argentina)');
  });
});
