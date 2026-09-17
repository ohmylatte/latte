import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateState, UpdateUnsupportedKind } from '../shared/contracts';

vi.mock('./browser-api', () => ({ api: {} }));

const { UnsupportedUpdateNotice } = await import('./UpdateBanner');

const unsupported = (message: string, unsupportedKind: UpdateUnsupportedKind): UpdateState => ({
  phase: 'unsupported',
  unsupportedKind,
  version: null,
  percent: 0,
  message,
});

const render = (message: string, unsupportedKind: UpdateUnsupportedKind) => renderToStaticMarkup(
  createElement(UnsupportedUpdateNotice, { state: unsupported(message, unsupportedKind) }),
);

describe('UpdateBanner unsupported installations', () => {
  it('shows manual-install guidance without relying on message wording', () => {
    const message = 'Descargá la versión nueva y reinstalá Latte.';
    const markup = render(message, 'manual-install');

    expect(markup).toContain(message);
    expect(markup).not.toContain('<button');
  });

  it('keeps non-manual unsupported states quiet even when prose mentions .deb', () => {
    const misleadingMessage = 'El código fuente también puede mencionar .deb.';

    expect(render(misleadingMessage, 'source')).toBe('');
    expect(render(misleadingMessage, 'unavailable')).toBe('');
  });
});

describe('UpdateBanner copy', () => {
  it('reads every word from the dictionary: the first screen after an install is not half Spanish', () => {
    const source = readFileSync(resolve('src/UpdateBanner.tsx'), 'utf8')
      // Comments explain the code in Spanish on purpose; only shipped strings count.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // Any quoted run of text carrying Spanish orthography is prose that never
    // reached the dictionary, so an English install would read it in Spanish.
    const literals = source.match(new RegExp("(['\"`])[^'\"`\\n]*[áéíóúñ¿¡][^'\"`\\n]*\\1", 'g')) ?? [];
    expect(literals).toEqual([]);
  });
});
