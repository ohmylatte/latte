import type { Brand, Decision, DecisionAuthorityMode, EffortTier, FunnelStage, Work } from '../../shared/contracts';
import type { SkillRef } from '../../shared/generationContracts';
import { WORK_FILES } from '../core/paths';
import {
  BRAND_MEMORY_DIR,
  BRAND_MEMORY_FILE,
  INHERITED_ARTIFACTS_INLINE_FLOOR,
  INHERITED_ARTIFACTS_INLINE_MAX,
  INHERITED_DECISIONS_INLINE_FLOOR,
  INHERITED_DECISIONS_INLINE_MAX,
  hasBrandMemory,
  renderBrandMemory,
  type BrandMemorySnapshot,
} from './brandMemory';
import { DELIVERABLES_DIR } from './deliverables';
import type { BrandContextNudge, BrandContextNudgeReason } from './brandContextNudge';

/** E2: donde van los borradores de lo que después se publica. */
export const DRAFTS_DIR = 'borradores';
/** E4: donde Latte proyecta la identidad aprobada de la marca. El mismo nombre que `IDENTITY_DIR` de `branding/identity`. */
const IDENTITY_DIR_NAME = 'identidad';

export const MANAGED_MARKER = '<!-- latte:managed -->';

/**
 * Formats a person names when they expect a real document, not an answer in
 * the chat. "Word" only counts capitalised: "a 300-word summary" is a length.
 */
const REQUESTED_FORMATS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'PDF', pattern: /\bpdf\b/i },
  { label: 'DOCX', pattern: /\bdocx\b|\bWord\b/ },
];

/** File formats the expected output asks for, in a stable order. */
export function requestedFormats(expectedOutput: string): string[] {
  return REQUESTED_FORMATS.filter((f) => f.pattern.test(expectedOutput)).map((f) => f.label);
}

const OUTCOME_TITLE = 'Expected output (what closes this work)';
const MEMBER_OUTCOME_TITLE = '## Expected output of this work, as of when this conversation started';

/** What closes the work, as lines. Null when the human has not said it. */
function outcomeLines(work: Work, resultExists: boolean | undefined): string[] | null {
  const expected = (work.expectedOutput ?? '').trim();
  const result = work.resultPath ?? null;
  if (expected.length === 0 && !result) return null;
  const lines = [
    expected.length > 0 ? expected : '_Not written yet. Ask what the concrete result should be only if that blocks you._',
    '',
    `- The brief (\`./${WORK_FILES.brief}\`) is the goal. This is the concrete output the human expects to receive: the work is done when it exists, not when it has been described.`,
  ];
  const formats = requestedFormats(expected);
  if (formats.length > 0) {
    lines.push(`- Asked for as ${formats.join(' and ')}. That means a real ${formats.map((f) => `.${f.toLowerCase()}`).join(' and a real ')} file in \`./${DELIVERABLES_DIR}/\`, built with a tool you actually have. Markdown with another extension, or the content pasted in the chat, is not that file. If you cannot build it, say so plainly instead of claiming it.`);
  }
  if (result) {
    lines.push(resultExists === false
      ? `- The human linked \`./${DELIVERABLES_DIR}/${result}\` as the result, but that file is not there anymore. Say so before building on it.`
      : `- The human linked \`./${DELIVERABLES_DIR}/${result}\` as the result. A new version is a new file with a new name next to it; never replace this one without permission.`);
  }
  return lines;
}

/**
 * The outcome section of the shared context files. Absent without an outcome,
 * so a work without one renders exactly the context it always had.
 */
function outcomeSection(work: Work, resultExists: boolean | undefined): string | null {
  const lines = outcomeLines(work, resultExists);
  return lines ? section(OUTCOME_TITLE, lines.join('\n'), '') : null;
}

/** The outcome section a context file shows, exactly as rendered, or null when it shows none. */
function fileOutcomeSection(content: string): string | null {
  const start = content.indexOf(`## ${OUTCOME_TITLE}\n`);
  if (start < 0) return null;
  // Sections are joined by a blank line; the next heading closes this one.
  const end = content.indexOf('\n## ', start + 1);
  return end < 0 ? content.slice(start) : content.slice(start, end);
}

/**
 * True when a context file Latte wrote already states this work's outcome as
 * it is now, or states none when the work has none. A conversation opening
 * on such a file needs nothing more about it in its own prompt.
 */
export function showsCurrentOutcome(content: string, work: Work, resultExists: boolean | undefined): boolean {
  return fileOutcomeSection(content) === outcomeSection(work, resultExists);
}

/**
 * The outcome for ONE conversation's own prompt, fixed when it opens.
 *
 * CLAUDE.md / AGENTS.md are shared by the team and never rewritten under a
 * live session, so a conversation opened next to a live one can find them
 * older than the work. This travels through the runtime's own prompt channel
 * instead, and says which of the two is current. `removedFromFiles` covers the
 * one case with nothing to state: the files still show an outcome the human
 * took out. Null when there is nothing to say, so the prompt stays as it was.
 */
