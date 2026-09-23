import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { ClaudeChatAdapter } from '../../electron/agents/claude/claudeAdapter';
import { makeTempDir, removeDir } from './helpers';

/**
 * LA PREGUNTA NATIVA DEL CLI LLEGA A LA PERSONA.
 *
 * Prueba real: un miembro de Claude Code llamo a `AskUserQuestion` --su
 * herramienta de preguntas con opciones-- y Latte no mostro nada. La pregunta
 * viaja por el MISMO canal que un permiso (`can_use_tool`), asi que Latte la
 * contestaba como tal: `allow` con el input INTACTO. El protocolo espera las
 * respuestas en `updatedInput.answers`, asi que el CLI leia "the user did not
 * answer the questions", se lo contestaba a si mismo y seguia. El dueno veia la
 * pregunta solo adentro del detalle de la llamada, sin forma de responderla.
 *
 * No confundir con `latte_ask`, la pregunta de COORDINACION por MCP: son dos
 * canales distintos y este es el nativo del CLI.
 */

const FAKE_CLAUDE = path.resolve(__dirname, 'fakeClaude.cjs');

async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakeClaudeAdapter(events: ChatEvent[]) {
  return new ClaudeChatAdapter({
    resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.263' }),
    emit: (e) => events.push(e),
    accountEnv: (accountId): Record<string, string> => (accountId && accountId !== SYSTEM_ACCOUNT_ID ? { CLAUDE_CONFIG_DIR: `C:\\managed\\${accountId}` } : {}),
    spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(file, [FAKE_CLAUDE, ...args], options)) as typeof spawn,
    platform: 'linux',
    env: { PATH: process.env.PATH ?? '', CLAUDECODE: '1', ORCA_RUN: 'x' },
  });
}

/** El texto que el fake devuelve como resultado de la herramienta: el `updatedInput` tal cual. */
const toolOutput = (adapter: ClaudeChatAdapter, chatId: string): string => {
  for (const message of adapter.listMessages(chatId)) {
    for (const part of message.parts) {
      // Un `is_error` deja el texto en `error`, no en `output`: los dos son el
      // resultado que el CLI recibio.
      if (part.type === 'tool' && part.tool === 'AskUserQuestion' && (part.output || part.error)) return part.output || part.error || '';
    }
  }
  return '';
};

describe('AskUserQuestion, la pregunta nativa de Claude Code', () => {
  let events: ChatEvent[];
  let adapter: ClaudeChatAdapter;
  let dir: string;

  beforeEach(() => {
    events = [];
    dir = makeTempDir();
    adapter = fakeClaudeAdapter(events);
  });
  afterEach(() => { adapter.shutdown(); removeDir(dir); });

  it('no se contesta como un permiso: emite una pregunta, con sus opciones', async () => {
    const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Claude', accountId: null });
    await adapter.send(session.id, 'necesito preguntar algo');
    await waitFor(() => events.some((e) => e.type === 'question'));
    // Y NUNCA como un permiso: una pregunta con opciones no es "permitir Write".
    expect(events.some((e) => e.type === 'permission')).toBe(false);
    const question = events.find((e) => e.type === 'question') as Extract<ChatEvent, { type: 'question' }>;
    expect(question.request.questions).toHaveLength(1);
    expect(question.request.questions[0]).toMatchObject({
      header: 'Tono',
      question: 'Que tono usamos?',
      multiple: false,
      custom: true,
      options: [{ label: 'Cercano', description: 'De vos' }, { label: 'Formal', description: 'De usted' }],
    });
  });

  it('la respuesta vuelve en updatedInput.answers, con la etiqueta elegida', async () => {
    const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Claude', accountId: null });
    await adapter.send(session.id, 'necesito preguntar algo');
    await waitFor(() => events.some((e) => e.type === 'question'));
    const request = (events.find((e) => e.type === 'question') as Extract<ChatEvent, { type: 'question' }>).request;
    await adapter.replyQuestion(session.id, request.id, [['Cercano']]);
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle'));
    expect(JSON.parse(toolOutput(adapter, session.id))).toMatchObject({ answers: { 'Que tono usamos?': 'Cercano' } });
    expect(events.some((e) => e.type === 'question-resolved')).toBe(true);
  });

  it('con varias elegidas van separadas por coma, y el texto libre viaja igual', async () => {
    const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Claude', accountId: null });
    await adapter.send(session.id, 'necesito preguntar algo');
    await waitFor(() => events.some((e) => e.type === 'question'));
    const request = (events.find((e) => e.type === 'question') as Extract<ChatEvent, { type: 'question' }>).request;
    await adapter.replyQuestion(session.id, request.id, [['Cercano', 'Formal', 'ninguno de los dos']]);
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle'));
    expect(JSON.parse(toolOutput(adapter, session.id))).toMatchObject({
      answers: { 'Que tono usamos?': 'Cercano, Formal, ninguno de los dos' },
    });
  });

  it('descartarla la deniega con un motivo legible, y no la responde por nadie', async () => {
    const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Claude', accountId: null });
    await adapter.send(session.id, 'necesito preguntar algo');
    await waitFor(() => events.some((e) => e.type === 'question'));
    const request = (events.find((e) => e.type === 'question') as Extract<ChatEvent, { type: 'question' }>).request;
    await adapter.replyQuestion(session.id, request.id, null);
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle'));
    expect(toolOutput(adapter, session.id)).toMatch(/Latte/);
  });

  it('un permiso de verdad sigue siendo un permiso, y las dos vias no se cruzan', async () => {
    const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Claude', accountId: null });
    await adapter.send(session.id, 'necesito preguntar algo');
    await waitFor(() => events.some((e) => e.type === 'question'));
    const request = (events.find((e) => e.type === 'question') as Extract<ChatEvent, { type: 'question' }>).request;
    // Una pregunta no se puede contestar como permiso ni al reves.
    await expect(adapter.replyPermission(session.id, request.id, 'once')).rejects.toThrow(/Permission request not found/);
    await expect(adapter.replyQuestion(session.id, 'no_existe', [['Cercano']])).rejects.toThrow(/Question not found/);
  });
});
