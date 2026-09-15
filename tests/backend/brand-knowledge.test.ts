import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../electron/core/errors';
import { makeBackend, type TestBackend } from './helpers';

describe('brand knowledge aggregation', () => {
  let b: TestBackend | null = null;
  afterEach(() => { b?.cleanup(); b = null; });

  async function twoWorksSameBrand() {
    const backend = await makeBackend();
    b = backend;
    const brand = await backend.service.createBrand('Casa');
    const launch = await backend.service.createWork(brand.id, 'Lanzamiento');
    const retain = await backend.service.createWork(brand.id, 'Retención');
    const otherBrand = await backend.service.createBrand('Otra');
    const otherWork = await backend.service.createWork(otherBrand.id, 'Ajeno');
    return { backend, brand, launch, retain, otherBrand, otherWork };
  }

  it('aggregates documents of two works and excludes another brand', async () => {
    const { backend, brand, launch, retain, otherBrand, otherWork } = await twoWorksSameBrand();
    const launchCopy = await backend.service.createDocument(launch.id, 'copy', 'Anuncio primavera');
    const retainNote = await backend.service.createDocument(retain.id, 'note', 'Aprendizajes Q1');
    await backend.service.createDocument(otherWork.id, 'copy', 'No se ve');

    const brandDocs = await backend.service.listBrandDocuments(brand.id);
    const titles = brandDocs.map((d) => d.title);
    expect(titles).toContain('Anuncio primavera');
    expect(titles).toContain('Aprendizajes Q1');
    expect(titles).toContain(launch.title);
    expect(titles).toContain(retain.title);
    expect(titles).not.toContain('No se ve');
    expect(brandDocs.find((d) => d.id === launchCopy.document.id)?.workId).toBe(launch.id);
    expect(brandDocs.find((d) => d.id === retainNote.document.id)?.workId).toBe(retain.id);

    const otherDocs = await backend.service.listBrandDocuments(otherBrand.id);
    expect(otherDocs.map((d) => d.title)).toContain('No se ve');
    expect(otherDocs.map((d) => d.title)).not.toContain('Anuncio primavera');
  });

  it('aggregates decisions with provenance and keeps the work-local list intact', async () => {
    const { backend, brand, launch, retain, otherWork } = await twoWorksSameBrand();
    await backend.service.addDecision(launch.id, 'Instagram antes que TikTok');
    await backend.service.addDecision(retain.id, 'Email mensual, no semanal');
    await backend.service.addDecision(otherWork.id, 'Decisión de otra marca');

    const brandDecisions = await backend.service.listBrandDecisions(brand.id);
    expect(brandDecisions.map((d) => d.text).sort()).toEqual(['Email mensual, no semanal', 'Instagram antes que TikTok']);
    expect(brandDecisions.find((d) => d.text.startsWith('Instagram'))?.workId).toBe(launch.id);
    expect(brandDecisions.find((d) => d.text.startsWith('Email'))?.workId).toBe(retain.id);

    expect((await backend.service.listDecisions(launch.id)).map((d) => d.text)).toEqual(['Instagram antes que TikTok']);
    expect((await backend.service.listDecisions(retain.id)).map((d) => d.text)).toEqual(['Email mensual, no semanal']);
    expect((await backend.service.listDecisions(otherWork.id)).map((d) => d.text)).toEqual(['Decisión de otra marca']);
  });

  it('builds the funnel from the aggregated document set, not from one work', async () => {
    const { backend, brand, launch, retain } = await twoWorksSameBrand();
    const discovery = await backend.service.createDocument(launch.id, 'research', 'Entrevistas');
    const conversion = await backend.service.createDocument(retain.id, 'copy', 'Oferta');
    await backend.service.updateDocument(discovery.document.id, { funnelStages: ['discovery'] });
    await backend.service.updateDocument(conversion.document.id, { funnelStages: ['conversion'] });

    const launchOnly = await backend.service.listDocuments(launch.id);
    expect(launchOnly.some((d) => d.funnelStages.includes('conversion'))).toBe(false);
    expect(launchOnly.find((d) => d.id === discovery.document.id)?.funnelStages).toEqual(['discovery']);

    const aggregated = await backend.service.listBrandDocuments(brand.id);
    expect(aggregated.find((d) => d.id === discovery.document.id)).toMatchObject({ workId: launch.id, funnelStages: ['discovery'] });
    expect(aggregated.find((d) => d.id === conversion.document.id)).toMatchObject({ workId: retain.id, funnelStages: ['conversion'] });
  });

  it('creates and lists documents on a single work without flattening provenance', async () => {
    const { backend, launch, retain } = await twoWorksSameBrand();
    const created = await backend.service.createDocument(launch.id, 'strategy', 'Estrategia local');
    expect(created.document.workId).toBe(launch.id);
    expect((await backend.service.listDocuments(launch.id)).some((d) => d.id === created.document.id)).toBe(true);
    expect((await backend.service.listDocuments(retain.id)).some((d) => d.id === created.document.id)).toBe(false);
  });

  it('refuses another brand id that does not exist', async () => {
    const backend = await makeBackend();
    b = backend;
    await expect(backend.service.listBrandDocuments('brd_missing_brand_xx')).rejects.toBeInstanceOf(NotFoundError);
    await expect(backend.service.listBrandDecisions('brd_missing_brand_xx')).rejects.toBeInstanceOf(NotFoundError);
  });
});
