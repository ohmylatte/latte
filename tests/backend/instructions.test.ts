import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Brand, Decision, Work } from '../../shared/contracts';
import { LattePaths } from '../../electron/core/paths';
import { loadInstructionPack } from '../../electron/workspace/packs';
import {
  BRAND_CONTEXT_CHARS,
  DECISIONS_INLINE_MAX,
  INSTRUCTIONS_MAX_CHARS,
  renderInstructionBundle,
  renderInstructions,
  type PackSkill,
} from '../../electron/workspace/instructions';
import { WorkspaceFiles } from '../../electron/workspace/workspace';
import { makeTempDir, removeDir } from './helpers';

const PACKS_DIR = path.resolve(__dirname, '..', '..', 'packs');
const pack = loadInstructionPack(PACKS_DIR, 'marketing-core');
const writingSkill = pack?.skills.find((s) => s.id === 'writing') ?? null;

const brand: Brand = { id: 'brd_1', name: 'Bruma Café', context: 'Tono directo, sin muletillas.', createdAt: '2026-01-01T00:00:00.000Z' };
const work: Work = { id: 'wrk_1', brandId: 'brd_1', title: 'Lanzamiento Q1', brief: '# Brief', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' } as Work;

function decision(i: number, day: number, status: Decision['status'] = 'approved'): Decision {
  return {
    id: `dec_${String(i).padStart(3, '0')}`,
    workId: work.id,
    text: `Decision number ${i} about the campaign budget and channel mix.`,
    rationale: '',
    alternativesRejected: [],
    evidenceRefs: [],
    status,
    source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
    clientRequestId: null,
    fingerprint: '',
    createdAt: `2026-${String(1 + Math.floor(day / 28)).padStart(2, '0')}-${String((day % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    decidedAt: null,
  };
}

describe('renderInstructionBundle: brand context ceiling', () => {
  it('inlines the whole context and writes no side file when under the ceiling', () => {
    const bundle = renderInstructionBundle({ brand, work, decisions: [] });
    expect(bundle.text).toContain(brand.context);
    expect(bundle.files.some((f) => f.path.endsWith('brand.md'))).toBe(false);
  });

  it('truncates at BRAND_CONTEXT_CHARS, points to a side file, and writes the full text there', () => {
    const longBrand: Brand = { ...brand, context: 'A'.repeat(BRAND_CONTEXT_CHARS + 500) };
    const bundle = renderInstructionBundle({ brand: longBrand, work, decisions: [] });
    const brandSection = bundle.text.slice(bundle.text.indexOf('## Brand context'));
    expect(brandSection).toContain('A'.repeat(BRAND_CONTEXT_CHARS));
    expect(brandSection).not.toContain('A'.repeat(BRAND_CONTEXT_CHARS + 1));
    expect(brandSection).toMatch(/truncated; read \.\/\.latte\/context\/brand\.md for the full text/);
    const side = bundle.files.find((f) => f.path === '.latte/context/brand.md');
    expect(side?.content).toContain('A'.repeat(BRAND_CONTEXT_CHARS + 500));
  });
});

describe('renderInstructionBundle: decisions ceiling', () => {
  it('inlines every approved decision, in chronological order, under the ceiling', () => {
    const decisions = Array.from({ length: 10 }, (_, i) => decision(i, i));
    const bundle = renderInstructionBundle({ brand, work, decisions });
    const idx = decisions.map((d) => bundle.text.indexOf(d.text));
    expect(idx.every((i) => i > -1)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(bundle.files.some((f) => f.path.endsWith('decisions.md'))).toBe(false);
  });

  it('ignores decisions that are not approved when counting the ceiling', () => {
    const decisions = [decision(0, 0, 'pending'), decision(1, 1)];
    const bundle = renderInstructionBundle({ brand, work, decisions });
    expect(bundle.text).not.toContain(decisions[0].text);
    expect(bundle.text).toContain(decisions[1].text);
  });

  it('keeps only the most recent DECISIONS_INLINE_MAX, points to a side file with the full log', () => {
    const total = DECISIONS_INLINE_MAX + 7;
    const decisions = Array.from({ length: total }, (_, i) => decision(i, i));
    const bundle = renderInstructionBundle({ brand, work, decisions });
    const overflow = total - DECISIONS_INLINE_MAX;
    // The oldest `overflow` decisions dropped out of the inline section...
    for (const d of decisions.slice(0, overflow)) expect(bundle.text).not.toContain(d.text);
    // ...the most recent DECISIONS_INLINE_MAX stayed, in chronological order.
    const kept = decisions.slice(overflow);
    const idx = kept.map((d) => bundle.text.indexOf(d.text));
    expect(idx.every((i) => i > -1)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(bundle.text).toContain(`${overflow} earlier decisions are recorded in ./.latte/context/decisions.md`);
    const side = bundle.files.find((f) => f.path === '.latte/context/decisions.md');
    expect(side).toBeTruthy();
    // The side file is the complete log, overflow included.
    for (const d of decisions) expect(side!.content).toContain(d.text);
  });
});

describe('renderInstructionBundle: skills by reference', () => {
  it('points to a side file instead of inlining the skill body', () => {
    expect(writingSkill).toBeTruthy();
    const skill = writingSkill as PackSkill;
    const bundle = renderInstructionBundle({ brand, work, decisions: [], skills: [skill] });
    expect(bundle.text).toContain(`<!-- latte:skill ${skill.id} -->`);
    expect(bundle.text).toContain(`## ${skill.name}`);
    expect(bundle.text).toContain(`Before writing final copy for the human, read ./.latte/skills/${skill.id}.md and follow it.`);
    // The body itself never rides the instruction file any more.
    const firstBodyLine = skill.body.trim().split('\n')[0];
    expect(bundle.text).not.toContain(firstBodyLine);
    const side = bundle.files.find((f) => f.path === `.latte/skills/${skill.id}.md`);
    expect(side?.content).toContain(skill.body.trim());
  });

  it('writes nothing for a skill with an empty body', () => {
    const empty: PackSkill = { id: 'noop', name: 'Noop', summary: '', body: '   ' };
    const bundle = renderInstructionBundle({ brand, work, decisions: [], skills: [empty] });
    expect(bundle.text).not.toContain('latte:skill noop');
    expect(bundle.files.some((f) => f.path.includes('noop'))).toBe(false);
  });
});

