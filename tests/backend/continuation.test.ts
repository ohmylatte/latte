import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, ChatMessage, Decision, Work } from '../../shared/contracts';
import { TranscriptStore } from '../../electron/agents/transcripts';
import { openDriver } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { briefObjective, openItems, relevantMessages, renderContinuation, type ContinuationInput } from '../../electron/workspace/continuation';
import { DELIVERABLES_DIR } from '../../electron/workspace/deliverables';
import { fakeRunner, makeBackend, makeTempDir, removeDir, type TestBackend } from './helpers';
import { startFakeOpenCode, type FakeOpenCode } from './fakeOpenCode';

const AT = '2026-09-10T12:00:00.000Z';

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const message = (id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, chatId: 'mem_src', role, parts: text ? [{ type: 'text', id: `p_${id}`, text }] : [], createdAt: AT, completed: true, error: null, ...extra,
});

const decision = (id: string, text: string, status: Decision['status'], rationale = ''): Decision => ({
  id, workId: 'wrk_1', text, rationale, alternativesRejected: [], evidenceRefs: [], status,
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null }, clientRequestId: null, fingerprint: '', createdAt: AT, decidedAt: AT,
});

function input(overrides: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    locale: 'es-AR',
    brandName: 'Casa Oliva',
    workTitle: 'Lanzamiento',
    directory: '/datos/works/wrk_1',
    ownFolder: false,
    source: { memberId: 'mem_src', roleName: 'Strategist', label: 'Claude Code · Cuenta A', runtime: 'claude', working: false },
    brief: '# Lanzamiento\n\n## Objetivo\nVender la colección de otoño.\n',
    outcome: { expectedOutput: null, resultPath: null, resultExists: false },
    decisions: [decision('dec_1', 'Elegimos Instagram.', 'approved', 'Ahí está la audiencia.')],
    documents: [{ fileName: 'brief.md', title: 'Lanzamiento', kind: 'brief', status: 'draft', baseFileName: null, baseOutdated: false, proposalPending: false, openItems: [] }],
    deliverables: [],
    conversation: { messages: [], exposed: true },
    untracked: [],
    asks: [],
    ...overrides,
  };
}