export function renderOutcomeContext(work: Work, resultExists: boolean | undefined, removedFromFiles = false): string | null {
  const lines = outcomeLines(work, resultExists);
  if (lines) {
    return [
      MEMBER_OUTCOME_TITLE,
      '',
      ...lines,
      '',
      `If the "Expected output" section of ./${WORK_FILES.claude} or ./${WORK_FILES.agents} differs from this, that file is older than this conversation: this one is current.`,
    ].join('\n');
  }
  if (!removedFromFiles) return null;
  return [
    MEMBER_OUTCOME_TITLE,
    '',
    `None. The human removed it after ./${WORK_FILES.claude} and ./${WORK_FILES.agents} were written, so do not work towards the "Expected output" section you may find there.`,
  ].join('\n');
}

/** The funnel, in the order a person moves through it. Mirrors FunnelStage. */
const FUNNEL_STAGES: readonly FunnelStage[] = ['discovery', 'consideration', 'conversion', 'retention'];

/** How much of the working document is echoed into the instructions. */
const DOCUMENT_EXCERPT_CHARS = 6_000;

/** A role shipped by the pack: the personality a team member opens with. */
export interface PackRole {
  id: string;
  name: string;
  initial: string;
  summary: string;
  /**
   * The face this role opens with, serialized (`bun.2.1.glasses`), from its
   * `avatar:` front matter. Null when the pack did not choose one: the role
   * catalogue then derives one from the role id, so nothing has to migrate.
   */
  avatar: string | null;
  /**
   * Effort this role opens with, from its `tier:` front matter. A role that
   * mostly gathers and checks opens light; one that decides opens deep.
   */
  tier: EffortTier;
  /** Appended to the runtime's system prompt for that member only. */
  instructions: string;
}

/** A writing skill Latte ships. Applies to every conversation unless turned off. */
export interface PackSkill {
  id: string;
  name: string;
  summary: string;
  body: string;
}

export interface InstructionPack {
  id: string;
  title: string;
  version: string;
  /** Workspace context rendered into CLAUDE.md / AGENTS.md. */
  body: string;
  /**
   * Marketing behaviour handed to EVERY conversation as a system prompt,
   * including the neutral assistant. Instruction files depend on the runtime
   * reading them; this travels through each runtime's own prompt channel.
   */
  base: string;
  roles: PackRole[];
  skills: PackSkill[];
}

/** One tracked deliverable, as the agent needs to see it. */
export interface InstructionDocument {
  kind: string;
  title: string;
  fileName: string;
  status: string;
  baseFileName?: string | null;
  /** Funnel stages this deliverable is filed under; empty means unclassified. */
  funnelStages?: FunnelStage[];
}

export interface InstructionsInput {
  brand: Brand;
  work: Work;
  /** Whether the result the human linked is still in the Deliverables folder. Read by the caller, never stored. */
  resultExists?: boolean;
  decisions: Decision[];
  /** Tracked deliverables of this work, in creation order. */
  documents?: InstructionDocument[];
  /** Optional memory excerpt (already fetched, bounded by the caller). */
  memory?: string;
  /** Optional discipline pack (packs/marketing-core) rendered before the brand context. */
  pack?: InstructionPack | null;
  /** Engram project for this brand, stated explicitly (shared runtimes cannot rely on env). */
  memoryProject?: string | null;
  /**
   * Whether this member's runtime actually received `latte_memory` MCP
   * tools at spawn (task 6.27, design-v2-conversational D3 — engram ships
   * BY DEFAULT wherever the runtime supports per-member injection). TRUE
   * changes the memory instruction's wording; FALSE or omitted keeps the
   * existing conditional line verbatim — still honest for a member whose
   * runtime (OpenCode) or environment (engram not installed) cannot receive
   * the tools, but who may have configured their own server anyway.
   */
  memoryToolsInjected?: boolean;
  /** Skills the human left on. They travel here, once per session, not per request. */
  skills?: PackSkill[];
  /** Who is already open on this work: an agent that cannot see its team cannot ask for one. */
  team?: { roleId: string; roleName: string; status: string }[];
  /** Roles that exist and could still be called in. */
  available?: { id: string; name: string; summary: string }[];
  /** Language for human-facing output. Operational instructions remain canonical English. */
  outputLanguage?: 'es-AR' | 'en-US';
  decisionAuthority?: DecisionAuthorityMode;
  /**
   * Compact pointer to a pinned generation receipt. Kit hash + skill refs only;
   * never binaries or full SKILL.md bodies. Learned refs are dropped (and reported)
   * when they would not fit after base, brief, rules, shipped skills and this pointer.
   */
  generation?: GenerationPointerInput | null;
  /**
   * Inherited knowledge from other works of this brand. The current brief,
   * documents and decisions stay the work's delta; this is the brand's.
   */
  brandMemory?: BrandMemorySnapshot | null;
  /**
   * Who may draft an empty brand context, computed by the service. Omitted in
   * pure renders: the default keeps today's behaviour (full nudge when the
   * context is empty, none when it is written).
   */
  brandContextNudge?: BrandContextNudge;
  /**
   * E4: la identidad APROBADA de la marca, ya proyectada en `./identidad/`.
   * Ausente o `null`: no hay identidad aprobada y rige explicit-neutral.
   */
  identity?: { hash: string } | null;
}