describe('renderInstructionBundle: hard cap', () => {
  it('never trims the pack body, the brief, the team/roles sections or the Working rules', () => {
    const decisions = Array.from({ length: 200 }, (_, i) => decision(i, i));
    const heavy: Brand = { ...brand, context: 'B'.repeat(60_000) };
    const heavyWork: Work = { ...work, brief: 'C'.repeat(6_000) };
    const bundle = renderInstructionBundle({
      brand: heavy,
      work: heavyWork,
      decisions,
      pack,
      documents: Array.from({ length: 5 }, (_, i) => ({ kind: 'copy', title: `Pieza ${i}`, fileName: `pieza-${i}.md`, status: 'draft' })),
      team: [{ roleId: 'strategist', roleName: 'Strategist', status: 'open' }],
      available: (pack?.roles ?? []).map((r) => ({ id: r.id, name: r.name, summary: r.summary })),
      skills: writingSkill ? [writingSkill] : [],
    });
    expect(pack).toBeTruthy();
    expect(bundle.text).toContain(pack!.body.trim());
    expect(bundle.text).toContain('C'.repeat(6_000));
    expect(bundle.text).toContain('## Working rules');
    expect(bundle.text).toContain('The team on this work');
    expect(bundle.text).toContain('Roles that could be called in');
  });

  it('renders a realistic heavy fixture, compacts it and appends a footer with working pointers', () => {
    const decisions = Array.from({ length: 40 }, (_, i) => decision(i, i));
    const heavy: Brand = { ...brand, context: 'D'.repeat(15_000) };
    const bundle = renderInstructionBundle({
      brand: heavy,
      work,
      decisions,
      pack,
      skills: writingSkill ? [writingSkill] : [],
      team: [{ roleId: 'strategist', roleName: 'Strategist', status: 'open' }],
      available: (pack?.roles ?? []).map((r) => ({ id: r.id, name: r.name, summary: r.summary })),
    });
    expect(bundle.text).toContain('This file was compacted');
    expect(bundle.text).toMatch(/the full decision log in \.\/\.latte\/context\/decisions\.md/);
    expect(bundle.text).toMatch(/the full brand context in \.\/\.latte\/context\/brand\.md/);
    // Compacted, not merely capped by luck: comfortably below the unbounded size
    // this fixture would have produced (brand + every decision + the skill body inlined).
    expect(bundle.text.length).toBeLessThan(heavy.context.length + decisions.length * 60);
    // The cap is a target, not an absolute: a short footer may push it slightly over,
    // but never by much once decisions and brand context are both at their floor.
    expect(bundle.text.length).toBeLessThan(INSTRUCTIONS_MAX_CHARS + 500);
  });
});

