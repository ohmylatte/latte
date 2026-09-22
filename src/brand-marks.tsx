import type { CSSProperties } from 'react';

/**
 * Flat SVG marks shared by the Layer 2 microinteractions.
 *
 * The printed pieces (web, installer, splash, large icons) draw these with the
 * canvas print-kit — grain, halftone, ink register. Inside the app the marks are
 * clean vectors on tokens: no texture, no canvas, no animation libraries.
 *
 * Colour comes from `currentColor` (set via `color: var(--token)`), so a single
 * mark can be rust on the document, foam on the approval stamp, or a role colour
 * on a team tab.
 */

/** The L, the human signature ("vos aprobás"). Same polygon as the print kit. */
const L_PTS = '56,96 104,57 104,152 201,152 160,198 56,198';

export function LMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 256 256" aria-hidden="true">
      <polygon points={L_PTS} fill="currentColor" />
    </svg>
  );
}

/**
 * The cup from above: a rim with coffee inside. `level` (0..1) is how full the
 * coffee is — 0 is empty, 1 is full. The coffee always stays inside the rim.
 */
export function CupFromAbove({
  size = 32,
  level = 1,
  rim = 'var(--ink)',
  coffee = 'var(--rust)',
  className,
}: {
  size?: number;
  level?: number;
  rim?: string;
  coffee?: string;
  className?: string;
}) {
  const r = 45;
  const fill = Math.max(0, Math.min(1, level));
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r={r} fill="none" stroke={rim} strokeWidth="4" />
      <circle cx="50" cy="50" r={r * fill} fill={coffee} />
    </svg>
  );
}

/** A single wisp of steam, 10×16, drawn as a wavy stroke that rises in a loop. */
export function SteamWisp({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg className={className} style={style} width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
      <path
        d="M5 15 C 1.5 12.5, 8.5 10.5, 5 8 C 1.5 5.5, 8.5 3.5, 5 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The loading cup: the rim stays put while the coffee (rust) fills the
 * paper-deep interior in a 2.6s loop. Replaces the spinner for waits over
 * ~400ms. `label` is announced to assistive tech and hidden visually.
 */
export function Loading({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span className="loading-cup" role="status" aria-label={label}>
      <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="45" fill="var(--paper-deep)" />
        <circle className="loading-cup-coffee" cx="50" cy="50" r="45" fill="var(--rust)" />
        <circle cx="50" cy="50" r="45" fill="none" stroke="var(--ink)" strokeWidth="4" />
      </svg>
      {label && <span className="visually-hidden">{label}</span>}
    </span>
  );
}

/** A version ring: 14px, 2px rust border. `filled` marks the current version. */
export function VersionRing({ filled = false, drawing = false }: { filled?: boolean; drawing?: boolean }) {
  return (
    <svg className={'version-ring' + (filled ? ' filled' : '') + (drawing ? ' drawing' : '')} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill={filled ? 'var(--rust)' : 'none'} stroke="var(--rust)" strokeWidth="2" />
    </svg>
  );
}

/**
 * The approval stamp: the cup from above (ink rim, rust coffee) with the L in
 * foam. It pops in (0→1 with a short bounce) when a document is approved.
 */
export function ApprovalStamp({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="45" fill="none" stroke="var(--ink)" strokeWidth="4" />
      <circle cx="50" cy="50" r="41" fill="var(--rust)" />
      <polygon points={L_PTS} fill="var(--foam)" transform="translate(50 50) scale(0.4) translate(-128 -128)" />
    </svg>
  );
}

/**
 * El color de un rol, para quien ya importaba esto desde acá. La decisión vive
 * en `coordination/role-color`: una sola paleta, un solo lugar donde elegir.
 */
export { roleColor, roleColorVar } from './coordination/role-color';
