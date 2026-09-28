import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { DocumentsView, type DocumentsViewProps } from './DocumentsView';
import { ResultadosView } from './ResultadosView';
import { catalogs, type MessageKey } from './i18n';
import type { BrandDnaEntry, BrandDnaFields, BrandDnaView, Work, WorkDocument } from '../shared/contracts';

/**
 * ADN · CHEQUEO DE MARCA.
 *
 *  1. La línea compacta, su detalle y el resaltado de lo encontrado en el
 *     documento (sólo tokens de color).
 *  2. "Aprobar" con avisos pasa por el diálogo y sin avisos aprueba directo.
 *  3. Sin ADN aprobado: una línea discreta que ofrece armarlo, y que NUNCA
 *     bloquea aprobar.
 *  4. El chequeo también vive donde se revisa lo que el trabajo entrega.
 *  5. El copy nuevo está en los dos idiomas y el CSS nuevo habla sólo tokens.
 */

const mocks = vi.hoisted(() => ({
  readBrandDna: vi.fn(),
  readDocument: vi.fn(),
  documentState: vi.fn(),
  listDocumentRevisions: vi.fn(),
  updateDocument: vi.fn(),
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    api: {
      ...actual.browserAPI,
      readBrandDna: mocks.readBrandDna,
      readDocument: mocks.readDocument,
      documentState: mocks.documentState,
      listDocumentRevisions: mocks.listDocumentRevisions,
      updateDocument: mocks.updateDocument,
    },
  };
});

function entry<T>(value: T): BrandDnaEntry<T> {
  return { value, sources: [], assumption: false };
}

const fields = (patch: Partial<BrandDnaFields> = {}): BrandDnaFields => ({
  tone: null, audience: null, valueProp: null, wordsYes: null, wordsNo: null,
  claims: null, colors: null, fonts: null, ...patch,
});

const view = (patch: Partial<BrandDnaFields> | null, version = 2): BrandDnaView => ({
  brandId: 'b1',
  draft: null,
  approved: patch === null ? null : { version, approvedAt: '2026-09-20T10:00:00.000Z', fields: fields(patch) },
  changedSinceApproval: false,
  proposals: [],
});

const work: Work = {
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña.',
  folder: null, outOfScopeStages: [], updatedAt: '2026-09-01T00:00:00.000Z',
  expectedOutput: 'Propuesta de cierre con oferta para el cliente.',
  resultPath: null,
};

const doc = (status: WorkDocument['status']): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Oferta de lanzamiento', fileName: 'oferta.md',
  status, funnelStages: [], proposedFunnelStages: [], baseDocumentId: null,
  baseRevisionId: null, baseFingerprint: null, createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
});

const onOpenBrand = vi.fn();

const base: DocumentsViewProps = {
  work,
  brandName: 'Casa Oliva',
  documents: [doc('draft')],
  selectedId: 'a',
  onSelect: () => {},
  onDocumentsChanged: async () => {},
  onWorkUpdated: () => {},
  onDirtyChange: () => {},
  onNotice: () => {},
  onError: () => {},
  onCreate: () => {},
  onUseFolder: () => {},
  funnel: false,
  onView: () => {},
  hasBrand: true,
  onStart: () => {},
  untracked: [],
  onTrack: async () => {},
  editors: {},
  busy: false,
  currentWorkId: 'w1',
  workTitles: {},
  showWorkDelta: false,
  onOpenBrand,
};

const BANNED = { wordsNo: entry(['oferta', 'barato']) };
const CONTENT = '# Oferta de la semana\n\nTodo al mejor precio, 100% artesanal.';

/** Espera a que el elemento EXISTA: `waitFor` resuelve aunque vuelva `null`. */
async function until(get: () => Element | null, name: string): Promise<Element> {
  await waitFor(() => expect(get(), `no apareció ${name}`).not.toBeNull());
  // El resultado viaja al padre por un effect: se descarga antes de tocar nada.
  await act(async () => {});
  return get()!;
}

