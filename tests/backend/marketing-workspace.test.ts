import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { makeBackend, makeTempDir, removeDir, fakeRunner } from './helpers';
import { openDriver } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_SQL } from '../../electron/storage/schema';
import { startFakeOpenCode } from './fakeOpenCode';

it('persists explicit stages without changing document identity, file, content or revisions', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const before = (await b.service.listDocuments(work.id))[0];
    expect(before.funnelStages).toEqual([]);
    const content = await b.service.readDocument(before.id);
    const revisions = await b.service.listDocumentRevisions(before.id);
    const after = await b.service.updateDocument(before.id, { status: 'review', funnelStages: ['discovery', 'conversion', 'discovery'] });
    expect(after.funnelStages).toEqual(['discovery', 'conversion']);
    expect(after).toMatchObject({ id: before.id, fileName: before.fileName, status: 'review' });
    expect((await b.service.readDocument(before.id)).content).toBe(content.content);
    expect(await b.service.listDocumentRevisions(before.id)).toEqual(revisions);
    await expect(b.service.updateDocument(before.id, { funnelStages: ['bad'] } as never)).rejects.toThrow();
    expect((await b.service.listDocuments(work.id))[0].funnelStages).toEqual(['discovery', 'conversion']);
  } finally { b.cleanup(); }
});

it.each(['node:sqlite', 'sql.js'] as const)('migrates legacy v5 and reopens twice without losing metadata on %s', async engine => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    opened.driver.exec(SCHEMA_SQL.replace("  funnel_stages  TEXT NOT NULL DEFAULT '[]',", ''));
    opened.driver.run("INSERT INTO brands VALUES ('b', 'Bruma', '', 'now')");
    opened.driver.run("INSERT INTO works VALUES ('w', 'b', 'Legacy', 'content', NULL, 'now')");
    opened.driver.close();
    for (let pass = 0; pass < 2; pass++) {
      const { driver } = await openDriver(file, engine);
      const repo = new LatteRepository(driver);
      repo.migrate(); repo.migrate();
      expect(repo.getMeta('schema_version')).toBe('8');
      expect(repo.getWork('w').brief).toBe('content');
      const document = repo.briefDocument('w');
      expect(document.funnelStages).toEqual(pass === 0 ? [] : ['retention']);
      repo.updateDocument(document.id, { funnelStages: ['retention'], updatedAt: 'now' });
      repo.close();
    }
  } finally { removeDir(dir); }
});

it('supplies custom SOUL and skills to runtime, leaves active prompt unchanged and refreshes on resume', async () => {
  const fake = await startFakeOpenCode();
  const b = await makeBackend({ chatEndpoint: fake.endpoint, runner: fakeRunner(() => ({ code: 0, stdout: '1.0.0' })) });
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Campaign');
    const input = { id: 'bruma-editor', name: 'Bruma editor', initial: 'B', summary: 'Campaigns', soul: 'ORIGINAL SOUL', skills: 'UNIQUE SKILL' };
    const profile = await b.service.saveProfile(input, null);
    const member = await b.service.addTeamMember(work.id, input.id, { runtime: 'opencode' });
    const prompt = () => (fake.requests.filter(r => r.path.endsWith('/prompt_async')).at(-1)?.body as { system: string }).system;
    await b.service.sendChat(member.id, 'Hello');
    expect(prompt()).toContain('ORIGINAL SOUL'); expect(prompt()).toContain('UNIQUE SKILL');
    await b.service.saveProfile({ ...input, soul: 'NEW SOUL' }, profile.fingerprint);
    await b.service.openTeamMember(member.id);
    await b.service.sendChat(member.id, 'Again');
    expect(prompt()).toContain('ORIGINAL SOUL'); expect(prompt()).not.toContain('NEW SOUL');
    await b.service.pauseTeamMember(member.id);
    await b.service.openTeamMember(member.id);
    await b.service.sendChat(member.id, 'Resumed');
    expect(prompt()).toContain('NEW SOUL');
  } finally { b.cleanup(); await fake.close(); }
});