describe('hand-over renderer', () => {
  it('takes the goal from the brief, or its first paragraph, and never the whole brief', () => {
    expect(briefObjective('# T\n\n_Brief de lanzamiento_\n\n## 01 / Objetivo\nPresentar   la colección\na quienes eligen menos.\n\n## 02 / Audiencia\nOtra cosa')).toBe('Presentar la colección a quienes eligen menos.');
    expect(briefObjective('# T\n\nUn párrafo que dice qué es.\nSigue acá.\n\n## Otro\nNo')).toBe('Un párrafo que dice qué es. Sigue acá.');
    expect(briefObjective('## Goal\nShip it.')).toBe('Ship it.');
    expect(briefObjective('# Solo el título\n\n')).toBe('');
    expect(briefObjective(`## Objetivo\n${'palabra '.repeat(400)}`).length).toBeLessThanOrEqual(600);
  });

  it('finds open items a document states, not ordinary words or code', () => {
    const doc = '- [ ] Incorporar entrevistas\n- [x] Hecho\nEsto queda pendiente de revisar\n- Audiencia: PENDIENTE — falta la edad\n```\nTODO dentro de un bloque\n```\n* [ ] Dos';
    expect(openItems(doc)).toEqual(['[ ] Incorporar entrevistas', 'Audiencia: PENDIENTE — falta la edad', '[ ] Dos']);
  });

  it('quotes only the last text turns, without decision blocks or an earlier hand-over', () => {
    const earlier = renderContinuation(input());
    const quotes = relevantMessages([
      message('m0', 'user', earlier),
      message('m1', 'user', 'Uno'),
      message('m2', 'assistant', 'Dos\n```latte-decision\n{"statement":"x"}\n```\n```latte-brand-context\n{"text":"oculto"}\n```'),
      message('m3', 'assistant', ''),
      message('m4', 'user', 'Tres'),
      message('m5', 'assistant', 'Cuatro'),
      message('m6', 'user', 'Cinco'),
    ]);
    expect(quotes.map((q) => q.text)).toEqual(['Dos', 'Tres', 'Cuatro', 'Cinco']);
  });

  it('is deterministic, names files instead of pasting them, and lists what is still open', () => {
    const long = `${'A'.repeat(400)} medio ${'B'.repeat(900)} final`;
    const data = input({
      decisions: [decision('dec_1', 'Elegimos Instagram.', 'approved', 'Ahí está la audiencia.'), decision('dec_2', 'Probar un sorteo.', 'pending'), decision('dec_3', 'Descartado.', 'rejected')],
      documents: [
        { fileName: 'brief.md', title: 'Lanzamiento', kind: 'brief', status: 'draft', baseFileName: null, baseOutdated: false, proposalPending: false, openItems: ['[ ] Entrevistas'] },
        { fileName: 'calendar.md', title: 'Calendario', kind: 'calendar', status: 'review', baseFileName: 'strategy.md', baseOutdated: true, proposalPending: true, openItems: [] },
      ],
      deliverables: ['grilla.xlsx', 'propuesta.pdf'],
      conversation: { exposed: true, messages: [message('m1', 'user', 'Seguí con el calendario'), message('m2', 'assistant', long), message('m3', 'assistant', '', { error: 'You have hit your usage limit' })] },
      untracked: ['ideas.md'],
      asks: [{ roleName: 'Reviewer', request: 'Revisá el calendario\nDetalle' }],
    });
    const text = renderContinuation(data);
    expect(renderContinuation(data)).toBe(text);
    expect(text.startsWith('# Traspaso de trabajo · Casa Oliva · Lanzamiento\n')).toBe(true);
    expect(text).toContain('Origen: Strategist · Claude Code · Cuenta A (conversación `mem_src`; sigue intacta en Latte).');
    expect(text).toContain('Carpeta del trabajo: `/datos/works/wrk_1` (la administra Latte).');
    expect(text).toContain('Vender la colección de otoño.');
    expect(text).toContain('- 2026-09-10 — Elegimos Instagram. (por qué: Ahí está la audiencia.)');
    expect(text).not.toContain('Descartado.');
    expect(text).toContain('- `./calendar.md` — Calendario (calendario, en revisión, se basa en `./strategy.md`)');
    expect(text).toContain('Entregables en `./entregables/`: grilla.xlsx, propuesta.pdf');
    expect(text).toContain('> **Persona:**\n> Seguí con el calendario');
    expect(text).toContain(' […] ');
    expect(text).not.toContain('B'.repeat(900));
    expect(text).toContain('> **Strategist:** (terminó con error: You have hit your usage limit)');
    for (const line of [
      '- El último turno de Strategist terminó con error: You have hit your usage limit',
      '- Decisión propuesta, sin aprobar: Probar un sorteo.',
      '- `./calendar.md` se basa en una versión anterior de `./strategy.md`: revisalo contra la actual.',
      '- `./calendar.md` está en revisión.',
      '- `./calendar.md` tiene una propuesta de etapas del embudo sin responder.',
      '- `./ideas.md` está en la carpeta pero todavía no es un documento de Latte.',
      '- Un agente pidió sumar a Reviewer: Revisá el calendario',
      '- `./brief.md`: [ ] Entrevistas',
    ]) expect(text).toContain(line);
    expect(text).not.toContain('Detalle');
  });

  it('bounds long logs and says plainly when the runtime keeps the conversation to itself', () => {
    const many = Array.from({ length: 45 }, (_, i) => decision(`dec_${i}`, `Decisión ${i}`, 'approved'));
    const text = renderContinuation(input({ decisions: many, conversation: { messages: [], exposed: false }, source: { memberId: 'mem_src', roleName: 'Analyst', label: 'Codex · mi sesión', runtime: 'codex', working: false } }));
    expect(text).toContain('Decisión 29');
    expect(text).not.toContain('Decisión 30');
    expect(text).toContain('…y 15 más en Latte.');
    expect(text).toContain('Codex guarda su historial adentro de la conversación: este traspaso no incluye mensajes.');
    expect(text).toContain('Latte no encontró bloqueos ni pendientes registrados.');
  });

  it('speaks the language the work was created in', () => {
    const text = renderContinuation(input({ locale: 'en-US', ownFolder: true, source: { memberId: 'mem_src', roleName: 'Strategist', label: 'OpenCode', runtime: 'opencode', working: true } }));
    expect(text.startsWith('# Work hand-over · Casa Oliva · Lanzamiento')).toBe(true);
    expect(text).toContain('## Approved decisions (do not reopen them)');
    expect(text).toContain('(chosen by the human)');
    expect(text).toContain('Strategist is still answering in its own conversation');
  });

  it('leaves the outcome out when the human set none, so the hand-over reads as before', () => {
    const text = renderContinuation(input());
    expect(renderContinuation(input({ outcome: { expectedOutput: '   ', resultPath: null, resultExists: false } }))).toBe(text);
    expect(text).not.toContain('## Resultado esperado');
    expect(renderContinuation(input({ locale: 'en-US' }))).not.toContain('## Expected output');
  });

  it('carries the closing contract, with a linked result that is in the folder', () => {
    const text = renderContinuation(input({ outcome: { expectedOutput: 'La propuesta en PDF y un Word editable.', resultPath: 'propuesta.pdf', resultExists: true } }));
    expect(text).toContain('## Resultado esperado (lo que cierra el trabajo)\n\nLa propuesta en PDF y un Word editable.\n');
    expect(text).toContain('- Se pidió como PDF y DOCX: el trabajo cierra con un .pdf real y un .docx real en `./entregables/`, no con Markdown renombrado ni con el contenido en el chat.');
    expect(text).toContain('- Entregable vinculado como resultado: `./entregables/propuesta.pdf` (está en la carpeta; una versión nueva va en un archivo nuevo al lado).');
    expect(text).not.toContain('ya no está en la carpeta');
    // The goal first, then what closes it, then what was already decided.
    expect(text.indexOf('## Brief y objetivo')).toBeLessThan(text.indexOf('## Resultado esperado'));
    expect(text.indexOf('## Resultado esperado')).toBeLessThan(text.indexOf('## Decisiones aprobadas'));
  });

  it('says when the linked result left the folder, and when nothing is linked yet', () => {
    const gone = renderContinuation(input({ outcome: { expectedOutput: 'Tres posteos para Instagram', resultPath: 'posteos.pdf', resultExists: false } }));
    expect(gone).toContain('- Entregable vinculado como resultado: `./entregables/posteos.pdf`, pero ya no está en la carpeta: avisalo antes de apoyarte en él.');
    expect(gone).not.toContain('(está en la carpeta');
    // Formats come from what the human asked for, not from the linked file's extension.
    expect(gone).not.toContain('Se pidió como');
    expect(renderContinuation(input({ outcome: { expectedOutput: 'Tres posteos para Instagram', resultPath: null, resultExists: false } }))).toContain('- Todavía no hay un entregable vinculado como resultado.');
    // A link with no written expected output still closes on that file.
    const onlyLink = renderContinuation(input({ outcome: { expectedOutput: null, resultPath: 'propuesta.pdf', resultExists: true } }));
    expect(onlyLink).toContain('_Todavía no está escrito: preguntá cuál es el resultado concreto sólo si eso te bloquea._');
    expect(onlyLink).toContain('`./entregables/propuesta.pdf` (está en la carpeta;');
  });

  it('states the closing contract in English for an English work', () => {
    const outcome = { expectedOutput: 'A two-page PDF proposal.', resultPath: 'proposal.pdf', resultExists: true };
    const present = renderContinuation(input({ locale: 'en-US', outcome }));
    expect(present).toContain('## Expected output (what closes this work)\n\nA two-page PDF proposal.\n');
    expect(present).toContain('- Asked for as PDF: the work closes with a real .pdf file in `./entregables/`, not with renamed Markdown or the content pasted in the chat.');
    expect(present).toContain('- Result linked by the human: `./entregables/proposal.pdf` (in the folder; a new version goes in a new file next to it).');
    expect(present).not.toContain('Resultado esperado');
    expect(renderContinuation(input({ locale: 'en-US', outcome: { ...outcome, resultExists: false } }))).toContain('- Result linked by the human: `./entregables/proposal.pdf`, but it is no longer in the folder: say so before building on it.');
    expect(renderContinuation(input({ locale: 'en-US', outcome: { ...outcome, resultPath: null, resultExists: false } }))).toContain('- No file has been linked as the result yet.');
  });
});

