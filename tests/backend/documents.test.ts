import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver } from '../../electron/storage/openDriver';
import { briefDocumentId, LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { documentFileName, fingerprintOf } from '../../electron/workspace/workspace';
import { makeBackend, makeTempDir, removeDir, type TestBackend } from './helpers';

const AGENT_TEXT = '# Agent strategy improved';

async function fixture() {
  const b = await makeBackend();
  const brand = await b.service.createBrand('Casa');
  const work = await b.service.createWork(brand.id, 'Plan');
  const dir = b.files.workDir(brand.id, work.id);
  const brief = briefDocumentId(work.id);
  /** Simulates any writer that is not Latte: an agent, an editor, a script. */
  const writeOutside = (text: string, file = 'brief.md') => fs.writeFileSync(path.join(dir, file), text);
  return { b, brand, work, dir, brief, writeOutside };
}

describe('Conflict-safe saving (regression for the reproduced data loss)', () => {
  let b: TestBackend | null = null;
  afterEach(() => { b?.cleanup(); b = null; });

  it('keeps a version instead of overwriting when the editor is stale and unchanged', async () => {
    const f = await fixture(); b = f.b;
    await f.b.service.saveBrief(f.work.id, '# Draft original');
    f.writeOutside(AGENT_TEXT);

    // The old UI called save() with the stale draft before every snapshot.
    const outcome = await f.b.service.saveBrief(f.work.id, '# Draft original');
    expect(outcome.status).toBe('conflict');
    if (outcome.status !== 'conflict') throw new Error('unreachable');
    expect(outcome.disk.content).toBe(AGENT_TEXT);
    expect(outcome.keptRevision.source).toBe('external');
    // The external change is still the file, and it is also preserved as a version.
    expect(fs.readFileSync(path.join(f.dir, 'brief.md'), 'utf8')).toBe(AGENT_TEXT);
    expect((await f.b.service.listDocumentRevisions(f.brief)).map((r) => r.content)).toContain(AGENT_TEXT);

    // Taking a version now snapshots the disk, never the stale editor.
    const revision = await f.b.service.snapshot(f.work.id);
    expect(revision.content).toBe(AGENT_TEXT);
  });

  it('reports a conflict when a human draft meets an external change, and resolves explicitly', async () => {
    const f = await fixture(); b = f.b;
    const first = await f.b.service.saveBrief(f.work.id, '# Base');
    expect(first.status).toBe('saved');
    const base = first.status === 'saved' ? first.fingerprint : '';
    f.writeOutside(AGENT_TEXT);

    const conflict = await f.b.service.saveBrief(f.work.id, '# Mi versión humana', base);
    expect(conflict.status).toBe('conflict');
    if (conflict.status !== 'conflict') throw new Error('unreachable');
    expect(fs.readFileSync(path.join(f.dir, 'brief.md'), 'utf8')).toBe(AGENT_TEXT);

    // Resolution "keep mine": save again against the fingerprint the user just saw.
    const resolved = await f.b.service.saveBrief(f.work.id, '# Mi versión humana', conflict.disk.fingerprint);
    expect(resolved.status).toBe('saved');
    expect(fs.readFileSync(path.join(f.dir, 'brief.md'), 'utf8')).toBe('# Mi versión humana');
    // Both variants survive: the external one as a version, the human one on disk.
    const contents = (await f.b.service.listDocumentRevisions(f.brief)).map((r) => r.content);
    expect(contents).toContain(AGENT_TEXT);
  });

  it('never loses an external change when another member is opened with a pending draft', async () => {
    const f = await fixture(); b = f.b;
    await f.b.service.saveBrief(f.work.id, '# Base');
    f.writeOutside(AGENT_TEXT);
    // persistPending in the UI: saving the pending draft must not clobber the file.
    const outcome = await f.b.service.saveBrief(f.work.id, '# Draft del humano');
    expect(outcome.status).toBe('conflict');
    expect(fs.readFileSync(path.join(f.dir, 'brief.md'), 'utf8')).toBe(AGENT_TEXT);
    // Reading is safe and refreshes what the UI shows.
    expect((await f.b.service.readDocument(f.brief)).content).toBe(AGENT_TEXT);
    expect((await f.b.service.listWorks(f.brand.id))[0].brief).toBe(AGENT_TEXT);
  });

  it('keeps the human draft as a version when the disk version wins', async () => {
    const f = await fixture(); b = f.b;
    await f.b.service.saveBrief(f.work.id, '# Base');
    f.writeOutside(AGENT_TEXT);
    const conflict = await f.b.service.saveBrief(f.work.id, '# Mi texto', fingerprintOf('# Base'));
    expect(conflict.status).toBe('conflict');
    // Resolution "keep the file": the human text is archived instead of dropped.
    const kept = await f.b.service.keepDraftAsVersion(f.brief, '# Mi texto');
    expect(kept.source).toBe('human');
    expect(fs.readFileSync(path.join(f.dir, 'brief.md'), 'utf8')).toBe(AGENT_TEXT);
    const contents = (await f.b.service.listDocumentRevisions(f.brief)).map((r) => [r.source, r.content]);
    expect(contents).toContainEqual(['external', AGENT_TEXT]);
    expect(contents).toContainEqual(['human', '# Mi texto']);
  });

  it('saves happily when nobody else touched the file, and is idempotent', async () => {
    const f = await fixture(); b = f.b;
    const read = await f.b.service.readDocument(f.brief);
    const saved = await f.b.service.saveBrief(f.work.id, '# Nuevo', read.fingerprint);
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') throw new Error('unreachable');
    expect(saved.fingerprint).toBe(fingerprintOf('# Nuevo'));
    // Writing the same content an agent already wrote is not a conflict.
    f.writeOutside('# Igualito');
    expect((await f.b.service.saveBrief(f.work.id, '# Igualito', saved.fingerprint)).status).toBe('saved');
    await expect(f.b.service.saveBrief(f.work.id, 'x', 'not-a-fingerprint')).rejects.toThrow(/Invalid fingerprint/);
  });

  it('detects external changes through a cheap fingerprint poll (survives atomic rename writes)', async () => {
    const f = await fixture(); b = f.b;
    const before = await f.b.service.documentState(f.brief);
    // Atomic write = write temp + rename: inode and mtime change, content does not.
    const file = path.join(f.dir, 'brief.md');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, (await f.b.service.readDocument(f.brief)).content);
    fs.renameSync(tmp, file);
    expect((await f.b.service.documentState(f.brief)).fingerprint).toBe(before.fingerprint);
    f.writeOutside(AGENT_TEXT);
    expect((await f.b.service.documentState(f.brief)).fingerprint).not.toBe(before.fingerprint);
  });
});

