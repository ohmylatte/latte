import { describe, expect, it } from 'vitest';
import { composeBrandContext } from '../shared/brandContext';
import { LCS_CELL_LIMIT, contextDiff } from './context-diff';

describe('contextDiff', () => {
  it('uses append strategy without an LCS matrix', () => {
    const current = 'Tono cercano.\nSin muletillas.';
    const added = 'Audiencia: 25-40.';
    const after = composeBrandContext(current, added, 'append');
    const result = contextDiff(current, after, 'append');
    expect(result.strategy).toBe('append');
    expect(result.lines).toEqual([
      { kind: 'same', text: 'Tono cercano.' },
      { kind: 'same', text: 'Sin muletillas.' },
      { kind: 'add', text: '' },
      { kind: 'add', text: 'Audiencia: 25-40.' },
    ]);
  });

  it('uses LCS for a small replace and yields the expected hunks', () => {
    const result = contextDiff('alpha\nbeta\ngamma', 'alpha\ndelta\ngamma', 'replace');
    expect(result.strategy).toBe('lcs');
    expect(result.lines).toEqual([
      { kind: 'same', text: 'alpha' },
      { kind: 'del', text: 'beta' },
      { kind: 'add', text: 'delta' },
      { kind: 'same', text: 'gamma' },
    ]);
  });

  it('does not allocate an LCS matrix when n×m exceeds the cell cap', () => {
    const n = Math.ceil(Math.sqrt(LCS_CELL_LIMIT)) + 10;
    const before = Array.from({ length: n }, (_, i) => `keep-${i}`).join('\n');
    const after = `NEW\n${before}`;
    const cells = (n + 1) * (n + 2);
    expect(cells).toBeGreaterThan(LCS_CELL_LIMIT);
    const result = contextDiff(before, after, 'replace');
    expect(result.strategy).toBe('affix');
    expect(result.lines[0]).toEqual({ kind: 'add', text: 'NEW' });
    expect(result.lines.slice(1).every((line) => line.kind === 'same')).toBe(true);
    expect(result.lines).toHaveLength(n + 1);
  });
});