/** Compact receipt pointer that rides CLAUDE.md / AGENTS.md. */
export interface GenerationPointerInput {
  generationId: string;
  contextHash: string;
  kitHash: string | null;
  skillRefs: SkillRef[];
}

function section(title: string, body: string, empty: string): string {
  const text = body.trim();
  return `## ${title}\n\n${text.length > 0 ? text : `_${empty}_`}\n`;
}

/** How much brand context is inlined before the rest moves to a side file. */
export const BRAND_CONTEXT_CHARS = 6_000;
/** Floor brand context is squeezed to when the whole file still exceeds INSTRUCTIONS_MAX_CHARS. */
const BRAND_CONTEXT_CHARS_FLOOR = 2_000;

/** How many of the most recent approved decisions are inlined before older ones move to a side file. */
export const DECISIONS_INLINE_MAX = 15;
/** Floor the inline decision count is squeezed to when the whole file still exceeds INSTRUCTIONS_MAX_CHARS. */
const DECISIONS_INLINE_FLOOR = 5;

/**
 * Hard ceiling on the rendered instruction file. CLAUDE.md/AGENTS.md and the
 * pack's base prompt are both re-sent on every turn (the runtime prompt-caches
 * both of them); this bounds the fixed per-message cost the instruction file
 * itself adds, on top of whatever the pack and brief already cost.
 */
export const INSTRUCTIONS_MAX_CHARS = 20_000;

/** A file Latte writes next to CLAUDE.md/AGENTS.md to hold what an inlined section had to cut. */
export interface RenderedInstructionFile {
  /** Relative to the work directory, e.g. `.latte/context/brand.md`. */
  path: string;
  content: string;
}

/** What renderInstructions renders, plus the side files its pointers refer to. */
export interface InstructionBundle {
  text: string;
  files: RenderedInstructionFile[];
}

const SIDE_FILES = {
  brandContext: `${WORK_FILES.metaDir}/${WORK_FILES.contextDir}/brand.md`,
  decisions: `${WORK_FILES.metaDir}/${WORK_FILES.contextDir}/decisions.md`,
  brandMemory: BRAND_MEMORY_FILE,
  skill: (id: string) => `${WORK_FILES.metaDir}/${WORK_FILES.skillsDir}/${id}.md`,
};

function decisionLine(d: Decision): string {
  return `- ${d.createdAt.slice(0, 10)} — ${d.text.trim().replace(/\s+/g, ' ')}`;
}

/**
 * Builds the instruction text for one specific set of section ceilings.
 * Pulled out of renderInstructionBundle so the hard-cap fallback can re-render
 * with tighter ceilings without duplicating the whole layout.
 */
type BrandContextProtocolOpts = { updateLine: boolean; nudge: BrandContextNudge };

/**
 * Why THIS work must not draft the brand context, said plainly.
 *
 * A bare "do not draft it" is what made agents ask anyway: told to stop
 * without a reason, they ask the human. Each reason names the real one, and
 * the `pending` line carries the "do not ask for positioning, tone or
 * audience" wording the empty-context section used to carry on its own.
 */
function suppressedNudgeLine(reason: BrandContextNudgeReason | null): string {
  switch (reason) {
    case 'pending':
      return '- The brand context is empty. A proposal is already waiting for the human to review: do not ask for positioning, tone or audience, and do not draft or propose it here.';
    case 'inherited':
      return '- The brand context is empty. Brand knowledge from previous work is inherited below: use it and do not draft or propose a new context here.';
    case 'owner-elsewhere':
      return '- The brand context is empty. Another work of this brand is drafting it: do not draft or propose it here.';
    case 'context-exists':
      return '- The brand context is already written. Do not draft or propose it here.';
    default:
      return '- Do not draft or propose a brand context here.';
  }
}

/** The form the renderer uses when the caller passed no policy. */
function resolvedNudge(input: InstructionsInput): BrandContextNudge {
  if (input.brandContextNudge) return input.brandContextNudge;
  return input.brand.context.trim().length > 0
    ? { form: 'none', reason: 'context-exists' }
    : { form: 'full', reason: null };
}