beforeEach(() => {
  onOpenBrand.mockReset();
  mocks.readBrandDna.mockReset().mockResolvedValue(view(BANNED));
  mocks.readDocument.mockReset().mockResolvedValue({ content: CONTENT, fingerprint: 'fp', baseOutdated: false });
  mocks.documentState.mockReset().mockResolvedValue({ documentId: 'a', fingerprint: 'fp', modifiedAt: null, baseOutdated: false });
  mocks.listDocumentRevisions.mockReset().mockResolvedValue([]);
  mocks.updateDocument.mockReset().mockResolvedValue(doc('approved'));
});

afterEach(() => { vi.clearAllMocks(); });

describe('1 · la línea del chequeo, su detalle y el resaltado', () => {
  it('una fila compacta con ícono y texto: Palabras y Tono, nunca sólo color', async () => {
    const { container } = render(<DocumentsView {...base} />);
    const line = await until(() => container.querySelector('.brand-check-line'), '.brand-check-line');
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(line.textContent).toContain('Tono');
    expect(line.querySelector('svg')).not.toBeNull();
    const segments = [...container.querySelectorAll('.brand-check-seg')];
    expect(segments).toHaveLength(3);
    // Con la palabra de la marca en el texto, el primer segmento avisa.
    expect(segments[0]!.getAttribute('data-status')).toBe('warn');
    expect(segments[0]!.textContent).toBe('1 palabra que la marca no usa');
    expect(segments[0]!.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.brand-check')!.getAttribute('aria-label')).toBe('Chequeo de marca');
  });

  it('al hacer clic se despliega el detalle, veredicto por veredicto', async () => {
    const { container } = render(<DocumentsView {...base} />);
    const line = await until(() => container.querySelector('.brand-check-line'), '.brand-check-line');
    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');

    const detail = container.querySelector('.brand-check-detail')!;
    expect([...detail.querySelectorAll('li')].map((li) => li.getAttribute('data-kind')))
      .toEqual(['wordsNo', 'wordsYes', 'claims', 'tone', 'identity']);
    // La palabra hallada, con su conteo, y quién cierra tono e identidad.
    expect(detail.textContent).toContain('oferta (1)');
    expect(detail.textContent).toContain('lo revisa la persona');
    expect(detail.querySelector('[data-kind="wordsNo"]')!.getAttribute('data-status')).toBe('warn');
    expect(detail.querySelector('[data-kind="tone"]')!.getAttribute('data-status')).toBe('unknown');
  });

  it('con el detalle abierto, lo encontrado se resalta en el documento', async () => {
    const { container } = render(<DocumentsView {...base} />);
    const line = await until(() => container.querySelector('.brand-check-line'), '.brand-check-line');
    expect(container.querySelectorAll('.markdown mark')).toHaveLength(0);

    fireEvent.click(line);
    const marks = [...container.querySelectorAll('.markdown mark.brand-hit')];
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.map((mark) => mark.textContent).join(' ')).toContain('Oferta');
    expect(marks[0]!.getAttribute('data-tone')).toBe('blocked');
    // El texto entero sigue estando: los segmentos suman el párrafo original.
    expect(container.querySelector('.markdown h1')!.textContent).toBe('Oferta de la semana');
  });

  it('las palabras de la marca se resaltan con su propio token', async () => {
    mocks.readBrandDna.mockResolvedValue(view({ wordsNo: entry(['oferta']), wordsYes: entry(['semana']) }));
    const { container } = render(<DocumentsView {...base} />);
    const line = await until(() => container.querySelector('.brand-check-line'), '.brand-check-line');
    fireEvent.click(line);
    const tones = [...container.querySelectorAll('.markdown mark.brand-hit')].map((mark) => mark.getAttribute('data-tone'));
    expect(tones).toContain('blocked');
    expect(tones).toContain('verified');
  });
});

