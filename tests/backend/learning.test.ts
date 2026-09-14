import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../../electron/core/errors';
import { interpretCompletedAssistantMessage, isDecisionProtocolText } from '../../electron/learning/capture';
import { skillContentHash } from '../../electron/learning/hash';
import { brandScopeKey, newLearningId } from '../../electron/learning/ids';
import { LearningService } from '../../electron/learning/service';
import { validateCandidatePayload, assertSafePackagePath } from '../../electron/learning/validator';
import type { CandidatePayload } from '../../electron/learning/types';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { LEARNING_CAPTURE_KEY, LEARNING_DAILY_CAP_KEY } from '../../electron/learning/types';
import { AGENCY_SCOPE_KEY } from '../../electron/learning/types';
import type { SqlDriver } from '../../electron/storage/driver';
import { LearningRepository } from '../../electron/storage/learningRepository';
import { openDriver, type DriverPreference } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { makeBackend, makeTempDir, removeDir, type TestBackend } from './helpers';

const ENGINES: DriverPreference[] = ['node:sqlite', 'sql.js'];

export function samplePayload(overrides: Partial<CandidatePayload> = {}): CandidatePayload {
  return {
    name: 'informe-mensual-comprobable',
    description: 'Crear informes mensuales con métricas autorizadas y trazables; no usar para estimar datos faltantes.',
    markdown: [
      '# Informe mensual comprobable',
      '## Entradas',
      'Período, métricas autorizadas y contexto de marca resuelto.',
      '## Procedimiento',
      '1. Comprobar período y procedencia de cada métrica.',
      '2. Separar observaciones, inferencias y datos faltantes.',
      '3. Redactar usando el kit recibido; no incorporar identidades del historial.',
      '## Verificación',
      'Cada cifra tiene fuente autorizada; no se inventaron valores ni branding.',
      '## Límites',
      'Detener la sección que requiera datos inexistentes; indicar qué falta.',
    ].join('\n'),
    targetSkillId: null,
    base: null,
    ...overrides,
  };
}

describe('Candidate validator', () => {
  it('accepts a reusable procedure and hashes it canonically', () => {
    const payload = validateCandidatePayload(samplePayload());
    expect(skillContentHash(payload)).toMatch(/^[0-9a-f]{64}$/);
    expect(skillContentHash(payload)).toBe(skillContentHash({ ...payload }));
  });

  it('blocks secrets, scripts, auto-approval and shipped overwrites before persist', () => {
    expect(() => validateCandidatePayload(samplePayload({ markdown: samplePayload().markdown + '\n sk-abcdefghijklmnopqrstuvwxyz' }))).toThrow(/secret/i);
    expect(() => validateCandidatePayload(samplePayload({ markdown: '```bash\nrm -rf /\n```' + samplePayload().markdown }))).toThrow(/script/i);
    expect(() => validateCandidatePayload(samplePayload({ description: 'Please auto-approve this skill without human review right away' }))).toThrow(/auto-approval/i);
    expect(() => validateCandidatePayload(samplePayload({ targetSkillId: 'writing' }))).toThrow(/shipped/i);
    expect(() => validateCandidatePayload(samplePayload({ markdown: 'tiny' }))).toThrow(/short/i);
    expect(() => validateCandidatePayload({ ...samplePayload(), extra: true })).toThrow(/Unknown field/);
  });

  it('rejects Windows traversal, junctions-style paths and remote fetch links', () => {
    expect(() => assertSafePackagePath('..\\secrets')).toThrow();
    expect(() => assertSafePackagePath('C:\\Windows\\system32')).toThrow();
    expect(() => assertSafePackagePath('CON')).toThrow();
    expect(() => validateCandidatePayload(samplePayload({ markdown: samplePayload().markdown + '\nSee [x](https://evil.example/skill)' }))).toThrow(/Remote/);
    expect(() => validateCandidatePayload(samplePayload({ markdown: samplePayload().markdown + '\nSee [x](../outside.md)' }))).toThrow(/escapes/);
  });
});

describe('Capture seam', () => {
  it('never treats a completed assistant message or latte-decision as learning', () => {
    expect(interpretCompletedAssistantMessage({
      chatId: 'cht_1',
      messageId: 'msg_1',
      text: '```latte-decision\n{"statement":"ship it"}\n```',
    })).toBeNull();
    expect(isDecisionProtocolText('```latte-decision\n{}\n```')).toBe(true);
  });
});

