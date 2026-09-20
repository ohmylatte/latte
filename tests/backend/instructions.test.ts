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

const brand: Brand = { id: 'brd_1', name: 'Bruma Café', context: 'Tono directo, sin muletillas.', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null };
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
    expect(bundle.text).toMatch(/the full decision log of this work in \.\/\.latte\/context\/decisions\.md/);
    expect(bundle.text).toMatch(/the full brand context in \.\/\.latte\/context\/brand\.md/);
    // Compacted, not merely capped by luck: comfortably below the unbounded size
    // this fixture would have produced (brand + every decision + the skill body inlined).
    // The protocol stays available under compaction; inherited brand memory adds a bounded summary on 0.5+.
    expect(bundle.text.length).toBeLessThan(heavy.context.length + decisions.length * 60 + 600);
    // The cap is a target, not an absolute: a short footer may push it slightly over,
    // but never by much once decisions and brand context are both at their floor.
    expect(bundle.text.length).toBeLessThan(INSTRUCTIONS_MAX_CHARS + 500);
  });
});

describe('renderInstructionBundle: brand context protocol', () => {
  it('tells every role to draft the context when it is empty', () => {
    const empty: Brand = { ...brand, context: '' };
    const bundle = renderInstructionBundle({ brand: empty, work, decisions: [], decisionAuthority: 'suggest' });
    expect(bundle.text).toContain('Before starting any other work, draft this brand\'s context from the brief and propose it with the `latte-brand-context` block.');
    expect(bundle.text).toContain('fenced `latte-brand-context` JSON block');
    expect(bundle.text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });

  it('does not include the empty-context draft instruction when context exists', () => {
    const bundle = renderInstructionBundle({ brand, work, decisions: [], decisionAuthority: 'suggest' });
    expect(bundle.text).not.toContain('Before starting any other work, draft this brand\'s context');
    expect(bundle.text).toContain('Propose a brand-context update only when you have new durable facts');
    expect(bundle.text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });

  it('omits the empty-context nudge when authority is off', () => {
    const empty: Brand = { ...brand, context: '' };
    const off = renderInstructionBundle({ brand: empty, work, decisions: [], decisionAuthority: 'off' });
    expect(off.text).not.toContain('Before starting any other work, draft this brand\'s context');
    expect(off.text).not.toContain('Propose a brand-context update only when you have new durable facts');
    expect(off.text).toContain('Do not emit brand-context protocol blocks');
    const on = renderInstructionBundle({ brand: empty, work, decisions: [], decisionAuthority: 'suggest' });
    expect(on.text).toContain('Before starting any other work, draft this brand\'s context from the brief and propose it with the `latte-brand-context` block.');
  });

  it('keeps the durable-facts line when decision squeeze already fits', () => {
    const decisions = Array.from({ length: 16 }, (_, i) => decision(i, i));
    const medium: Brand = { ...brand, context: 'E'.repeat(8_000) };
    const first = renderInstructionBundle({
      brand: medium,
      work,
      decisions,
      pack,
      skills: writingSkill ? [writingSkill] : [],
      team: [{ roleId: 'strategist', roleName: 'Strategist', status: 'open' }],
      available: (pack?.roles ?? []).map((r) => ({ id: r.id, name: r.name, summary: r.summary })),
    });
    expect(first.text).toContain('This file was compacted');
    expect(first.text).toContain('Propose a brand-context update only when you have new durable facts');
  });
});

describe('renderInstructionBundle: brand context nudge policy', () => {
  const empty: Brand = { ...brand, context: '' };
  const FULL = 'Before starting any other work, draft this brand\'s context from the brief and propose it with the `latte-brand-context` block.';
  const SHORT = 'Draft this brand\'s context from the brief and propose it with the `latte-brand-context` block.';
  const PENDING = 'The brand context is empty. A proposal is already waiting for the human to review: do not ask for positioning, tone or audience, and do not draft or propose it here.';
  const INHERITED = 'The brand context is empty. Brand knowledge from previous work is inherited below: use it and do not draft or propose a new context here.';
  const OWNER_ELSEWHERE = 'The brand context is empty. Another work of this brand is drafting it: do not draft or propose it here.';

  it('defaults to the full nudge for an empty brand and to none when context exists', () => {
    expect(renderInstructionBundle({ brand: empty, work, decisions: [] }).text).toContain(FULL);
    const defined = renderInstructionBundle({ brand, work, decisions: [] }).text;
    expect(defined).not.toContain(FULL);
    expect(defined).toContain('Propose a brand-context update only when you have new durable facts');
  });

  it('emits one precise line per reason and never the draft nudge', () => {
    const pending = renderInstructionBundle({ brand: empty, work, decisions: [], brandContextNudge: { form: 'none', reason: 'pending' } }).text;
    expect(pending).toContain(PENDING);
    expect(pending).not.toContain(FULL);
    expect(pending).not.toContain(SHORT);

    const inherited = renderInstructionBundle({ brand: empty, work, decisions: [], brandContextNudge: { form: 'none', reason: 'inherited' } }).text;
    expect(inherited).toContain(INHERITED);
    expect(inherited).not.toContain(FULL);

    const elsewhere = renderInstructionBundle({ brand: empty, work, decisions: [], brandContextNudge: { form: 'none', reason: 'owner-elsewhere' } }).text;
    expect(elsewhere).toContain(OWNER_ELSEWHERE);
    expect(elsewhere).not.toContain(FULL);
  });

  it('emits the short form when the policy asks for it', () => {
    const short = renderInstructionBundle({ brand: empty, work, decisions: [], brandContextNudge: { form: 'short', reason: null } }).text;
    expect(short).toContain(SHORT);
    expect(short).not.toContain(FULL);
  });

  it('never resurrects none when the size squeeze runs', () => {
    const heavyWork: Work = { ...work, brief: 'C'.repeat(6_000) };
    const documents = Array.from({ length: 300 }, (_, i) => ({ kind: 'copy', title: `Pieza ${i}`, fileName: `pieza-${i}.md`, status: 'draft' }));
    const bundle = renderInstructionBundle({
      brand: empty,
      work: heavyWork,
      decisions: Array.from({ length: 40 }, (_, i) => decision(i, i)),
      pack,
      documents,
      brandContextNudge: { form: 'none', reason: 'pending' },
    });
    expect(bundle.text).toContain(PENDING);
    expect(bundle.text).not.toContain(FULL);
    expect(bundle.text).not.toContain(SHORT);
  });

  it('downgrades full to short when the size squeeze runs', () => {
    const heavyWork: Work = { ...work, brief: 'C'.repeat(6_000) };
    const documents = Array.from({ length: 300 }, (_, i) => ({ kind: 'copy', title: `Pieza ${i}`, fileName: `pieza-${i}.md`, status: 'draft' }));
    const bundle = renderInstructionBundle({
      brand: empty,
      work: heavyWork,
      decisions: Array.from({ length: 40 }, (_, i) => decision(i, i)),
      pack,
      documents,
      brandContextNudge: { form: 'full', reason: null },
    });
    expect(bundle.text).toContain(SHORT);
    expect(bundle.text).not.toContain(FULL);
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

  it('reports byte-identical files as unchanged and writes nothing for them', () => {
    dir = makeTempDir();
    const files = new WorkspaceFiles(new LattePaths(dir));
    files.ensureWork(brand.id, work.id, work.brief);
    const bundle = renderInstructionBundle({ brand, work, decisions: [] });

    const first = files.writeInstructions(brand.id, work.id, bundle.text, bundle.files);
    expect(first.written.sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(first.unchanged).toEqual([]);
    expect(first.skipped).toEqual([]);

    const second = files.writeInstructions(brand.id, work.id, bundle.text, bundle.files);
    expect(second.written).toEqual([]);
    expect(second.unchanged.sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(second.sideFilesChanged).toBe(false);
  });

  it('flags sideFilesChanged when a side file is created or removed', () => {
    dir = makeTempDir();
    const files = new WorkspaceFiles(new LattePaths(dir));
    files.ensureWork(brand.id, work.id, work.brief);

    const long = renderInstructionBundle({ brand: { ...brand, context: 'E'.repeat(BRAND_CONTEXT_CHARS + 100) }, work, decisions: [] });
    const created = files.writeInstructions(brand.id, work.id, long.text, long.files);
    expect(created.sideFilesChanged).toBe(true);

    const clean = renderInstructionBundle({ brand, work, decisions: [] });
    const removed = files.writeInstructions(brand.id, work.id, clean.text, clean.files);
    expect(removed.sideFilesChanged).toBe(true);

    const again = files.writeInstructions(brand.id, work.id, clean.text, clean.files);
    expect(again.sideFilesChanged).toBe(false);
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

// --- task 6.27: the memory instruction follows the tools ------------------------------
//
// Once engram ships BY DEFAULT (design-v2-conversational D3), the old
// conditional wording ("if you have Engram tools, always pass project X") is
// wrong twice over on an injected member: the conditional no longer applies,
// and telling the agent to pass a project invites it to pass a DIFFERENT one
// (spike 6.26 proved a tool-supplied `project` argument wins over the
// server's pinned `--project`/`ENGRAM_PROJECT`).
describe('renderInstructionBundle: the memory instruction follows the tools (task 6.27)', () => {
  const OLD_CONDITIONAL = /if you have Engram tools, always pass project/i;

  it('memoryToolsInjected:true — the injected wording, scoped-and-fixed, plus the explicit never-pass-project clause (spike 6.26: a tool argument wins)', () => {
    const bundle = renderInstructionBundle({ brand, work, decisions: [], memoryProject: 'latte-brd_1', memoryToolsInjected: true });
    expect(bundle.text).toContain('you have Engram tools, already scoped to this brand');
    expect(bundle.text).toContain('Save and search without passing a project');
    expect(bundle.text).toMatch(/never pass a `project` argument/i);
    expect(bundle.text).not.toMatch(OLD_CONDITIONAL);
  });

  it('memoryToolsInjected:false (OpenCode, or engram missing) — the EXISTING conditional line stays verbatim', () => {
    const bundle = renderInstructionBundle({ brand, work, decisions: [], memoryProject: 'latte-brd_1', memoryToolsInjected: false });
    expect(bundle.text).toMatch(OLD_CONDITIONAL);
    expect(bundle.text).toContain('Never rely on auto-detected project names; other brands must not see this brand\'s memories.');
    expect(bundle.text).not.toContain('already scoped to this brand');
  });

  it('memoryToolsInjected omitted defaults to the existing (non-injected) wording — no behavior change for a caller that does not pass it yet', () => {
    const bundle = renderInstructionBundle({ brand, work, decisions: [], memoryProject: 'latte-brd_1' });
    expect(bundle.text).toMatch(OLD_CONDITIONAL);
  });

  it('no memoryProject at all — no memory instruction of either form (unchanged)', () => {
    const bundle = renderInstructionBundle({ brand, work, decisions: [], memoryToolsInjected: true });
    expect(bundle.text).not.toContain('Engram tools');
    expect(bundle.text).not.toMatch(/never pass a `project` argument/i);
  });

  it('the old conditional wording NEVER appears on an injected member — it is wrong twice over there', () => {
    const bundle = renderInstructionBundle({ brand, work, decisions: [], memoryProject: 'latte-brd_9', memoryToolsInjected: true });
    expect(bundle.text).not.toMatch(OLD_CONDITIONAL);
  });
});
