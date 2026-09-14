import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Brand, Work } from '../../shared/contracts';
import { createBackend } from '../../electron/bootstrap';
import { openDriver, type DriverPreference } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { DELIVERABLES_DIR } from '../../electron/workspace/deliverables';
import { renderInstructions, renderOutcomeContext, requestedFormats, showsCurrentOutcome } from '../../electron/workspace/instructions';
import { fakeRunner, makeBackend, makeTempDir, removeDir, type TestBackend } from './helpers';
import { startFakeOpenCode, type FakeOpenCode } from './fakeOpenCode';

function writeDeliverable(b: TestBackend, work: Work, name: string, content = 'bytes'): string {
  const dir = path.join(b.files.workDir(work.brandId, work.id), DELIVERABLES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('Work outcome: expected output and linked result', () => {
  let b: TestBackend;
  beforeEach(async () => { b = await makeBackend(); });
  afterEach(() => b.cleanup());

  it('starts undefined, so a work behaves exactly as before', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    expect(work.expectedOutput ?? null).toBeNull();
    expect(work.resultPath ?? null).toBeNull();
    expect((await b.service.listWorks(brand.id))[0]).toMatchObject({ expectedOutput: null, resultPath: null });
  });

  it('keeps the expected output apart from the brief, which stays the goal', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    const updated = await b.service.updateWork(work.id, { expectedOutput: '  Un PDF de dos páginas con la propuesta.  ' });
    expect(updated.expectedOutput).toBe('Un PDF de dos páginas con la propuesta.');
    expect(updated.brief).toBe(work.brief);
    expect(fs.readFileSync(path.join(b.files.workDir(brand.id, work.id), 'brief.md'), 'utf8')).toBe(work.brief);
    // Omitted means unchanged; blank means cleared.
    expect((await b.service.updateWork(work.id, {})).expectedOutput).toBe('Un PDF de dos páginas con la propuesta.');
    expect((await b.service.updateWork(work.id, { expectedOutput: '   ' })).expectedOutput).toBeNull();
  });

  it('links only a file that is in Deliverables right now', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    writeDeliverable(b, work, 'propuesta.pdf');

    expect((await b.service.updateWork(work.id, { resultPath: 'propuesta.pdf' })).resultPath).toBe('propuesta.pdf');
    await expect(b.service.updateWork(work.id, { resultPath: 'no-existe.pdf' })).rejects.toThrow(/no está en entregables/);
    // Deliverables is the only list: nothing outside it, nothing that escapes it.
    await expect(b.service.updateWork(work.id, { resultPath: '../brief.md' })).rejects.toThrow(/inválido/);
    await expect(b.service.updateWork(work.id, { resultPath: 'instalador.exe' })).rejects.toThrow(/no permitido/);
    // Falsy is not "clear": only null or '' are. The browser preview answers the same.
    for (const bad of [false, 0]) await expect(b.service.updateWork(work.id, { resultPath: bad } as never)).rejects.toThrow(/inválido/);
    // A refused link leaves the previous one in place.
    expect((await b.service.listWorks(brand.id))[0].resultPath).toBe('propuesta.pdf');
    expect((await b.service.updateWork(work.id, { resultPath: null })).resultPath).toBeNull();
  });

  it('never stores whether the linked file still exists', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    const file = writeDeliverable(b, work, 'propuesta.pdf');
    await b.service.updateWork(work.id, { expectedOutput: 'Propuesta en PDF', resultPath: 'propuesta.pdf' });
    fs.rmSync(file);
    const [listed] = await b.service.listWorks(brand.id);
    // The pointer stays; its absence is read from the folder, not kept as a state.
    expect(listed.resultPath).toBe('propuesta.pdf');
    expect(Object.keys(listed).sort()).toEqual(['brandId', 'brief', 'expectedOutput', 'folder', 'id', 'resultPath', 'title', 'updatedAt']);
    expect((await b.service.listDeliverables(work.id)).files).toEqual([]);
    // Saving the expected output alone does not re-validate an untouched link.
    expect((await b.service.updateWork(work.id, { expectedOutput: 'Propuesta en PDF, v2' })).resultPath).toBe('propuesta.pdf');
  });

  it('changes only the outcome: brief, title and folder have their own paths', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    await expect(b.service.updateWork(work.id, { brief: '# otro' } as never)).rejects.toThrow(/Only the expected output/);
    await expect(b.service.updateWork(work.id, { title: 'Otro' } as never)).rejects.toThrow(/Only the expected output/);
    await expect(b.service.updateWork(work.id, null as never)).rejects.toThrow(/Invalid work patch/);
    await expect(b.service.updateWork(work.id, { expectedOutput: 'x'.repeat(2_001) })).rejects.toThrow(/too long/);
    await expect(b.service.updateWork('wrk_nope', { expectedOutput: 'x' })).rejects.toThrow();
  });

  it('survives a restart', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    writeDeliverable(b, work, 'propuesta.pdf');
    await b.service.updateWork(work.id, { expectedOutput: 'Propuesta en PDF', resultPath: 'propuesta.pdf' });
    b.service.shutdown();

    const again = await createBackend({ dataDir: b.dir, version: '0.0.0-test', emit: () => {}, chooseExportPath: async () => null, seedDemo: false });
    try {
      expect((await again.service.listWorks(brand.id))[0]).toMatchObject({ expectedOutput: 'Propuesta en PDF', resultPath: 'propuesta.pdf' });
    } finally {
      again.service.shutdown();
    }
  });
});

