import type { BrandContextMode } from '../shared/contracts';

export type ContextDiffKind = 'same' | 'add' | 'del';
export type ContextDiffLine = { kind: ContextDiffKind; text: string };
export type ContextDiffStrategy = 'append' | 'lcs' | 'affix';

/** LCS matrix cells above this use a prefix/suffix diff instead of allocating (n+1)×(m+1). */
export const LCS_CELL_LIMIT = 250_000;

export function contextDiff(before: string, after: string, mode: BrandContextMode): { lines: ContextDiffLine[]; strategy: ContextDiffStrategy } {
  if (mode === 'append') return { lines: appendDiff(before, after), strategy: 'append' };
  const a = before.split('\n');
  const b = after.split('\n');
  if ((a.length + 1) * (b.length + 1) > LCS_CELL_LIMIT) return { lines: affixDiff(a, b), strategy: 'affix' };
  return { lines: lcsDiff(a, b), strategy: 'lcs' };
}

function appendDiff(before: string, after: string): ContextDiffLine[] {
  const current = before.replace(/\s+$/u, '');
  const prefix = current.length === 0 ? [] : current.split('\n');
  const afterLines = after.split('\n');
  const lines: ContextDiffLine[] = prefix.map((text) => ({ kind: 'same', text }));
  for (const text of afterLines.slice(prefix.length)) lines.push({ kind: 'add', text });
  return lines;
}

function affixDiff(a: string[], b: string[]): ContextDiffLine[] {
  let start = 0;
  const min = Math.min(a.length, b.length);
  while (start < min && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const out: ContextDiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: 'same', text: a[i] });
  for (let i = start; i <= endA; i++) out.push({ kind: 'del', text: a[i] });
  for (let i = start; i <= endB; i++) out.push({ kind: 'add', text: b[i] });
  for (let i = endA + 1; i < a.length; i++) out.push({ kind: 'same', text: a[i] });
  return out;
}

function lcsDiff(a: string[], b: string[]): ContextDiffLine[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: ContextDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: a[i++] });
    else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}
