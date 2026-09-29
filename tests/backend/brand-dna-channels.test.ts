import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dnaBuildSpec,
  parseDnaStepReport,
  requireBrandDnaFields,
} from '../../electron/branding/dna';
import {
  fakeCoordinationHub,
  fakeExecutablePath,
  fakePtyLoader,
  fakeRunner,
  makeBackend,
  type FakeTeamMember,
  type TestBackend,
} from './helpers';

/**
 * OTROS CANALES — el contrato del build.
 *
 * La fuente deja de ser "Instagram" y pasa a ser los canales donde la marca ya
 * publica: uno o varios links, cada uno con su propia línea de detalle. Lo que
 * Latte promete en el pedido al agente es lo mismo que prometía con una sola
 * fuente: leer lo PÚBLICO de cada canal, y si alguno no se puede leer,
 * declararlo `failed` con el motivo de ESE canal y seguir con los demás.
 */
describe('ADN de marca — otros canales', () => {
  let b: TestBackend;
  let brandId: string;
  let workId: string;
  let members: FakeTeamMember[];

  const step = (job: { steps: readonly { key: string; state: string; detail: string | null }[] }, key: string) =>
    job.steps.find((s) => s.key === key)!;

  /**
   * IA disponible (terminal que carga y CLI en el PATH), marca fresca y un
   * equipo FALSO: el despacho de K1 tiene que salir bien para que el build
   * siga en vuelo y el detalle de cada canal se conserve.
   */
  const restartWithAi = async () => {
    b.cleanup();
    b = await makeBackend({
      loadPty: fakePtyLoader().load,
      runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which'
        ? { code: 0, stdout: `${fakeExecutablePath(args[0])}\n` }
        : { code: 0, stdout: '1.0.0\n' })),
    });
    brandId = (await b.service.createBrand('Ayulem')).id;
    workId = (await b.service.createWork(brandId, 'Propuesta mayorista')).id;
    members = [];
    fakeCoordinationHub(b, members);
  };

  beforeEach(async () => {
    b = await makeBackend();
    brandId = (await b.service.createBrand('Ayulem')).id;
    workId = (await b.service.createWork(brandId, 'Propuesta mayorista')).id;
    members = [];
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('el paso se llama "Canales", nunca más "Instagram"', async () => {
    const job = await b.service.buildBrandDna(brandId, 'sources', {
      url: null,
      channels: ['https://instagram.com/ayulem'],
      useIdentityFiles: false,
    });
    expect(job.steps.map((s) => s.key)).toContain('channels');
    expect(job.steps.map((s) => s.key)).not.toContain('instagram');
    // Sin IA el build termina con el código del motor; el PASO existe igual.
    expect(job).toMatchObject({ done: true, outcome: 'failed', reason: 'NOT_INSTALLED' });
  });

  it('el detalle del paso nombra a cada canal', async () => {
    await restartWithAi();
    const channels = ['https://instagram.com/ayulem', 'https://linkedin.com/company/ayulem'];

    const job = await b.service.buildBrandDna(brandId, 'sources', { url: null, channels, useIdentityFiles: false });

    const detail = step(job, 'channels').detail ?? '';
    expect(detail).toContain('instagram.com/ayulem');
    expect(detail).toContain('linkedin.com/company/ayulem');
    expect(step(job, 'channels').state).toBe('pending');
    // El trabajo de campaña NO es donde se compone el ADN de la marca.
    expect(fs.existsSync(path.join(b.files.workDir(brandId, workId), 'borradores', 'adn'))).toBe(false);
  });

  it('en el modo "con lo que ya tiene" no se leen canales', async () => {
    await restartWithAi();

    const job = await b.service.buildBrandDna(brandId, 'existing', null);
    // K1: este modo no pidió canales, así que la fila ni existe — no es un
    // "Omitido" que la persona tenga que leer.
    expect(job.steps.map((s) => s.key)).toEqual(['context', 'documents', 'decisions', 'memory', 'compose']);
  });

  it('la marca decide cuántos canales y cuáles', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `https://ayulem.com/canal-${i}`);
    await expect(b.service.buildBrandDna(brandId, 'sources', { url: null, channels: nine, useIdentityFiles: false }))
      .rejects.toThrow(/8/);
    await expect(b.service.buildBrandDna(brandId, 'sources', { url: null, channels: ['ftp://ayulem.com'], useIdentityFiles: false }))
      .rejects.toThrow(/canal/i);
    await expect(b.service.buildBrandDna(brandId, 'sources', { url: null, channels: ['hola mundo'], useIdentityFiles: false }))
      .rejects.toThrow(/canal/i);
    await expect(b.service.buildBrandDna(brandId, 'sources', { url: null, channels: 'no soy una lista' as never, useIdentityFiles: false }))
      .rejects.toThrow(/canales/i);
  });

  it('un @usuario entra y se interpreta como Instagram', async () => {
    await restartWithAi();

    const job = await b.service.buildBrandDna(brandId, 'sources', { url: null, channels: ['@ayulem'], useIdentityFiles: false });
    expect(step(job, 'channels').detail).toContain('@ayulem');
  });

  it('sin ninguna fuente el error sigue nombrando a los canales', async () => {
    await expect(b.service.buildBrandDna(brandId, 'sources', { url: null, channels: [], useIdentityFiles: false }))
      .rejects.toThrow(/canal/i);
  });
});

