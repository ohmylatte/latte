import type { ChatMessage, ChatRuntime, Decision } from '../../shared/contracts';
import { WORK_FILES } from '../core/paths';
import { DELIVERABLES_DIR } from './deliverables';
import { requestedFormats } from './instructions';

/**
 * Every cap keeps the hand-over a map of the work, never a second copy of it:
 * documents are named, not pasted, and the conversation is quoted, not copied.
 */
const CAPS = { objective: 600, decisions: 30, documents: 40, deliverables: 12, messages: 4, messageHead: 480, messageTail: 200, pending: 25, line: 200, openItemsPerFile: 5 } as const;

export type ContinuationLocale = 'es-AR' | 'en-US';

/** One tracked deliverable, as a successor needs to find it. */
export interface ContinuationDocument {
  fileName: string;
  title: string;
  kind: string;
  status: string;
  /** File this one was derived from, when it declared a base. */
  baseFileName: string | null;
  /** The base moved on after this document pinned it. */
  baseOutdated: boolean;
  /** The agent proposed funnel stages and nobody answered yet. */
  proposalPending: boolean;
  /** Open items written in the file itself (see openItems). */
  openItems: string[];
}

export interface ContinuationInput {
  locale: ContinuationLocale;
  brandName: string;
  workTitle: string;
  directory: string;
  /** The work lives in a folder the person chose rather than one Latte manages. */
  ownFolder: boolean;
  source: { memberId: string; roleName: string; label: string; runtime: ChatRuntime; working: boolean };
  /** Current content of the brief document. */
  brief: string;
  /**
   * What closes the work, as the work holds it now. `resultExists` is read
   * from ./entregables/ when the hand-over is drafted, never stored.
   */
  outcome: { expectedOutput: string | null; resultPath: string | null; resultExists: boolean };
  decisions: Decision[];
  documents: ContinuationDocument[];
  /** File names inside ./entregables/. */
  deliverables: string[];
  /** What the source conversation said; `exposed` is false when its runtime keeps it to itself. */
  conversation: { messages: ChatMessage[]; exposed: boolean };
  /** Markdown in the folder that is not a tracked document yet. */
  untracked: string[];
  /** Roles an agent asked for that the human has not answered. */
  asks: Array<{ roleName: string; request: string }>;
}

const RUNTIME_NAME: Record<ChatRuntime, string> = { opencode: 'OpenCode', claude: 'Claude Code', codex: 'Codex' };
const DECISION_BLOCK = /```latte-decision\s*\r?\n[\s\S]*?```/g;
const BRAND_CONTEXT_BLOCK = /```latte-brand-context\s*\r?\n[\s\S]*?```/g;
const HEADING = /^#{1,6}\s/;
const OBJECTIVE_HEADING = /^#{1,6}\s*(?:\d+\s*[./)-]?\s*)?(?:objetivos?|goals?|objectives?)\b/i;
const OPEN_BOX = /^\s*[-*+]\s+\[ \]\s+(.+)$/;
const OPEN_MARK = /\b(?:PENDIENTE|PENDING|TODO)\b/;

