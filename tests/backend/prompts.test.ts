import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { RoleCatalog } from '../../electron/agents/roles';
import { ClaudeChatAdapter } from '../../electron/agents/claude/claudeAdapter';
import { CodexChatAdapter } from '../../electron/agents/codex/codexAdapter';
import { loadInstructionPack } from '../../electron/workspace/packs';
import { makeBackend, makeTempDir, removeDir, fakeRunner, type TestBackend } from './helpers';
import { startFakeOpenCode, type FakeOpenCode } from './fakeOpenCode';

const PACKS_DIR = path.resolve(__dirname, '..', '..', 'packs');
const FAKE_CLAUDE = path.resolve(__dirname, 'fakeClaude.cjs');
const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');
const pack = loadInstructionPack(PACKS_DIR, 'marketing-core');
const catalog = new RoleCatalog(pack);

/**
 * The behaviours the base prompt must carry. These are lexical checks on the
 * text Latte composes: they prove the instructions REACH each runtime, not
 * that a live model obeys them. Model behaviour is evaluated separately with
 * the fixtures in docs/marketing-eval.
 */
const BASE_MARKERS: Array<[string, RegExp]> = [
  ['marketing before code', /marketing, not on software/i],
  ['user language', /Answer in the user's language/i],
  ['goal', /\*\*Goal\*\*/],
  ['audience', /\*\*Audience\*\*/],
  ['offer', /\*\*Offer\*\*/],
  ['funnel stage', /\*\*Funnel stage\*\*/],
  ['baseline and KPI', /\*\*Baseline and KPI\*\*/],
  ['constraints', /\*\*Constraints\*\*/],
  ['no forced questionnaire', /never impose a framework|Never open with a long\s+questionnaire/i],
  ['fact vs hypothesis vs decision', /\*\*fact\*\*[\s\S]{0,120}\*\*hypothesis\*\*[\s\S]{0,120}\*\*decision\*\*/],
  ['evidence and sample size', /how many observations/i],
  ['brand approved vs proposed', /brand-approved[\s\S]{0,120}proposing/i],
  ['real deliverables', /Produce the actual deliverable/i],
  ['review and next step', /what is still assumed, and the next concrete step/i],
  ['experiment guardrail', /\*\*guardrail\*\*/],
  ['review cadence', /\*\*review cadence\*\*/],
  ['no publishing without authority', /may not publish, send, spend/i],
  ['no credentials in deliverables', /never write credentials/i],
  ['no borrowed credit', /Never present work as done by another member or role/i],
  ['propose coordinating instead of doing it all alone', /latte_request_coordination/],
];

describe('Marketing base prompt composition', () => {
  it('ships a base that covers the behaviours the product promises', () => {
    expect(pack).not.toBeNull();
    expect(catalog.hasBase).toBe(true);
    const assistant = catalog.promptFor('assistant');
    for (const [name, pattern] of BASE_MARKERS) {
      expect(pattern.test(assistant), `base prompt is missing: ${name}`).toBe(true);
    }
    // Compact on purpose: a long prompt per request is a cost and a distraction.
    // Measured on the pack's base, which is what every role pays for: the
    // assistant now layers its own rule on top and has its own ceiling below.
    expect((pack?.base ?? '').trim().length).toBeLessThan(7_500);
  });

  /**
   * THE ASSISTANT DOES NOT DO ANOTHER ROLE'S WORK.
   *
   * Real use: with a connection wired (The Agentcy), the owner asked for the
   * pieces of a campaign and the assistant composed them itself -- the
   * Community Manager's job -- instead of proposing coordination with the hire
   * and dispatching. Having the tool is not having the role.
   *
   * Asserted line by line so a CRLF never breaks a marker, and the composed
   * prompt keeps a ceiling of its own: it is charged on every message.
   */
  it('tells the neutral assistant to coordinate instead of doing another role work', () => {
    const assistant = catalog.promptFor('assistant');
    const lines = assistant.split(/\r?\n/).map((line) => line.trim());
    const has = (pattern: RegExp) => lines.some((line) => pattern.test(line));
    expect(has(/^# Another role's work is not yours$/), 'the section').toBe(true);
    expect(has(/you do not do it yourself/), 'the rule itself').toBe(true);
    expect(has(/latte_request_coordination.*including the hires/), 'the way out, with the hires').toBe(true);
    expect(has(/grants access to a tool, never a role/), 'a connected tool does not grant a role').toBe(true);
    // El techo del asistente es el de la base MÁS el presupuesto de su propia
    // regla. Son dos cuentas distintas a propósito: la base la paga cada
    // miembro en cada mensaje; esto lo paga sólo el punto de partida.
    expect(assistant.length).toBeLessThan(7_500 + 700);
  });

  it('gives the neutral assistant the base and nothing role-specific', () => {
    const assistant = catalog.promptFor('assistant');
    expect(assistant).toContain('marketing, not on software');
    expect(assistant).not.toContain('acting as:');
    for (const role of ['strategist', 'researcher', 'analyst', 'paid-media', 'reviewer']) {
      expect(assistant).not.toContain(`# Role: ${role[0].toUpperCase()}${role.slice(1)}`);
    }
  });

  it('layers each role on top of the base without replacing it', () => {
    for (const role of ['strategist', 'researcher', 'analyst', 'paid-media', 'reviewer']) {
      const prompt = catalog.promptFor(role);
      expect(prompt, role).toContain('marketing, not on software');
      expect(prompt, role).toContain('acting as:');
      expect(prompt, role).toContain('# Role:');
      // Base first, role second: the specific narrows the general.
      expect(prompt.indexOf('marketing, not on software')).toBeLessThan(prompt.indexOf('# Role:'));
    }
    // An unknown role still gets the marketing behaviour instead of nothing.
    expect(catalog.promptFor('does-not-exist')).toContain('marketing, not on software');
  });

  it('degrades honestly when a build has no pack', () => {
    const empty = new RoleCatalog(null);
    expect(empty.hasBase).toBe(false);
    // Sin pack no hay comportamiento de marketing que repartir. Lo único que
    // queda es la regla propia del asistente, que no sale del pack: no hacer
    // el trabajo de otro rol vale igual en un build sin disciplina cargada.
    expect(empty.promptFor('assistant')).not.toContain('marketing, not on software');
    expect(empty.promptFor('assistant')).toContain("Another role's work is not yours");
    expect(empty.list().map((r) => r.id)).toEqual(['assistant']);
  });

  it('does not claim Latte intercepts writes it cannot intercept', () => {
    const workspaceContext = pack?.body ?? '';
    expect(workspaceContext).not.toMatch(/Latte keeps both versions when two writers disagree/);
    expect(workspaceContext).toMatch(/not intercepted|does NOT apply to a write you make directly/i);
    // Pack header and manifest agree on the version.
    expect(workspaceContext).not.toMatch(/Marketing core \/ 0\.\d/);
    expect(pack?.version).toBe(JSON.parse(fs.readFileSync(path.join(PACKS_DIR, 'marketing-core', 'manifest.json'), 'utf8')).version);
  });
});

/**
 * Autonomous-coordination Phase 7 task 7.12: when a human asks the
 * strategist to coordinate the team, it must PROPOSE a concrete plan with
 * `latte_request_coordination` instead of ever answering that it lacks
 * permissions or asking the human to configure something first — proposing
 * IS how it asks (`latte/coordination-wow-entrypoint`). Smoke test only:
 * proves the role still parses via `RoleCatalog.promptFor()` and that the
 * composed prompt names the tool. Model behaviour is out of scope here.
 */
describe('Strategist proposes coordination instead of asking for permissions (task 7.12)', () => {
  it('names the exact tool the human approval routes through', () => {
    const prompt = catalog.promptFor('strategist');
    expect(prompt).toContain('latte_request_coordination');
  });

  it('never tells the human to configure something first — proposing is the ask', () => {
    const prompt = catalog.promptFor('strategist');
    expect(prompt).toMatch(/propose a concrete plan/i);
    expect(prompt).toMatch(/never answer that you lack permissions|ask the human to configure/i);
  });

  it('still layers on top of the base prompt without breaking it', () => {
    const prompt = catalog.promptFor('strategist');
    expect(prompt).toContain('marketing, not on software');
    expect(prompt).toContain('# Role: Strategist');
  });
});

describe('The base prompt reaches every runtime', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => removeDir(dir));

  it('Claude Code receives it as an appended system prompt file', async () => {
    const spawned: string[][] = [];
    const adapter = new ClaudeChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.263' }),
      emit: () => {},
      accountEnv: () => ({}),
      promptDir: path.join(dir, 'prompts'),
      spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => { spawned.push(args); return spawn(file, [FAKE_CLAUDE, ...args], options); }) as typeof spawn,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
    });
    try {
      await adapter.start({ workId: 'wrk_1', chatId: 'mem_assistant', roleId: 'assistant', roleName: 'Asistente', instructions: catalog.promptFor('assistant'), directory: dir, title: 't', label: 'Claude Code' });
      const flag = spawned[0].indexOf('--append-system-prompt-file');
      expect(flag).toBeGreaterThan(-1);
      expect(fs.readFileSync(spawned[0][flag + 1], 'utf8')).toContain('marketing, not on software');
    } finally {
      adapter.shutdown();
    }
  });

  it('Codex receives it as developer instructions on the thread', async () => {
    const events: ChatEvent[] = [];
    const adapter = new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.153.4' }),
      emit: (e) => events.push(e),
      accountEnv: (): Record<string, string> => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(file, [FAKE_CODEX, ...args], options)) as typeof spawn,
      requestTimeoutMs: 5_000,
    });
    try {
      await adapter.start({ workId: 'wrk_1', chatId: 'mem_assistant', roleId: 'assistant', roleName: 'Asistente', instructions: 'MARKETING-BASE-MARKER', directory: dir, title: 't', label: 'Codex' });
      await adapter.send('mem_assistant', 'hola');
      const started = Date.now();
      while (!events.some((e) => e.type === 'status' && e.status === 'idle')) {
        if (Date.now() - started > 6_000) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
      }
      // The fake echoes the developer instructions it received on the thread.
      expect(adapter.listMessages('mem_assistant')[1].parts[0]).toMatchObject({ text: 'Echo: hola [dev: MARKETING-BASE-MARKER]' });
    } finally {
      adapter.shutdown();
    }
  });
});