function brandContextProtocolLines(input: InstructionsInput, protocol: BrandContextProtocolOpts): string[] {
  const authority = input.decisionAuthority ?? 'suggest';
  if (authority === 'off') {
    return ['- Brand-context suggestions are disabled for this work. Do not emit brand-context protocol blocks.'];
  }
  const lines = [
    '- When the brand context should change, invoke Latte\'s brand-context protocol by appending exactly one fenced `latte-brand-context` JSON block per conversation with: `text`, `rationale`, `mode` (`replace` or `append`; default `append` when context already exists), and a stable unique `clientRequestId`. Emit it only with evidence from the brief or this work\'s documents; never for hypotheses or anything the human has not confirmed. Latte will ask the human to approve it or apply it according to the same decision-authority setting.',
  ];
  if (input.brand.context.trim().length === 0) {
    if (protocol.nudge.form === 'full') {
      lines.push('- Before starting any other work, draft this brand\'s context from the brief and propose it with the `latte-brand-context` block.');
    } else if (protocol.nudge.form === 'short') {
      lines.push('- Draft this brand\'s context from the brief and propose it with the `latte-brand-context` block.');
    } else {
      lines.push(suppressedNudgeLine(protocol.nudge.reason));
    }
  } else if (protocol.updateLine) {
    lines.push('- Propose a brand-context update only when you have new durable facts the current context does not already hold.');
  }
  return lines;
}