describe('Several tracked documents per work', () => {
  let b: TestBackend | null = null;
  afterEach(() => { b?.cleanup(); b = null; });

  it('creates, lists, saves, versions and exports documents independently', async () => {
    const f = await fixture(); b = f.b;
    expect((await f.b.service.listDocuments(f.work.id)).map((d) => [d.kind, d.fileName, d.title])).toEqual([['brief', 'brief.md', 'Plan']]);

    const strategy = await f.b.service.createDocument(f.work.id, 'strategy', 'Estrategia de lanzamiento');
    expect(strategy.document.fileName).toBe('strategy.md');
    expect(strategy.content).toContain('## Objetivo');
    expect(strategy.content).toContain('Sin definir todavía');
    expect(fs.existsSync(path.join(f.dir, 'strategy.md'))).toBe(true);

    // A second document of the same kind gets its own file, never a clash.
    const second = await f.b.service.createDocument(f.work.id, 'strategy', 'Alternativa');
    expect(second.document.fileName).toBe('strategy-2.md');

    await f.b.service.saveDocument(strategy.document.id, '# Estrategia\n\nObjetivo real.', strategy.fingerprint);
    expect(fs.readFileSync(path.join(f.dir, 'strategy.md'), 'utf8')).toBe('# Estrategia\n\nObjetivo real.');
    // The brief is untouched by a sibling document's save.
    expect((await f.b.service.readDocument(f.brief)).content).toBe('# Plan\n\n');

    const revision = await f.b.service.snapshotDocument(strategy.document.id);
    expect(revision.documentId).toBe(strategy.document.id);
    expect((await f.b.service.listDocumentRevisions(f.brief)).length).toBe(0);
    expect((await f.b.service.listDocumentRevisions(strategy.document.id)).map((r) => r.id)).toEqual([revision.id]);

    const renamed = await f.b.service.updateDocument(strategy.document.id, { title: 'Estrategia v2', status: 'review' });
    expect(renamed).toMatchObject({ title: 'Estrategia v2', status: 'review' });
    await expect(f.b.service.updateDocument(strategy.document.id, { status: 'publicado' as never })).rejects.toThrow(/status/);
    await expect(f.b.service.createDocument(f.work.id, 'wat' as never, 'x')).rejects.toThrow(/kind/);
  });

  it('exports the selected document, not the work', async () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'out.md');
    const backend = await makeBackend({ chooseExportPath: async () => target });
    b = backend;
    const brand = await backend.service.createBrand('Casa');
    const work = await backend.service.createWork(brand.id, 'Plan');
    const doc = await backend.service.createDocument(work.id, 'calendar', 'Calendario de 30 días');
    await backend.service.saveDocument(doc.document.id, '# Calendario real', doc.fingerprint);
    expect(await backend.service.exportDocument(doc.document.id)).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe('# Calendario real');
    removeDir(dir);
  });

  it('picks safe file names and refuses foreign base documents', async () => {
    expect(documentFileName('strategy', [])).toBe('strategy.md');
    expect(documentFileName('strategy', ['strategy.md', 'strategy-2.md'])).toBe('strategy-3.md');
    expect(documentFileName('../evil', [])).toBe('document.md');
    const f = await fixture(); b = f.b;
    const other = await f.b.service.createWork(f.brand.id, 'Otro trabajo');
    const foreign = (await f.b.service.listDocuments(other.id))[0];
    await expect(f.b.service.createDocument(f.work.id, 'calendar', 'Cal', foreign.id)).rejects.toThrow(/another work/);
  });
});

