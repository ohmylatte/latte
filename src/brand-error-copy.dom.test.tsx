import { describe, expect, it } from 'vitest';
import { BRAND_ERROR_KEYS, COORDINATION_ERROR_KEYS, displayError } from './App';
import { catalogs } from './i18n';

/**
 * M2 (ronda 8): LA COPY DE MARCA LA LEE QUIEN ESTÁ EN MARCA.
 *
 * Aprobar una propuesta de contexto de marca ya decidida, aprobarla sobre un
 * contexto que cambió, o pedirle un borrador a un estratega ocupado son tres
 * errores del camino de MARCA. Viajaban con códigos del mapa de coordinación
 * (`PROPOSAL_DECIDED`, `PROPOSAL_STALE`, `MEMBER_BUSY`), así que la persona
 * leía frases escritas para equipos y despachos — y una de ellas hablaba de
 * marca desde adentro del namespace `error.coordination.*`, o sea que el
 * namespace mentía en los dos sentidos a la vez.
 */
describe('M2: los errores del contexto de marca se leen con copy de marca', () => {
  const cases = [
    { code: 'BRAND_PROPOSAL_DECIDED', key: 'error.brand.proposalDecided' },
    { code: 'BRAND_PROPOSAL_STALE', key: 'error.brand.proposalStale' },
    { code: 'STRATEGIST_BUSY', key: 'error.brand.strategistBusy' },
  ] as const;

  it('cada código de marca cae en su frase, no en el `message` crudo del backend', () => {
    for (const { code, key } of cases) {
      const shown = displayError({ code, message: 'Brand context proposal already rejected: bcp_1' });
      expect(shown, code).toBe(catalogs['es-AR'][key]);
      // Y no es el texto del backend, que está escrito para quien lee el código.
      expect(shown, code).not.toContain('bcp_1');
    }
  });

  it('las tres frases existen en los dos idiomas y no hablan de equipos, tareas ni despachos', () => {
    for (const locale of ['es-AR', 'en-US'] as const) {
      for (const { key } of cases) {
        const text = catalogs[locale][key];
        expect(text, `${locale} ${key}`).toBeTypeOf('string');
        expect(text.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
        expect(text, `${locale} ${key}`).not.toMatch(/\bequipo|\btarea|\bdespach|\bteam\b|\btask\b|\bdispatch/i);
      }
    }
  });

  it('y los códigos viejos ya no traducen nada: salieron del mapa de coordinación', () => {
    expect(COORDINATION_ERROR_KEYS.PROPOSAL_STALE).toBeUndefined();
    expect(COORDINATION_ERROR_KEYS.PROPOSAL_DECIDED).toBeUndefined();
    expect(Object.keys(BRAND_ERROR_KEYS)).toHaveLength(3);
  });

  it('`MEMBER_BUSY` sigue existiendo, y sigue siendo del motor: su frase habla de roles ocupados', () => {
    expect(COORDINATION_ERROR_KEYS.MEMBER_BUSY).toBe('error.coordination.memberBusy');
    expect(displayError({ code: 'MEMBER_BUSY', message: 'x' })).toBe(catalogs['es-AR']['error.coordination.memberBusy']);
    // Y no es la misma frase que la del estratega: son dos hechos distintos.
    expect(catalogs['es-AR']['error.coordination.memberBusy']).not.toBe(catalogs['es-AR']['error.brand.strategistBusy']);
  });
});