function renderCore(
  input: InstructionsInput,
  decisionsInlineMax: number,
  brandContextChars: number,
  includeLearnedRefs: boolean,
  inheritedDecisionsMax: number,
  inheritedArtifactsMax: number,
  protocol: BrandContextProtocolOpts,
): { text: string; files: RenderedInstructionFile[]; brandTruncated: boolean; decisionsTruncated: boolean; brandMemoryTruncated: boolean; learnedOmitted: boolean } {
  const { brand, work, decisions, memory, pack, memoryProject, memoryToolsInjected } = input;
  const files: RenderedInstructionFile[] = [];
  const documentLines = (input.documents ?? [])
    .map((d) => {
      const status = d.status === 'draft' ? d.kind : `${d.kind}, ${d.status}`;
      const derived = d.baseFileName ? `, derived from ./${d.baseFileName}` : '';
      const stages = d.funnelStages?.length ? d.funnelStages.join(', ') : 'unclassified';
      return `- \`./${d.fileName}\` — ${d.title} (${status})${derived} — funnel: ${stages}`;
    })
    .join('\n');
  // What the funnel is MISSING is the finding; the per-file list alone buries it.
  const tracked = input.documents ?? [];
  const coverageLines = tracked.length === 0 ? '' : [
    'A deliverable can sit in several stages at once, or in none. A piece that mixes stages does none well.',
    '',
    ...FUNNEL_STAGES.map((stage) => `- \`${stage}\`: ${tracked.filter((d) => d.funnelStages?.includes(stage)).length}`),
    `- \`unclassified\`: ${tracked.filter((d) => !d.funnelStages?.length).length}`,
  ].join('\n');
  const team = input.team ?? [];
  const teamLines = team.map((m) => `- **${m.roleName}** (\`${m.roleId}\`) — ${m.status}`).join('\n');
  const availableLines = (input.available ?? [])
    .filter((r) => !team.some((m) => m.roleId === r.id))
    .map((r) => `- \`${r.id}\` — ${r.name}: ${r.summary}`)
    .join('\n');

  // Decisions: only the most recent N ride the prompt forever; the rest are one
  // pointer line away in a side file that always holds the complete log.
  const approvedDecisions = decisions.filter((d) => d.status === 'approved');
  const decisionOverflow = Math.max(0, approvedDecisions.length - decisionsInlineMax);
  const decisionsTruncated = decisionOverflow > 0;
  const inlinedDecisions = decisionsTruncated ? approvedDecisions.slice(decisionOverflow) : approvedDecisions;
  const decisionLines = [
    ...inlinedDecisions.map(decisionLine),
    ...(decisionsTruncated ? [`- ${decisionOverflow} earlier decisions are recorded in ./${SIDE_FILES.decisions}.`] : []),
  ].join('\n');
  if (decisionsTruncated) {
    files.push({
      path: SIDE_FILES.decisions,
      content: `# Decisions already taken in this work — ${brand.name} · ${work.title}\n\n${approvedDecisions.map(decisionLine).join('\n')}\n`,
    });
  }

  const memorySnapshot = input.brandMemory;
  const inherited = memorySnapshot && hasBrandMemory(memorySnapshot)
    ? renderBrandMemory(memorySnapshot, {
      decisions: inheritedDecisionsMax,
      artifacts: inheritedArtifactsMax,
    })
    : null;
  if (inherited) files.push(...inherited.files);

  // Brand context: same excerpt-plus-pointer pattern as the brief below, so a
  // brand written as a small book never becomes the biggest thing in the file.
  const brandTruncated = brand.context.length > brandContextChars;
  const brandExcerpt = brandTruncated
    ? `${brand.context.slice(0, brandContextChars)}\n\n_[… truncated; read ./${SIDE_FILES.brandContext} for the full text]_`
    : brand.context;
  if (brandTruncated) {
    files.push({ path: SIDE_FILES.brandContext, content: `# Brand context — ${brand.name}\n\n${brand.context.trim()}\n` });
  }

  const excerpt = work.brief.length > DOCUMENT_EXCERPT_CHARS
    ? `${work.brief.slice(0, DOCUMENT_EXCERPT_CHARS)}\n\n_[… truncated; read ./${WORK_FILES.brief} for the full text]_`
    : work.brief;

  const parts: string[] = [
    MANAGED_MARKER,
    '<!-- Generated by Latte from the discipline pack, the brand context, inherited brand knowledge, the working document and the decision log.',
    '     Edit those in the Latte app; this file is rewritten when a new agent session starts. -->',
    '',
    `# Latte · ${brand.name} · ${work.title}`,
    '',
    'You are working inside a Latte work directory. Latte is a local-first marketing',
    'workspace: the human directs, you execute, everything stays on this machine.',
    '',
  ];

  if (pack && pack.body.trim().length > 0) {
    parts.push(`<!-- latte:pack ${pack.id}@${pack.version} -->`, pack.body.trim(), '', '---', '');
  }

  const brandEmpty = inherited
    ? 'No durable brand text yet. Previous work of this brand is listed below; do not claim you lack brand context if that section has decisions or artifacts.'
    : 'No brand context yet. Ask before assuming positioning, tone or audience.';
  parts.push(
    section('Brand context', brandExcerpt, brandEmpty),
  );
  if (inherited) {
    parts.push(section('Brand knowledge from previous work (inherited, not this work\'s delta)', inherited.body, ''));
  }
  parts.push(
    section('Tracked deliverables of this work', documentLines, `Only ./${WORK_FILES.brief} is tracked so far.`),
    section('Funnel coverage of this work', coverageLines, 'Nothing is tracked yet, so the funnel is empty.'),
    section(`The brief (current state of ./${WORK_FILES.brief})`, excerpt, 'The brief is still empty. Ask the human what the deliverable should be.'),
  );
  const outcome = outcomeSection(work, input.resultExists);
  if (outcome) parts.push(outcome);
  parts.push(
    section('Decisions already taken in this work (do not reopen)', decisionLines, 'No decisions recorded yet in this work.'),
    section('The team on this work', teamLines, 'You are the only one open on this work.'),
    section('Roles that could be called in', availableLines, 'Every shipped role is already open here.'),
  );

  if (memory && memory.trim().length > 0) {
    parts.push(section('Memory from previous sessions', memory, ''));
  }

  // Skills travel through the instruction file as a pointer, not a body: like
  // the pack's base prompt, this file is re-sent on every turn and prompt-cached
  // by the runtime, so a skill's full text lives in its own side file instead of
  // being repriced on every message it never changes.
  for (const skill of input.skills ?? []) {
    const body = skill.body.trim();
    if (body.length === 0) continue;
    const skillPath = SIDE_FILES.skill(skill.id);
    parts.push(
      `<!-- latte:skill ${skill.id} -->`,
      section(skill.name, `Before writing final copy for the human, read ./${skillPath} and follow it.`, ''),
    );
    files.push({ path: skillPath, content: `# ${skill.name}\n\n${body}\n` });
  }

  const generationPointer = generationPointerSection(input.generation ?? null, includeLearnedRefs);
  if (generationPointer) parts.push(generationPointer.text);

  parts.push(
    '## Working rules',
    `- Write all human-facing answers and new deliverable content in ${input.outputLanguage === 'en-US' ? 'English (United States)' : 'Spanish (Argentina)'}. Keep file names, stage IDs, commands, code, and persisted contracts unchanged.`,
    // E2: `entregables/` es la frontera: sólo lo publicado. Los borradores van
    // en la raíz o en `borradores/`, y publica Latte después de la revisión.
    `- ./${DELIVERABLES_DIR}/ holds only what was published for the client, one current version per piece: never write there yourself. Drafts go at the top level or in ./${DRAFTS_DIR}/. In a team run Latte publishes a client task's file after the reviewer passes it and moves older versions to ./${DELIVERABLES_DIR}/.versiones/; outside a run, move a finished piece there only when the human asks. Keep context, instructions, handoff requests and tracked Markdown where they are; never overwrite an output without permission.`,
    '- Before drafting a client document, use relevant brand context, brief, expected output, source documents and approved decisions already available; read missing relevant sources instead of copying the whole context again. Keep evidence, hypotheses and pending choices distinct from approved decisions; never invent agreement or present an assumption as a fact.',
    '- Produce real formats only with tools actually available. Renaming Markdown to .pdf/.docx/.xlsx is not conversion. Existence and size do not validate the format: open or parse it with a format-appropriate tool. For paginated documents, when tools permit, render and visually inspect every page; correct defects and repeat the checks before calling it ready. If generation, parsing or visual inspection tools are missing, report the blocker and exact QA scope, offer a real alternative, and never imply an unperformed check passed. Latte lists these files; it does not generate, validate, approve or version binary outputs. Prefer self-contained HTML without external assets; opening HTML is an explicit human decision.',
    `- When a PDF or DOCX is asked for, the file is the answer, not a description of it, and it is not done until the file exists (in ./${DRAFTS_DIR}/ or published in ./${DELIVERABLES_DIR}/). Do not conclude that from what you intended or planned: after writing it, check that it is there and not empty (list the folder or read its size), then give its relative path (in a team run, in \`files\` when you report). If the check fails, say so; never report a file you did not verify.`,
    '- A deliverable file holds only the finished piece for the client: no internal reasoning, thinking notes, plans or instructions to yourself.',
    identityLine(input.identity ?? null),
    '- Handoff: give the relative path, checks actually performed and remaining limitations, then direct the human to Entregables / Deliverables for review. If no agent tool is available for linking, ask the human to use Encargo > Resultado esperado / Expected output > Editar / Edit in the desktop app, select the file and choose Guardar / Save; never edit SQLite or managed metadata to link it, and do not claim it is linked until confirmed. File creation, QA, human approval and result linking are separate steps.',
    '',
    `- Each tracked file listed above is a deliverable of its own. Write in the one your task belongs to; \`./${WORK_FILES.brief}\` holds the ask, not every result.`,
    '- The human edits these same files from Latte. Re-read a file immediately before editing it and keep it valid Markdown.',
    '- A save made THROUGH Latte is refused when the file no longer matches the version Latte last saw, and the version on disk is kept for the human to resolve. A write you make directly to the file is not intercepted: it replaces what was there and Latte only notices afterwards. Re-read a file immediately before editing it.',
    '- You cannot register a document yourself: this file is managed by Latte. But a Markdown file you create at the top level of this folder is offered to the human in the app as "agregar como documento", and once they accept it gets versions and export. So: create the file, then say plainly that it is there and worth adding.',
    `- \`./${WORK_FILES.claude}\` and \`./${WORK_FILES.agents}\` are managed by Latte. Do not edit them.`,
    `- \`./${WORK_FILES.metaDir}/\` holds immutable snapshots. Never modify or delete anything in it.`,
    '- Stay inside this directory. Do not touch other brands, other works or global tool configuration.',
    `- Brand continuity is automatic. Inherited knowledge is in "Brand knowledge from previous work", ./${SIDE_FILES.brandMemory} and local copies under ./${BRAND_MEMORY_DIR}/ — not this work's delta. When an excerpt is not enough, read the local copy here; do not leave this directory or open another work. Do not claim you lack brand context when those files have content. Inherited decisions keep their origin; never read another brand.`,
    '- MCP is optional: use only tools actually exposed by the current runtime and configured by the human; never assume a provider or preinstalled server. A missing tool blocks only that external action: explain what is missing, point the human to Herramientas (MCP) / Tools (MCP), and continue ordinary local work. Do not install servers or change global configuration yourself.',
    '- Distinguish a request to plan from a request to execute. Use only the relevant brief, approved decisions, files and expected output, without copying all context. Before external side effects, confirm scope, target account, budget and business authorization (including whether spending is allowed). Technical tool permissions are not business authorization. If any required approval or detail is missing, ask and wait for the human before that action. Once authorized and available, execute with the real tool rather than substituting Markdown; never invent a tool call or success.',
    '- Verify external execution: query remote state after the action when a read/status tool is available; otherwise report the outcome as unconfirmed and explain the verification blocker. A timeout is not proof of failure: reconcile remote state before considering another attempt and do not retry blindly. Put result files in ./borradores/; report remote IDs, observed status and pending steps in the response or a relevant existing document, without inventing confirmation; never include credentials or secrets.',
    input.decisionAuthority === 'off'
      ? '- Decision suggestions are disabled for this work. Do not emit decision protocol blocks.'
      : '- When the human explicitly agrees to a durable choice, invoke Latte\'s decision protocol by appending exactly one fenced `latte-decision` JSON block with: `statement`, `rationale`, optional `alternativesRejected` and `evidenceRefs`, and a stable unique `clientRequestId`. This is a structured tool fallback, not prose detection. Never emit it for facts, hypotheses, recommendations awaiting approval, summaries, temporary actions or technical permissions. Latte will either ask the human to approve it or record it according to the separate decision-authority setting.',
    ...brandContextProtocolLines(input, protocol),
    `- The funnel stages are \`${FUNNEL_STAGES.join('`, `')}\`. You do not assign them; the human does, when they adopt the file. What you can do is propose one: begin a Markdown file you create with a front matter block — a line \`---\`, then \`funnel: ${FUNNEL_STAGES[2]}, ${FUNNEL_STAGES[3]}\`, then a line \`---\`. Latte reads it when the human adopts the file and takes it out of the deliverable. Name only the stages the piece really serves.`,
    '- Say plainly which stages have nothing in them. An empty stage is a finding, not a detail.',
    '- You share this folder with the team, but not their conversations: you cannot read what they said and you cannot write to them. What you can do is ask for one of them, and the human decides.',
    '- To ask for a role, write a Markdown file at the top level whose front matter is a line `---`, then `para: <role id>`, then a line `---`, and put the request in the body: what you need from them, and what you already checked so they do not redo it. Latte offers it to the human, who opens that conversation with your request loaded. Ask only when the other role would genuinely do it better; doing the work yourself is usually the right answer.',
  );
  if (memoryProject) {
    // Task 6.27: the wording follows whether the tools actually arrived.
    // TRUE (the normal case once engram ships by default) drops the
    // conditional entirely — it no longer applies — and, since spike 6.26
    // proved a tool-supplied `project` argument WINS over the pinned
    // `--project`/`ENGRAM_PROJECT`, adds the explicit instruction never to
    // pass one: the pinning sets the right default, but it is not a jail.
    // FALSE/omitted (OpenCode, or engram missing) keeps the EXISTING line
    // verbatim — still the honest instruction for a member that may have
    // configured its own server, since nothing was actually injected here.
    parts.push(
      memoryToolsInjected
        ? `- Memory: you have Engram tools, already scoped to this brand (project \`${memoryProject}\`). Save and search without passing a project — it is fixed for you. Never pass a \`project\` argument to a memory tool: an explicit one overrides the pinned default and could write into or read another brand's memory.`
        : `- Memory: if you have Engram tools, always pass project \`${memoryProject}\` explicitly when saving or searching. Never rely on auto-detected project names; other brands must not see this brand's memories.`,
    );
  }
  parts.push('');

  return {
    text: parts.join('\n'),
    files,
    brandTruncated,
    decisionsTruncated,
    brandMemoryTruncated: inherited?.truncated ?? false,
    learnedOmitted: generationPointer?.learnedOmitted ?? false,
  };
}