const COPY = {
  'es-AR': {
    title: 'Traspaso de trabajo',
    intro: 'Venís a continuar un trabajo que empezó otro agente en Latte. La marca, las decisiones y los archivos son de Latte, no de ese agente: leé los documentos antes de proponer cambios y no rehagas lo que ya está hecho. Si algo de este traspaso no coincide con un archivo, manda el archivo.',
    origin: (role: string, label: string, id: string) => `Origen: ${role} · ${label} (conversación \`${id}\`; sigue intacta en Latte).`,
    folder: (dir: string, own: boolean) => `Carpeta del trabajo: \`${dir}\` (${own ? 'la eligió la persona' : 'la administra Latte'}). Es tu directorio de trabajo.`,
    objective: 'Brief y objetivo',
    noObjective: 'El brief todavía no dice cuál es el objetivo: preguntalo antes de avanzar.',
    fullBrief: (file: string) => `Brief completo: \`./${file}\`.`,
    outcome: 'Resultado esperado (lo que cierra el trabajo)',
    noExpected: '_Todavía no está escrito: preguntá cuál es el resultado concreto sólo si eso te bloquea._',
    formats: (labels: string[], dir: string) => `Se pidió como ${labels.join(' y ')}: el trabajo cierra con ${labels.map((l) => `un .${l.toLowerCase()} real`).join(' y ')} en \`./${dir}/\`, no con Markdown renombrado ni con el contenido en el chat.`,
    linked: (dir: string, file: string) => `Entregable vinculado como resultado: \`./${dir}/${file}\` (está en la carpeta; una versión nueva va en un archivo nuevo al lado).`,
    linkedMissing: (dir: string, file: string) => `Entregable vinculado como resultado: \`./${dir}/${file}\`, pero ya no está en la carpeta: avisalo antes de apoyarte en él.`,
    notLinked: 'Todavía no hay un entregable vinculado como resultado.',
    decisions: 'Decisiones aprobadas (no las reabras)',
    noDecisions: 'Todavía no hay decisiones aprobadas.',
    because: 'por qué',
    more: (n: number) => `…y ${n} más en Latte.`,
    documents: 'Documentos del trabajo',
    derived: (base: string) => `, se basa en \`./${base}\``,
    deliverables: 'Entregables en `./entregables/`',
    messages: (role: string) => `Últimos mensajes de la conversación de ${role}`,
    notExposed: (runtime: string) => `La conversación de origen está en pausa y ${runtime} guarda su historial adentro de la conversación: este traspaso no incluye mensajes.`,
    noMessages: 'La conversación de origen todavía no tiene mensajes.',
    person: 'Persona',
    endedWithError: (error: string) => `(terminó con error: ${error})`,
    unfinished: '(respuesta incompleta)',
    answering: '(todavía la está escribiendo)',
    pending: 'Bloqueos y pendientes',
    noPending: 'Latte no encontró bloqueos ni pendientes registrados.',
    lastError: (role: string, error: string) => `El último turno de ${role} terminó con error: ${error}`,
    lastUnfinished: (role: string) => `La última respuesta de ${role} quedó incompleta.`,
    stillWorking: (role: string) => `${role} todavía está respondiendo en su conversación: coordiná antes de tocar los mismos archivos.`,
    pendingDecision: (text: string) => `Decisión propuesta, sin aprobar: ${text}`,
    outdatedBase: (file: string, base: string) => `\`./${file}\` se basa en una versión anterior de \`./${base}\`: revisalo contra la actual.`,
    inReview: (file: string) => `\`./${file}\` está en revisión.`,
    proposal: (file: string) => `\`./${file}\` tiene una propuesta de etapas del embudo sin responder.`,
    untracked: (file: string) => `\`./${file}\` está en la carpeta pero todavía no es un documento de Latte.`,
    ask: (role: string, request: string) => `Un agente pidió sumar a ${role}: ${request}`,
    openItem: (file: string, item: string) => `\`./${file}\`: ${item}`,
    closing: (file: string) => `Antes de seguir, leé \`./${file}\` y los documentos de la lista, y contestá con lo que entendiste y el próximo paso concreto.`,
    kind: { brief: 'encargo', strategy: 'estrategia', calendar: 'calendario', research: 'investigación', copy: 'piezas', note: 'nota' } as Record<string, string>,
    status: { draft: 'borrador', review: 'en revisión', approved: 'aprobado' } as Record<string, string>,
  },
  'en-US': {
    title: 'Work hand-over',
    intro: 'You are continuing work that another agent started in Latte. The brand, the decisions and the files belong to Latte, not to that agent: read the documents before proposing changes and do not redo what is already done. If anything in this hand-over disagrees with a file, the file wins.',
    origin: (role: string, label: string, id: string) => `Source: ${role} · ${label} (conversation \`${id}\`; left intact in Latte).`,
    folder: (dir: string, own: boolean) => `Work folder: \`${dir}\` (${own ? 'chosen by the human' : 'managed by Latte'}). It is your working directory.`,
    objective: 'Brief and goal',
    noObjective: 'The brief does not state a goal yet: ask before moving on.',
    fullBrief: (file: string) => `Full brief: \`./${file}\`.`,
    outcome: 'Expected output (what closes this work)',
    noExpected: '_Not written yet: ask what the concrete result should be only if that blocks you._',
    formats: (labels: string[], dir: string) => `Asked for as ${labels.join(' and ')}: the work closes with a real ${labels.map((l) => `.${l.toLowerCase()}`).join(' and a real ')} file in \`./${dir}/\`, not with renamed Markdown or the content pasted in the chat.`,
    linked: (dir: string, file: string) => `Result linked by the human: \`./${dir}/${file}\` (in the folder; a new version goes in a new file next to it).`,
    linkedMissing: (dir: string, file: string) => `Result linked by the human: \`./${dir}/${file}\`, but it is no longer in the folder: say so before building on it.`,
    notLinked: 'No file has been linked as the result yet.',
    decisions: 'Approved decisions (do not reopen them)',
    noDecisions: 'No decisions have been approved yet.',
    because: 'why',
    more: (n: number) => `…and ${n} more in Latte.`,
    documents: 'Documents of this work',
    derived: (base: string) => `, based on \`./${base}\``,
    deliverables: 'Deliverables in `./entregables/`',
    messages: (role: string) => `Latest messages from the ${role} conversation`,
    notExposed: (runtime: string) => `The source conversation is paused and ${runtime} keeps its history inside the conversation, so this hand-over quotes no messages.`,
    noMessages: 'The source conversation has no messages yet.',
    person: 'Human',
    endedWithError: (error: string) => `(ended with an error: ${error})`,
    unfinished: '(unfinished answer)',
    answering: '(still being written)',
    pending: 'Blockers and open items',
    noPending: 'Latte found no recorded blockers or open items.',
    lastError: (role: string, error: string) => `The last ${role} turn ended with an error: ${error}`,
    lastUnfinished: (role: string) => `The last ${role} answer was left unfinished.`,
    stillWorking: (role: string) => `${role} is still answering in its own conversation: coordinate before touching the same files.`,
    pendingDecision: (text: string) => `Proposed decision, not approved: ${text}`,
    outdatedBase: (file: string, base: string) => `\`./${file}\` is based on an older version of \`./${base}\`: review it against the current one.`,
    inReview: (file: string) => `\`./${file}\` is in review.`,
    proposal: (file: string) => `\`./${file}\` has an unanswered funnel-stage proposal.`,
    untracked: (file: string) => `\`./${file}\` is in the folder but is not a Latte document yet.`,
    ask: (role: string, request: string) => `An agent asked to bring in ${role}: ${request}`,
    openItem: (file: string, item: string) => `\`./${file}\`: ${item}`,
    closing: (file: string) => `Before continuing, read \`./${file}\` and the listed documents, then reply with what you understood and the concrete next step.`,
    kind: { brief: 'brief', strategy: 'strategy', calendar: 'calendar', research: 'research', copy: 'copy', note: 'note' } as Record<string, string>,
    status: { draft: 'draft', review: 'in review', approved: 'approved' } as Record<string, string>,
  },
} as const;