describe('Derived documents keep the version they were based on', () => {
  let b: TestBackend | null = null;
  afterEach(() => { b?.cleanup(); b = null; });

  it('pins the base version and flags the derived document when the base moves', async () => {
    const f = await fixture(); b = f.b;
    const strategy = await f.b.service.createDocument(f.work.id, 'strategy', 'Estrategia');
    await f.b.service.saveDocument(strategy.document.id, '# Estrategia v1', strategy.fingerprint);

    const calendar = await f.b.service.createDocument(f.work.id, 'calendar', 'Calendario 30 días', strategy.document.id);
    expect(calendar.document.baseDocumentId).toBe(strategy.document.id);
    expect(calendar.document.baseRevisionId).toBeTruthy();
    expect(calendar.baseOutdated).toBe(false);
    expect(calendar.content).toContain('basado en: Estrategia');
    // The pinned version is an immutable revision of the strategy, so it survives later edits.
    const pinned = (await f.b.service.listDocumentRevisions(strategy.document.id)).find((r) => r.id === calendar.document.baseRevisionId);
    expect(pinned?.content).toBe('# Estrategia v1');

    // The strategy moves on: the calendar needs review, nothing is regenerated.
    await f.b.service.saveDocument(strategy.document.id, '# Estrategia v2', fingerprintOf('# Estrategia v1'));
    expect((await f.b.service.documentState(calendar.document.id)).baseOutdated).toBe(true);
    expect((await f.b.service.readDocument(calendar.document.id)).content).toContain('## Calendario');
    expect(pinned?.content).toBe('# Estrategia v1');

    // An external edit of the base counts too.
    const acknowledged = await f.b.service.acknowledgeBase(calendar.document.id);
    expect(acknowledged.baseFingerprint).toBe(fingerprintOf('# Estrategia v2'));
    expect((await f.b.service.documentState(calendar.document.id)).baseOutdated).toBe(false);
    f.writeOutside('# Estrategia tocada por fuera', 'strategy.md');
    expect((await f.b.service.documentState(calendar.document.id)).baseOutdated).toBe(true);

    await expect(f.b.service.acknowledgeBase(f.brief)).rejects.toThrow(/no base version/);
  });
});