describe('renderInstructions', () => {
  it('is the text half of renderInstructionBundle', () => {
    const input = { brand, work, decisions: [decision(0, 0)] };
    expect(renderInstructions(input)).toBe(renderInstructionBundle(input).text);
  });
});

describe('WorkspaceFiles.writeInstructions: side files', () => {
  let dir: string;
  afterEach(() => removeDir(dir));

  it('writes side files next to CLAUDE.md/AGENTS.md and cleans up ones that no longer apply', () => {
    dir = makeTempDir();
    const files = new WorkspaceFiles(new LattePaths(dir));
    files.ensureWork(brand.id, work.id, work.brief);
    const workDir = files.workDir(brand.id, work.id);

    const bundle = renderInstructionBundle({ brand: { ...brand, context: 'E'.repeat(BRAND_CONTEXT_CHARS + 100) }, work, decisions: [], skills: writingSkill ? [writingSkill] : [] });
    files.writeInstructions(brand.id, work.id, bundle.text, bundle.files);

    const brandSide = path.join(workDir, '.latte', 'context', 'brand.md');
    const skillSide = path.join(workDir, '.latte', 'skills', 'writing.md');
    expect(fs.readFileSync(brandSide, 'utf8')).toContain('E'.repeat(BRAND_CONTEXT_CHARS + 100));
    expect(fs.existsSync(skillSide)).toBe(true);
    expect(fs.readFileSync(path.join(workDir, 'CLAUDE.md'), 'utf8')).toBe(bundle.text);

    // Brand context back under the ceiling and the skill turned off: both side
    // files should disappear, not linger as stale leftovers.
    const clean = renderInstructionBundle({ brand, work, decisions: [] });
    files.writeInstructions(brand.id, work.id, clean.text, clean.files);
    expect(fs.existsSync(brandSide)).toBe(false);
    expect(fs.existsSync(skillSide)).toBe(false);
  });

  it('still syncs side files even when CLAUDE.md itself is user-owned and skipped', () => {
    dir = makeTempDir();
    const files = new WorkspaceFiles(new LattePaths(dir));
    files.ensureWork(brand.id, work.id, work.brief);
    const workDir = files.workDir(brand.id, work.id);
    fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), '# Not managed by Latte\n');

    const bundle = renderInstructionBundle({ brand: { ...brand, context: 'F'.repeat(BRAND_CONTEXT_CHARS + 100) }, work, decisions: [] });
    const result = files.writeInstructions(brand.id, work.id, bundle.text, bundle.files);
    expect(result.skipped).toContain('CLAUDE.md');
    expect(fs.readFileSync(path.join(workDir, '.latte', 'context', 'brand.md'), 'utf8')).toContain('F'.repeat(BRAND_CONTEXT_CHARS + 100));
  });
});

describe('renderInstructionBundle: pinned generation pointer', () => {
  const hash = 'ab'.repeat(32);
  const pointer = {
    generationId: 'gen_eeeeeeeeeeeeeeeeeeee',
    contextHash: hash,
    kitHash: hash,
    skillRefs: [{ skillId: 'learned-report', version: 1, hash }],
  };

  it('adds a compact kit-hash + skill-ref pointer and never inlines a learned body', () => {
    const bundle = renderInstructionBundle({ brand, work, decisions: [], generation: pointer });
    expect(bundle.text).toContain('Pinned generation context');
    expect(bundle.text).toContain(pointer.generationId);
    expect(bundle.text).toContain('learned-report@1');
    expect(bundle.text).toContain(`.latte/generations/${pointer.generationId}/context.json`);
    expect(bundle.files.some((f) => f.path.includes('learned-report'))).toBe(false);
  });

  it('drops learned refs when they would blow the budget, and never silences a shipped skill to make room', () => {
    expect(writingSkill).not.toBeNull();
    const learned = Array.from({ length: 400 }, (_, i) => ({
      skillId: `learned-${String(i).padStart(3, '0')}`,
      version: 1,
      hash,
    }));
    const bundle = renderInstructionBundle({
      brand: { ...brand, context: 'B'.repeat(BRAND_CONTEXT_CHARS) },
      work: { ...work, brief: 'C'.repeat(6_000) },
      decisions: [],
      skills: writingSkill ? [writingSkill] : [],
      generation: { ...pointer, skillRefs: learned },
    });
    expect(bundle.text).toContain('<!-- latte:skill writing -->');
    expect(bundle.files.some((f) => f.path.endsWith('writing.md'))).toBe(true);
    expect(bundle.text).toMatch(/Learned skills were omitted/);
    expect(bundle.text).not.toContain('learned-000@1');
    expect(bundle.text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS + 400);
  });
});
