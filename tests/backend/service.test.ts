import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend } from '../../electron/bootstrap';
import { MANAGED_MARKER, renderInstructions } from '../../electron/workspace/instructions';
import { fakeRunner, makeBackend, type TestBackend } from './helpers';
import type { OnboardingDraft } from '../../shared/contracts';

function workDirOf(b: TestBackend, brandId: string, workId: string): string {
  return path.join(b.dir, 'brands', brandId, 'works', workId);
}

describe('LatteService persistence flow', () => {
  let b: TestBackend;

  beforeEach(async () => {
    b = await makeBackend();
  });

  afterEach(() => b.cleanup());

  it('persists UI and content locales independently and pins new work output language', async () => {
    expect(await b.service.getUiLocale()).toBe('es-AR');
    await b.service.setUiLocale('en-US');
    await b.service.setContentLocale('en-US');
    expect(await b.service.getUiLocale()).toBe('en-US');
    expect(await b.service.getContentLocale()).toBe('en-US');
    const brand = await b.service.createBrand('Example');
    const work = await b.service.createWork(brand.id, 'Launch');
    expect(fs.readFileSync(path.join(workDirOf(b, brand.id, work.id), 'AGENTS.md'), 'utf8')).toContain('English (United States)');
    await b.service.setContentLocale('es-AR');
    await b.service.updateBrand(brand.id, 'Changed');
    expect(fs.readFileSync(path.join(workDirOf(b, brand.id, work.id), 'AGENTS.md'), 'utf8')).toContain('English (United States)');
  });

  it('persists the onboarding-complete flag in meta and validates its type', async () => {
    expect(await b.service.getOnboardingComplete()).toBe(false);
    expect(await b.service.setOnboardingComplete(true)).toBe(true);
    expect(await b.service.getOnboardingComplete()).toBe(true);
    await b.service.setOnboardingComplete(false);
    expect(await b.service.getOnboardingComplete()).toBe(false);
    await expect(b.service.setOnboardingComplete('yes' as never)).rejects.toThrow(/onboarding/i);
  });

  it('round-trips the onboarding draft and clears it when the terminal flag flips', async () => {
    expect(await b.service.getOnboardingDraft()).toBeNull();
    const draft: OnboardingDraft = {
      step: 'brand',
      workTypeId: 'campaign-new',
      answers: { objetivo: 'Vender', canales: ['instagram', 'email'] },
      assumptions: ['Sigo sin audiencia definida; la confirmamos después.'],
      brandId: null,
      usedDemo: false,
      linkFolderRequested: true,
      recommendedRoleId: 'strategist',
      brief: '## Objetivo\n\nVender\n',
    };
    await b.service.setOnboardingDraft(draft);
    expect(await b.service.getOnboardingDraft()).toEqual(draft);

    // Completing (terminal flag set) clears the draft so a later replay starts fresh.
    await b.service.setOnboardingComplete(true);
    expect(await b.service.getOnboardingDraft()).toBeNull();
  });

  it('rejects a malformed onboarding draft and returns null for corrupt storage', async () => {
    await expect(b.service.setOnboardingDraft({ step: 'nope' } as never)).rejects.toThrow(/onboarding draft/i);
    await expect(b.service.setOnboardingDraft('garbage' as never)).rejects.toThrow(/onboarding draft/i);
    // A corrupt value already in storage must not break the reader.
    b.repo.setMeta('onboarding_draft', '{not json');
    expect(await b.service.getOnboardingDraft()).toBeNull();
    // A valid JSON blob that is not a draft is also refused.
    b.repo.setMeta('onboarding_draft', JSON.stringify({ step: 'intent' }));
    expect(await b.service.getOnboardingDraft()).toBeNull();
  });

  it('reports the running app version through appInfo', async () => {
    // A dedicated backend with its own version, so the assertion is not
    // coupled to the shared fixture's default.
    const versioned = await makeBackend({ version: '9.9.9-test' });
    try {
      expect((await versioned.service.appInfo()).version).toBe('9.9.9-test');
    } finally {
      versioned.cleanup();
    }
  });

  it('creates brand, work, document, snapshots and decisions on real disk', async () => {
    const brand = await b.service.createBrand('  Casa   Prueba ');
    expect(brand.name).toBe('Casa Prueba');
    expect(fs.existsSync(path.join(b.dir, 'brands', brand.id))).toBe(true);

    const updated = await b.service.updateBrand(brand.id, 'Tono cálido.');
    expect(updated.context).toBe('Tono cálido.');

    const work = await b.service.createWork(brand.id, 'Campaña otoño');
    const workDir = workDirOf(b, brand.id, work.id);
    expect(work.brief).toBe('# Campaña otoño\n\n');
    expect(fs.readFileSync(path.join(workDir, 'brief.md'), 'utf8')).toBe('# Campaña otoño\n\n');
    expect(fs.readFileSync(path.join(workDir, 'CLAUDE.md'), 'utf8')).toContain('Tono cálido.');

    // The UI "brief" is the editable deliverable: saving it writes brief.md.
    const saved = await b.service.saveBrief(work.id, '# Plan\n\nContenido v1');
    expect(saved.status).toBe('saved');
    expect(saved.status === 'saved' && saved.work.brief).toBe('# Plan\n\nContenido v1');
    expect(fs.readFileSync(path.join(workDir, 'brief.md'), 'utf8')).toBe('# Plan\n\nContenido v1');

    const rev1 = await b.service.snapshot(work.id);
    expect(rev1.content).toBe('# Plan\n\nContenido v1');
    const snapshots = fs.readdirSync(path.join(workDir, '.latte', 'snapshots'));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain(rev1.id);
    const snapFile = path.join(workDir, '.latte', 'snapshots', snapshots[0]);
    expect(fs.statSync(snapFile).mode & 0o222).toBe(0);

    await b.service.saveBrief(work.id, '# Plan\n\nContenido v2');
    const rev2 = await b.service.snapshot(work.id);
    const revisions = await b.service.listRevisions(work.id);
    // Newest first, matching the UI numbering.
    expect(revisions.map((r) => r.id)).toEqual([rev2.id, rev1.id]);
    expect(revisions[0].content).toBe('# Plan\n\nContenido v2');
    expect(revisions[1].content).toBe('# Plan\n\nContenido v1');

    const decision = await b.service.addDecision(work.id, 'Sin descuentos el primer mes.');
    expect((await b.service.listDecisions(work.id)).map((d) => d.id)).toEqual([decision.id]);
    // Instruction files only change when a NEW session starts, never under a running one.
    const claude = fs.readFileSync(path.join(workDir, 'CLAUDE.md'), 'utf8');
    expect(claude.startsWith(MANAGED_MARKER)).toBe(true);
    expect(claude).not.toContain('Sin descuentos el primer mes.');
    expect(claude).toContain('Latte · Marketing core');

    const works = await b.service.listWorks(brand.id);
    expect(works[0].brief).toBe('# Plan\n\nContenido v2');
  });

  it('picks up agent edits made directly to deliverable.md', async () => {
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    const file = path.join(workDirOf(b, brand.id, work.id), 'brief.md');

    // An agent (or any editor) rewrites the file outside the app.
    fs.writeFileSync(file, '# Escrito por el agente\n');
    const [refreshed] = await b.service.listWorks(brand.id);
    expect(refreshed.brief).toBe('# Escrito por el agente\n');

    const revision = await b.service.snapshot(work.id);
    expect(revision.content).toBe('# Escrito por el agente\n');
  });

  it('regenerates instructions for new sessions but keeps a user-owned AGENTS.md untouched', async () => {
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    const agents = path.join(workDirOf(b, brand.id, work.id), 'AGENTS.md');
    fs.writeFileSync(agents, '# Mine\n');
    await b.service.updateBrand(brand.id, 'Contexto nuevo');
    await b.service.addDecision(work.id, 'Algo importante');
    // Same rendering startAgent performs right before spawning (the spawn itself needs a CLI).
    b.files.writeInstructions(brand.id, work.id, renderInstructions({
      brand: (await b.service.listBrands())[0],
      work: (await b.service.listWorks(brand.id))[0],
      decisions: await b.service.listDecisions(work.id),
      pack: null,
    }));
    expect(fs.readFileSync(agents, 'utf8')).toBe('# Mine\n');
    const claude = fs.readFileSync(path.join(path.dirname(agents), 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('Algo importante');
    expect(claude).toContain('Contexto nuevo');
  });

  it('survives a restart with the same data directory', async () => {
    const brand = await b.service.createBrand('Persistente');
    const work = await b.service.createWork(brand.id, 'Obra');
    await b.service.saveBrief(work.id, 'contenido');
    await b.service.snapshot(work.id);
    b.service.shutdown();

    const again = await createBackend({
      dataDir: b.dir,
      version: '0.0.0-test',
      emit: () => {},
      chooseExportPath: async () => null,
      seedDemo: false,
    });
    try {
      expect((await again.service.listBrands()).map((x) => x.name)).toEqual(['Persistente']);
      expect((await again.service.listWorks(brand.id))[0].brief).toBe('contenido');
      expect(await again.service.listRevisions(work.id)).toHaveLength(1);
    } finally {
      again.service.shutdown();
    }
  });

  it('exports the current document through the chooser and honours cancel', async () => {
    let suggested = '';
    const chosen = path.join(b.dir, 'export', 'out.md');
    const withChooser = await makeBackend({
      chooseExportPath: async (name) => {
        suggested = name;
        return chosen;
      },
    });
    try {
      const brand = await withChooser.service.createBrand('Marca');
      const work = await withChooser.service.createWork(brand.id, 'Título con acento é');
      await withChooser.service.saveBrief(work.id, '# Export me');
      const result = await withChooser.service.exportWork(work.id);
      expect(suggested).toBe('titulo-con-acento-e.md');
      expect(result).toBe(chosen);
      expect(fs.readFileSync(chosen, 'utf8')).toBe('# Export me');
    } finally {
      withChooser.cleanup();
    }

    const cancelBackend = await makeBackend({ chooseExportPath: async () => null });
    try {
      const b2 = await cancelBackend.service.createBrand('X');
      const w2 = await cancelBackend.service.createWork(b2.id, 'Y');
      expect(await cancelBackend.service.exportWork(w2.id)).toBeNull();
    } finally {
      cancelBackend.cleanup();
    }
  });

  it('exports an intentionally blank document as blank (never older content)', async () => {
    const target = path.join(b.dir, 'blank.md');
    const withChooser = await makeBackend({ chooseExportPath: async () => target });
    try {
      const brand = await withChooser.service.createBrand('Marca');
      const work = await withChooser.service.createWork(brand.id, 'Obra');
      await withChooser.service.saveBrief(work.id, 'snapshot content');
      await withChooser.service.snapshot(work.id);
      await withChooser.service.saveBrief(work.id, '');
      await withChooser.service.exportWork(work.id);
      expect(fs.readFileSync(target, 'utf8')).toBe('');
    } finally {
      withChooser.cleanup();
    }
  });
});

describe('LatteService validation', () => {
  let b: TestBackend;
  beforeEach(async () => { b = await makeBackend(); });
  afterEach(() => b.cleanup());

  it('rejects empty or oversized labels', async () => {
    await expect(b.service.createBrand('   ')).rejects.toThrow(/cannot be empty/);
    await expect(b.service.createBrand('x'.repeat(121))).rejects.toThrow(/too long/);
    const brand = await b.service.createBrand('Ok');
    // Labels are single-line: internal whitespace (including newlines) collapses.
    expect((await b.service.createWork(brand.id, 'multi\n  line')).title).toBe('multi line');
    await expect(b.service.createWork(brand.id, '\n\t ')).rejects.toThrow(/cannot be empty/);
  });

  it('rejects ids that are not app-generated shapes', async () => {
    await expect(b.service.listWorks('../../etc')).rejects.toThrow(/Invalid brandId/);
    await expect(b.service.snapshot('C:\\evil')).rejects.toThrow(/Invalid workId/);
    await expect(b.service.saveBrief('wrk_missing', 'x')).rejects.toThrow(/Work not found/);
    await expect(b.service.addDecision('wrk_x', '')).rejects.toThrow(/cannot be empty/);
    await expect(b.service.resizeAgent('ses_x', 1.5, 10)).rejects.toThrow(/must be an integer/);
  });

  it('rejects unknown providers before touching the terminal', async () => {
    const brand = await b.service.createBrand('Ok');
    const work = await b.service.createWork(brand.id, 'W');
    await expect(b.service.startAgent(work.id, 'bash' as never)).rejects.toThrow(/Unknown provider/);
  });

  it('reports the terminal backend honestly when node-pty is unavailable', async () => {
    const brand = await b.service.createBrand('Ok');
    const work = await b.service.createWork(brand.id, 'W');
    // notFoundRunner: no CLI on PATH -> clear message, no fake session.
    await expect(b.service.startAgent(work.id, 'claude')).rejects.toThrow(/not installed or not on PATH/);
    const status = await b.service.runtimeStatus();
    expect(status.every((s) => s.available === false)).toBe(true);
    expect(b.events).toEqual([]);
  });

  it('never writes outside the data directory', async () => {
    const brand = await b.service.createBrand('Ok');
    const work = await b.service.createWork(brand.id, 'W');
    await b.service.saveBrief(work.id, 'x');
    const walk = (p: string): string[] =>
      fs.readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]));
    for (const file of walk(b.dir)) {
      expect(path.relative(b.dir, file).startsWith('..')).toBe(false);
    }
  });
});