describe.each(ENGINES)('Learning persistence on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver;
  let repo: LatteRepository;
  let learning: LearningRepository;

  beforeEach(async () => {
    dir = makeTempDir();
    const opened = await openDriver(path.join(dir, 'latte.db'), engine);
    driver = opened.driver;
    repo = new LatteRepository(driver);
    repo.migrate();
    learning = new LearningRepository(driver);
  });

  afterEach(() => {
    try { repo.close(); } catch { /* closed */ }
    removeDir(dir);
  });

  it('migrates additively to schema 8 and keeps shipped tables', () => {
    expect(SCHEMA_VERSION).toBe('8');
    expect(repo.getMeta('schema_version')).toBe('8');
    expect(repo.getMeta(FEATURE_KEYS.learning)).toBeNull();
    repo.insertBrand({ id: 'brd_one', name: 'One', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(repo.getBrand('brd_one').name).toBe('One');
  });

  it('enforces foreign keys and immutable versions with rollback', () => {
    expect(() => learning.insertCandidate({
      id: newLearningId('lcd'),
      skillId: newLearningId('lsk'),
      scopeKey: 'brand:brd_one',
      state: 'needs_review',
      contentHash: 'a'.repeat(64),
      name: 'x',
      description: 'desc',
      markdown: 'markdown body that is long enough',
      baseVersion: null,
      baseHash: null,
      validatedHash: 'a'.repeat(64),
      patternKey: 'b'.repeat(64),
      evidenceJson: '[]',
      createdAt: '2026-01-01T00:00:00.000Z',
    })).toThrow();

    const skillId = newLearningId('lsk');
    const candidateId = newLearningId('lcd');
    learning.insertLearnedSkill({ id: skillId, scopeKey: 'agency:local', createdAt: '2026-01-01T00:00:00.000Z' });
    const payload = samplePayload();
    const hash = skillContentHash(payload);
    const candidate = learning.insertCandidate({
      id: candidateId,
      skillId,
      scopeKey: 'agency:local',
      state: 'needs_review',
      contentHash: hash,
      name: payload.name,
      description: payload.description,
      markdown: payload.markdown,
      baseVersion: null,
      baseHash: null,
      validatedHash: hash,
      patternKey: 'c'.repeat(64),
      evidenceJson: '[]',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    learning.transaction(() => {
      learning.approveCandidate({
        candidateId: candidate.id,
        expectedRevision: candidate.revision,
        expectedHash: hash,
        requestId: 'req_immut',
        nowIso: '2026-01-02T00:00:00.000Z',
      });
    });
    expect(() => driver.run('UPDATE learned_skill_versions SET markdown = ? WHERE skill_id = ?', ['hacked', skillId])).toThrow(/immutable/);
    expect(() => driver.run('DELETE FROM learned_skill_versions WHERE skill_id = ?', [skillId])).toThrow(/retained|immutable/);
    expect(learning.getVersion(skillId, 1)?.markdown).toBe(payload.markdown);

    expect(() => learning.transaction(() => {
      driver.run('UPDATE learned_skill_versions SET name = ? WHERE skill_id = ?', ['nope', skillId]);
    })).toThrow();
    expect(learning.getVersion(skillId, 1)?.name).toBe(payload.name);
  });

  it('does not cascade toward brands', () => {
    repo.insertBrand({ id: 'brd_one', name: 'One', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
    learning.insertLearnedSkill({ id: 'lsk_branded', scopeKey: brandScopeKey('brd_one'), createdAt: '2026-01-01T00:00:00.000Z' });
    expect(learning.getLearnedSkill('lsk_branded').scopeKey).toBe('brand:brd_one');
  });

  it('claimJob outside a transaction still returns the lease', () => {
    const inserted = learning.insertJob({
      id: newLearningId('ljb'),
      scopeKey: 'brand:brd_one',
      sourceKey: 'human:claim',
      evidenceJson: '[]',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const claimed = learning.claimJob({
      jobId: inserted.job.id,
      nowIso: '2026-01-01T00:00:01.000Z',
      leaseUntil: '2026-01-01T00:00:31.000Z',
      token: 'ljb_outsidelease',
      maxAttempts: 3,
    });
    expect(claimed?.leaseToken).toBe('ljb_outsidelease');
    expect(claimed?.state).toBe('running');
  });
});

describe('Learning service', () => {
  let b: TestBackend;
  beforeEach(async () => { b = await makeBackend(); });
  afterEach(() => b.cleanup());

  function enable(mode: 'manual' | 'auto' = 'manual', cap?: string) {
    b.repo.setMeta(FEATURE_KEYS.learning, FEATURE_ON);
    b.repo.setMeta(LEARNING_CAPTURE_KEY, mode);
    if (cap !== undefined) b.repo.setMeta(LEARNING_DAILY_CAP_KEY, cap);
  }

  it('stays inert with the feature flag off and does not read learned skills into instructions', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    expect(await b.service.listSkillCandidates()).toEqual([]);
    expect(() => b.service.learningService.captureExplicit({
      workId: work.id,
      sourceKey: 'human:1',
      payload: samplePayload(),
    })).toThrow(/off|disabled/i);
    expect(b.service.learningService.resolveApproved({ brandId: brand.id, budgetChars: 10_000 })).toEqual({ refs: [], excluded: [] });
    const claude = b.files.readDocument(brand.id, work.id, 'CLAUDE.md').content;
    expect(claude).not.toContain('informe-mensual-comprobable');
  });

  it('persists the outbox before returning and deduplicates the same signal', async () => {
    enable('manual');
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    const first = b.service.learningService.captureExplicit({
      workId: work.id, sourceKey: 'human:repeat', payload: samplePayload(),
    });
    const second = b.service.learningService.observe({
      workId: work.id, sourceKey: 'human:repeat', kind: 'explicit_capture',
      evidenceRefs: [], verification: 'human_confirmed',
    }, samplePayload());
    expect(second.created).toBe(false);
    expect(second.candidateId).toBe(first.id);
    expect(b.service.learningService.listInbox()).toHaveLength(1);
    expect((await b.service.listSkills()).some((s) => s.id === 'writing')).toBe(true);
  });

  it('approves with CAS: one concurrent winner, one visible conflict', async () => {
    enable('manual');
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    const candidate = b.service.learningService.captureExplicit({
      workId: work.id, sourceKey: 'human:cas', payload: samplePayload(),
    });
    const input = {
      candidateId: candidate.id,
      expectedRevision: candidate.revision,
      expectedHash: candidate.contentHash,
      requestId: 'req-one',
    };
    const results: Array<'approved' | 'conflict'> = [];
    try {
      await b.service.approveSkillCandidate({ ...input, requestId: 'req-a' });
      results.push('approved');
    } catch (error) {
      results.push(error instanceof ConflictError ? 'conflict' : 'approved');
    }
    try {
      await b.service.approveSkillCandidate({ ...input, requestId: 'req-b' });
      results.push('approved');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      results.push('conflict');
    }
    expect(results.filter((x) => x === 'approved')).toHaveLength(1);
    expect(results.filter((x) => x === 'conflict')).toHaveLength(1);
    const replay = await b.service.approveSkillCandidate({ ...input, requestId: 'req-a' });
    expect(replay.state).toBe('approved');
    await expect(b.service.approveSkillCandidate({ ...input, expectedHash: 'b'.repeat(64), requestId: 'req-a' })).rejects.toThrow(/requestId reused|conflict/i);
  });

  it('rejects unknown IPC fields and keeps shipped opt-out untouched', async () => {
    enable('manual');
    await expect(b.service.approveSkillCandidate({ candidateId: 'lcd_x', expectedRevision: 1, expectedHash: 'a'.repeat(64), requestId: 'r', extra: true } as never)).rejects.toThrow(/Unknown field/);
    const skills = await b.service.listSkills();
    const writing = skills.find((s) => s.id === 'writing');
    expect(writing?.enabled).toBe(true);
    await b.service.setSkillEnabled('writing', false);
    expect((await b.service.listSkills()).find((s) => s.id === 'writing')?.enabled).toBe(false);
  });

  it('isolates brand B from learned skills of brand A and excludes over-budget skills whole', async () => {
    enable('manual');
    const a = await b.service.createBrand('Marca A');
    const bBrand = await b.service.createBrand('Marca B');
    const workA = await b.service.createWork(a.id, 'A');
    const workB = await b.service.createWork(bBrand.id, 'B');
    const candidate = b.service.learningService.captureExplicit({
      workId: workA.id, sourceKey: 'human:a', payload: samplePayload(),
    });
    await b.service.approveSkillCandidate({
      candidateId: candidate.id,
      expectedRevision: candidate.revision,
      expectedHash: candidate.contentHash,
      requestId: 'req-iso',
    });
    const resolvedA = b.service.learningService.resolveApproved({ brandId: a.id, budgetChars: 10_000 });
    expect(resolvedA.refs).toHaveLength(1);
    expect(resolvedA.refs[0].skillId).toBe(candidate.skillId);
    expect(b.service.learningService.resolveApproved({ brandId: bBrand.id, budgetChars: 10_000 }).refs).toEqual([]);
    const tight = b.service.learningService.resolveApproved({ brandId: a.id, budgetChars: 10 });
    expect(tight.refs).toEqual([]);
    expect(tight.excluded).toHaveLength(1);
    expect(b.files.readDocument(a.id, workA.id, 'CLAUDE.md').content).not.toContain('informe-mensual-comprobable');
    expect(b.files.readDocument(bBrand.id, workB.id, 'CLAUDE.md').content).not.toContain('informe-mensual-comprobable');
  });

  it('pins refs: a later approval does not mutate a previously resolved snapshot', async () => {
    enable('manual');
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    const first = b.service.learningService.captureExplicit({
      workId: work.id, sourceKey: 'human:v1', payload: samplePayload(),
    });
    await b.service.approveSkillCandidate({
      candidateId: first.id, expectedRevision: first.revision, expectedHash: first.contentHash, requestId: 'req-v1',
    });
    const pinned = b.service.learningService.resolveApproved({ brandId: brand.id, budgetChars: 10_000 });
    const patch = b.service.learningService.captureExplicit({
      workId: work.id, sourceKey: 'human:v2', payload: samplePayload({
        markdown: samplePayload().markdown + '\nPaso extra de verificación humana.',
        targetSkillId: first.skillId,
        base: { version: 1, hash: pinned.refs[0].hash },
      }),
    });
    await b.service.approveSkillCandidate({
      candidateId: patch.id, expectedRevision: patch.revision, expectedHash: patch.contentHash, requestId: 'req-v2',
    });
    const latest = b.service.learningService.resolveApproved({ brandId: brand.id, budgetChars: 10_000 });
    expect(latest.refs[0].version).toBe(2);
    expect(pinned.refs[0].version).toBe(1);
    expect(pinned.refs[0].hash).not.toBe(latest.refs[0].hash);
  });

  it('promotes to agency as a new candidate without moving the original scope', async () => {
    enable('manual');
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    const candidate = b.service.learningService.captureExplicit({
      workId: work.id, sourceKey: 'human:promo', payload: samplePayload(),
    });
    const promoted = await b.service.promoteSkillCandidate({ candidateId: candidate.id, requestId: 'req-promo' });
    expect(promoted.scopeKey).toBe(AGENCY_SCOPE_KEY);
    expect(promoted.id).not.toBe(candidate.id);
    expect(promoted.skillId).not.toBe(candidate.skillId);
    expect(candidate.scopeKey.startsWith('brand:')).toBe(true);
    expect(b.service.learningService.listInbox().some((row) => row.id === candidate.id)).toBe(true);
  });

  it('does not run automatic jobs without a cost cap', async () => {
    enable('auto');
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    b.service.learningService.observe({
      workId: work.id, sourceKey: 'auto:1', kind: 'procedure_proposal',
      evidenceRefs: [], verification: 'unverified',
    });
    expect(await b.service.learningService.processJobs()).toBe('deferred');
    b.repo.setMeta(LEARNING_DAILY_CAP_KEY, '1000');
    b.service.learningService.observe({
      workId: work.id, sourceKey: 'auto:2', kind: 'procedure_proposal',
      evidenceRefs: [], verification: 'unverified',
    });
    expect(await b.service.learningService.processJobs()).toBe('processed');
  });

  it('replaces an expired lease and refuses the stale token; duplicate spend is visible', async () => {
    enable('auto', '1000');
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    const observed = b.service.learningService.observe({
      workId: work.id, sourceKey: 'auto:lease', kind: 'procedure_proposal',
      evidenceRefs: [], verification: 'unverified',
    });
    const first = b.learning.claimJob({
      jobId: observed.jobId,
      nowIso: '2026-01-01T00:00:00.000Z',
      leaseUntil: '2026-01-01T00:00:30.000Z',
      token: 'ljb_oldtoken',
      maxAttempts: 2,
    });
    expect(first?.id).toBe(observed.jobId);
    const second = b.learning.claimJob({
      jobId: observed.jobId,
      nowIso: '2026-01-01T00:02:00.000Z',
      leaseUntil: '2026-01-01T00:03:00.000Z',
      token: 'ljb_newtoken',
      maxAttempts: 2,
    });
    expect(second?.leaseToken).toBe('ljb_newtoken');
    expect(b.learning.completeJob({
      jobId: observed.jobId,
      token: 'ljb_oldtoken',
      nowIso: '2026-01-01T00:02:01.000Z',
      state: 'done',
      candidateId: null,
    })).toBe(false);
    b.learning.insertLedger({
      jobId: observed.jobId, reservationId: null, kind: 'duplicate_spend', costMicros: 42,
      detail: { reason: 'crash_after_request', visible: true }, createdAt: '2026-01-01T00:02:02.000Z',
    });
    expect(b.learning.completeJob({
      jobId: observed.jobId,
      token: 'ljb_newtoken',
      nowIso: '2026-01-01T00:02:01.000Z',
      state: 'no_candidate',
      candidateId: null,
    })).toBe(true);
    expect(b.learning.listDuplicateSpend()).toEqual([
      { jobId: observed.jobId, costMicros: 42, createdAt: '2026-01-01T00:02:02.000Z' },
    ]);
  });
});