describe('OpenCode: the base prompt travels with every message', () => {
  let fake: FakeOpenCode;
  let b: TestBackend;

  beforeEach(async () => {
    fake = await startFakeOpenCode();
    b = await makeBackend({
      chatEndpoint: fake.endpoint,
      runner: fakeRunner((file, args) => ((file === 'where.exe' || file === 'which') && args[0] === 'opencode' ? { code: 0, stdout: 'C:\\npm\\opencode.exe\n' } : { code: 0, stdout: '1.18.26\n' })),
      emitChat: () => {},
    });
  });

  afterEach(async () => { b.cleanup(); await fake.close(); });

  it('sends it for the assistant and for a named role', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');

    const assistant = await b.service.addTeamMember(work.id, 'assistant', null);
    await b.service.sendChat(assistant.id, 'Hola');
    const first = (fake.requests.filter((r) => r.path.endsWith('/prompt_async')).at(-1)?.body ?? {}) as { system?: string };
    expect(first.system).toContain('marketing, not on software');
    expect(first.system).not.toContain('acting as:');

    const strategist = await b.service.addTeamMember(work.id, 'strategist', null);
    await b.service.sendChat(strategist.id, 'Hola');
    const second = (fake.requests.filter((r) => r.path.endsWith('/prompt_async')).at(-1)?.body ?? {}) as { system?: string };
    expect(second.system).toContain('marketing, not on software');
    expect(second.system).toContain('acting as: Strategist');
  });

  it('renders the workspace context into the instruction files as well', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    await b.service.addTeamMember(work.id, 'assistant', null);
    const dir = b.files.workDir(brand.id, work.id);
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const rendered = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(rendered).toContain('latte:pack marketing-core@');
      expect(rendered).toContain('Tracked deliverables of this work');
      expect(rendered).toMatch(/not intercepted/);
    }
  });
});