/** Earlier hand-overs are superseded by the one being written, so they are never quoted. */
const HANDOVER_TITLES = Object.values(COPY).map((c) => `# ${c.title} · `);

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function clip(text: string, max: number): string {
  const clean = oneLine(text);
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Head and tail of a long message: how it opened and where it left things. */
function excerpt(text: string): string {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= CAPS.messageHead + CAPS.messageTail) return clean;
  return `${clean.slice(0, CAPS.messageHead).trimEnd()} […] ${clean.slice(-CAPS.messageTail).trimStart()}`;
}

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<ChatMessage['parts'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
    .replace(DECISION_BLOCK, '')
    .replace(BRAND_CONTEXT_BLOCK, '')
    .trim();
}

/**
 * What the brief says the work is for. The section under an "Objetivo" /
 * "Goal" heading when there is one; otherwise the first paragraph that is not
 * a title. Empty when the brief says nothing yet.
 */
export function briefObjective(brief: string): string {
  const lines = brief.split(/\r?\n/);
  const heading = lines.findIndex((l) => OBJECTIVE_HEADING.test(l.trim()));
  let body: string[];
  if (heading >= 0) {
    const end = lines.findIndex((l, i) => i > heading && HEADING.test(l.trim()));
    body = lines.slice(heading + 1, end === -1 ? undefined : end);
  } else {
    const start = lines.findIndex((l) => l.trim() !== '' && !HEADING.test(l.trim()));
    if (start === -1) return '';
    const end = lines.findIndex((l, i) => i > start && (l.trim() === '' || HEADING.test(l.trim())));
    body = lines.slice(start, end === -1 ? undefined : end);
  }
  return clip(body.join(' '), CAPS.objective);
}