describe('Continuar con otro agente, through the service', () => {
  let fake: FakeOpenCode;
  let b: TestBackend;
  let events: ChatEvent[];

  beforeEach(async () => {
    events = [];
    fake = await startFakeOpenCode();
    b = await makeBackend({
      chatEndpoint: fake.endpoint,
      runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0.0\n' })),
      emitChat: (e) => events.push(e),
    });
  });

  afterEach(async () => {
    b.cleanup();
    await fake.close();
  });

  it('hands a live conversation over to a new member and leaves the source exactly as it was', async () => {
    const brand = await b.service.createBrand('Casa Oliva');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    const [brief] = await b.service.listDocuments(work.id);
    const current = await b.service.readDocument(brief.id);
    await b.service.saveDocument(brief.id, '# Lanzamiento\n\n## 01 / Objetivo\nPresentar la colección a quienes eligen menos objetos.\n\n## 02 / Próximos pasos\n- [ ] Incorporar entrevistas reales\n- [x] Revisar la propuesta\n', current.fingerprint);
    const strategy = await b.service.createDocument(work.id, 'strategy', 'Estrategia');
    await b.service.saveDocument(strategy.document.id, `# Estrategia\n\nAudiencia: PENDIENTE — falta el dato de edad.\n\n${'contenido-del-documento '.repeat(5)}`, strategy.fingerprint);
    await b.service.updateDocument(strategy.document.id, { status: 'review' });
    await b.service.addDecision(work.id, 'Elegimos Instagram antes que TikTok.');

    const source = await b.service.addTeamMember(work.id, 'strategist');
    await b.service.proposeDecisionFromAgent(source.id, 'msg_1', { statement: 'Probar un sorteo.', rationale: '', clientRequestId: 'req_1' });
    const rejected = await b.service.proposeDecisionFromAgent(source.id, 'msg_2', { statement: 'Pautar en radio.', rationale: '', clientRequestId: 'req_2' });
    await b.service.rejectDecision(rejected!.id);
    await b.service.sendChat(source.id, 'Armá la estrategia de lanzamiento');
    // The fake answers "Hello" and stops on a permission request: the source is still working.
    await waitFor(() => events.some((e) => e.type === 'permission' && e.chatId === source.id));
    const before = b.repo.getMember(source.id);

    const draft = await b.service.draftContinuation(source.id);
    expect(draft.sourceMemberId).toBe(source.id);
    expect((await b.service.draftContinuation(source.id)).text).toBe(draft.text);
    const text = draft.text;
    expect(text).toContain('# Traspaso de trabajo · Casa Oliva · Lanzamiento');
    expect(text).toContain('Presentar la colección a quienes eligen menos objetos.');
    expect(text).toContain(b.files.workDir(brand.id, work.id));
    expect(text).toContain('Elegimos Instagram antes que TikTok.');
    expect(text).not.toContain('Pautar en radio.');
    expect(text).toContain('- Decisión propuesta, sin aprobar: Probar un sorteo.');
    expect(text).toContain('- `./strategy.md` — Estrategia (estrategia, en revisión)');
    expect(text).toContain('- `./strategy.md` está en revisión.');
    expect(text).toContain('- `./strategy.md`: Audiencia: PENDIENTE — falta el dato de edad.');
    expect(text).toContain('- `./brief.md`: [ ] Incorporar entrevistas reales');
    // Files are named, never pasted.
    expect(text).not.toContain('contenido-del-documento');
    // No outcome set: no closing-contract section.
    expect(text).not.toContain('## Resultado esperado');
    expect(text).toContain('> **Persona:**\n> Armá la estrategia de lanzamiento');
    expect(text).toContain('> **Strategist:** (todavía la está escribiendo)\n> Hello');
    expect(text).toContain('- Strategist todavía está respondiendo en su conversación');

    const next = await b.service.addTeamMember(work.id, 'reviewer', { continuedFrom: source.id });
    await b.service.sendChat(next.id, text);
    expect(next.id).not.toBe(source.id);
    const team = await b.service.listTeam(work.id);
    expect(team.find((m) => m.id === next.id)).toMatchObject({ roleId: 'reviewer', continuedFrom: source.id });
    expect(team.find((m) => m.id === source.id)).toMatchObject({ continuedFrom: null, status: 'working' });
    // Same runtime session, account, status and timestamps: nothing about the source moved.
    expect(b.repo.getMember(source.id)).toEqual(before);
    // The hand-over is the new conversation's first message, sent to its own session.
    const prompt = fake.requests.filter((r) => r.path.endsWith('/prompt_async')).at(-1);
    expect(prompt?.path).toContain(b.repo.getMember(next.id).sessionId);
    expect(b.repo.getMember(next.id).sessionId).not.toBe(before.sessionId);
    expect((prompt?.body as { parts?: Array<{ text?: string }> }).parts?.[0]?.text).toBe(text);
    // No document, decision or memory was created on the way.
    expect((await b.service.listDocuments(work.id)).map((d) => d.fileName)).toEqual(['brief.md', 'strategy.md']);
    expect((await b.service.listDecisions(work.id)).map((d) => d.text).sort()).toEqual(['Elegimos Instagram antes que TikTok.', 'Pautar en radio.', 'Probar un sorteo.']);
  });

  it('refuses an origin from another work or an invalid id, and leaves nothing behind', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    const other = await b.service.createWork(brand.id, 'Dos');
    const source = await b.service.addTeamMember(work.id, 'strategist');
    await expect(b.service.addTeamMember(other.id, 'reviewer', { continuedFrom: source.id })).rejects.toThrow(/no es de este trabajo/);
    await expect(b.service.addTeamMember(work.id, 'reviewer', { continuedFrom: 'mem_nope' })).rejects.toThrow(/no es de este trabajo/);
    await expect(b.service.addTeamMember(work.id, 'reviewer', { continuedFrom: '../x' })).rejects.toThrow(/Invalid member id/);
    await expect(b.service.draftContinuation('mem_nope')).rejects.toThrow(/Team member/);
    expect(await b.service.listTeam(other.id)).toEqual([]);
    expect((await b.service.listTeam(work.id)).map((m) => m.id)).toEqual([source.id]);
  });

  it('keeps a non-default model when the continuation names it; without one an explicit runtime means its default', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    const source = await b.service.addTeamMember(work.id, 'strategist', { model: 'fake-provider/fake-model' });
    expect((await b.service.listTeam(work.id))[0].model).toBe('fake-provider/fake-model');
    const next = await b.service.addTeamMember(work.id, 'reviewer', { runtime: 'opencode', model: 'fake-provider/fake-model', continuedFrom: source.id });
    expect((await b.service.listTeam(work.id)).find((m) => m.id === next.id)).toMatchObject({ model: 'fake-provider/fake-model', continuedFrom: source.id, label: 'OpenCode · fake-provider/fake-model' });
    // Why the dialog always sends a model: leaving it out silently drops to the default.
    const bare = await b.service.addTeamMember(work.id, 'analyst', { runtime: 'opencode', continuedFrom: source.id });
    expect((await b.service.listTeam(work.id)).find((m) => m.id === bare.id)?.model).toBeNull();
  });

  it('never reopens a paused conversation to read it', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    const source = await b.service.addTeamMember(work.id, 'analyst');
    await b.service.pauseTeamMember(source.id);
    const before = b.repo.getMember(source.id);
    const draft = await b.service.draftContinuation(source.id);
    expect(draft.text).toContain('OpenCode guarda su historial adentro de la conversación: este traspaso no incluye mensajes.');
    expect((await b.service.listTeam(work.id))[0].status).toBe('paused');
    expect(b.repo.getMember(source.id)).toEqual(before);
  });

  function writeDeliverable(work: Work, name: string): string {
    const dir = path.join(b.files.workDir(work.brandId, work.id), DELIVERABLES_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, '%PDF-1.4');
    return file;
  }

  /** The system prompt each turn of this member carried (OpenCode sends it with every turn). */
  const systemsOf = (memberId: string): string[] => {
    const sessionId = b.repo.getMember(memberId).sessionId;
    return fake.requests.filter((r) => r.path === `/session/${sessionId}/prompt_async`).map((r) => String((r.body as { system?: string } | null)?.system ?? ''));
  };

  it('hands over the closing contract with a linked result that is there, and adds nothing to the prompt', async () => {
    const brand = await b.service.createBrand('Casa Oliva');
    const work = await b.service.createWork(brand.id, 'Propuesta');
    writeDeliverable(work, 'propuesta.pdf');
    await b.service.updateWork(work.id, { expectedOutput: 'La propuesta en PDF para el cliente.', resultPath: 'propuesta.pdf' });
    // Nobody is live yet, so the shared files are written with the outcome when the source opens.
    const source = await b.service.addTeamMember(work.id, 'strategist');

    const { text } = await b.service.draftContinuation(source.id);
    expect(text).toContain('## Resultado esperado (lo que cierra el trabajo)\n\nLa propuesta en PDF para el cliente.\n');
    expect(text).toContain('- Se pidió como PDF: el trabajo cierra con un .pdf real en `./entregables/`');
    expect(text).toContain('- Entregable vinculado como resultado: `./entregables/propuesta.pdf` (está en la carpeta;');

    const next = await b.service.addTeamMember(work.id, 'reviewer', { continuedFrom: source.id });
    await b.service.sendChat(next.id, text);
    const sessionId = b.repo.getMember(next.id).sessionId;
    const first = fake.requests.filter((r) => r.path === `/session/${sessionId}/prompt_async`).at(-1);
    // The contract reaches the new member once, in its first message...
    expect((first?.body as { parts?: Array<{ text?: string }> }).parts?.[0]?.text).toBe(text);
    // ...and not again in its prompt: the frozen shared files already state it, so the prompt is what it always was.
    expect(systemsOf(next.id).at(-1)).not.toContain('## Expected output');
    expect(systemsOf(next.id).at(-1)).not.toContain('La propuesta en PDF para el cliente.');
  });

  it('says the linked result left the folder, without recreating the folder or dropping the link', async () => {
    const brand = await b.service.createBrand('Casa Oliva');
    const work = await b.service.createWork(brand.id, 'Propuesta');
    const folder = path.dirname(writeDeliverable(work, 'propuesta.pdf'));
    await b.service.updateWork(work.id, { expectedOutput: 'La propuesta en PDF para el cliente.', resultPath: 'propuesta.pdf' });
    const source = await b.service.addTeamMember(work.id, 'strategist');
    fs.rmSync(folder, { recursive: true });

    const { text } = await b.service.draftContinuation(source.id);
    expect(text).toContain('- Entregable vinculado como resultado: `./entregables/propuesta.pdf`, pero ya no está en la carpeta: avisalo antes de apoyarte en él.');
    expect(text).not.toContain('(está en la carpeta');
    // Drafting is a read: ./entregables/ is not created to look inside, and the pointer stays.
    expect(fs.existsSync(folder)).toBe(false);
    expect((await b.service.listWorks(brand.id))[0].resultPath).toBe('propuesta.pdf');
  });
});