function generationPointerSection(
  generation: GenerationPointerInput | null,
  includeLearnedRefs: boolean,
): { text: string; learnedOmitted: boolean } | null {
  if (!generation) return null;
  const pinPath = `${WORK_FILES.metaDir}/${WORK_FILES.generationsDir}/${generation.generationId}/context.json`;
  const identity = generation.kitHash
    ? `- Identity snapshot hash: \`${generation.kitHash}\`.`
    : '- No identity kit and no agency signature: explicit-neutral. Do not invent official colours, type or a logo.';
  const learnedOmitted = !includeLearnedRefs && generation.skillRefs.length > 0;
  const learnedLines = includeLearnedRefs && generation.skillRefs.length > 0
    ? generation.skillRefs.map((s) => `- \`${s.skillId}@${s.version}\` sha256 \`${s.hash}\``)
    : learnedOmitted
      ? ['- Learned skills were omitted from this file because they did not fit the remaining instruction budget. Shipped skills were not turned off to make room.']
      : ['- No approved learned skills in this receipt.'];
  return {
    learnedOmitted,
    text: section(
      'Pinned generation context',
      [
        `This work is pinned to generation \`${generation.generationId}\` (context sha256 \`${generation.contextHash}\`).`,
        identity,
        ...learnedLines,
        `- Full snapshot: \`./${pinPath}\`. A valid receipt is not proof that a deliverable applied the kit.`,
      ].join('\n'),
      '',
    ),
  };
}

