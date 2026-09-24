import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareForMigration } from '../../electron/storage/backup';
import type { SqlDriver, SqlRow } from '../../electron/storage/driver';
import { openDriver, type DriverPreference } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { avatarFromSeed, serializeAvatar } from '../../shared/avatar';
import { makeTempDir, removeDir } from './helpers';

const ENGINES: DriverPreference[] = ['node:sqlite', 'sql.js'];

/** Core tables as `upstream/main` schema 7 left them, before additive generation/brand/learning DDL. */
const UPSTREAM_V7 = `
CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', dir TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * `brand_context_proposals` exactly as schema 10 shipped it.
 *
 * A v10 file on disk really has this table: the previous fixture was a v7 core
 * with `schema_version` bumped to '10', so it proved nothing about the table the
 * migration actually touches. `decided_reason` / `superseded_by` are NOT here on
 * purpose — they arrive through the pragma-gated ALTER, which is the path a real
 * v10 file takes and the one worth testing.
 */
const BRAND_CONTEXT_PROPOSALS_V10 = `
CREATE TABLE IF NOT EXISTS brand_context_proposals (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  work_id TEXT NOT NULL,
  source_chat_id TEXT,
  source_message_id TEXT,
  source_member_id TEXT,
  source_role_id TEXT,
  source_runtime TEXT,
  text TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  base_fingerprint TEXT NOT NULL,
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_brand_context_proposals_brand ON brand_context_proposals(brand_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_context_request ON brand_context_proposals(brand_id, work_id, source_chat_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_context_pending ON brand_context_proposals(brand_id) WHERE status = 'pending';
`;

/** The same table as a v10 file that a build already ran the supersede ALTER on. */
const BRAND_CONTEXT_PROPOSALS_V10_WITH_TRAIL = `
CREATE TABLE IF NOT EXISTS brand_context_proposals (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  work_id TEXT NOT NULL,
  source_chat_id TEXT,
  source_message_id TEXT,
  source_member_id TEXT,
  source_role_id TEXT,
  source_runtime TEXT,
  text TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  base_fingerprint TEXT NOT NULL,
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_reason TEXT,
  superseded_by TEXT
);
`;

/** The column list a v10 insert names; the supersede columns did not exist yet. */
const INSERT_V10_PROPOSAL =
  'INSERT INTO brand_context_proposals(id, brand_id, work_id, source_chat_id, source_message_id, source_member_id, source_role_id, source_runtime, text, rationale, mode, status, fingerprint, base_fingerprint, client_request_id, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

describe.each(ENGINES)('schema 7 → 8 migration on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver | undefined;
  afterEach(() => {
    try { driver?.close(); } catch { /* closed */ }
    if (dir) removeDir(dir);
  });

  it('backs up the v7 file and creates generation, branding and learning tables', async () => {
    dir = makeTempDir(`latte-mig-${engine.replace(/[^a-z]/g, '')}-`);
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    driver = opened.driver;
    driver.exec(UPSTREAM_V7);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '7']);
    driver.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [
      'brd_1', 'Casa', '', '2026-01-01T00:00:00.000Z',
    ]);
    driver.run('INSERT INTO works(id, brand_id, title, brief, dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      'wrk_1', 'brd_1', 'Uno', '# Viejo', null, '2026-01-02T00:00:00.000Z',
    ]);

    const backup = prepareForMigration(file, '7', SCHEMA_VERSION, { now: () => new Date('2026-09-14T12:00:00Z') });
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v7-20260914T120000.db'));
    expect(fs.existsSync(backup!)).toBe(true);

    const repo = new LatteRepository(driver);
    repo.migrate();
    expect(repo.getMeta('schema_version')).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe('14');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='generations'")?.name).toBe('generations');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_kit_versions'")?.name).toBe('brand_kit_versions');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='learned_skills'")?.name).toBe('learned_skills');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_evidence'")?.name).toBe('delivery_evidence');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_archives'")?.name).toBe('brand_archives');
    expect(repo.getWork('wrk_1').title).toBe('Uno');
    repo.close();
    driver = undefined;
  });
});

describe.each(ENGINES)('schema 8 → 9 migration on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver | undefined;
  afterEach(() => {
    try { driver?.close(); } catch { /* closed */ }
    if (dir) removeDir(dir);
  });

  it('backs up the v8 file and creates brand_archives without rewriting brands', async () => {
    dir = makeTempDir(`latte-mig8-${engine.replace(/[^a-z]/g, '')}-`);
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    driver = opened.driver;
    driver.exec(UPSTREAM_V7);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '8']);
    driver.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [
      'brd_1', 'Casa', 'tono', '2026-01-01T00:00:00.000Z',
    ]);
    driver.run('INSERT INTO works(id, brand_id, title, brief, dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      'wrk_1', 'brd_1', 'Uno', '# Viejo', null, '2026-01-02T00:00:00.000Z',
    ]);

    const backup = prepareForMigration(file, '8', SCHEMA_VERSION, { now: () => new Date('2026-09-14T12:00:00Z') });
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v8-20260914T120000.db'));
    expect(fs.existsSync(backup!)).toBe(true);

    const repo = new LatteRepository(driver);
    repo.migrate();
    expect(repo.getMeta('schema_version')).toBe('14');
    expect(SCHEMA_VERSION).toBe('14');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_archives'")?.name).toBe('brand_archives');
    expect(repo.getBrand('brd_1')).toMatchObject({ name: 'Casa', context: 'tono', archivedAt: null });
    expect(repo.listBrands().map((b) => b.id)).toEqual(['brd_1']);
    expect(repo.getWork('wrk_1').title).toBe('Uno');
    repo.close();
    driver = undefined;
  });
});

describe.each(ENGINES)('schema 9 → 10 migration on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver | undefined;
  afterEach(() => {
    try { driver?.close(); } catch { /* closed */ }
    if (dir) removeDir(dir);
  });

  it('backs up the v9 file and creates brand_context_proposals without rewriting brands', async () => {
    dir = makeTempDir(`latte-mig9-${engine.replace(/[^a-z]/g, '')}-`);
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    driver = opened.driver;
    driver.exec(UPSTREAM_V7);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '9']);
    driver.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [
      'brd_1', 'Casa', 'tono', '2026-01-01T00:00:00.000Z',
    ]);
    driver.run('INSERT INTO works(id, brand_id, title, brief, dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      'wrk_1', 'brd_1', 'Uno', '# Viejo', null, '2026-01-02T00:00:00.000Z',
    ]);

    const backup = prepareForMigration(file, '9', SCHEMA_VERSION, { now: () => new Date('2026-09-14T12:00:00Z') });
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v9-20260914T120000.db'));
    expect(fs.existsSync(backup!)).toBe(true);

    const repo = new LatteRepository(driver);
    repo.migrate();
    expect(repo.getMeta('schema_version')).toBe('14');
    expect(SCHEMA_VERSION).toBe('14');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_context_proposals'")?.name).toBe('brand_context_proposals');
    expect(driver.all<{ name: string }>('PRAGMA table_info(brand_context_proposals)').map((c) => c.name)).toEqual(expect.arrayContaining(['source_member_id', 'source_role_id', 'source_runtime', 'base_fingerprint']));
    expect(repo.getBrand('brd_1')).toMatchObject({ name: 'Casa', context: 'tono' });
    expect(repo.getWork('wrk_1').title).toBe('Uno');
    repo.close();
    driver = undefined;
  });
});

describe.each(ENGINES)('schema 10 → 11 migration on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver | undefined;
  afterEach(() => {
    try { driver?.close(); } catch { /* closed */ }
    if (dir) removeDir(dir);
  });

  it('keeps the v10 proposals, adds the supersede columns and creates the immutable revisions table', async () => {
    dir = makeTempDir(`latte-mig10-${engine.replace(/[^a-z]/g, '')}-`);
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    driver = opened.driver;
    driver.exec(UPSTREAM_V7 + BRAND_CONTEXT_PROPOSALS_V10);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '10']);
    driver.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [
      'brd_1', 'Casa', 'tono', '2026-01-01T00:00:00.000Z',
    ]);
    // A v10 database really has proposals in it: one waiting, one already decided.
    driver.run(INSERT_V10_PROPOSAL, [
      'bcp_pending', 'brd_1', 'wrk_1', 'ses_1', 'msg_1', null, 'strategist', 'codex',
      'Tono cercano.', 'Del brief.', 'replace', 'pending', 'fp_pending', 'fp_base', 'req_1', '2026-01-03T00:00:00.000Z', null,
    ]);
    driver.run(INSERT_V10_PROPOSAL, [
      'bcp_decided', 'brd_1', 'wrk_1', 'ses_1', 'msg_0', null, 'strategist', 'codex',
      'Tono formal.', 'Viejo.', 'append', 'rejected', 'fp_decided', 'fp_base', 'req_0', '2026-01-02T00:00:00.000Z', '2026-01-02T01:00:00.000Z',
    ]);

    const backup = prepareForMigration(file, '10', SCHEMA_VERSION, { now: () => new Date('2026-09-14T12:00:00.000Z') });
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v10-20260914T120000.db'));
    expect(fs.existsSync(backup!)).toBe(true);

    const repo = new LatteRepository(driver);
    repo.migrate();
    expect(repo.getMeta('schema_version')).toBe('14');
    expect(SCHEMA_VERSION).toBe('14');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_context_revisions'")?.name).toBe('brand_context_revisions');
    expect(driver.all<{ name: string }>('PRAGMA table_info(brand_context_revisions)').map((c) => c.name)).toEqual(
      expect.arrayContaining(['id', 'brand_id', 'source', 'origin', 'content', 'fingerprint', 'created_at']),
    );
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='trigger' AND name='brand_context_revisions_immutable_update'")?.name).toBe('brand_context_revisions_immutable_update');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='trigger' AND name='brand_context_revisions_immutable_delete'")?.name).toBe('brand_context_revisions_immutable_delete');
    // The supersede trail arrives through the pragma-gated ALTER on the table
    // that was already there, so the columns exist and the old rows read NULL.
    expect(driver.all<{ name: string }>('PRAGMA table_info(brand_context_proposals)').map((c) => c.name)).toEqual(
      expect.arrayContaining(['decided_reason', 'superseded_by']),
    );
    // The rows a v10 file already had survive, unchanged, with no invented reason.
    const proposals = repo.listBrandContextProposals('brd_1');
    expect(proposals.map((p) => p.id)).toEqual(['bcp_decided', 'bcp_pending']);
    expect(proposals.find((p) => p.id === 'bcp_pending')).toMatchObject({
      text: 'Tono cercano.', rationale: 'Del brief.', mode: 'replace', status: 'pending',
      decidedAt: null, decidedReason: null, supersededBy: null,
    });
    expect(proposals.find((p) => p.id === 'bcp_decided')).toMatchObject({
      text: 'Tono formal.', status: 'rejected', decidedAt: '2026-01-02T01:00:00.000Z',
      decidedReason: null, supersededBy: null,
    });
    expect(repo.findPendingBrandContext('brd_1')?.id).toBe('bcp_pending');
    // Immutable by the database, not by convention: no code path can rewrite or
    // delete history, so a wipe stays recoverable.
    repo.insertBrandContextRevision({
      id: 'bcr_1', brandId: 'brd_1', source: 'human', origin: null, content: 'tono', fingerprint: 'f', createdAt: '2026-09-14T12:00:00.000Z',
    });
    expect(() => driver!.run("UPDATE brand_context_revisions SET content = 'otro' WHERE id = 'bcr_1'")).toThrow(/immutable/);
    expect(() => driver!.run("DELETE FROM brand_context_revisions WHERE id = 'bcr_1'")).toThrow(/immutable/);
    expect(repo.listBrandContextRevisions('brd_1').map((r) => r.content)).toEqual(['tono']);
    // Additive: the existing brand row is not rewritten.
    expect(repo.getBrand('brd_1')).toMatchObject({ name: 'Casa', context: 'tono' });
    repo.close();
    driver = undefined;
  });

  it('leaves a v10 file that already has the supersede trail untouched', async () => {
    dir = makeTempDir(`latte-mig10b-${engine.replace(/[^a-z]/g, '')}-`);
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    driver = opened.driver;
    driver.exec(UPSTREAM_V7 + BRAND_CONTEXT_PROPOSALS_V10_WITH_TRAIL);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '10']);
    driver.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [
      'brd_1', 'Casa', 'tono', '2026-01-01T00:00:00.000Z',
    ]);
    // A proposal a newer one replaced, recorded before the 11 bump: the trail
    // the migration must neither lose nor re-derive.
    driver.run(INSERT_V10_PROPOSAL, [
      'bcp_superseded', 'brd_1', 'wrk_1', 'ses_1', 'msg_0', null, 'strategist', 'codex',
      'Tono formal.', 'Viejo.', 'append', 'rejected', 'fp_decided', 'fp_base', 'req_0', '2026-01-02T00:00:00.000Z', '2026-01-02T01:00:00.000Z',
    ]);
    driver.run("UPDATE brand_context_proposals SET decided_reason = 'superseded', superseded_by = 'bcp_newer' WHERE id = 'bcp_superseded'");

    const repo = new LatteRepository(driver);
    // The ALTER is pragma-gated: running it again would throw, so a v10 file
    // that already has the columns has to migrate cleanly.
    expect(() => repo.migrate()).not.toThrow();
    expect(repo.getMeta('schema_version')).toBe('14');
    expect(repo.listBrandContextProposals('brd_1')).toEqual([
      expect.objectContaining({ id: 'bcp_superseded', decidedReason: 'superseded', supersededBy: 'bcp_newer' }),
    ]);
    repo.close();
    driver = undefined;
  });
});

/**
 * Esquema 12 → 13: las Conexiones MCP (brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`, 4.3). Aditivo puro,
 * sin un solo ALTER, así que lo que hay que probar es que un archivo v12 CON
 * DATOS se respalda, sube a 13 con las dos tablas nuevas y no pierde nada — y
 * que volver a migrarlo es idempotente.
 */
describe.each(ENGINES)('schema 12 → 13 migration on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver | undefined;
  afterEach(() => {
    try { driver?.close(); } catch { /* closed */ }
    if (dir) removeDir(dir);
  });

  it('respalda el archivo v12, crea connections y connection_tokens, y no toca lo que ya había', async () => {
    dir = makeTempDir(`latte-mig12-${engine.replace(/[^a-z]/g, '')}-`);
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    driver = opened.driver;
    driver.exec(UPSTREAM_V7);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '12']);
    driver.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [
      'brd_1', 'Casa', 'tono', '2026-01-01T00:00:00.000Z',
    ]);
    driver.run('INSERT INTO works(id, brand_id, title, brief, dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      'wrk_1', 'brd_1', 'Uno', '# Viejo', null, '2026-01-02T00:00:00.000Z',
    ]);

    const backup = prepareForMigration(file, '12', SCHEMA_VERSION, { now: () => new Date('2026-09-23T12:00:00.000Z') });
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v12-20260923T120000.db'));
    expect(fs.existsSync(backup!)).toBe(true);

    const repo = new LatteRepository(driver);
    repo.migrate();
    expect(repo.getMeta('schema_version')).toBe('14');
    expect(SCHEMA_VERSION).toBe('14');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='connections'")?.name).toBe('connections');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='connection_tokens'")?.name).toBe('connection_tokens');
    // Lo que ya estaba sigue estando: la migración es aditiva de verdad.
    expect(repo.getBrand('brd_1')).toMatchObject({ name: 'Casa', context: 'tono' });
    expect(repo.getWork('wrk_1').title).toBe('Uno');
    expect(repo.connections.list(null)).toEqual([]);

    // Y es idempotente: correrla de nuevo sobre la base ya migrada, con una
    // conexión adentro, no tira ni borra nada.
    repo.connections.insert({
      id: 'con_1', name: 'theagentcy', label: 'The Agentcy', url: 'https://theagentcy.app/api/mcp',
      transport: 'http', authKind: 'oauth', clientId: null, identity: null, scope: 'global', brandId: null,
      state: 'disconnected', stateDetail: '', memberOverride: null,
      createdAt: '2026-09-23T12:00:00.000Z', updatedAt: '2026-09-23T12:00:00.000Z',
    });
    expect(() => repo.migrate()).not.toThrow();
    expect(repo.connections.list(null).map((c) => c.id)).toEqual(['con_1']);
    repo.close();
    driver = undefined;
  });
});

