import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ProfileStore } from '../../electron/agents/profiles';
import { RoleCatalog } from '../../electron/agents/roles';
import { loadInstructionPack } from '../../electron/workspace/packs';
import { makeTempDir, removeDir } from './helpers';

const packsDir = path.resolve(__dirname, '../../packs');
const pack = loadInstructionPack(packsDir, 'marketing-core');
const catalog = new RoleCatalog(pack);

it('loads Sales Copywriter from the manifest as a shipped, cloneable profile', () => {
  const profile = catalog.listProfiles().find((item) => item.id === 'sales-copywriter');
  expect(pack?.version).toBe('0.8.1');
  expect(profile).toMatchObject({ name: 'Sales Copywriter', initial: 'C', source: 'builtin', directory: null });
  expect(catalog.list().filter((item) => item.id === 'sales-copywriter')).toHaveLength(1);
  expect(profile?.soul).toContain('# Role: Sales Copywriter');

  const raw = fs.readFileSync(path.join(packsDir, 'marketing-core/roles/sales-copywriter.md'), 'utf8');
  expect(raw.length).toBeLessThan(8_000); // The role loader truncates longer files.
  expect(raw).toContain('Convertí briefs');
  expect(raw).toContain('preserves `ñ`, accents, `¿` and `¡` in UTF-8');

  const dir = makeTempDir();
  try {
    const editable = new RoleCatalog(pack, new ProfileStore(path.join(dir, 'agents')));
    expect(() => editable.saveProfile({
      id: profile!.id,
      name: profile!.name,
      initial: profile!.initial,
      summary: profile!.summary,
      soul: profile!.soul,
      skills: profile!.skills,
    }, null)).toThrow(/read-only/i);
    editable.saveProfile({
      id: 'my-sales-copywriter',
      name: profile!.name,
      initial: profile!.initial,
      summary: profile!.summary,
      soul: profile!.soul,
      skills: profile!.skills,
    }, null);
    expect(editable.promptFor('my-sales-copywriter')).toContain('# Role: Sales Copywriter');
  } finally { removeDir(dir); }
});

it('composes the shared marketing contract before the Sales Copywriter role', () => {
  const prompt = catalog.promptFor('sales-copywriter');
  expect(prompt).toContain('acting as: Sales Copywriter');
  expect(prompt.indexOf('marketing, not on software')).toBeLessThan(prompt.indexOf('# Role: Sales Copywriter'));
  expect(prompt).not.toContain('# Role: Paid Media');
});

// Lexical contract checks ensure these safeguards reach the runtime prompt.
it.each([
  /offer, audience\/problem and desired next step/i,
  /funnel and awareness as distinct decisions/i,
  /### Ads[\s\S]*### Email[\s\S]*### Landing or sales page[\s\S]*### VSL[\s\S]*### Reel or short video/,
  /Dominant angle and big idea/,
  /Final copy:[\s\S]*complete and ready to paste/,
  /A\/B proposal:[\s\S]*hypothesis[\s\S]*KPI[\s\S]*guardrail/,
  /Never silently choose a price, guarantee, deadline, testimonial, statistic or product capability/,
  /Do not invent capabilities, customers, research, scarcity, urgency, guarantees, bonuses, prices or deadlines/,
  /Drafting is not authorization to publish, send or launch/,
  /Spanish \(Argentina\) or English \(United States\)/,
])('includes the Sales Copywriter delivery and integrity contract: %s', (pattern) => {
  expect(catalog.get('sales-copywriter')!.instructions).toMatch(pattern);
});