describe('2 · Aprobar con avisos y sin avisos', () => {
  it('con avisos, Aprobar abre el diálogo con la lista corta y las dos salidas', async () => {
    const { container, getByRole } = render(<DocumentsView {...base} />);
    await until(() => container.querySelector('.brand-check-line'), '.brand-check-line');
    fireEvent.click(getByRole('button', { name: 'Aprobar' }));

    const dialog = await until(() => container.querySelector('[role="dialog"]'), 'el diálogo');
    expect(dialog.textContent).toContain('Revisá antes de aprobar');
    expect(dialog.textContent).toContain('La marca no usa «oferta» (1)');
    const labels = [...dialog.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toContain('Aprobar igual');
    expect(labels).toContain('Volver a revisar');
    expect(mocks.updateDocument).not.toHaveBeenCalled();
  });

  it('"Volver a revisar" cierra sin aprobar', async () => {
    const { container, getByRole } = render(<DocumentsView {...base} />);
    await until(() => container.querySelector('.brand-check-line'), '.brand-check-line');
    fireEvent.click(getByRole('button', { name: 'Aprobar' }));
    const dialog = await until(() => container.querySelector('[role="dialog"]'), 'el diálogo');
    fireEvent.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Volver a revisar')!);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.updateDocument).not.toHaveBeenCalled();
  });

  it('"Aprobar igual" aprueba igual', async () => {
    const { container, getByRole } = render(<DocumentsView {...base} />);
    await until(() => container.querySelector('.brand-check-line'), '.brand-check-line');
    fireEvent.click(getByRole('button', { name: 'Aprobar' }));
    const dialog = await until(() => container.querySelector('[role="dialog"]'), 'el diálogo');
    fireEvent.click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Aprobar igual')!);
    await waitFor(() => expect(mocks.updateDocument).toHaveBeenCalledWith('a', { status: 'approved' }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('sin avisos aprueba directo, sin diálogo', async () => {
    mocks.readDocument.mockResolvedValue({ content: '# Un texto sin palabras de la marca', fingerprint: 'fp', baseOutdated: false });
    const { container, getByRole } = render(<DocumentsView {...base} />);
    const line = await until(() => container.querySelector('.brand-check-line'), '.brand-check-line');
    expect(line.textContent).toContain('Palabras');
    expect(line.textContent).toContain('Afirmaciones');
    fireEvent.click(getByRole('button', { name: 'Aprobar' }));
    await waitFor(() => expect(mocks.updateDocument).toHaveBeenCalledWith('a', { status: 'approved' }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('3 · sin ADN aprobado', () => {
  it('una línea discreta y positiva, con el enlace a Marca', async () => {
    mocks.readBrandDna.mockResolvedValue(view(null));
    const { container } = render(<DocumentsView {...base} />);
    const empty = await until(() => container.querySelector('.brand-check.is-empty'), '.brand-check.is-empty');
    expect(empty.textContent).toContain('Armá el ADN de la marca para chequear tus piezas');
    const link = [...empty.querySelectorAll('button')].find((button) => button.textContent === 'Ir a Marca')!;
    expect(link).toBeDefined();
    fireEvent.click(link);
    expect(onOpenBrand).toHaveBeenCalled();
  });

  it('nunca bloquea aprobar: sin ADN, Aprobar aprueba directo', async () => {
    mocks.readBrandDna.mockResolvedValue(view(null));
    const { container, getByRole } = render(<DocumentsView {...base} />);
    await until(() => container.querySelector('.brand-check.is-empty'), '.brand-check.is-empty');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Aprobar' }));
    await waitFor(() => expect(mocks.updateDocument).toHaveBeenCalledWith('a', { status: 'approved' }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('si el ADN no se puede leer, no se dibuja ninguna fila', async () => {
    mocks.readBrandDna.mockRejectedValue(new Error('no disponible'));
    const { container } = render(<DocumentsView {...base} />);
    await waitFor(() => expect(mocks.readBrandDna).toHaveBeenCalled());
    await until(() => container.querySelector('.markdown'), 'el documento');
    expect(container.querySelector('.brand-check')).toBeNull();
    expect(container.querySelector('.brand-check-line')).toBeNull();
    expect(container.querySelector('.brand-check.is-empty')).toBeNull();
  });
});

describe('4 · donde se revisa lo que el trabajo entrega', () => {
  it('el chequeo acompaña a los entregables de Resultados', async () => {
    const { container } = render(<ResultadosView work={work} decisions={[]} formatDate={(value) => value} onOpenBrand={onOpenBrand} />);
    const line = await until(() => container.querySelector('.resultados-brand-check .brand-check-line'), 'la línea en Resultados');
    expect(line.textContent).toContain('Tono');
    expect(container.querySelectorAll('.resultados-brand-check .brand-check-seg')).toHaveLength(3);
    fireEvent.click(line);
    expect(container.querySelector('.brand-check-detail')!.textContent).toContain('oferta (1)');
  });

  it('sin ADN, la misma línea que ofrece armarlo', async () => {
    mocks.readBrandDna.mockResolvedValue(view(null));
    const { container } = render(<ResultadosView work={work} decisions={[]} formatDate={(value) => value} />);
    const empty = await until(() => container.querySelector('.resultados-brand-check.is-empty'), 'la línea vacía en Resultados');
    expect(empty.textContent).toContain('Armá el ADN de la marca para chequear tus piezas');
    expect(empty.querySelector('button')).toBeNull();
  });
});

describe('5 · copy en los dos idiomas y CSS sólo con tokens', () => {
  /** Mismo texto a propósito: es una plantilla de lugar, no una frase. */
  const SAME_IN_BOTH = new Set(['brandcheck.hit']);

  it('cada clave nueva está en es y en, con texto propio', () => {
    const es = catalogs['es-AR'] as Record<string, string>;
    const en = catalogs['en-US'] as Record<string, string>;
    const keys = Object.keys(es).filter((key) => key.startsWith('brandcheck.'));
    expect(keys.length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(en).filter((key) => key.startsWith('brandcheck.')).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(es[key]!.trim().length, key).toBeGreaterThan(0);
      if (SAME_IN_BOTH.has(key)) expect(es[key], key).toBe(en[key]);
      else expect(es[key], `${key} tiene el mismo texto en los dos idiomas`).not.toBe(en[key]);
    }
    // El bloque vive justo antes de la clave identity.nav, en las dos hojas.
    const source = readFileSync(join(process.cwd(), 'src', 'i18n.tsx'), 'utf8').split(/\r?\n/);
    const identityKeys = source.map((line, index) => (line.includes("'identity.nav':") ? index : -1)).filter((index) => index >= 0);
    expect(identityKeys).toHaveLength(2);
    for (const index of identityKeys) {
      const before = source.slice(Math.max(0, index - 40), index);
      expect(before.some((line) => line.trim() === '// --- ADN · chequeo de marca ---')).toBe(true);
    }
  });

  it('las claves plurales son la frase entera, que es lo único que interpola el catálogo', () => {
    for (const key of ['brandcheck.words.warn', 'brandcheck.claims.warn'] as MessageKey[]) {
      for (const locale of ['es-AR', 'en-US'] as const) {
        expect(catalogs[locale][key]).toMatch(/^\{\w+, plural, one \{[^{}]*\} other \{[^{}]*\}\}$/);
      }
    }
  });

  it('el CSS nuevo está al final, en su bloque, y habla sólo tokens', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    const at = css.indexOf('/* ADN · chequeo de marca */');
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at);
    expect(block.indexOf('/* ADN', 1)).toBe(-1);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toContain('--text-xs');
    expect(block).not.toMatch(/font-size:\s*(?!var\()/);
    expect(block).toContain('.brand-check');
    expect(block).toContain('.markdown mark.brand-hit');
  });
});