/**
 * `team_members` exactamente como lo dejó el esquema 13: con `continued_from`,
 * `tier` y `usage_json` (llegaron por ALTER) y SIN `brand_member_id`. Es la
 * tabla que la migración 13 → 14 lee y completa.
 */
const TEAM_MEMBERS_V13 = `
CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL, role_name TEXT NOT NULL, initial TEXT NOT NULL, runtime TEXT NOT NULL,
  model TEXT, account_id TEXT, session_id TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
  continued_from TEXT, tier TEXT NOT NULL DEFAULT 'balanced', usage_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;
const INSERT_V13_MEMBER =
  'INSERT INTO team_members(id, work_id, role_id, role_name, initial, runtime, model, account_id, session_id, done, continued_from, tier, usage_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/**
 * Esquema 13 → 14: EL EQUIPO ES DE LA MARCA (brief
 * `docs/briefs/2026-09-23-equipo-de-marca.md`, 3.2). Nace `brand_members` —el
 * plantel— y cada fila de `team_members` pasa a ser la convocatoria de alguien
 * de ese plantel. Lo que hay que probar es lo que el brief nombra como riesgo:
 * cero filas perdidas, los ids de siempre (todo `coordination_*` apunta a
 * ellos), dos del mismo rol en trabajos distintos de la misma marca son UNA
 * persona, dos en el MISMO trabajo siguen siendo dos, y volver a migrar no
 * inventa a nadie.
 */
describe.each(ENGINES)('schema 13 → 14 migration on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver | undefined;
  afterEach(() => {
    try { driver?.close(); } catch { /* closed */ }
    if (dir) removeDir(dir);
  });

  it('respalda el v13, convierte a cada miembro en plantel de su marca convocado en su trabajo y no pierde una fila', async () => {
    dir = makeTempDir(`latte-mig13-${engine.replace(/[^a-z]/g, '')}-`);
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    driver = opened.driver;
    driver.exec(UPSTREAM_V7 + TEAM_MEMBERS_V13);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '13']);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['role-avatar:strategist', 'bob.2.4.phones']);
    for (const [id, name] of [['brd_1', 'Casa'], ['brd_2', 'Otra']]) {
      driver.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [id, name, '', '2026-01-01T00:00:00.000Z']);
    }
    for (const [id, brand] of [['wrk_a', 'brd_1'], ['wrk_b', 'brd_1'], ['wrk_c', 'brd_2']]) {
      driver.run('INSERT INTO works(id, brand_id, title, brief, dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, brand, id, '', null, '2026-01-02T00:00:00.000Z']);
    }
    const usage = JSON.stringify({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, costUsd: null, contextTokens: null });
    // La misma estratega (claude, sin cuenta) en dos trabajos de brd_1: se funde en una persona.
    driver.run(INSERT_V13_MEMBER, ['mem_a1', 'wrk_a', 'strategist', 'Strategist', 'S', 'claude', 'opus', null, 'ses-a1', 0, null, 'deep', usage, '2026-02-01T00:00:00.000Z', '2026-02-05T00:00:00.000Z']);
    driver.run(INSERT_V13_MEMBER, ['mem_b1', 'wrk_b', 'strategist', 'Strategist', 'S', 'claude', null, null, 'ses-b1', 1, null, 'balanced', null, '2026-03-01T00:00:00.000Z', '2026-03-09T00:00:00.000Z']);
    // Otra estratega en el MISMO wrk_a, continuación en codex: sigue siendo otra persona.
    driver.run(INSERT_V13_MEMBER, ['mem_a2', 'wrk_a', 'strategist', 'Strategist', 'S', 'codex', null, 'acc_1', '', 0, 'mem_a1', 'balanced', null, '2026-02-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z']);
    // Dos del mismo rol y el mismo runtime en el MISMO trabajo: dos personas, no una.
    driver.run(INSERT_V13_MEMBER, ['mem_b2', 'wrk_b', 'assistant', 'Asistente', 'A', 'claude', null, null, '', 0, null, 'balanced', null, '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z']);
    driver.run(INSERT_V13_MEMBER, ['mem_b3', 'wrk_b', 'assistant', 'Asistente', 'A', 'claude', null, null, '', 0, null, 'balanced', null, '2026-03-03T00:00:00.000Z', '2026-03-03T00:00:00.000Z']);
    // El mismo rol en OTRA marca: nunca se funde entre marcas.
    driver.run(INSERT_V13_MEMBER, ['mem_c1', 'wrk_c', 'strategist', 'Strategist', 'S', 'claude', null, null, '', 0, null, 'balanced', null, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z']);
    const before = driver.all<SqlRow>('SELECT * FROM team_members ORDER BY id');

    const backup = prepareForMigration(file, '13', SCHEMA_VERSION, { now: () => new Date('2026-09-23T12:00:00.000Z') });
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v13-20260923T120000.db'));
    expect(fs.existsSync(backup!)).toBe(true);

    const repo = new LatteRepository(driver);
    repo.migrate();
    expect(SCHEMA_VERSION).toBe('14');
    expect(repo.getMeta('schema_version')).toBe('14');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_members'")?.name).toBe('brand_members');

    // Cero filas perdidas, y ninguna columna de antes cambió: sólo se sumó el vínculo.
    const after = driver.all<SqlRow>('SELECT * FROM team_members ORDER BY id');
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    for (const [index, row] of before.entries()) expect(after[index]).toMatchObject(row);
    expect(after.every((row) => typeof row.brand_member_id === 'string' && row.brand_member_id !== '')).toBe(true);
    const bm = (id: string) => after.find((row) => row.id === id)!.brand_member_id;

    // brd_1: estratega claude (a1 + b1), estratega codex (a2), dos asistentes (b2, b3).
    expect(bm('mem_a1')).toBe(bm('mem_b1'));
    expect(bm('mem_a2')).not.toBe(bm('mem_a1'));
    expect(bm('mem_b2')).not.toBe(bm('mem_b3'));
    expect(bm('mem_c1')).not.toBe(bm('mem_a1'));
    const roster1 = repo.listBrandMembers('brd_1');
    expect(roster1).toHaveLength(4);
    expect(repo.listBrandMembers('brd_2')).toHaveLength(1);
    const strategist = roster1.find((m) => m.id === bm('mem_a1'))!;
    // La identidad sale de la primera convocatoria; la última actividad, de la más reciente.
    expect(strategist).toMatchObject({ brandId: 'brd_1', roleId: 'strategist', runtime: 'claude', model: 'opus', accountId: null, tier: 'deep', retiredAt: null, lastCalledAt: '2026-03-09T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z' });
    expect(roster1.find((m) => m.id === bm('mem_a2'))).toMatchObject({ runtime: 'codex', accountId: 'acc_1' });
    // La cara de hoy se conserva: la primera del rol en su trabajo es la del rol
    // (NULL, así sigue el override `role-avatar:`); la segunda tenía la suya propia.
    expect(strategist.avatar).toBeNull();
    expect(roster1.find((m) => m.id === bm('mem_b2'))!.avatar).toBeNull();
    expect(roster1.find((m) => m.id === bm('mem_b3'))!.avatar).toBe(serializeAvatar(avatarFromSeed('mem_b3')));
    expect(roster1.find((m) => m.id === bm('mem_a2'))!.avatar).toBe(serializeAvatar(avatarFromSeed('mem_a2')));
    expect(repo.getMeta('role-avatar:strategist')).toBe('bob.2.4.phones');
    // Lo que lee la app: el miembro sabe de quién es convocatoria.
    expect(repo.getMember('mem_b1')).toMatchObject({ workId: 'wrk_b', done: true, sessionId: 'ses-b1', brandMemberId: bm('mem_a1') });

    // Idempotente: migrar de nuevo no crea a nadie ni reasigna a nadie.
    repo.migrate();
    expect(driver.all<SqlRow>('SELECT * FROM team_members ORDER BY id')).toEqual(after);
    expect(repo.listBrandMembers('brd_1')).toEqual(roster1);
    repo.close();
    driver = undefined;
  });
});
