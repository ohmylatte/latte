import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeBackend, type TestBackend } from './helpers';

/**
 * LA PANTALLA DE FUENTES SE ACUERDA DE LO QUE SE PIDIÓ.
 *
 * En el recorrido inicial, "Armar mi marca" escribe la web y los canales en la
 * pantalla y en ningún otro lado: si la persona cierra Latte y vuelve, el
 * formulario aparece vacío (sólo los logos vuelven, porque se guardan en la
 * marca apenas se suben). Por eso el backend guarda las fuentes YA VALIDADAS en
 * `brand_dna_sources:{brandId}` APENAS se valida el pedido, antes del despacho,
 * y las devuelve en `lastSources`.
 *
 * Acá se prueban las dos mitades del contrato: un armado que FALLA igual deja
 * las fuentes guardadas, y un meta ilegible se lee como `null` en vez de romper
 * la ficha entera. Fakes en todos lados: ni un agente real.
 */
describe('ADN · lastSources: la web y los canales del último armado', () => {
  let b: TestBackend;
  let brandId: string;

  beforeEach(async () => {
    b = await makeBackend();
    brandId = (await b.service.createBrand('Ayulem')).id;
  });
  afterEach(() => { b.cleanup(); });

  it('un armado que falla (sin IA) igual deja lastSources con la web y los canales', async () => {
    // Sin ningún runtime disponible: el build se cae con el código del motor.
    const job = await b.service.buildBrandDna(brandId, 'sources', {
      url: 'https://ayulem.com.ar',
      channels: ['@ayulem', 'https://linkedin.com/company/ayulem'],
      useIdentityFiles: false,
    });
    expect(job).toMatchObject({ done: true, outcome: 'failed', reason: 'NOT_INSTALLED' });

    // Lo que escribió la persona no se perdió con el fallo: está guardado.
    const view = await b.service.readBrandDna(brandId);
    expect(view.lastSources).toEqual({
      url: 'https://ayulem.com.ar',
      channels: ['@ayulem', 'https://linkedin.com/company/ayulem'],
    });
  });

  it('una marca que nunca pidió un armado no tiene lastSources', async () => {
    const view = await b.service.readBrandDna(brandId);
    expect(view.lastSources).toBeNull();
  });

  it('un meta con JSON roto devuelve null en vez de romper la ficha', async () => {
    b.repo.setMeta(`brand_dna_sources:${brandId}`, '{esto no es un json');

    const view = await b.service.readBrandDna(brandId);

    expect(view.lastSources).toBeNull();
  });

  it('un meta con la forma equivocada también devuelve null', async () => {
    b.repo.setMeta(`brand_dna_sources:${brandId}`, JSON.stringify({ url: 42, channels: 'no' }));

    const view = await b.service.readBrandDna(brandId);

    expect(view.lastSources).toBeNull();
  });
});
