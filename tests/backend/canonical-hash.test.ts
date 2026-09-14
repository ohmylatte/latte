import { describe, expect, it } from 'vitest';
import { canonicalJson as coreCanonical, sha256Utf8 as coreHash } from '../../electron/core/canonical';
import { canonicalJson as genCanonical, sha256Utf8 as genHash } from '../../electron/generation/canon';
import { skillContentHash } from '../../electron/learning/hash';

describe('shared canonical hash', () => {
  it('hashes the same NFC/NFD content identically in core, branding, generation and learning', () => {
    const nfc = 'café';
    const nfd = 'cafe\u0301';
    expect(nfc).not.toBe(nfd);
    const coreNfc = coreHash(coreCanonical(nfc));
    const coreNfd = coreHash(coreCanonical(nfd));
    expect(coreNfc).toBe(coreNfd);
    expect(genHash(genCanonical(nfc))).toBe(coreNfc);
    expect(genHash(genCanonical(nfd))).toBe(coreNfc);
    const skillNfc = skillContentHash({ name: nfc, description: 'd', markdown: '# Informe mensual comprobable\n## Entradas\nPeríodo autorizado y kit.\n## Procedimiento\n1. Paso.\n2. Otro paso.\n3. Cierre.\n## Verificación\nCada cifra tiene fuente.\n## Límites\nDetener si falta dato.' });
    const skillNfd = skillContentHash({ name: nfd, description: 'd', markdown: '# Informe mensual comprobable\n## Entradas\nPeríodo autorizado y kit.\n## Procedimiento\n1. Paso.\n2. Otro paso.\n3. Cierre.\n## Verificación\nCada cifra tiene fuente.\n## Límites\nDetener si falta dato.' });
    expect(skillNfc).toBe(skillNfd);
  });
});