describe('ADN de marca — el pedido al agente con canales', () => {
  const base = {
    jobId: 'bdj_1',
    brandName: 'Ayulem',
    mode: 'sources' as const,
    url: null,
    prepared: [] as string[],
    language: 'es-AR' as const,
  };

  it('le pide leer lo público de CADA canal y declarar cuál no se pudo', () => {
    const channels = ['https://instagram.com/ayulem', 'https://linkedin.com/company/ayulem'];
    const spec = dnaBuildSpec({ ...base, channels });

    for (const channel of channels) expect(spec).toContain(channel);
    expect(spec).toContain('PUBLIC');
    expect(spec, 'cada canal que no se lee se declara con su motivo').toContain('"failed"');
    expect(spec, 'con el motivo escrito por canal').toContain('"detail"');
    expect(spec).not.toContain('mark the instagram step failed');
  });

  it('sin canales no le pide ninguno', () => {
    const spec = dnaBuildSpec({ ...base, channels: [] });
    expect(spec).not.toContain('PUBLIC channel');
  });

  it('los kind de las fuentes suman "channel" y siguen aceptando lo guardado', () => {
    const spec = dnaBuildSpec({ ...base, channels: ['https://instagram.com/ayulem'] });
    const kindLine = spec.split('\n').find((line) => line.includes('`kind` is one of')) ?? '';
    expect(kindLine).toContain('channel');
    expect(kindLine).toContain('instagram');
  });
});

describe('ADN de marca — el reporte de pasos por canal', () => {
  it('acepta el reporte por canal y lo reduce a un paso con detalle por canal', () => {
    const report = parseDnaStepReport(JSON.stringify({
      web: { state: 'done', detail: 'Leí la home.' },
      channels: {
        'https://instagram.com/ayulem': { state: 'done', detail: 'Bio y publicaciones.' },
        'https://linkedin.com/company/ayulem': { state: 'failed', detail: 'Pide login' },
      },
    }));

    expect(report.web).toEqual({ state: 'done', detail: 'Leí la home.' });
    expect(report.channels).toBeDefined();
    expect(report.channels!.state, 'un canal que no se leyó deja el paso en failed').toBe('failed');
    expect(report.channels!.detail).toContain('instagram.com/ayulem');
    expect(report.channels!.detail).toContain('linkedin.com/company/ayulem');
    expect(report.channels!.detail).toContain('Pide login');
  });

  it('todos los canales leídos dejan el paso en done', () => {
    const report = parseDnaStepReport(JSON.stringify({
      channels: {
        'https://instagram.com/ayulem': { state: 'done', detail: 'Bio y publicaciones.' },
        '@ayulem': { state: 'done', detail: 'Perfil público.' },
      },
    }));
    expect(report.channels!.state).toBe('done');
  });

  it('el reporte de un solo paso sigue siendo válido', () => {
    const report = parseDnaStepReport(JSON.stringify({
      web: { state: 'done', detail: 'Leí la home.' },
      channels: { state: 'skipped', detail: 'Sin canales para leer' },
    }));
    expect(report.channels).toEqual({ state: 'skipped', detail: 'Sin canales para leer' });
  });
});

describe('ADN de marca — el kind "channel" en la ficha', () => {
  const entry = (kind: string) => ({
    audience: { value: 'Mayoristas.', sources: [{ kind, label: 'canal · instagram.com/ayulem' }], assumption: false },
  });

  it('acepta "channel" como procedencia de un dato', () => {
    const fields = requireBrandDnaFields({
      tone: null, audience: entry('channel').audience, valueProp: null, wordsYes: null,
      wordsNo: null, claims: null, colors: null, fonts: null,
    });
    expect(fields.audience?.sources[0].kind).toBe('channel');
  });

  it('sigue aceptando "instagram": ya está guardado en borradores viejos', () => {
    const fields = requireBrandDnaFields({
      tone: null, audience: entry('instagram').audience, valueProp: null, wordsYes: null,
      wordsNo: null, claims: null, colors: null, fonts: null,
    });
    expect(fields.audience?.sources[0].kind).toBe('instagram');
  });

  it('una procedencia que no existe no entra', () => {
    expect(() => requireBrandDnaFields({
      tone: null, audience: entry('twitch').audience, valueProp: null, wordsYes: null,
      wordsNo: null, claims: null, colors: null, fonts: null,
    })).toThrow(/source/i);
  });
});