describe('LatteService memory (Engram)', () => {
  it('reports unavailable when the engram binary is missing', async () => {
    const b = await makeBackend();
    try {
      const brand = await b.service.createBrand('Marca');
      const result = await b.service.readMemory(brand.id);
      expect(result.available).toBe(false);
      expect(result.text).toMatch(/not found/);
    } finally {
      b.cleanup();
    }
  });

  it('scopes reads and saves to one project per brand and strips the banner', async () => {
    const runner = fakeRunner((file, args) => {
      if (file === 'where.exe') return { code: 0, stdout: 'C:\\tools\\engram.exe\n' };
      if (file === 'which') return { code: 0, stdout: '/usr/bin/engram\n' };
      if (args[0] === 'context') {
        return { code: 0, stdout: 'Update available: 1.11.0 -> 1.20.0\nTo update:\n  go install x\n\n## Memory\n- [decision] Something\n' };
      }
      if (args[0] === 'save') return { code: 0, stdout: 'Update available: 1\nMemory saved: #1 "t" (decision)\n' };
      return { code: 1 };
    });
    const b = await makeBackend({ runner });
    try {
      const brand = await b.service.createBrand('Casa Oliva');
      const read = await b.service.readMemory(brand.id);
      expect(read).toEqual({ available: true, text: '## Memory\n- [decision] Something' });
      const contextCall = runner.calls.find((c) => c.args[0] === 'context');
      expect(contextCall?.args[1]).toBe(`latte-${brand.id}`);

      const saved = await b.service.saveMemory(brand.id, 'Primera línea\nDetalle');
      expect(saved).toEqual({ available: true, text: 'Memory saved: #1 "t" (decision)' });
      const saveCall = runner.calls.find((c) => c.args[0] === 'save');
      expect(saveCall?.args).toEqual([
        'save', 'Casa Oliva: Primera línea', 'Primera línea\nDetalle', '--type', 'decision',
        '--project', `latte-${brand.id}`, '--scope', 'project',
      ]);
      expect(saveCall?.timeoutMs).toBeLessThanOrEqual(10_000);
    } finally {
      b.cleanup();
    }
  });

  it('degrades gracefully on timeout and non-zero exit', async () => {
    const runner = fakeRunner((file, args) => {
      if (file === 'where.exe' || file === 'which') return { code: 0, stdout: '/usr/local/bin/engram\n' };
      if (args[0] === 'context') return { code: null, timedOut: true };
      return { code: 2, stderr: 'database locked' };
    });
    const b = await makeBackend({ runner });
    try {
      const brand = await b.service.createBrand('Marca');
      const read = await b.service.readMemory(brand.id);
      expect(read.available).toBe(false);
      expect(read.text).toMatch(/did not answer/);
      const saved = await b.service.saveMemory(brand.id, 'nota');
      expect(saved.available).toBe(false);
      expect(saved.text).toMatch(/code 2.*database locked/);
    } finally {
      b.cleanup();
    }
  });
});