describe('Migration v3 -> v4', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => removeDir(dir));

  it('adds the documents table and keeps immutable revisions readable, without updating them', async () => {
    const { driver } = await openDriver(path.join(dir, 'latte.db'), 'sql.js');
    driver.exec("CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    driver.exec("CREATE TABLE works (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)");
    driver.exec('CREATE TABLE revisions (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT NOT NULL)');
    driver.exec("CREATE TRIGGER revisions_immutable_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END");
    driver.run('INSERT INTO brands VALUES (?, ?, ?, ?)', ['brd_1', 'Casa', '', '2026-01-01T00:00:00.000Z']);
    driver.run('INSERT INTO works VALUES (?, ?, ?, ?, ?)', ['wrk_1', 'brd_1', 'Uno', '# Viejo', '2026-01-02T00:00:00.000Z']);
    driver.run('INSERT INTO revisions VALUES (?, ?, ?, ?)', ['rev_old', 'wrk_1', '# Versión histórica', '2026-01-03T00:00:00.000Z']);

    const repo = new LatteRepository(driver);
    repo.migrate();
    repo.migrate();

    const documents = repo.listDocuments('wrk_1');
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ id: briefDocumentId('wrk_1'), kind: 'brief', title: 'Uno', fileName: 'brief.md' });
    // The historical revision was never rewritten, and still reads as the brief's version.
    const revisions = repo.listDocumentRevisions('wrk_1', briefDocumentId('wrk_1'));
    expect(revisions.map((r) => [r.id, r.documentId, r.source])).toEqual([['rev_old', briefDocumentId('wrk_1'), 'human']]);
    expect(driver.get<{ document_id: string | null }>('SELECT document_id FROM revisions WHERE id = ?', ['rev_old'])?.document_id).toBeNull();
    expect(repo.getMeta('schema_version')).toBe(SCHEMA_VERSION);
    repo.close();
  });
});

describe('Adopting a file an agent left in the folder', () => {
  let b: TestBackend | null = null;
  afterEach(() => { b?.cleanup(); b = null; });

  it('offers it, adopts it, and from then on it has versions and export', async () => {
    const f = await fixture(); b = f.b;
    // Exactly what happened in a real session: the agent wrote a file it could
    // not register, because registering is Latte's job, not the runtime's.
    f.writeOutside('# Qué necesito de vos\n\n- Objetivo\n- Audiencia\n', 'que-necesito.md');

    const pending = await f.b.service.listUntrackedFiles(f.work.id);
    expect(pending.map((p) => [p.fileName, p.title, p.kind])).toEqual([['que-necesito.md', 'Que necesito', 'note']]);
    expect(pending[0].bytes).toBeGreaterThan(0);
    // The managed files are never offered as documents.
    expect(pending.map((p) => p.fileName)).not.toContain('CLAUDE.md');
    expect(pending.map((p) => p.fileName)).not.toContain('AGENTS.md');

    const document = await f.b.service.trackFile(f.work.id, 'que-necesito.md');
    expect(document).toMatchObject({ fileName: 'que-necesito.md', title: 'Que necesito', kind: 'note' });
    // Now it behaves like any other deliverable.
    const read = await f.b.service.readDocument(document.id);
    expect(read.content).toContain('Qué necesito de vos');
    const revision = await f.b.service.snapshotDocument(document.id);
    expect(revision.documentId).toBe(document.id);
    expect(await f.b.service.listUntrackedFiles(f.work.id)).toEqual([]);
    // And the instructions now list it for the agent.
    const dir = f.b.files.workDir(f.brand.id, f.work.id);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain('que-necesito.md');
  });

  it('refuses to adopt what is not there, and never adopts twice', async () => {
    const f = await fixture(); b = f.b;
    await expect(f.b.service.trackFile(f.work.id, 'no-existe.md')).rejects.toThrow(/no está en la carpeta/);
    // brief.md is already a document: it must not be offered or adopted again.
    await expect(f.b.service.trackFile(f.work.id, 'brief.md')).rejects.toThrow(/ya es un documento/);
    f.writeOutside('# Otra', 'otra.md');
    await f.b.service.trackFile(f.work.id, 'otra.md');
    await expect(f.b.service.trackFile(f.work.id, 'otra.md')).rejects.toThrow(/ya es un documento/);
    expect((await f.b.service.listDocuments(f.work.id)).filter((d) => d.fileName === 'otra.md')).toHaveLength(1);
  });
});
