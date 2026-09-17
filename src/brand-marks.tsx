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

const ROLE_COLORS = new Set(['assistant', 'strategist', 'researcher', 'analyst', 'reviewer']);

/** The role colour token for a role id, falling back to the default role. */
export function roleColorVar(roleId: string): string {
  return ROLE_COLORS.has(roleId) ? `var(--role-${roleId})` : 'var(--role-default)';
}