it('quotes a finished Claude Code member from Latte\'s own transcript, account untouched', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripción');
    // Inserted directly: drafting must not need Claude Code installed or running.
    b.repo.insertMember({ id: 'mem_claude_src', workId: work.id, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'claude', model: null, accountId: 'acc_0123456789abcdef', sessionId: 'sess-1', done: true, createdAt: AT, updatedAt: AT });
    const store = new TranscriptStore(path.join(b.dir, 'transcripts'));
    store.append('mem_claude_src', message('u1', 'user', 'Seguí con el calendario', { chatId: 'mem_claude_src' }));
    store.append('mem_claude_src', message('a1', 'assistant', 'Tengo la grilla de octubre.', { chatId: 'mem_claude_src' }));
    store.append('mem_claude_src', message('a2', 'assistant', '', { chatId: 'mem_claude_src', error: 'You have hit your usage limit' }));
    const before = b.repo.getMember('mem_claude_src');
    const draft = await b.service.draftContinuation('mem_claude_src');
    expect(draft.text).toContain('> Seguí con el calendario');
    expect(draft.text).toContain('> Tengo la grilla de octubre.');
    expect(draft.text).toContain('- El último turno de Strategist terminó con error: You have hit your usage limit');
    expect(b.repo.getMember('mem_claude_src')).toEqual(before);
    expect(store.load('mem_claude_src')).toHaveLength(3);
  } finally { b.cleanup(); }
});