/**
 * The context a CLI agent sees when launched inside a work directory, plus
 * the side files a truncated section or an enabled skill points to. Claude
 * Code reads CLAUDE.md, Codex and OpenCode read AGENTS.md; both get the same
 * rendered text and the same side files.
 *
 * Order: discipline pack (how to work) -> brand -> inherited brand knowledge ->
 * this work's documents -> brief -> this work's decisions -> rules.
 * If the rendered text still exceeds INSTRUCTIONS_MAX_CHARS, sections are
 * squeezed further — decisions first (local then inherited), then brand
 * context and inherited artifacts — and a footer says so. The pack body, the
 * brief excerpt, the team/roles sections and the Working rules are never trimmed.
 */
export function renderInstructionBundle(input: InstructionsInput): InstructionBundle {
  // The footer itself takes room: budget for its longest possible wording
  // so the cap check accounts for it instead of the footer quietly
  // pushing the final text back over INSTRUCTIONS_MAX_CHARS.
  const footerReserve = compactedFooter(['decisions', 'brand', 'brandMemory']).length;
  const fits = (text: string) => text.length + footerReserve <= INSTRUCTIONS_MAX_CHARS;
  const hasLearned = (input.generation?.skillRefs.length ?? 0) > 0;

  const run = (includeLearned: boolean, protocol: BrandContextProtocolOpts) => {
    let rendered = renderCore(input, DECISIONS_INLINE_MAX, BRAND_CONTEXT_CHARS, includeLearned, INHERITED_DECISIONS_INLINE_MAX, INHERITED_ARTIFACTS_INLINE_MAX, protocol);
    // overCap is the first render: even if a later squeeze fits, the footer
    // still records that the file had to be compacted.
    const overCap = !fits(rendered.text);
    if (overCap) {
      rendered = renderCore(input, DECISIONS_INLINE_FLOOR, BRAND_CONTEXT_CHARS, includeLearned, INHERITED_DECISIONS_INLINE_FLOOR, INHERITED_ARTIFACTS_INLINE_MAX, protocol);
    }
    if (overCap && !fits(rendered.text)) {
      rendered = renderCore(input, DECISIONS_INLINE_FLOOR, BRAND_CONTEXT_CHARS_FLOOR, includeLearned, INHERITED_DECISIONS_INLINE_FLOOR, INHERITED_ARTIFACTS_INLINE_FLOOR, protocol);
    }
    return { rendered, overCap };
  };

  // The nudge is computed by the service (brand-scoped owner election). A pure
  // render without one keeps the historical default.
  const nudge = resolvedNudge(input);
  const fullProtocol: BrandContextProtocolOpts = { updateLine: true, nudge };
  // Base, brief, rules and shipped skills are never dropped to make room for learned refs.
  let { rendered, overCap } = run(true, fullProtocol);
  let includeLearned = true;
  if (overCap && hasLearned && !fits(rendered.text)) {
    const dropped = run(false, fullProtocol);
    rendered = dropped.rendered;
    overCap = dropped.overCap;
    includeLearned = false;
  }
  // Protocol extras participate in the budget only while the squeezed file still
  // overflows: drop the filled-context update line, and shorten the empty nudge.
  // A suppressed nudge ('none') is NEVER resurrected by the squeeze: the agent
  // must not be told to draft what another work already owns.
  if (overCap && !fits(rendered.text)) {
    const squeezed: BrandContextNudge = {
      form: nudge.form === 'full' ? 'short' : nudge.form,
      reason: nudge.reason,
    };
    rendered = run(includeLearned, { updateLine: false, nudge: squeezed }).rendered;
  }
  if (!overCap) return { text: rendered.text, files: rendered.files };

  const cut: Array<'decisions' | 'brand' | 'brandMemory'> = [];
  if (rendered.decisionsTruncated) cut.push('decisions');
  if (rendered.brandTruncated) cut.push('brand');
  if (rendered.brandMemoryTruncated) cut.push('brandMemory');
  // Nothing left we're allowed to trim actually shrank: no honest pointer to add.
  if (cut.length === 0) return { text: rendered.text, files: rendered.files };

  return { text: `${rendered.text}\n${compactedFooter(cut)}`, files: rendered.files };
}