describe('Expected output in the agent context', () => {
  let fake: FakeOpenCode;
  let b: TestBackend;

  beforeEach(async () => {
    fake = await startFakeOpenCode();
    b = await makeBackend({
      chatEndpoint: fake.endpoint,
      runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which') && args[0] === 'opencode' ? { code: 0, stdout: 'C:\\npm\\opencode.exe\n' } : { code: 0, stdout: '1.18.26\n' }),
      emitChat: () => {},
    });
  });

  afterEach(async () => {
    b.cleanup();
    await fake.close();
  });

  it('reaches the instruction files when a session starts, with the real files it asks for', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Propuesta');
    writeDeliverable(b, work, 'propuesta-v1.pdf');
    await b.service.updateWork(work.id, { expectedOutput: 'La propuesta en PDF y un Word editable.', resultPath: 'propuesta-v1.pdf' });

    await b.service.startChat(work.id);
    const workDir = b.files.workDir(brand.id, work.id);
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const text = fs.readFileSync(path.join(workDir, file), 'utf8');
      expect(text).toContain('## Expected output (what closes this work)');
      expect(text).toContain('La propuesta en PDF y un Word editable.');
      expect(text).toContain('Asked for as PDF and DOCX');
      expect(text).toContain(`\`./${DELIVERABLES_DIR}/propuesta-v1.pdf\``);
      // The goal comes first, then what closes it.
      expect(text.indexOf('## The brief')).toBeLessThan(text.indexOf('## Expected output'));
    }
  });

  it('tells the agent when the linked result left the folder', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Propuesta');
    const file = writeDeliverable(b, work, 'propuesta-v1.pdf');
    await b.service.updateWork(work.id, { expectedOutput: 'La propuesta en PDF.', resultPath: 'propuesta-v1.pdf' });
    fs.rmSync(file);

    await b.service.startChat(work.id);
    const text = fs.readFileSync(path.join(b.files.workDir(brand.id, work.id), 'AGENTS.md'), 'utf8');
    expect(text).toContain('that file is not there anymore');
  });

  /** The system prompt each turn of this member carried, oldest first (OpenCode sends it with every turn). */
  const systemsOf = (memberId: string): string[] => {
    const sessionId = b.repo.getMember(memberId).sessionId;
    return fake.requests
      .filter((r) => r.path === `/session/${sessionId}/prompt_async`)
      .map((r) => String((r.body as { system?: string } | null)?.system ?? ''));
  };

  it('reaches a conversation opened next to a live one, without touching the live one or the shared files', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Propuesta');
    const agents = path.join(b.files.workDir(brand.id, work.id), 'AGENTS.md');
    const first = await b.service.startChat(work.id);
    const shared = fs.readFileSync(agents, 'utf8');

    await b.service.updateWork(work.id, { expectedOutput: 'PDF para cliente' });
    const second = await b.service.addTeamMember(work.id, 'strategist');
    await b.service.sendChat(second.id, 'Arrancá');
    await b.service.sendChat(first.id, 'Seguí');

    // The new conversation gets the current outcome through its own prompt, and is told it is newer than the file.
    expect(systemsOf(second.id).at(-1)).toContain('PDF para cliente');
    expect(systemsOf(second.id).at(-1)).toContain('this one is current');
    // The live one keeps the context it started with, and the shared files were not rewritten under it.
    expect(systemsOf(first.id).at(-1)).not.toContain('PDF para cliente');
    expect(fs.readFileSync(agents, 'utf8')).toBe(shared);
  });

  it('does not repeat the outcome in the prompt when the shared files already say it', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Propuesta');
    await b.service.updateWork(work.id, { expectedOutput: 'PDF para cliente' });

    // Nobody live: the shared files are rewritten with the outcome, so the prompt stays as it always was.
    const first = await b.service.startChat(work.id);
    await b.service.sendChat(first.id, 'Hola');
    expect(fs.readFileSync(path.join(b.files.workDir(brand.id, work.id), 'AGENTS.md'), 'utf8')).toContain('PDF para cliente');
    expect(systemsOf(first.id).at(-1)).not.toContain('PDF para cliente');
    expect(systemsOf(first.id).at(-1)).not.toContain('## Expected output');

    // Frozen by the live one, but still current: nothing to make up for either.
    const second = await b.service.addTeamMember(work.id, 'strategist');
    await b.service.sendChat(second.id, 'Arrancá');
    expect(systemsOf(second.id).at(-1)).not.toContain('## Expected output');
  });

  it('states the outcome to a new conversation when a live one keeps the shared files frozen and they are gone', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Propuesta');
    const dir = b.files.workDir(brand.id, work.id);
    await b.service.startChat(work.id);
    fs.rmSync(path.join(dir, 'CLAUDE.md'));
    fs.rmSync(path.join(dir, 'AGENTS.md'));

    // No files and nothing to state: no file shows an old outcome, so no "removed" note either.
    const second = await b.service.addTeamMember(work.id, 'strategist');
    await b.service.sendChat(second.id, 'Hola');
    expect(systemsOf(second.id).at(-1)).not.toContain('## Expected output');

    await b.service.updateWork(work.id, { expectedOutput: 'PDF para cliente' });
    const third = await b.service.addTeamMember(work.id, 'analyst');
    await b.service.sendChat(third.id, 'Arrancá');
    expect(systemsOf(third.id).at(-1)).toContain('PDF para cliente');
    // Still frozen: nothing was written back under the live conversations.
    expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('tells a new conversation that an outcome still in the shared files was removed', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Propuesta');
    await b.service.updateWork(work.id, { expectedOutput: 'PDF para cliente' });
    const first = await b.service.startChat(work.id);
    await b.service.sendChat(first.id, 'Hola');

    await b.service.updateWork(work.id, { expectedOutput: null });
    const second = await b.service.addTeamMember(work.id, 'strategist');
    await b.service.sendChat(second.id, 'Arrancá');
    await b.service.sendChat(first.id, 'Seguí');

    expect(fs.readFileSync(path.join(b.files.workDir(brand.id, work.id), 'AGENTS.md'), 'utf8')).toContain('PDF para cliente');
    expect(systemsOf(second.id).at(-1)).toContain('None. The human removed it');
    expect(systemsOf(second.id).at(-1)).not.toContain('PDF para cliente');
    // The live one carries exactly the prompt it opened with.
    expect(systemsOf(first.id)).toHaveLength(2);
    expect(systemsOf(first.id)[1]).toBe(systemsOf(first.id)[0]);
  });

  it('keeps the context a live conversation opened with when its model changes, and takes the current one after a pause', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Propuesta');
    const agents = path.join(b.files.workDir(brand.id, work.id), 'AGENTS.md');
    const member = await b.service.addTeamMember(work.id, 'strategist');
    await b.service.updateWork(work.id, { expectedOutput: 'PDF para cliente' });

    // A model change restarts the runtime, not the conversation: neither its prompt nor the frozen files change.
    expect((await b.service.setTeamMemberModel(member.id, 'fake-provider/fake-model')).resumed).toBe(true);
    await b.service.sendChat(member.id, 'Seguí');
    expect(systemsOf(member.id).at(-1)).not.toContain('PDF para cliente');
    expect(fs.readFileSync(agents, 'utf8')).not.toContain('PDF para cliente');

    // Paused and opened again, it is no longer live: the files are rewritten, and only they carry the outcome.
    await b.service.pauseTeamMember(member.id);
    await b.service.openTeamMember(member.id);
    await b.service.sendChat(member.id, 'Retomá');
    expect(fs.readFileSync(agents, 'utf8')).toContain('PDF para cliente');
    expect(systemsOf(member.id).at(-1)).not.toContain('PDF para cliente');
  });
});