it('adds the origin column to an existing team without rewriting rows or bumping the schema', async () => {
  const dir = makeTempDir();
  try {
    const { driver } = await openDriver(path.join(dir, 'latte.db'), 'sql.js');
    driver.exec("CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    driver.exec("CREATE TABLE works (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', dir TEXT, updated_at TEXT NOT NULL)");
    driver.exec("CREATE TABLE team_members (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE, role_id TEXT NOT NULL, role_name TEXT NOT NULL, initial TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT, account_id TEXT, session_id TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    driver.run('INSERT INTO brands VALUES (?, ?, ?, ?)', ['brd_1', 'Casa', '', AT]);
    driver.run('INSERT INTO works VALUES (?, ?, ?, ?, ?, ?)', ['wrk_1', 'brd_1', 'Uno', '', null, AT]);
    driver.run("INSERT INTO team_members(id, work_id, role_id, role_name, initial, runtime, model, account_id, session_id, done, created_at, updated_at) VALUES ('mem_old', 'wrk_1', 'strategist', 'Strategist', 'S', 'codex', NULL, 'system', 'thr_1', 0, ?, ?)", [AT, AT]);
    const repo = new LatteRepository(driver);
    repo.migrate();
    repo.migrate();
    expect(driver.all<{ name: string }>("SELECT name FROM pragma_table_info('team_members')").map((c) => c.name)).toContain('continued_from');
    expect(repo.getMember('mem_old')).toMatchObject({ sessionId: 'thr_1', accountId: 'system', continuedFrom: null });
    repo.insertMember({ id: 'mem_new', workId: 'wrk_1', roleId: 'reviewer', roleName: 'Reviewer', initial: 'V', runtime: 'claude', model: null, accountId: 'system', sessionId: '', done: false, continuedFrom: 'mem_old', createdAt: AT, updatedAt: AT });
    expect(repo.getMember('mem_new').continuedFrom).toBe('mem_old');
    // Additive and nullable: an older Latte still opens this database.
    expect(repo.getMeta('schema_version')).toBe(SCHEMA_VERSION);
    repo.close();
  } finally { removeDir(dir); }
});