it('exposes file-backed profiles with protected builtins and optimistic edits', async () => {
  const b = await makeBackend();
  try {
    expect((await b.service.listProfiles())[0].source).toBe('builtin');
    const input = { id: 'bruma-editor', name: 'Bruma', initial: 'B', summary: 'Cafe', soul: '# Soul', skills: '# Skill' };
    const profile = await b.service.saveProfile(input, null);
    expect(fs.readFileSync(path.join(profile.directory!, 'SOUL.md'), 'utf8')).toBe(input.soul);
    await expect(b.service.saveProfile(input, null)).rejects.toThrow();
    fs.writeFileSync(path.join(profile.directory!, 'SOUL.md'), '# External');
    await expect(b.service.saveProfile(input, profile.fingerprint)).rejects.toThrow(/conflict/i);
    expect((await b.service.listProfiles()).find(p => p.id === input.id)?.soul).toBe('# External');
    await expect(b.service.saveProfile({ ...input, id: 'assistant' }, null)).rejects.toThrow();
  } finally { b.cleanup(); }
});

it('shows the agent every stage and, above all, the ones with nothing in them', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const piece = await b.service.saveAsDocument(work.id, 'copy', 'Oferta primer pedido', '# Oferta');
    await b.service.updateDocument(piece.id, { funnelStages: ['discovery', 'conversion'] });
    // saveAsDocument is one of the paths that rewrites the managed file, so the
    // second one renders the first with the stages it just got.
    await b.service.saveAsDocument(work.id, 'note', 'Todavia sin etapa', '# Nota');
    const claude = fs.readFileSync(path.join(b.dir, 'brands', brand.id, 'works', work.id, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('funnel: discovery, conversion');
    expect(claude).toContain('funnel: unclassified');
    expect(claude).toContain('- `discovery`: 1');
    expect(claude).toContain('- `consideration`: 0');
    expect(claude).toContain('- `retention`: 0');
    expect(claude).toContain('- `unclassified`: 2');
    expect(claude).toContain('An empty stage is a finding, not a detail.');
  } finally { b.cleanup(); }
});

it('adopts the stage the agent proposed and takes the block out of the deliverable', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const dir = path.join(b.dir, 'brands', brand.id, 'works', work.id);
    fs.writeFileSync(path.join(dir, 'oferta.md'), '---\nfunnel: Conversion, retention, conversion\n---\n# Oferta\nPrimer pedido.\n');
    const proposed = (await b.service.listUntrackedFiles(work.id)).find(f => f.fileName === 'oferta.md');
    // Listing only reads the proposal: the file is untouched until the human adopts.
    expect(proposed?.funnelStages).toEqual(['conversion', 'retention']);
    expect(fs.readFileSync(path.join(dir, 'oferta.md'), 'utf8')).toContain('funnel:');

    const adopted = await b.service.trackFile(work.id, 'oferta.md');
    expect(adopted.funnelStages).toEqual(['conversion', 'retention']);
    const content = await b.service.readDocument(adopted.id);
    expect(content.content).toBe('# Oferta\nPrimer pedido.\n');
    expect(fs.readFileSync(path.join(dir, 'oferta.md'), 'utf8')).toBe('# Oferta\nPrimer pedido.\n');
    // The tracked fingerprint is the stripped file, so it does not read as an external edit.
    expect((await b.service.documentState(adopted.id)).fingerprint).toBe(content.fingerprint);
  } finally { b.cleanup(); }
});

it('leaves a file alone when there is no usable proposal in it', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const dir = path.join(b.dir, 'brands', brand.id, 'works', work.id);
    // A client file that merely opens with a rule, and a block with no stage we know.
    const rule = '---\n\nNotas del cliente\n\n---\n\nTexto.\n';
    const unknown = '---\nfunnel: awareness\nautor: alguien\n---\n# Pieza\n';
    fs.writeFileSync(path.join(dir, 'notas.md'), rule);
    fs.writeFileSync(path.join(dir, 'pieza.md'), unknown);
    for (const [name, original] of [['notas.md', rule], ['pieza.md', unknown]] as const) {
      const doc = await b.service.trackFile(work.id, name);
      expect(doc.funnelStages).toEqual([]);
      expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(original);
    }
  } finally { b.cleanup(); }
});

