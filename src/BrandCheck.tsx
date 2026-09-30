import { createElement, Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronDown, CircleHelp } from 'lucide-react';
import type { Components } from 'react-markdown';
import { translate as t } from './i18n';
import { api } from './browser-api';
import { checkPieceAgainstDna, highlightSegments, type HighlightWord } from '../shared/brand-check';
import type { BrandCheckFinding, BrandCheckResult, BrandCheckKind, BrandDnaView } from '../shared/contracts';

/**
 * ADN · CHEQUEO DE MARCA: la franja que acompaña a "Aprobar".
 *
 * Su propia franja de ancho completo, debajo de la barra del documento: nunca
 * dentro de la fila de botones. Cerrada, una sola línea con ícono y texto
 * (el color nunca es la sola señal) y un chevron para abrir; abierta, el
 * detalle en filas `ícono · qué · dónde` a la izquierda. Sin avisos, una
 * línea discreta que dice qué respeta y contra qué versión del ADN.
 *
 * Sin ADN aprobado no hay nada que comparar, y la franja lo dice con una frase
 * que ofrece el camino: arma el ADN. Nunca bloquea aprobar.
 */

const KIND_ORDER: BrandCheckKind[] = ['wordsNo', 'wordsYes', 'claims', 'tone', 'identity'];

export interface BrandCheckProps {
  brandId: string;
  /** El nombre de la marca, para la línea de "respeta el ADN". */
  brandName?: string;
  /** El texto de la pieza: el documento abierto o el resultado del trabajo. */
  text: string;
  /** El detalle abierto lo decide el padre: de ahí sale el resaltado. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** El resultado del chequeo, para que el padre resalte las palabras halladas. */
  onResult?: (result: BrandCheckResult | null) => void;
  /** Enlace a Marca. Sin esto, la frase queda sin acción. */
  onOpenBrand?: () => void;
  className?: string;
}

/** Las palabras que el resultado encontró, con su token de color. */
export function highlightWordsOf(result: BrandCheckResult | null): HighlightWord[] {
  if (!result) return [];
  const words: HighlightWord[] = [];
  for (const kind of ['wordsNo', 'wordsYes'] as const) {
    const tone = kind === 'wordsNo' ? 'blocked' : 'verified';
    for (const hit of result.findings.find((f) => f.kind === kind)?.hits ?? []) words.push({ word: hit.word, tone });
  }
  return words;
}

/** Un aviso del diálogo: de qué clase es y cómo se lee. Uno por fila. */
export interface BrandCheckWarning {
  kind: 'word' | 'claim';
  text: string;
}

/** La lista corta de avisos que el diálogo de aprobación muestra. */
export function brandCheckWarnings(result: BrandCheckResult | null): BrandCheckWarning[] {
  if (!result) return [];
  const items: BrandCheckWarning[] = [];
  for (const finding of result.findings) {
    if (finding.kind === 'wordsNo') {
      for (const hit of finding.hits ?? []) {
        items.push({ kind: 'word', text: t('brandcheck.item.word', { word: hit.word, count: hit.count }) });
      }
    }
    if (finding.kind === 'claims') {
      for (const hit of finding.hits ?? []) {
        items.push({ kind: 'claim', text: t('brandcheck.item.claim', { text: hit.word }) });
      }
    }
  }
  return items;
}

function wrapChildren(children: unknown, words: readonly HighlightWord[]): ReactNode {
  if (typeof children === 'string') return marksFor(children, words);
  if (Array.isArray(children)) {
    return children.map((child, index) => createElement(Fragment, { key: index }, wrapChildren(child, words)));
  }
  return children as ReactNode;
}

/** El texto partido por el MISMO criterio que el conteo, envuelto en `<mark>`. */
function marksFor(text: string, words: readonly HighlightWord[]): ReactNode {
  const segments = highlightSegments(text, words);
  if (segments.every((segment) => segment.tone === null)) return text;
  return segments.map((segment, index) => (segment.tone
    ? createElement('mark', { key: index, className: 'brand-hit', 'data-tone': segment.tone }, segment.text)
    : createElement(Fragment, { key: index }, segment.text)));
}

/**
 * Los componentes del markdown con el resaltado puesto: p, li, los encabezados,
 * las celdas y los énfasis —todo lo que lleva texto de la pieza— se renderizan
 * igual que sin resaltar y sólo envuelven sus textos en `<mark>`.
 */
export function highlightComponents(words: readonly HighlightWord[]): Components {
  const make = (tag: string) => {
    // El `node` es interno de react-markdown: no es un atributo del DOM.
    const Highlighted = ({ node: _node, children, ...rest }: any) =>
      createElement(tag, rest, wrapChildren(children, words));
    return Highlighted;
  };
  return {
    p: make('p'), li: make('li'), h1: make('h1'), h2: make('h2'), h3: make('h3'), h4: make('h4'),
    h5: make('h5'), h6: make('h6'), td: make('td'), th: make('th'), blockquote: make('blockquote'),
    strong: make('strong'), em: make('em'), del: make('del'), a: make('a'), code: make('code'), span: make('span'),
  };
}

function icon(status: BrandCheckFinding['status'], size = 12) {
  if (status === 'ok') return <Check size={size} aria-hidden="true" />;
  if (status === 'warn') return <AlertTriangle size={size} aria-hidden="true" />;
  return <CircleHelp size={size} aria-hidden="true" />;
}