describe('renderInstructions: the outcome section', () => {
  const brand: Brand = { id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' };
  const work: Work = { id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '# Uno', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' };

  it('renders a work without an outcome exactly like a work from before the fields existed', () => {
    const before = renderInstructions({ brand, work, decisions: [] });
    expect(renderInstructions({ brand, work: { ...work, expectedOutput: null, resultPath: null }, decisions: [], resultExists: false })).toBe(before);
    expect(before).not.toContain('## Expected output');
  });

  it('asks for real files only when the expected output names them', () => {
    expect(requestedFormats('Un PDF y un Word editable')).toEqual(['PDF', 'DOCX']);
    expect(requestedFormats('Entregar informe.docx')).toEqual(['DOCX']);
    // A length is not a format.
    expect(requestedFormats('A 300-word summary for the newsletter')).toEqual([]);
    const posts = renderInstructions({ brand, work: { ...work, expectedOutput: 'Tres posteos para Instagram' }, decisions: [] });
    expect(posts).toContain('Tres posteos para Instagram');
    expect(posts).not.toContain('Asked for as');
  });

  it('always demands a verified file with no internal reasoning inside', () => {
    const text = renderInstructions({ brand, work, decisions: [] });
    expect(text).toContain(`it is not done until it exists in ./${DELIVERABLES_DIR}/`);
    expect(text).toContain('Do not conclude that from what you intended or planned');
    expect(text).toContain('never report a file you did not verify');
    expect(text).toContain('no internal reasoning');
  });

  it('renders the outcome for one conversation, and nothing when there is nothing to state', () => {
    expect(renderOutcomeContext(work, undefined)).toBeNull();
    const text = renderOutcomeContext({ ...work, expectedOutput: 'PDF para cliente' }, undefined) ?? '';
    expect(text).toContain('PDF para cliente');
    expect(text).toContain('Asked for as PDF');
    expect(text).toContain('this one is current');
    expect(renderOutcomeContext(work, undefined, true)).toContain('None. The human removed it');
  });

  it('knows whether a context file already says the outcome as it is now', () => {
    const withPdf = { ...work, expectedOutput: 'PDF para cliente' };
    const file = renderInstructions({ brand, work: withPdf, decisions: [] });
    expect(showsCurrentOutcome(file, withPdf, undefined)).toBe(true);
    expect(showsCurrentOutcome(file, { ...work, expectedOutput: 'PDF y Word' }, undefined)).toBe(false);
    expect(showsCurrentOutcome(file, work, undefined)).toBe(false);
    const plain = renderInstructions({ brand, work, decisions: [] });
    expect(showsCurrentOutcome(plain, work, undefined)).toBe(true);
    expect(showsCurrentOutcome(plain, withPdf, undefined)).toBe(false);
    // A link dropped or gone since the file was written is a difference, not a prefix match.
    const linked = { ...withPdf, resultPath: 'propuesta.pdf' };
    const linkedFile = renderInstructions({ brand, work: linked, decisions: [], resultExists: true });
    expect(showsCurrentOutcome(linkedFile, linked, true)).toBe(true);
    expect(showsCurrentOutcome(linkedFile, withPdf, undefined)).toBe(false);
    expect(showsCurrentOutcome(linkedFile, linked, false)).toBe(false);
  });

  it('names the linked result, and says when it is gone', () => {
    const linked = { ...work, expectedOutput: 'Propuesta en PDF', resultPath: 'propuesta.pdf' };
    expect(renderInstructions({ brand, work: linked, decisions: [], resultExists: true })).toContain('never replace this one without permission');
    expect(renderInstructions({ brand, work: linked, decisions: [], resultExists: false })).toContain('that file is not there anymore');
  });
});

describe.each<DriverPreference>(['node:sqlite', 'sql.js'])('Outcome columns on an existing database (%s)', (engine) => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => removeDir(dir));

  it('adds them without touching rows, and without a version an older build would refuse', async () => {
    const { driver } = await openDriver(path.join(dir, 'latte.db'), engine);
    // The works table as schema 6 left it: no expected_output, no result_path.
    driver.exec("CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    driver.exec("CREATE TABLE works (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', dir TEXT, updated_at TEXT NOT NULL)");
    driver.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '6']);
    driver.run('INSERT INTO brands VALUES (?, ?, ?, ?)', ['brd_1', 'Casa', '', '2026-01-01T00:00:00.000Z']);
    driver.run('INSERT INTO works VALUES (?, ?, ?, ?, ?, ?)', ['wrk_1', 'brd_1', 'Uno', '# Viejo', null, '2026-01-02T00:00:00.000Z']);

    const repo = new LatteRepository(driver);
    try {
      repo.migrate();
      repo.migrate();
      expect(repo.getWork('wrk_1')).toEqual({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '# Viejo', folder: null, expectedOutput: null, resultPath: null, updatedAt: '2026-01-02T00:00:00.000Z' });
      expect(repo.getMeta('schema_version')).toBe(SCHEMA_VERSION);
      // 8 adds learned-skill tables; the outcome columns still add none of their own.
      expect(SCHEMA_VERSION).toBe('8');
      // What an older build still does after this one ran: insert naming only the columns it knows.
      driver.run('INSERT INTO works(id, brand_id, title, brief, dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['wrk_2', 'brd_1', 'Dos', '', null, '2026-01-03T00:00:00.000Z']);
      expect(repo.getWork('wrk_2')).toMatchObject({ expectedOutput: null, resultPath: null });
      expect(repo.setWorkOutcome('wrk_1', 'Un PDF', 'propuesta.pdf', '2026-01-04T00:00:00.000Z')).toMatchObject({ expectedOutput: 'Un PDF', resultPath: 'propuesta.pdf', brief: '# Viejo' });
    } finally {
      repo.close();
    }
  });
});