/**
 * Open items a document states about itself: unchecked boxes, and lines
 * marked PENDIENTE / PENDING / TODO (Latte asks agents to mark gaps that way).
 * Upper case only, so an ordinary "pendiente" in a sentence is not a finding.
 */
export function openItems(content: string, max: number = CAPS.openItemsPerFile): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of content.split(/\r?\n/).slice(0, 2_000)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const box = OPEN_BOX.exec(line);
    const raw = box ? `[ ] ${box[1]}` : OPEN_MARK.test(line) ? line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '') : null;
    if (raw === null) continue;
    const item = clip(raw, CAPS.line);
    if (item && !out.includes(item)) out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** Text turns worth quoting, newest last. Tool-only turns say nothing a successor can use. */
export function relevantMessages(messages: ChatMessage[]): Array<{ role: ChatMessage['role']; text: string; error: string | null; completed: boolean }> {
  const quotes: Array<{ role: ChatMessage['role']; text: string; error: string | null; completed: boolean }> = [];
  for (const message of messages) {
    const text = textOf(message);
    if (message.role === 'user' && HANDOVER_TITLES.some((title) => text.startsWith(title))) continue;
    if (!text && !message.error) continue;
    quotes.push({ role: message.role, text, error: message.error, completed: message.completed });
  }
  return quotes.slice(-CAPS.messages);
}

function capped(lines: string[], max: number, more: (n: number) => string): string[] {
  return lines.length > max ? [...lines.slice(0, max), more(lines.length - max)] : lines;
}

/**
 * What closes the work, so the hand-over stands on its own wherever it is
 * pasted: the expected output, the real files it asks for and the linked
 * result with whether it is still in the folder. No section when the human set
 * no outcome, so such a hand-over reads exactly as before.
 *
 * It rides this first message only. The new member's own prompt stays what
 * memberContext decides (the outcome only when frozen shared files do not say
 * it), so the hand-over adds nothing that is paid again on every turn.
 */
function outcomeSection(c: (typeof COPY)[ContinuationLocale], outcome: ContinuationInput['outcome']): string[] {
  // Not clipped: it is the contract itself, and updateWork already bounds it.
  const expected = (outcome.expectedOutput ?? '').replace(/\r\n/g, '\n').trim();
  const result = outcome.resultPath ?? null;
  if (!expected && !result) return [];
  const lines = [`## ${c.outcome}`, '', expected || c.noExpected, ''];
  const formats = requestedFormats(expected);
  if (formats.length > 0) lines.push(`- ${c.formats(formats, DELIVERABLES_DIR)}`);
  lines.push(`- ${!result ? c.notLinked : outcome.resultExists ? c.linked(DELIVERABLES_DIR, result) : c.linkedMissing(DELIVERABLES_DIR, result)}`, '');
  return lines;
}

/**
 * The hand-over a new member receives as its first message. Deterministic:
 * the same records always produce the same text, and nothing in it was
 * written by a model. The human reads and edits it before it is sent.
 */