it('shows the rest of the folder without pretending Latte can track it', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const dir = path.join(b.dir, 'brands', brand.id, 'works', work.id);
    fs.mkdirSync(path.join(dir, 'piezas-instagram'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'propuesta-final.docx'), 'x');
    fs.writeFileSync(path.join(dir, 'metricas.xlsx'), 'x');
    fs.writeFileSync(path.join(dir, 'suelto.md'), '# Suelto\n');
    const entries = await b.service.listFolderEntries(work.id);
    expect(entries.subfolders).toEqual(['piezas-instagram']);
    expect(entries.otherFiles).toEqual(['metricas.xlsx', 'propuesta-final.docx']);
    expect(entries.truncated).toBe(false);
    // Markdown is the adoptable list, and Latte's own managed files are not the client's material.
    expect(entries.otherFiles).not.toContain('suelto.md');
    for (const managed of ['CLAUDE.md', 'AGENTS.md', 'README.md']) expect(entries.otherFiles).not.toContain(managed);
    expect((await b.service.listUntrackedFiles(work.id)).map(f => f.fileName)).toContain('suelto.md');
  } finally { b.cleanup(); }
});

it('keeps a proposal on an already tracked document pending until the human answers', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const doc = await b.service.saveAsDocument(work.id, 'copy', 'Oferta primer pedido', '# Oferta\nPrimer pedido.\n');
    const file = path.join(b.dir, 'brands', brand.id, 'works', work.id, doc.fileName);
    // What an agent asked to organise the funnel actually does: it can only write files.
    fs.writeFileSync(file, '---\nfunnel: conversion, retention\n---\n# Oferta\nPrimer pedido.\n');

    const listed = (await b.service.listDocuments(work.id)).find(d => d.id === doc.id)!;
    expect(listed.proposedFunnelStages).toEqual(['conversion', 'retention']);
    // Pending is not applied: reading never classifies anything by itself.
    expect(listed.funnelStages).toEqual([]);
    // The block never reaches the editor, a version or an export.
    expect(fs.readFileSync(file, 'utf8')).toBe('# Oferta\nPrimer pedido.\n');
    expect((await b.service.readDocument(doc.id)).content).toBe('# Oferta\nPrimer pedido.\n');
    // And the stripped file is what Latte knows, so it does not read as an external edit.
    expect((await b.service.documentState(doc.id)).fingerprint).toBe((await b.service.readDocument(doc.id)).fingerprint);

    const applied = await b.service.applyFunnelProposal(doc.id);
    expect(applied.funnelStages).toEqual(['conversion', 'retention']);
    expect(applied.proposedFunnelStages).toEqual([]);
    await expect(b.service.applyFunnelProposal(doc.id)).rejects.toThrow(/propuesta pendiente/);
  } finally { b.cleanup(); }
});

it('dismissing a proposal leaves the stages the document already had', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const doc = await b.service.saveAsDocument(work.id, 'copy', 'Oferta', '# Oferta\n');
    await b.service.updateDocument(doc.id, { funnelStages: ['discovery'] });
    fs.writeFileSync(path.join(b.dir, 'brands', brand.id, 'works', work.id, doc.fileName), '---\nfunnel: retention\n---\n# Oferta\n');
    expect((await b.service.listDocuments(work.id)).find(d => d.id === doc.id)!.proposedFunnelStages).toEqual(['retention']);

    const kept = await b.service.dismissFunnelProposal(doc.id);
    expect(kept.funnelStages).toEqual(['discovery']);
    expect(kept.proposedFunnelStages).toEqual([]);
  } finally { b.cleanup(); }
});

it('ships the writing skill on by pointer, and the switch takes it out of the instruction file and its side file', async () => {
  const b = await makeBackend();
  try {
    const skills = await b.service.listSkills();
    expect(skills.map(s => [s.id, s.enabled])).toEqual([['writing', true]]);

    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const workDir = path.join(b.dir, 'brands', brand.id, 'works', work.id);
    const claudeFile = path.join(workDir, 'CLAUDE.md');
    const skillSideFile = path.join(workDir, '.latte', 'skills', 'writing.md');
    const withSkill = fs.readFileSync(claudeFile, 'utf8');
    expect(withSkill).toContain('latte:skill writing');
    expect(withSkill).toContain('Escritura sin relleno');
    // The body itself no longer rides the instruction file: only a pointer to it does.
    expect(withSkill).not.toContain('Prueba de portabilidad');
    expect(withSkill).toContain('read ./.latte/skills/writing.md and follow it');

    // The full body, attribution included, lives in the side file instead.
    const sideBody = fs.readFileSync(skillSideFile, 'utf8');
    expect(sideBody).toContain('Prueba de portabilidad');
    expect(sideBody).toContain('no-ai-slop');

    const off = await b.service.setSkillEnabled('writing', false);
    expect(off[0].enabled).toBe(false);
    await b.service.saveAsDocument(work.id, 'note', 'Nota', '# Nota\n');
    const without = fs.readFileSync(claudeFile, 'utf8');
    expect(without).not.toContain('latte:skill writing');
    // Turning a skill off never touches the rest of the context.
    expect(without).toContain('Tracked deliverables of this work');
    // And it cleans up the side file it is no longer pointing to.
    expect(fs.existsSync(skillSideFile)).toBe(false);

    await expect(b.service.setSkillEnabled('no-existe', true)).rejects.toThrow(/no viene con Latte/);
  } finally { b.cleanup(); }
});