describe('Behaviour evaluation fixtures', () => {
  const file = path.resolve(__dirname, '..', '..', 'docs', 'marketing-eval', 'fixtures.json');
  const suite = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    purpose: string;
    cases: Array<{ id: string; title: string; task: string; prompt: string; expected: string[]; mustNot: string[] }>;
  };

  it('covers the six marketing tasks with usable, self-contained cases', () => {
    expect(suite.cases).toHaveLength(6);
    expect(suite.cases.map((c) => c.task).sort()).toEqual(['copy', 'followup', 'growth', 'results', 'strategy', 'strategy']);
    // The two named in the brief: missing data and a brand violation.
    expect(suite.cases.map((c) => c.id)).toContain('missing-data');
    expect(suite.cases.map((c) => c.id)).toContain('brand-violation');
    const ids = new Set<string>();
    for (const c of suite.cases) {
      expect(ids.has(c.id), `duplicate fixture id ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(c.prompt.trim().length, c.id).toBeGreaterThan(10);
      expect(c.expected.length, c.id).toBeGreaterThanOrEqual(3);
      expect(c.mustNot.length, c.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('says out loud that it does not verify live model behaviour', () => {
    expect(suite.purpose).toMatch(/not automated assertions|no lexical test/i);
    const readme = fs.readFileSync(path.resolve(path.dirname(file), 'README.md'), 'utf8');
    expect(readme).toMatch(/Pendiente/);
    expect(readme).toMatch(/Nunca uses una marca real/);
  });
});