/** El ícono de cada aviso en el diálogo: el mismo triángulo, uno por fila. */
export function warningIcon(kind: BrandCheckWarning['kind'], size = 14): ReactNode {
  return <AlertTriangle size={size} aria-hidden="true" data-warning={kind} />;
}

/** El rótulo de la fila: la cuenta sale del resultado, nunca de otro lado. */
function labelOf(finding: BrandCheckFinding): string {
  switch (finding.kind) {
    case 'wordsNo':
      return finding.status === 'warn'
        ? t('brandcheck.words.warn', { count: finding.hits?.length ?? 0 })
        : t('brandcheck.words.ok');
    case 'wordsYes':
      return t('brandcheck.words.yes');
    case 'claims':
      return finding.status === 'warn'
        ? t('brandcheck.claims.warn', { count: finding.hits?.length ?? 0 })
        : t('brandcheck.claims.ok');
    case 'tone':
      return t('brandcheck.tone');
    case 'identity':
      return t('brandcheck.identity');
  }
}

function hitsOf(finding: BrandCheckFinding): string | null {
  if (finding.kind === 'tone' || finding.kind === 'identity') return t('brandcheck.byHuman');
  const hits = finding.hits ?? [];
  if (hits.length > 0) return hits.map((hit) => t('brandcheck.hit', { word: hit.word, count: hit.count })).join(' · ');
  if (finding.kind === 'wordsYes') return t('brandcheck.words.yesNone');
  if (finding.kind === 'claims' && finding.status === 'unknown') return t('brandcheck.claims.unknown');
  return null;
}

export function BrandCheck(props: BrandCheckProps) {
  const [view, setView] = useState<BrandDnaView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const resultRef = useRef(props.onResult);
  useEffect(() => { resultRef.current = props.onResult; }, [props.onResult]);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    setFailed(false);
    // La lectura entra por una promesa a propósito: el chequeo es opcional y
    // una API que no está disponible no se puede llevar puesta a la pantalla.
    Promise.resolve()
      .then(() => api.readBrandDna(props.brandId))
      .then((next) => { if (live) { setView(next); setLoaded(true); } })
      .catch(() => { if (live) { setView(null); setLoaded(true); setFailed(true); } });
    return () => { live = false; };
  }, [props.brandId]);

  const approved = view?.approved ?? null;
  const result = useMemo(
    () => (approved ? checkPieceAgainstDna(props.text, approved.fields, approved.version) : null),
    [props.text, approved],
  );
  useEffect(() => { resultRef.current?.(result); }, [result]);

  // Todavía se está leyendo el ADN, o no se pudo leer: no se dibuja nada antes
  // de saber la verdad. La fila sin ADN es la única que habla sin resultado.
  if (!loaded || failed) return null;
  const className = ['brand-check', props.className].filter(Boolean).join(' ');

  if (!approved) {
    return <p className={`${className} is-empty`}>
      <span>{t('brandcheck.noDna')}</span>
      {props.onOpenBrand && <button type="button" onClick={props.onOpenBrand}>{t('brandcheck.noDnaLink')}</button>}
    </p>;
  }

  const byKind = new Map(result!.findings.map((finding) => [finding.kind, finding]));
  const warn = result!.warnings > 0;
  const segmentOf = (kind: 'wordsNo' | 'claims' | 'tone') => {
    const finding = byKind.get(kind)!;
    return <span className="brand-check-seg" data-status={finding.status} key={kind}>
      {icon(finding.status)}{labelOf(finding)}
    </span>;
  };
  // Con avisos, la línea nombra cada uno; sin avisos, una sola frase discreta
  // con la marca y la versión del ADN contra la que se miró la pieza.
  const line = warn
    ? (['wordsNo', 'claims', 'tone'] as const).map((kind, index) => <Fragment key={kind}>
        {index > 0 && <span className="brand-check-sep" aria-hidden="true">·</span>}
        {segmentOf(kind)}
      </Fragment>)
    : <span className="brand-check-seg" data-status="ok" key="ok">
        <Check size={12} aria-hidden="true" />
        {(props.brandName ?? '').trim()
          ? t('brandcheck.ok', { brand: props.brandName!.trim(), version: approved.version })
          : t('brandcheck.okNoBrand', { version: approved.version })}
      </span>;

  return <div className={className} data-tone={warn ? 'warn' : 'ok'} role="group" aria-label={t('brandcheck.region')}>
    <button type="button" className="brand-check-line" aria-expanded={props.open} title={t('brandcheck.toggle')}
      onClick={() => props.onOpenChange(!props.open)}>
      {line}
      <ChevronDown size={12} className={props.open ? 'rotated' : ''} aria-hidden="true" />
    </button>
    {props.open && <ul className="brand-check-detail">
      {KIND_ORDER.map((kind) => {
        const finding = byKind.get(kind)!;
        const hits = hitsOf(finding);
        return <li key={kind} data-kind={kind} data-status={finding.status}>
          <span className="brand-check-row-label">{icon(finding.status, 13)}{labelOf(finding)}</span>
          {hits && <span className="brand-check-row-where">
            <span className="brand-check-row-sep" aria-hidden="true">·</span>
            <span className="brand-check-row-hits">{hits}</span>
          </span>}
        </li>;
      })}
    </ul>}
  </div>;
}