export function renderContinuation(input: ContinuationInput): string {
  const c = COPY[input.locale];
  const { source } = input;
  const out: string[] = [
    `# ${c.title} · ${oneLine(input.brandName)} · ${oneLine(input.workTitle)}`,
    '',
    c.intro,
    '',
    `- ${c.origin(source.roleName, source.label, source.memberId)}`,
    `- ${c.folder(input.directory, input.ownFolder)}`,
    '',
  ];

  const objective = briefObjective(input.brief);
  out.push(`## ${c.objective}`, '', objective || c.noObjective, '', c.fullBrief(WORK_FILES.brief), '');
  out.push(...outcomeSection(c, input.outcome));

  const approved = input.decisions.filter((d) => d.status === 'approved').map((d) => {
    const why = d.rationale.trim() ? ` (${c.because}: ${clip(d.rationale, CAPS.line)})` : '';
    return `- ${d.createdAt.slice(0, 10)} — ${clip(d.text, CAPS.line * 2)}${why}`;
  });
  out.push(`## ${c.decisions}`, '', ...(approved.length ? capped(approved, CAPS.decisions, c.more) : [c.noDecisions]), '');

  const documents = input.documents.map((d) => `- \`./${d.fileName}\` — ${oneLine(d.title)} (${c.kind[d.kind] ?? d.kind}, ${c.status[d.status] ?? d.status}${d.baseFileName ? c.derived(d.baseFileName) : ''})`);
  out.push(`## ${c.documents}`, '', ...capped(documents, CAPS.documents, c.more));
  if (input.deliverables.length > 0) {
    const shown = input.deliverables.slice(0, CAPS.deliverables).join(', ');
    const rest = input.deliverables.length - CAPS.deliverables;
    out.push('', `${c.deliverables}: ${shown}${rest > 0 ? ` ${c.more(rest)}` : ''}`);
  }
  out.push('');

  out.push(`## ${c.messages(source.roleName)}`, '');
  const quotes = input.conversation.exposed ? relevantMessages(input.conversation.messages) : [];
  if (!input.conversation.exposed) out.push(c.notExposed(RUNTIME_NAME[source.runtime]));
  else if (quotes.length === 0) out.push(c.noMessages);
  else {
    quotes.forEach((quote, index) => {
      const speaker = quote.role === 'user' ? c.person : source.roleName;
      // The turn a live source is writing right now is in progress, not broken.
      const open = source.working && index === quotes.length - 1 ? c.answering : c.unfinished;
      const note = quote.error ? ` ${c.endedWithError(clip(quote.error, CAPS.line))}` : quote.role === 'assistant' && !quote.completed ? ` ${open}` : '';
      const lines = (quote.text ? excerpt(quote.text) : '').split('\n');
      out.push(`> **${speaker}:**${note}`, ...(quote.text ? lines.map((line) => (line ? `> ${line}` : '>')) : []));
      if (index < quotes.length - 1) out.push('');
    });
  }
  out.push('');

  const pending: string[] = [];
  const last = input.conversation.messages.at(-1);
  if (last?.error) pending.push(c.lastError(source.roleName, clip(last.error, CAPS.line)));
  if (source.working) pending.push(c.stillWorking(source.roleName));
  else if (last && last.role === 'assistant' && !last.completed && !last.error) pending.push(c.lastUnfinished(source.roleName));
  for (const decision of input.decisions) if (decision.status === 'pending') pending.push(c.pendingDecision(clip(decision.text, CAPS.line)));
  for (const d of input.documents) if (d.baseOutdated && d.baseFileName) pending.push(c.outdatedBase(d.fileName, d.baseFileName));
  for (const d of input.documents) if (d.status === 'review') pending.push(c.inReview(d.fileName));
  for (const d of input.documents) if (d.proposalPending) pending.push(c.proposal(d.fileName));
  for (const file of input.untracked) pending.push(c.untracked(file));
  for (const ask of input.asks) pending.push(c.ask(ask.roleName, clip(ask.request.split(/\r?\n/)[0] ?? '', CAPS.line)));
  for (const d of input.documents) for (const item of d.openItems) pending.push(c.openItem(d.fileName, item));
  out.push(`## ${c.pending}`, '', ...(pending.length ? capped(pending.map((p) => `- ${p}`), CAPS.pending, c.more) : [c.noPending]), '');

  out.push('---', c.closing(WORK_FILES.brief));
  return out.join('\n');
}