it('keeps the skill out of the per-request base prompt, which has its own budget', async () => {
  const b = await makeBackend();
  try {
    // The skill rides the instruction file, written once per conversation.
    // base.md is charged on every message and stays under its own limit.
    const base = fs.readFileSync(path.join(process.cwd(), 'packs', 'marketing-core', 'base.md'), 'utf8');
    expect(base).not.toContain('Prueba de portabilidad');
    expect(base.length).toBeLessThan(6_000);
    const skill = fs.readFileSync(path.join(process.cwd(), 'packs', 'marketing-core', 'skills', 'writing.md'), 'utf8');
    expect(skill.length).toBeGreaterThan(1_000);
  } finally { b.cleanup(); }
});

it('an agent can ask for a role, and asking never opens anything', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const dir = path.join(b.dir, 'brands', brand.id, 'works', work.id);
    // The only channel an agent has: it writes a file.
    fs.writeFileSync(path.join(dir, 'para-paid.md'), '---\npara: paid-media\n---\nRevisar el presupuesto de octubre contra el objetivo de 40 pruebas.\n');
    fs.writeFileSync(path.join(dir, 'para-nadie.md'), '---\npara: no-existe\n---\nAlgo.\n');

    const pending = await b.service.listHandoffs(work.id);
    expect(pending.map(h => [h.roleId, h.known])).toEqual([['no-existe', false], ['paid-media', true]]);
    expect(pending.find(h => h.roleId === 'paid-media')!.request).toMatch(/presupuesto de octubre/);
    expect(pending.find(h => h.roleId === 'paid-media')!.roleName).toBe('Paid Media');
    // Reading is reading: no member was opened and the files are still there.
    expect(await b.service.listTeam(work.id)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'para-paid.md'))).toBe(true);

    await b.service.dismissHandoff(work.id, 'para-paid.md');
    expect(fs.existsSync(path.join(dir, 'para-paid.md'))).toBe(false);
    expect((await b.service.listHandoffs(work.id)).map(h => h.roleId)).toEqual(['no-existe']);
    await expect(b.service.dismissHandoff(work.id, 'para-paid.md')).rejects.toThrow(/ya no está/);
  } finally { b.cleanup(); }
});

it('tells each agent who is on the team and who could be called in', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const claude = fs.readFileSync(path.join(b.dir, 'brands', brand.id, 'works', work.id, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('The team on this work');
    expect(claude).toContain('Roles that could be called in');
    // An agent that cannot see the roster cannot ask for anyone.
    expect(claude).toContain('`paid-media`');
    expect(claude).toContain('para: <role id>');
    expect(claude).toContain('you cannot read what they said');
  } finally { b.cleanup(); }
});

it('a handoff resolves against whatever roles exist, including profiles you made yourself', async () => {
  const b = await makeBackend();
  try {
    // A profile that ships with nothing: created here, in Settings, by a person.
    await b.service.saveProfile({ id: 'crm-lifecycle', name: 'CRM y ciclo de vida', initial: 'C', summary: 'Correo, retención y reactivación.', soul: '# Soul', skills: '' }, null);
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    const dir = path.join(b.dir, 'brands', brand.id, 'works', work.id);

    // The instruction file offers it like any other role: nothing here is a fixed list.
    const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('`crm-lifecycle` — CRM y ciclo de vida');

    fs.writeFileSync(path.join(dir, 'para-crm.md'), '---\npara: crm-lifecycle\n---\nArmar el correo de reactivación a 60 días.\n');
    const [handoff] = await b.service.listHandoffs(work.id);
    expect([handoff.roleId, handoff.known, handoff.roleName]).toEqual(['crm-lifecycle', true, 'CRM y ciclo de vida']);
    // And it opens: the same path a shipped role takes.
    expect((await b.service.listRoles()).map(r => r.id)).toContain('crm-lifecycle');
  } finally { b.cleanup(); }
});