/** The footer appended when the hard cap forced sections below their normal ceiling. */
function compactedFooter(cut: Array<'decisions' | 'brand' | 'brandMemory'>): string {
  const pointers = cut.map((c) => {
    if (c === 'decisions') return `the full decision log of this work in ./${SIDE_FILES.decisions}`;
    if (c === 'brand') return `the full brand context in ./${SIDE_FILES.brandContext}`;
    return `the inherited brand snapshot in ./${SIDE_FILES.brandMemory}`;
  });
  return section(
    'This file was compacted',
    `Latte shortened this file to stay closer to its ${INSTRUCTIONS_MAX_CHARS}-character budget, since it is re-sent on every turn. Read ${pointers.join(' and ')} for what does not fit here.`,
    '',
  );
}

/**
 * E4: la identidad de la marca, en una línea. Con kit aprobado apunta a lo que
 * Latte proyectó en `./identidad/`; sin él, explicit-neutral: nada inventado,
 * y la portada de un entregable para el cliente lo dice.
 */
function identityLine(identity: { hash: string } | null): string {
  return identity
    ? `- Identity: ./${IDENTITY_DIR_NAME}/IDENTIDAD.md and the files next to it (the approved brand kit, sha256 \`${identity.hash.slice(0, 12)}\`). Client deliverables apply it: logo, palette, type. Latte keeps ./${IDENTITY_DIR_NAME}/ in sync; do not edit it.`
    : '- No approved brand identity: explicit-neutral. Do not invent official colours, type or a logo; a client deliverable\'s cover says there is no approved identity.';
}

/** Text-only form of renderInstructionBundle, for callers that never write the side files. */
export function renderInstructions(input: InstructionsInput): string {
  return renderInstructionBundle(input).text;
}

export function isManagedFile(content: string | null): boolean {
  return content !== null && content.trimStart().startsWith(MANAGED_MARKER);
}
