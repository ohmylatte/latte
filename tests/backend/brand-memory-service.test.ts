import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRAND_MEMORY_FILE } from '../../electron/workspace/brandMemory';
import { makeBackend, type TestBackend } from './helpers';

function readAgents(b: TestBackend, brandId: string, workId: string): string {
  return fs.readFileSync(path.join(b.dir, 'brands', brandId, 'works', workId, 'AGENTS.md'), 'utf8');
}

function readSide(b: TestBackend, brandId: string, workId: string): string {
  return fs.readFileSync(path.join(b.dir, 'brands', brandId, 'works', workId, ...BRAND_MEMORY_FILE.split('/')), 'utf8');
}

describe('brand memory inheritance through createWork / refreshInstructions', () => {
  let b: TestBackend;
  beforeEach(async () => { b = await makeBackend(); });
  afterEach(() => b.cleanup());

  it('injects approved context, funnel and origin from a previous work of the same brand', async () => {
    const bruma = await b.service.createBrand('Bruma Café');
    await b.service.updateBrand(bruma.id, 'Tono directo, sin muletillas. Café de especialidad en CABA.');
    const onboarding = await b.service.createWork(bruma.id, 'Onboarding');
    await b.service.saveBrief(onboarding.id, '# Onboarding\n\nDefinir posicionamiento y embudo de Bruma.');
    await b.service.addDecision(onboarding.id, 'Audiencia primaria: mujeres 25-40 en CABA.');
    const strategy = await b.service.createDocument(onboarding.id, 'strategy', 'Embudo de marca');
    await b.service.saveDocument(strategy.document.id, '# Embudo de marca\n\nTOFU awareness, MOFU consideration.', strategy.fingerprint);
    await b.service.updateDocument(strategy.document.id, { funnelStages: ['consideration', 'conversion'] });

    const paid = await b.service.createWork(bruma.id, 'Paid Media Q2');
    const agents = readAgents(b, bruma.id, paid.id);
    expect(agents).toContain('Tono directo, sin muletillas.');
    expect(agents).toContain('Brand knowledge from previous work');
    expect(agents).toContain('Audiencia primaria: mujeres 25-40 en CABA.');
    expect(agents).toContain(`from work "Onboarding" (\`${onboarding.id}\`)`);
    expect(agents).toContain('Embudo de marca');
    expect(agents).toContain('funnel: consideration, conversion');
    expect(agents).toContain('Do not claim you lack brand context');
    expect(agents).toContain(BRAND_MEMORY_FILE.replace(/\\/g, '/'));
    expect(agents).toContain('No decisions recorded yet in this work.');
    expect(readSide(b, bruma.id, paid.id)).toContain('Audiencia primaria: mujeres 25-40 en CABA.');

    const firstWork = readAgents(b, bruma.id, onboarding.id);
    expect(firstWork).not.toContain('## Brand knowledge from previous work');
  });

  it('never leaks another brand into the snapshot', async () => {
    const bruma = await b.service.createBrand('Bruma Café');
    const onboarding = await b.service.createWork(bruma.id, 'Onboarding');
    await b.service.addDecision(onboarding.id, 'Audiencia Bruma: CABA.');

    const rival = await b.service.createBrand('Marca Rival');
    await b.service.updateBrand(rival.id, 'SECRET_RIVAL_POSITIONING');
    const rivalWork = await b.service.createWork(rival.id, 'Plan rival');
    await b.service.addDecision(rivalWork.id, 'SECRET_RIVAL_BUDGET_900k');
    const rivalDoc = await b.service.createDocument(rivalWork.id, 'strategy', 'Plan secreto');
    await b.service.saveDocument(rivalDoc.document.id, '# Plan\n\nSECRET_RIVAL_CREATIVE', rivalDoc.fingerprint);

    const paid = await b.service.createWork(bruma.id, 'Paid Media Q2');
    const agents = readAgents(b, bruma.id, paid.id);
    const side = readSide(b, bruma.id, paid.id);
    for (const text of [agents, side]) {
      expect(text).toContain('Audiencia Bruma: CABA.');
      expect(text).not.toContain('SECRET_RIVAL_BUDGET_900k');
      expect(text).not.toContain('SECRET_RIVAL_POSITIONING');
      expect(text).not.toContain('SECRET_RIVAL_CREATIVE');
      expect(text).not.toContain(rivalWork.id);
    }
  });

  it('shows local current decisions and inherited ones with origin after opening a new session', async () => {
    const bruma = await b.service.createBrand('Bruma Café');
    const onboarding = await b.service.createWork(bruma.id, 'Onboarding');
    await b.service.addDecision(onboarding.id, 'Canal orgánico primero: Instagram.');
    const paid = await b.service.createWork(bruma.id, 'Paid Media Q2');
    await b.service.addDecision(paid.id, 'Pausar Advantage+ esta semana.');
    fs.writeFileSync(path.join(b.dir, 'brands', bruma.id, 'works', paid.id, 'nota.md'), '# Nota\n');
    await b.service.trackFile(paid.id, 'nota.md');

    const agents = readAgents(b, bruma.id, paid.id);
    expect(agents).toContain('Pausar Advantage+ esta semana.');
    expect(agents).toContain(`from work "Onboarding" (\`${onboarding.id}\`): Canal orgánico primero: Instagram.`);
    const inheritedHeading = agents.indexOf('Brand knowledge from previous work');
    const localHeading = agents.indexOf('Decisions already taken in this work');
    expect(inheritedHeading).toBeGreaterThan(-1);
    expect(localHeading).toBeGreaterThan(inheritedHeading);
    expect(agents.indexOf('Pausar Advantage+ esta semana.')).toBeGreaterThan(localHeading);
    expect(readSide(b, bruma.id, paid.id)).not.toContain('Pausar Advantage+ esta semana.');
  });

  it('does not inherit pending decisions and truncates a large inherited catalog to pointers', async () => {
    const bruma = await b.service.createBrand('Bruma Café');
    const onboarding = await b.service.createWork(bruma.id, 'Onboarding');
    const chatId = 'ses_brand_memory';
    const at = new Date().toISOString();
    b.repo.insertMember({
      id: chatId, workId: onboarding.id, roleId: 'strategist', roleName: 'Strategist', initial: 'S',
      runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at,
    });
    const pending = await b.service.proposeDecisionFromAgent(chatId, 'msg_pend', {
      statement: 'Probar radio AM de madrugada.',
      rationale: '',
      clientRequestId: 'req_pend',
    });
    expect(pending?.status).toBe('pending');
    for (let i = 0; i < 14; i += 1) {
      await b.service.addDecision(onboarding.id, `Decision heredada numero ${i} sobre el mix de canales y presupuesto.`);
    }

    const paid = await b.service.createWork(bruma.id, 'Paid Media Q2');
    const agents = readAgents(b, bruma.id, paid.id);
    const side = readSide(b, bruma.id, paid.id);
    expect(agents).not.toContain('Probar radio AM de madrugada.');
    expect(side).not.toContain('Probar radio AM de madrugada.');
    expect(agents).toMatch(/earlier inherited decisions are recorded in \.\/\.latte\/context\/brand-memory\.md/);
    expect(agents.match(/Decision heredada numero/g)).toHaveLength(10);
    expect(side.match(/Decision heredada numero/g)).toHaveLength(14);
  });
});
