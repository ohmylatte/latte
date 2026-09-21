export type Provider = 'claude' | 'codex' | 'opencode';
export type UiLocale = 'es-AR' | 'en-US';
export type ContentLocale = UiLocale;

// --- First-run onboarding -----------------------------------------------------

export const ONBOARDING_STEP_VALUES = ['intent', 'context', 'brand', 'connect', 'prepare'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEP_VALUES)[number];

/**
 * Mid-flow onboarding progress, persisted so a person who abandons the walk
 * resumes at the same step with their answers intact. `assumptions` are
 * already-localized phrases. Stored as JSON under the `onboarding_draft` meta
 * key; cleared the moment the terminal `onboarding_complete` flag flips.
 */
export interface OnboardingDraft {
  step: OnboardingStep;
  workTypeId: string | null;
  answers: Record<string, string | string[]>;
  assumptions: string[];
  brandId: string | null;
  usedDemo: boolean;
  /** Records the intent to link an existing folder (honoured at the start CTA). */
  linkFolderRequested: boolean;
  recommendedRoleId: string;
  brief: string;
}

/** True when a value has the shape of a persisted onboarding draft. */
export function isOnboardingDraft(value: unknown): value is OnboardingDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  if (typeof d.step !== 'string' || !(ONBOARDING_STEP_VALUES as readonly string[]).includes(d.step)) return false;
  if (d.workTypeId !== null && typeof d.workTypeId !== 'string') return false;
  if (typeof d.answers !== 'object' || d.answers === null || Array.isArray(d.answers)) return false;
  for (const v of Object.values(d.answers as Record<string, unknown>)) {
    if (typeof v !== 'string' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) return false;
  }
  if (!Array.isArray(d.assumptions) || d.assumptions.some((a) => typeof a !== 'string')) return false;
  if (d.brandId !== null && typeof d.brandId !== 'string') return false;
  if (typeof d.usedDemo !== 'boolean') return false;
  if (typeof d.linkFolderRequested !== 'boolean') return false;
  if (typeof d.recommendedRoleId !== 'string') return false;
  if (typeof d.brief !== 'string') return false;
  return true;
}

export interface Brand { id: string; name: string; context: string; createdAt: string; archivedAt: string | null }
export interface Work {
  id: string;
  brandId: string;
  title: string;
  brief: string;
  /**
   * Folder the user chose for this work. Latte works IN it: no copy is made.
   * null means Latte keeps the work in its own data directory.
   */
  folder: string | null;
  /**
   * What the human expects to receive when the work is done ("PDF de dos
   * páginas con la propuesta"). The brief stays the goal; this names the
   * output. Absent or null: not defined, and the work behaves as before.
   */
  expectedOutput?: string | null;
  /**
   * The file the human linked as the result, relative to Deliverables
   * (`./entregables/`), e.g. `propuesta.pdf`. Deliverables stays the only list
   * of files: this is a pointer into it. Whether the file still exists is
   * read from that folder, never stored.
   */
  resultPath?: string | null;
  /**
   * Stages the human marked "out of scope" for this work. They stay visible in
   * the funnel but muted, and unmarking restores them. Only empty stages can be
   * out of scope (a stage with documents is never hidden). Defaults to [].
   */
  outOfScopeStages?: FunnelStage[];
  updatedAt: string;
}
/** The outcome of a work, the only part edited through `updateWork`. Omitted = unchanged; null or '' = cleared. */
export interface WorkPatch { expectedOutput?: string | null; resultPath?: string | null }

/** Identity and agency-signature choice for a work. Not part of WorkPatch. */
export type BrandIdentityMode = 'brand' | 'agency' | 'neutral';
export type BrandSignatureMode = 'none' | 'agency';
export interface BrandChoice { identity: BrandIdentityMode; signature: BrandSignatureMode }
export interface WorkBrandChoiceInput extends BrandChoice {
  allowNeutral?: boolean;
  allowAgencySignature?: boolean;
}
export interface FeatureFlags {
  generation: boolean;
  brandKits: boolean;
  learning: boolean;
  coordination: boolean;
}
export interface AgencyProfilePatch { publicName: string; website?: string | null; contact?: string | null }
export interface AgencyProfileView {
  revision: number;
  hash: string;
  publicName: string;
  website: string | null;
  contact: string | null;
}
export interface BrandKitDraftView {
  kitId: string;
  ownerKind: 'brand' | 'agency';
  ownerBrandId: string | null;
  permitsAgencySignature: boolean;
  assetCount: number;
  warnings: string[];
}
export interface BrandKitView {
  kitId: string;
  version: number;
  hash: string;
  ownerKind: 'brand' | 'agency';
}
export interface WorkBrandPolicyView {
  workId: string;
  brandId: string;
  revision: number;
  defaultChoice: BrandChoice;
  allowNeutral: boolean;
  allowAgencySignature: boolean;
}
/** Resolved composition. Generation worktree adapts this to its port after merge. */
export interface BrandContextSnapshot {
  schemaVersion: 1;
  /** Present only on a sealed generation. Preview IPC omits it; prepareGeneration mints the id. */
  generationId?: string;
  workId: string;
  brandId: string;
  choice: BrandChoice;
  identity: BrandIdentityMode;
  sourceKit: { kitId: string; version: number; hash: string } | null;
  rules: string;
  assets: ReadonlyArray<{ id: string; hash: string }>;
  signature: {
    agencyRevision: number;
    hash: string;
    publicName: string;
    website: string | null;
    logo: { id: string; hash: string } | null;
  } | null;
  warnings: readonly string[];
}
export interface WorkBrandContextView {
  receipt: {
    schemaVersion: 1;
    workId: string;
    brandId: string;
    brandContext: { kitId: string; version: number; hash: string } | null;
    skillRefs: ReadonlyArray<{ skillId: string; version: number; hash: string }>;
  };
  snapshot: BrandContextSnapshot;
}
/** Where a stored version came from. `external` = the file changed outside Latte; we never guess who wrote it. */
export type RevisionSource = 'human' | 'external' | 'latte';
export interface Revision { id: string; workId: string; documentId: string; source: RevisionSource; content: string; createdAt: string }

// --- Documents: a work holds one or more tracked Markdown deliverables ---------

/** `brief` is the default document of every work. The rest are optional. */
export type DocumentKind = 'brief' | 'strategy' | 'calendar' | 'research' | 'copy' | 'note';
export type DocumentStatus = 'draft' | 'review' | 'approved';
export type FunnelStage = 'discovery' | 'consideration' | 'conversion' | 'retention';
export interface DocumentPatch { title?: string; status?: DocumentStatus; funnelStages?: FunnelStage[] }
export interface WorkDocument {
  id: string;
  workId: string;
  kind: DocumentKind;
  title: string;
  /** Latte-generated file name inside the work directory (e.g. `strategy.md`). */
  fileName: string;
  status: DocumentStatus;
  funnelStages: FunnelStage[];
  /** What the agent proposed and you have not answered yet; empty when there is nothing pending. */
  proposedFunnelStages: FunnelStage[];
  /** Document this one was derived from (a calendar built on a strategy). */
  baseDocumentId: string | null;
  /** Exact version of the base document used, so a later change is visible as "needs review". */
  baseRevisionId: string | null;
  baseFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Content plus the fingerprint a later save must present to prove it edited this version. */
export interface DocumentContent {
  document: WorkDocument;
  content: string;
  fingerprint: string;
  modifiedAt: string | null;
  /** True when the base document moved on since this document declared its base version. */
  baseOutdated: boolean;
}
/** What linking a folder found and registered. Nothing is copied or moved. */
export interface FolderLinkResult {
  work: Work;
  folder: string;
  /** Markdown found at the top level and now tracked with versions of its own. */
  documents: WorkDocument[];
  /** Other files at the top level: left exactly as they are, readable by an agent. */
  otherFiles: string[];
  subfolders: string[];
  /** Files Latte created or refreshed inside the folder. */
  managedFiles: string[];
}

// --- MCP: the tools an agent can reach beyond this folder ----------------------

/** A server as its runtime reports it. Latte neither implements MCP nor stores credentials. */
export interface McpServer {
  name: string;
  transport: 'stdio' | 'http';
  /** Command line or URL, as configured. */
  target: string;
  status: 'connected' | 'failed' | 'pending' | 'disabled' | 'configured' | 'needsAuth';
  detail: string;
  /** Codex `mcpServerStatus/list` auth, or Claude health text. */
  needsAuth?: boolean;
}
export interface McpRuntimeTools {
  runtime: ChatRuntime;
  installed: boolean;
  /** False when the runtime can only be read from here (OpenCode's add is interactive). */
  canEdit: boolean;
  detail: string;
  servers: McpServer[];
}
export interface McpServerInput {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  /** KEY=VALUE pairs handed to the runtime; Latte never persists them. */
  env: string[];
}

/** A Markdown file in the work folder that is not a tracked document yet. */
/**
 * Everything in the work folder that is NOT a tracked document: the client's
 * own files and its subfolders. Latte cannot adopt these, but the agent reads
 * them, so the person has to be able to see them too.
 */
/**
 * A skill Latte ships: how every agent writes, not who works. On by default,
 * because quality is not an option each person has to discover and enable.
 */
/** A role one agent asked for, waiting on the human who decides. */
export interface HandoffRequest { fileName: string; roleId: string; roleName: string; known: boolean; request: string }

export interface AgentSkill { id: string; name: string; summary: string; enabled: boolean }

/** Learned-skill candidate waiting on a human. Never mixed with shipped `skill-off:` ids. */
export type SkillCandidateState =
  | 'draft'
  | 'validating'
  | 'needs_review'
  | 'blocked'
  | 'approved'
  | 'rejected'
  | 'superseded';
export interface SkillCandidate {
  id: string;
  skillId: string;
  scopeKey: string;
  state: SkillCandidateState;
  revision: number;
  contentHash: string;
  name: string;
  description: string;
  markdown: string;
  patternKey: string;
  createdAt: string;
  duplicateSpend: boolean;
}
export interface SkillReviewInput {
  candidateId: string;
  expectedRevision: number;
  expectedHash: string;
  requestId: string;
}
export interface SkillPromoteInput {
  candidateId: string;
  requestId: string;
}

export interface FolderEntries { subfolders: string[]; otherFiles: string[]; truncated: boolean }
export interface DeliverableFile { fileName: string; extension: string; bytes: number; modifiedAt: string }
export interface DeliverableListing { files: DeliverableFile[]; truncated: boolean }

export interface UntrackedFile { fileName: string; title: string; kind: DocumentKind; bytes: number; modifiedAt: string | null; /** Stages the agent proposed in the file; empty when it proposed none. */ funnelStages: FunnelStage[] }

/** Cheap poll answer used to notice external edits without a filesystem watcher. */
export interface DocumentState { documentId: string; fingerprint: string; modifiedAt: string | null; baseOutdated: boolean }
/**
 * A save never overwrites silently. On `conflict` the disk version is kept as
 * an immutable revision, the editor keeps the human draft, and the user picks.
 */
export type SaveOutcome =
  | { status: 'saved'; document: WorkDocument; fingerprint: string; work: Work }
  | { status: 'conflict'; document: WorkDocument; disk: DocumentContent; keptRevision: Revision };
export type DecisionAuthorityMode = 'off' | 'suggest' | 'auto-record';
export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'archived' | 'superseded';
export interface DecisionSource { chatId: string | null; messageId: string | null; memberId: string | null; roleId: string | null; runtime: ChatRuntime | null }
export interface Decision {
  id: string; workId: string; text: string; rationale: string; alternativesRejected: string[]; evidenceRefs: string[];
  status: DecisionStatus; source: DecisionSource; clientRequestId: string | null; fingerprint: string; createdAt: string; decidedAt: string | null;
}
export interface DecisionProposalInput { statement: string; rationale: string; alternativesRejected?: string[]; evidenceRefs?: string[]; clientRequestId: string }
export type BrandContextMode = 'replace' | 'append';
export type BrandContextProposalStatus = 'pending' | 'approved' | 'rejected';
export interface BrandContextProposal {
  id: string;
  brandId: string;
  workId: string;
  /** Who proposed it: same shape as a decision source. */
  source: DecisionSource;
  text: string;
  rationale: string;
  mode: BrandContextMode;
  status: BrandContextProposalStatus;
  fingerprint: string;
  /** Huella de Brand.context al momento de proponer. */
  baseFingerprint: string;
  /** True when Brand.context no longer matches baseFingerprint. Filled when listing. */
  stale?: boolean;
  clientRequestId: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** Why it was decided. `superseded` is the visible trail of a replaced pending proposal. */
  decidedReason?: 'approved' | 'rejected' | 'superseded' | 'auto-recorded' | null;
  /** The proposal that replaced this one, when `decidedReason` is `superseded`. */
  supersededBy?: string | null;
}
export interface BrandContextProposalInput { text: string; rationale: string; mode: BrandContextMode; clientRequestId: string }
/** Why a brand-context revision exists: who applied the change. */
export type BrandContextRevisionSource = 'human' | 'proposal' | 'clear' | 'restore';
/**
 * One immutable entry of the history of `brands.context`.
 *
 * Nothing can update or delete a row (the database refuses), so a wipe is
 * always recoverable. `origin` says what produced it: the proposal id for an
 * approval, the revision id a restore came from, or null for a hand edit.
 */
export interface BrandContextRevision {
  id: string;
  brandId: string;
  source: BrandContextRevisionSource;
  origin: string | null;
  content: string;
  /** Canonical hash of `content`; the same value a save sends back for its check. */
  fingerprint: string;
  createdAt: string;
}
/** One work of the brand, as the Contexto view needs it. */
export interface BrandContextStatusWork {
  id: string;
  title: string;
  /** A running agent session is reading this work's instruction files. */
  live: boolean;
}
/**
 * Everything the Contexto view knows about the brand context beyond the brand
 * record: the fingerprint the editor loaded (sent back on every write so a
 * concurrent change is refused instead of silently overwritten), the proposals,
 * the brand's works and the history.
 */
export interface BrandContextStatus {
  brandId: string;
  fingerprint: string;
  pending: BrandContextProposal | null;
  proposals: BrandContextProposal[];
  works: BrandContextStatusWork[];
  /** The work that owns the empty-context draft, or null when the brand has none. */
  ownerWorkId: string | null;
  /** Newest first. */
  revisions: BrandContextRevision[];
}
/**
 * What a brand-context write did to the brand's works, as work ids.
 *
 * `live` are works with a running agent session: the write does not reach them
 * and the UI must say so. `userOwned` are works where the human replaced the
 * managed file with their own. `unchanged` needed no write at all.
 */
export interface BrandContextRefreshReport {
  updated: string[];
  unchanged: string[];
  live: string[];
  userOwned: string[];
}
/** Result of approving or rejecting a proposal: the decided proposal, the brand and the propagation. */
export interface BrandContextDecisionResult {
  proposal: BrandContextProposal;
  brand: Brand;
  refresh: BrandContextRefreshReport;
}
/** Result of writing `brand.context` by hand: the persisted brand and the propagation. */
export interface BrandContextSaveResult {
  brand: Brand;
  refresh: BrandContextRefreshReport;
}
export interface AgentEvent { sessionId: string; type: 'output' | 'exit' | 'error'; data: string }
export interface AgentSession { id: string; provider: Provider; workId: string }
export interface RuntimeStatus { provider: Provider; available: boolean; detail: string }
export interface MemoryResult { available: boolean; text: string }
/** Read-only facts about this installation, shown in the Settings screen. */
export interface AppInfo {
  dataDir: string;
  engine: string;
  engineReason: string;
  pack: string | null;
  packRoles: number;
  /** The running app's version: Electron's `app.getVersion()` (package.json in dev, packaged metadata otherwise). */
  version: string;
}

// --- Updates -----------------------------------------------------------------

/**
 * Where the update flow stands. `unsupported` is the honest state for a source
 * checkout or a build without the updater: nothing is checked and nothing is
 * promised.
 */
export type UpdatePhase = 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
export type UpdateUnsupportedKind = 'source' | 'manual-install' | 'unavailable';

export interface UpdateState {
  phase: UpdatePhase;
  /** Backend-owned reason category. Present only while `phase` is unsupported. */
  unsupportedKind?: UpdateUnsupportedKind;
  /** Version being offered, downloaded or ready. Null when there is nothing. */
  version: string | null;
  /** 0..100 while downloading; 0 otherwise. */
  percent: number;
  /** Reason for `unsupported` and `error`; empty for every other phase. */
  message: string;
}

/**
 * Result of asking to install. `unsaved` is a refusal, not a warning: the
 * update never starts while a document has changes the user has not saved.
 */
export type InstallOutcome =
  | { status: 'installing' }
  | { status: 'unsaved' }
  | { status: 'cancelled' }
  | { status: 'not-ready' };

// --- Structured chat (OpenCode runtime underneath, native Latte UI on top) ---

export type ChatRole = 'user' | 'assistant';
export type ChatToolStatus = 'pending' | 'running' | 'completed' | 'error';
export type ChatPart =
  | { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'tool'; id: string; tool: string; status: ChatToolStatus; title: string; input: string; output: string; error: string };
export interface ChatMessage { id: string; chatId: string; role: ChatRole; parts: ChatPart[]; createdAt: string; completed: boolean; error: string | null }
/** Which local runtime drives a chat: OpenCode (API-key providers), Claude Code or Codex (their own subscription logins). */
export type ChatRuntime = 'opencode' | 'claude' | 'codex';
/**
 * A live conversation. Its id is the team member's id, so it stays stable
 * across pause/resume and app restarts.
 */
export interface ChatSession { id: string; workId: string; provider: ChatRuntime; model: string | null; accountId: string | null; label: string; resumed: boolean; roleId: string; roleName: string; /** On a resume: whether earlier messages could be shown again. False means the runtime kept its context but Latte has no local record. */ historyRecovered: boolean }

// --- Team: roles with a preset personality, one conversation each ---------------

/**
 * How hard a member works on each answer. A plain choice for the human, never
 * a model ID: each runtime translates it into its own model and reasoning
 * effort (Claude Code: `--model` + `--effort`; Codex: reasoning effort;
 * OpenCode: variant when the server supports one). `light` answers fast and
 * spends little of the plan; `deep` thinks longer and spends more. A member
 * with an explicit `model` keeps that model and only takes the effort.
 */
export type EffortTier = 'light' | 'balanced' | 'deep';
export const EFFORT_TIERS: readonly EffortTier[] = ['light', 'balanced', 'deep'];
export const DEFAULT_EFFORT_TIER: EffortTier = 'balanced';

/**
 * What a conversation has consumed, in the runtime's own numbers. Latte never
 * estimates from text length: every field comes from what the runtime
 * reported, so a zero means "nothing yet", not "unknown". `costUsd` is null
 * when the runtime gave none (subscriptions usually don't).
 */
export interface ChatUsage {
  /** Fresh input tokens the model read (not served from cache). */
  inputTokens: number;
  /** Tokens the model generated: the visible answer plus reasoning when the runtime counts it. */
  outputTokens: number;
  /** Input tokens served from the prompt cache. Cheap: this is what keeps a long conversation affordable. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens: number;
  /** Turns counted so far. */
  turns: number;
  /** Cost the runtime itself estimated, in USD. Null when it did not say. */
  costUsd: number | null;
  /** Size of what the model re-reads on each new message, after the last turn. Null until a turn reports it. */
  contextTokens: number | null;
}
export const EMPTY_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, costUsd: null, contextTokens: null };

/** A preset personality a team member opens with. Shipped by the discipline pack; `assistant` is the neutral default. `tier` is the effort it opens with unless the human picks another. */
export interface AgentRole { id: string; name: string; initial: string; summary: string; builtin: boolean; tier: EffortTier }
export interface AgentProfile extends AgentRole { soul: string; skills: string; source: 'builtin' | 'custom'; directory: string | null; fingerprint: string; /** Invalid disk entries are visible but must not be edited or cloned. */ error?: string }
export interface ProfileInput { id: string; name: string; initial: string; summary: string; soul: string; skills: string }
/** working = answering now · idle = open and waiting · paused = closed, resumable · ended = finished by the user (can be reopened). */
export type TeamMemberStatus = 'working' | 'idle' | 'paused' | 'ended';
/** A role opened inside a work: its own conversation, runtime, account and status. Persisted and resumable. */
export interface TeamMember {
  id: string;
  workId: string;
  roleId: string;
  roleName: string;
  initial: string;
  runtime: ChatRuntime;
  model: string | null;
  accountId: string | null;
  label: string;
  status: TeamMemberStatus;
  /** How hard this member works per answer. Starts as the role's default; the human can change it any time. */
  tier: EffortTier;
  /** Everything this member consumed across all its sessions, as the runtimes reported it. Never estimated. */
  usage: ChatUsage;
  /** Member of the same work this one took over from ("continuar con otro agente"); null when opened from scratch. A reference only: the origin is never changed. */
  continuedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Advanced overrides when adding a member; empty = the primary agent. `continuedFrom` names the member of the same work it continues. `tier` overrides the role's default effort. */
export interface TeamMemberOptions { runtime?: ChatRuntime | null; model?: string | null; accountId?: string | null; continuedFrom?: string | null; tier?: EffortTier | null }
/**
 * What a new member needs to continue another one's work, assembled by Latte
 * from its own records: no model summarises anything. The human edits it
 * before it becomes the new member's first message.
 */
export interface ContinuationDraft { sourceMemberId: string; text: string }
/** The agent a new chat starts with. Chosen once in the Providers screen, never asked per chat. */
export interface PrimaryAgent { runtime: ChatRuntime; model: string | null; accountId: string | null; label: string }
/** A Claude Code / Codex login. `system` = the user's own CLI profile; otherwise a Latte-managed profile directory. */
export interface AgentAccount {
  runtime: 'claude' | 'codex'; id: string; label: string; system: boolean; loggedIn: boolean; detail: string;
  /**
   * Model IDs worth suggesting for this account without asking anyone: the
   * aliases the CLI itself documents, plus whatever that account's own
   * configuration already uses. Cheap and always there. The real catalog, when
   * the runtime has one, arrives separately through `listAccountModels`.
   */
  models: string[];
}

/**
 * One model a runtime says this account can use.
 *
 * `source` is the point: `catalog` means the runtime answered with its own
 * list, `suggested` means Latte could only offer what it can state as fact.
 * The difference is shown, never hidden behind an identical-looking list.
 */
export interface AgentModel { id: string; label: string; description: string; isDefault: boolean }
export interface AgentModelList { source: 'catalog' | 'suggested'; models: AgentModel[]; detail: string }
/**
 * How much this work's team may do without stopping to ask.
 *
 * `ask` is the default: every tool asks. `folder` grants reading and writing
 * inside the work folder. `auto` means Latte answers each request itself —
 * once, never "always", so the moment it is turned off the next request asks
 * you again and no runtime kept a grant behind your back.
 */
export type WorkPermissionMode = 'ask' | 'folder' | 'auto';

/** What changing a conversation's model did. `session` is null when it was paused. */
export interface MemberModelChange { member: TeamMember; session: ChatSession | null; resumed: boolean }
export interface AgentRuntimeInfo { runtime: 'claude' | 'codex'; installed: boolean; version: string | null; detail: string; accounts: AgentAccount[] }
export type AccountLoginStart =
  | { mode: 'terminal'; sessionId: string; instructions: string }
  | { mode: 'browser'; url: string; instructions: string };
export interface ChatPermission {
  id: string;
  permission: string;
  patterns: string[];
  always: string[];
  title: string;
  /** MCP URL-mode elicitation; opened from main, never from the renderer. */
  url?: string;
  serverName?: string;
}
export interface ChatQuestionOption { label: string; description: string }
export interface ChatQuestionItem { header: string; question: string; options: ChatQuestionOption[]; multiple: boolean; custom: boolean; required?: boolean }
export interface ChatQuestion { id: string; questions: ChatQuestionItem[] }
export type ChatStatus = 'idle' | 'busy' | 'retry';
export type ChatEvent =
  | { chatId: string; type: 'message'; message: ChatMessage }
  | { chatId: string; type: 'part'; messageId: string; part: ChatPart }
  | { chatId: string; type: 'delta'; messageId: string; partId: string; delta: string }
  | { chatId: string; type: 'status'; status: ChatStatus; detail: string }
  | { chatId: string; type: 'permission'; request: ChatPermission }
  | { chatId: string; type: 'permission-resolved'; requestId: string }
  | { chatId: string; type: 'question'; request: ChatQuestion }
  | { chatId: string; type: 'question-resolved'; requestId: string }
  | { chatId: string; type: 'error'; message: string }
  /**
   * The runtime reported what a turn consumed. `turn` is that turn alone;
   * `total` is the member's lifetime consumption after adding it, as persisted
   * by Latte, so the UI never sums anything itself.
   */
  | { chatId: string; type: 'usage'; turn: ChatUsage; total: ChatUsage }
  | { chatId: string; type: 'closed'; reason: string };
export type PermissionReply = 'once' | 'always' | 'reject';
export interface ChatRuntimeStatus { available: boolean; detail: string; version: string | null; models: string[]; defaultModel: string | null }

// --- Providers (managed by the OpenCode runtime; Latte is only the UI, never the vault) ---

export interface ProviderPrompt { key: string; type: 'text' | 'select'; message: string; placeholder: string; options: Array<{ label: string; value: string; hint: string }> }
export interface ProviderAuthMethod { index: number; type: 'oauth' | 'api'; label: string; prompts: ProviderPrompt[] }
export interface ProviderInfo { id: string; name: string; connected: boolean; models: string[]; methods: ProviderAuthMethod[] }
export interface ProviderOAuthStart { url: string; method: 'auto' | 'code'; instructions: string }

/** Result of pinning a generation receipt. `pending` means live members blocked rewriting CLAUDE.md/AGENTS.md. */
export interface PrepareGenerationOutcome {
  generationId: string;
  contextHash: string;
  pending: boolean;
  instructionsRefreshed: boolean;
}

/**
 * Coordination (autonomous multi-agent runs): per-Work settings that cross
 * the IPC boundary. Everything else about a run (tasks, dispatches, the
 * mailbox) is Phase 3's `electron/coordination/engine.ts`; these three types
 * are only what a human configures ahead of time, following the
 * `DecisionAuthorityMode` precedent exactly — a closed union, validated on
 * write, defaulting to a safe value on an unset or invalid read.
 */
export type CoordinationAuthorityMode = 'manual' | 'plan' | 'auto';

/**
 * A Work's coordination budget default. `startCoordinationRun` (Phase 3)
 * copies this into `coordination_run.budget_json` at run start, so raising a
 * cap later never rewrites a run already in flight.
 *
 * `maxDispatches` is the primary, required unit: it is always countable
 * (`SUM(dispatches) WHERE kind='spend'`) with zero cost data. The other caps
 * are optional and secondary because `ChatUsage.costUsd` is nullable per
 * runtime — `maxCostMicros` is inherently best-effort, never authoritative.
 * `maxDispatches: null` means "no cap" and is only ever valid alongside an
 * explicit `unlimitedConfirmedAt` timestamp: an unlimited budget is always a
 * human choice, never an implicit default.
 */
export interface CoordinationBudget {
  maxDispatches: number | null;
  unlimitedConfirmedAt?: string | null;
  maxTokens?: number | null;
  maxCostMicros?: number | null;
  maxWallMinutes?: number | null;
  maxConcurrent?: number | null;
}

/**
 * The single team member (by id) holding the `coordinator` capability grant
 * for a Work, or `null` when none does. A capability, not a role: granting it
 * never changes the member's `roleId` or prompt.
 */
export type CoordinatorGrant = string | null;

/**
 * El tope app-wide, tal como cruza la frontera IPC: TRES estados, no dos.
 *
 * Antes este getter devolvía `CoordinationBudget | null` y colapsaba
 * "nunca se configuró" con "los bytes guardados no se pueden leer" en el
 * mismo `null`, que la pantalla renderiza como "sin tope global". Mientras
 * tanto el camino de despacho denegaba cada despacho contra esos mismos
 * bytes. La pantalla mentía, y la mentira era exactamente la inversa de lo
 * que pasaba. `invalid` existe para que la interfaz pueda decir "el tope no
 * se pudo leer, revisalo" en vez de "sin tope".
 */
export type CoordinationBudgetView =
  | { state: 'unset' }
  | { state: 'set'; budget: CoordinationBudget }
  | { state: 'invalid' };

/** El tope app-wide. Mismo contrato de tres estados que el presupuesto de un Trabajo, porque es el mismo dato guardado del mismo modo. */
export type CoordinationGlobalBudgetView = CoordinationBudgetView;

/**
 * Phase 3: the run/task/dispatch surface, reachable only through IPC in this
 * phase (no MCP transport exists yet — see `electron/coordination/engine.ts`).
 * These are read views over `LatteRepository`'s coordination rows, never the
 * rows themselves: the storage layer stays free to evolve independently of
 * what crosses the process boundary.
 */
export type CoordinationRunStatus = 'planning' | 'running' | 'suspended' | 'done' | 'cancelled';

/**
 * POR QUÉ ESTÁ DETENIDO UN EQUIPO. La lista COMPLETA de lo que el motor puede
 * escribir en `suspend_reason`, cerrada a propósito: el campo lo leen la
 * pantalla de Decisiones (`listGates` decide con él si hay una decisión de
 * presupuesto que tomar) y el tick (decide con él si puede reactivar). Un
 * motivo nuevo que nadie enumeró aparecía como una decisión de presupuesto
 * inventada.
 *
 * M9 (ronda 8): `coordination_disabled` es el que faltaba. Con
 * `feature:coordination` abajo, contestar una pregunta no reactiva el equipo
 * (N6) — pero el motivo tampoco puede seguir siendo `all_blocked_on_ask`
 * cuando ya no queda nada trabado: lo detiene el interruptor.
 *
 * Los `max_*` y `global_*` son los veredictos de presupuesto, y son
 * exactamente los que SÍ abren la decisión de presupuesto.
 */
export type CoordinationSuspendReason =
  | 'paused_by_human'
  | 'all_blocked_on_ask'
  | 'coordination_disabled'
  | 'budget_invalid'
  | 'global_budget_invalid'
  | 'max_dispatches' | 'max_tokens' | 'max_cost' | 'max_wall_minutes'
  | 'global_max_dispatches' | 'global_max_tokens' | 'global_max_cost' | 'global_max_wall_minutes';

/** Los dos motivos que nacen de una pregunta abierta y mueren cuando deja de haberla. */
export function isAskSuspendReason(reason: string | null): boolean {
  return reason === 'all_blocked_on_ask' || reason === 'coordination_disabled';
}

export interface CoordinationRunView {
  id: string;
  workId: string;
  status: CoordinationRunStatus;
  coordinatorMemberId: string | null;
  /**
   * Q10: `null` cuando los bytes de `budget_json` no se pueden leer, nunca un
   * presupuesto inventado. Acá se hacía un `JSON.parse` a pelo mientras todos
   * sus vecinos —la tira global, el getter del Trabajo, el camino de despacho—
   * ya toleraban una fila rota: una sola fila ilegible tumbaba `getCoordinationRun`
   * y con él la única salida que la persona tenía, que es cancelar ese run.
   */
  budget: CoordinationBudget | null;
  /** Q10: los bytes están rotos, que NO es lo mismo que "sin tope". Igual que en la tira global. */
  budgetInvalid: boolean;
  planApproved: boolean;
  /**
   * Lo que escribió el motor, tal como salió de la base. Se lee con
   * `CoordinationSuspendReason` en mente —esa unión es la lista completa de lo
   * que el motor PUEDE escribir— pero el tipo queda abierto a propósito: una
   * base vieja puede tener un motivo que esta versión ya no emite, y la
   * pantalla tiene que poder mostrarlo en vez de tumbarse.
   */
  suspendReason: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Whether this run is still one of the Work's ACTIVE runs
   * (`planning`/`running`/`suspended`). `getCoordinationRun` also answers with
   * the Work's LAST finished run (`done`/`cancelled`), so its bitácora — the
   * `run_done` closing entry included — does not vanish the moment the team
   * finishes; the renderer used to clear log, gates and asks on the `null`
   * this getter returned, so that entry was never seen once. A run with
   * `active: false` must never be offered live-run actions, and never appears
   * in the app-wide active strip.
   */
  active: boolean;
  /**
   * El instante del último hecho de este run: el máximo entre su propio
   * `updatedAt`, el `createdAt` del gate o del despacho más nuevo, y el
   * instante en que cerró. `updatedAt` solo no alcanzaba para "desde tu última
   * visita": un gate que nace o un despacho que arranca son exactamente lo que
   * la persona no vio, y ninguno de los dos reescribe la fila del run.
   */
  lastEventAt: string;
  /**
   * Cómo le fue a este run, contado sobre sus propias tareas y nunca guardado
   * como frase: `tasksDone` las que terminaron bien, `tasksFailed` las que
   * fracasaron y `tasksPending` todo lo demás (lo que quedó sin terminar).
   *
   * La interfaz los necesita para poder decir "este equipo terminó: N listas,
   * M fallidas" en vez de un "terminado" pelado que no dice si salió bien.
   * Un run cancelado no hace fracasar a nadie: ahí lo que importa es
   * `tasksPending`, y por eso las tres cuentas viajan separadas en vez de
   * colapsar `failed` dentro de "sin terminar".
   */
  tasksDone: number;
  tasksFailed: number;
  tasksPending: number;
}

/**
 * The gate kinds a human resolves with approve/reject. An open `latte_ask`
 * is a separate surface (`answerCoordinationAsk`) — its middle action is the
 * answer itself, not an edit. `'proposal'` (Phase 6, design-v2-conversational
 * D1): a worker's `latte_request_coordination` — the sentence becomes this
 * ONE gate. Unlike `'plan'` (which only appears under `'plan'` authority),
 * `'proposal'` appears in every authority mode: it decides the authority.
 */
export type CoordinationGateKind = 'plan' | 'dispatch' | 'budget' | 'proposal';

/** The aggregate across every OTHER active run, shown at a `proposal` gate — never hidden (design-v2-conversational D2). `null` fields mean an honest "can't sum this", never a fabricated number (e.g. another run is explicitly unlimited). */
export interface CoordinationGateAggregate {
  otherActiveRuns: number;
  otherCommittedDispatches: number | null;
  totalIfApproved: number | null;
}

/**
 * The shape of a `proposal` gate's `proposalJson`, mirrored from
 * `electron/coordination/engine.ts`'s own `CoordinationProposal` (Phase 7,
 * task 7.5) — the renderer parses `CoordinationGateView.proposalJson` into
 * this, never into a narrative summary. Kept in sync by hand: this type never
 * crosses IPC as its own `LatteAPI` method, it is only what a JSON string
 * field decodes to on both sides of the process boundary.
 */
export interface CoordinationProposalTask {
  roleId: string;
  spec: string;
  dependsOn?: number[];
}

export interface CoordinationProposalHire {
  roleId: string;
  why: string;
}

export interface CoordinationProposal {
  plan: CoordinationProposalTask[];
  /** `null` only ever means "unlimited", and only alongside `unlimitedConfirmedAt` — "no implicit unlimited" applies to a proposal exactly as it does to a Work's own budget default. */
  estimatedDispatches: number | null;
  unlimitedConfirmedAt?: string | null;
  membersToHire?: CoordinationProposalHire[];
  rationale: string;
}

export interface CoordinationGateView {
  id: string;
  kind: CoordinationGateKind;
  runId: string;
  taskId?: string | null;
  dispatchId?: string | null;
  /** Only present on a `dispatch` gate: the task prompt, editable before approval. */
  prompt?: string | null;
  /** Only present on a `proposal` gate: the whole proposal, JSON-encoded. */
  proposalJson?: string | null;
  /** Only present on a `proposal` gate. */
  aggregate?: CoordinationGateAggregate;
  /**
   * Q6: only present on a legible `proposal` gate — who can do each role the
   * plan names, decided by the engine. The renderer trims the plan with THIS
   * and never recomputes the team on its own: two different answers to
   * "who can do this role" is exactly how an approval bounces with an error
   * the screen did not see coming.
   */
  roleCoverage?: CoordinationGateRoleCoverage[];
  createdAt: string;
}

/**
 * `hire`: covered by a hire in this very proposal — unticking it trims its tasks.
 * `member`: the Work already has someone for it; nothing to hire.
 * `orphan`: nobody covers it. Possible on rows written by an older version, or
 * when the team changed between the proposal and the approval.
 */
export interface CoordinationGateRoleCoverage {
  roleId: string;
  coverage: 'hire' | 'member' | 'orphan';
}

export type CoordinationDispatchStatus = 'pending_approval' | 'dispatched' | 'running' | 'reported' | 'failed' | 'rejected' | 'cancelled';

/** One bitácora entry, derived only from a `coordination_dispatch` row's own timestamps — never narrative text. */
export interface CoordinationDispatchLogEntryView {
  /** Absent means the same as `'dispatch'`: every entry but the run's own closing one is a dispatch. */
  kind?: 'dispatch';
  id: string;
  taskId: string;
  memberId: string;
  status: CoordinationDispatchStatus;
  createdAt: string;
  startedAt: string | null;
  settledAt: string | null;
}

/**
 * The run's closing entry: the only bitácora row that does not come from a
 * dispatch. Also derived, never stored — the counts are read off the run's own
 * tasks each time, so the sentence cannot drift from what happened.
 */
export interface CoordinationRunDoneLogEntryView {
  kind: 'run_done';
  id: string;
  runId: string;
  tasksDone: number;
  tasksFailed: number;
  createdAt: string;
}

/**
 * The run's other ending. A cancelled run is as finished as a done one — it
 * never dispatches again — and it used to leave the bitácora with no closing
 * line at all: the last thing on screen was the dispatch that got cut off, as
 * if the team were still working. Derived the same way, never stored.
 *
 * Las TRES cuentas van separadas. `tasksPending` contaba antes todo lo que no
 * llegó a `done`, las `failed` adentro: eso borraba la única diferencia que
 * importa acá. Una tarea que FRACASÓ (se intentó, no salió) y una que nunca
 * empezó son dos hechos distintos, y son justo los que la persona necesita
 * para decidir si vuelve a intentarlo. Cancelar no hace fracasar a nadie —
 * pero tampoco des-fracasa a quien ya había fracasado antes del corte.
 */
export interface CoordinationRunCancelledLogEntryView {
  kind: 'run_cancelled';
  id: string;
  runId: string;
  tasksDone: number;
  tasksFailed: number;
  /** Ni `done` ni `failed`: lo que quedó sin terminar cuando se cortó. */
  tasksPending: number;
  createdAt: string;
}

export type CoordinationLogEntryView = CoordinationDispatchLogEntryView | CoordinationRunDoneLogEntryView | CoordinationRunCancelledLogEntryView;

export type CoordinationTaskStatus = 'pending' | 'ready' | 'dispatched' | 'running' | 'done' | 'failed' | 'blocked';

/** A task's own state after `settleCoordinationDispatch` (task 3.19) settles its current dispatch. */
export interface CoordinationTaskView {
  id: string;
  runId: string;
  roleId: string;
  spec: string;
  status: CoordinationTaskStatus;
  attempts: number;
  resultSummary: string | null;
}

export interface CoordinationAskView {
  id: string;
  runId: string;
  taskId: string | null;
  memberId: string;
  question: string;
  answer: string | null;
  deadlineAt: string;
  answeredAt: string | null;
  createdAt: string;
}

/**
 * Phase 6, tasks 6.28-6.33 (design-v2-conversational D2/D3): why a member's
 * runtime does not carry a working `latte_coordination`/`latte_memory`
 * entry right now. Six named reasons, never a silent gap.
 */
export type CoordinationDegradedReason =
  | 'claude_below_floor'
  | 'codex_run_cap'
  | 'codex_global_cap'
  | 'codex_process_ceiling'
  | 'opencode_shared_server'
  | 'engram_not_installed'
  /**
   * El adaptador entregó MENOS de lo que el planificador había reclamado: el
   * runtime se negó a inyectar después de la decisión (Claude sin `promptDir`
   * o con el archivo de config MCP fallando; Codex con su propio contador de
   * procesos lleno). La UI nunca puede afirmar una capacidad que el proceso
   * no tiene.
   */
  | 'runtime_refused_injection'
  /**
   * El cupo se había reservado y el servidor MCP local no pudo arrancar. La
   * reserva se soltó (si no, un servidor que nunca levantó se comía el cupo de
   * otra Marca para siempre) y el miembro quedó sin coordinación, pero con su
   * memoria: degradar la coordinación nunca se lleva puesta a engram.
   */
  | 'coordination_server_unavailable';

/**
 * One row per team member of the Work, from `coordinationRuntimeSupport`
 * (task 6.33). `memoryInjected` is a SEPARATE field from `reason`/
 * `canPropose` on purpose -- the two injection policies are independent
 * (task 6.29): a member can carry memory with no coordination (the ordinary
 * case, `canPropose:false`, `memoryInjected:true`, `reason` explaining only
 * the coordination side, or `null`), never the reverse.
 */
export interface CoordinationMemberSupport {
  memberId: string;
  canPropose: boolean;
  memoryInjected: boolean;
  reason: CoordinationDegradedReason | null;
  /**
   * Whether the RUNTIME itself has reported what it actually brought up. `false`
   * means Latte wrote the injection and nothing has contradicted it YET -- which
   * is not the same as "it works", and the UI must never render it as such
   * (crítico 7). A closed member's hypothetical preview is never confirmed.
   */
  runtimeConfirmed: boolean;
  /**
   * Whether this member's runtime is CAPABLE of reporting what it actually
   * connected — ever. Claude reports it in `system/init`, Codex answers
   * `mcpStatus`; OpenCode's server exposes no such endpoint, so for it
   * `runtimeConfirmed` can never turn true.
   *
   * Without this field the UI could only say "not confirmed yet", which reads
   * as "wait a moment" about something that is never going to arrive. Never a
   * reason to claim it works: `false` here only changes the SENTENCE, never
   * the verdict.
   */
  runtimeReportsInjection: boolean;
}

/**
 * A member hired for a run, as the bitácora shows it. `roleName` is resolved
 * by the backend: the surface never renders a raw id.
 */
/**
 * Un mensaje de un miembro a otro (`latte_message`), con los dos extremos
 * resueltos a `memberId` + `roleId`: un id pelado no le dice nada a nadie.
 *
 * `from: null` es un mensaje que escribió Latte, no un miembro. `readAt` es
 * cuándo el destinatario lo consumió con `latte_check`; `null` es "todavía no
 * lo leyó", que es información, no un hueco.
 */
export interface CoordinationMessageView {
  id: string;
  runId: string;
  from: { memberId: string; roleId: string } | null;
  to: { memberId: string; roleId: string };
  text: string;
  readAt: string | null;
  createdAt: string;
}

export interface CoordinationHireView {
  memberId: string;
  roleId: string;
  roleName: string;
  hiredAt: string;
}

/** One row per active coordination run app-wide, for the global "Equipos activos" strip (task 6.34) -- the only app-scoped read in this change. */
export interface CoordinationActiveRunSummary {
  runId: string;
  workId: string;
  workTitle: string;
  brandId: string;
  brandName: string;
  status: CoordinationRunStatus;
  dispatchesUsed: number;
  maxDispatches: number | null;
  pendingGates: number;
  /**
   * `true` cuando el `budget_json` de ESTE run no se pudo leer. Antes, una
   * sola fila así hacía tirar el mapeo entero y la tira global —que es
   * app-wide, de TODAS las marcas— se caía para todo el mundo. Ahora la fila
   * se marca y las demás marcas se listan igual; `maxDispatches`/
   * `dispatchesUsed` vienen en `null`/`0`, que NO significa "sin tope": sólo
   * significa que no se pudo leer, y por eso existe este campo.
   */
  budgetInvalid: boolean;
  /** When this run last changed — the instant "since your last visit" is measured against. */
  updatedAt: string;
  /**
   * El último hecho de este run, igual que en `CoordinationRunView`: el máximo
   * entre `updatedAt`, el gate/despacho más nuevo y el cierre. Es contra ESTO
   * que se compara `lastSeenAt`, no contra `updatedAt`.
   */
  lastEventAt: string;
  /**
   * When the person last opened this Work's coordination panel
   * (`markCoordinationSeen`), or `null` if never. Inicio's "since your last
   * visit" card used to measure NO visit at all: it rendered the CURRENT state
   * under a title that speaks about the past. With `null`, the card must say
   * what it is really reporting from, never invent a visit.
   */
  lastSeenAt: string | null;
}

/**
 * `{brandId, workId, runId}` only -- never the payload itself (the renderer
 * re-reads via the existing IPC methods; this channel is a "something
 * changed, go look" nudge, not a data transport). `runId` is `null` for a
 * change that has no run yet (e.g. a fresh `latte_request_coordination`
 * proposal before its gate exists is still reported through the run it just
 * created, so in practice this is rarely null -- kept nullable for honesty
 * with `CoordinationGrant.runId`'s own shape). Lets the renderer route an
 * event from a Brand the person is not currently looking at (task 6.37).
 */
export interface CoordinationEvent {
  brandId: string;
  workId: string;
  runId: string | null;
}

/**
 * `acceptHandoffAsTask` bridges a handoff into a `coordination_task` only
 * when the Work has an active run; `bridged:false` means "do nothing new" —
 * the existing handoff flow (open a member, draft the request, dismiss the
 * file) is unaffected, exactly as the spec requires outside an active run.
 */
/**
 * Q1: los TRES finales que puede tener un puente de handoff, porque el motor
 * tiene tres y no dos. `startDispatch` devuelve `pending_approval` cuando la
 * autoridad gatea —el modo por defecto, `manual`, y también `plan`, porque la
 * tarea del puente nace fuera del plan—, así que un booleano `dispatched`
 * obligaba a la interfaz a elegir entre dos frases para tres hechos, y elegía
 * la que mentía: "despachada al equipo" sobre una tarea esperando aprobación.
 */
export type HandoffBridgeOutcome = 'dispatched' | 'pending_approval' | 'not_dispatched';

export interface HandoffTaskBridgeResult {
  bridged: boolean;
  task: { id: string; roleId: string; spec: string; status: string } | null;
  /**
   * R3/Q1: qué pasó de verdad con el despacho que sigue al puente. `null`
   * cuando no hubo puente y no hay nada que despachar.
   *
   * Aceptar un pedido no puede explotarle en la cara a la persona: cuando el
   * despacho se deniega —presupuesto agotado, concurrencia al tope— el puente
   * ya creó la tarea y eso no se deshace, así que el fallo se DEVUELVE acá en
   * vez de subir como excepción. La interfaz necesita saberlo para no anunciar
   * un despacho que no pasó.
   */
  outcome: HandoffBridgeOutcome | null;
  /** El código del motor cuando `outcome` es `not_dispatched` (`BUDGET_EXCEEDED`, `MAX_CONCURRENT`, …). Nunca un texto inventado. */
  reason: string | null;
}

export interface LatteAPI {
  getUiLocale(): Promise<UiLocale>;
  setUiLocale(locale: UiLocale): Promise<UiLocale>;
  getContentLocale(): Promise<ContentLocale>;
  setContentLocale(locale: ContentLocale): Promise<ContentLocale>;
  /** Whether the first-run onboarding has been completed. Authoritative: the gate shows iff this is false/unset. */
  getOnboardingComplete(): Promise<boolean>;
  setOnboardingComplete(complete: boolean): Promise<boolean>;
  /** Mid-flow draft so a walk abandoned part-way resumes at the same step. Null when unset or already completed. */
  getOnboardingDraft(): Promise<OnboardingDraft | null>;
  setOnboardingDraft(draft: OnboardingDraft): Promise<void>;
  clearOnboardingDraft(): Promise<void>;
  appInfo(): Promise<AppInfo>;
  listBrands(): Promise<Brand[]>;
  getBrand(brandId: string): Promise<Brand>;
  createBrand(name: string): Promise<Brand>;
  updateBrand(id: string, context: string): Promise<Brand>;
  archiveBrand(id: string): Promise<Brand>;
  restoreBrand(id: string): Promise<Brand>;
  listArchivedBrands(): Promise<Brand[]>;
  readAgencyProfile(): Promise<AgencyProfileView | null>;
  saveAgencyProfile(expectedRevision: number, patch: AgencyProfilePatch): Promise<AgencyProfileView>;
  importBrandKit(workId: string): Promise<BrandKitDraftView | null>;
  publishBrandKit(workId: string, expectedVersion: number): Promise<BrandKitView>;
  revokeBrandKit(workId: string, version: number, reason: string): Promise<void>;
  importAgencyKit(): Promise<BrandKitDraftView | null>;
  publishAgencyKit(expectedVersion: number): Promise<BrandKitView>;
  setWorkBrandChoice(workId: string, choice: WorkBrandChoiceInput, expectedRevision: number): Promise<WorkBrandPolicyView>;
  readWorkBrandContext(workId: string): Promise<WorkBrandContextView>;
  /** Installation feature switches. Default off; no secrets. */
  featureFlags(): Promise<FeatureFlags>;
  listWorks(brandId: string): Promise<Work[]>;
  createWork(brandId: string, title: string): Promise<Work>;
  /**
   * Sets what the work should deliver and, optionally, links an existing file
   * of Deliverables as its result. A link is refused unless the file is there.
   */
  updateWork(workId: string, patch: WorkPatch): Promise<Work>;
  /**
   * Pins an immutable generation receipt for this work. `brandId` is derived
   * from the work in the repository; a brand id in the payload is ignored.
   * No-op of product behaviour when the installation flag is off: the call is refused.
   */
  prepareGeneration(workId: string): Promise<PrepareGenerationOutcome>;
  /** Saves the work's brief document. `baseFingerprint` is the one handed out by the last read; omitting it falls back to the database copy. */
  saveBrief(workId: string, brief: string, baseFingerprint?: string | null): Promise<SaveOutcome>;
  listRevisions(workId: string): Promise<Revision[]>;
  snapshot(workId: string): Promise<Revision>;
  // Documents
  listDocuments(workId: string): Promise<WorkDocument[]>;
  /** Documents of every work of this brand. Each item keeps its originating workId. */
  listBrandDocuments(brandId: string): Promise<WorkDocument[]>;
  readDocument(documentId: string): Promise<DocumentContent>;
  /** Cheap: only the fingerprint, for noticing external edits. */
  documentState(documentId: string): Promise<DocumentState>;
  createDocument(workId: string, kind: DocumentKind, title: string, baseDocumentId?: string | null): Promise<DocumentContent>;
  saveDocument(documentId: string, content: string, baseFingerprint: string | null): Promise<SaveOutcome>;
  updateDocument(documentId: string, patch: DocumentPatch): Promise<WorkDocument>;
  snapshotDocument(documentId: string): Promise<Revision>;
  /** Keeps an editor draft as an immutable version without writing the file: used to resolve a conflict without losing the human's text. */
  keepDraftAsVersion(documentId: string, content: string): Promise<Revision>;
  listDocumentRevisions(documentId: string): Promise<Revision[]>;
  exportDocument(documentId: string): Promise<string | null>;
  /**
   * Markdown files sitting in the work folder that Latte is not tracking yet,
   * typically written by an agent. An agent cannot register a document itself,
   * so Latte offers to adopt them.
   */
  listUntrackedFiles(workId: string): Promise<UntrackedFile[]>;
  /** The rest of the work folder: subfolders and files Latte does not track. */
  listFolderEntries(workId: string): Promise<FolderEntries>;
  listDeliverables(workId: string): Promise<DeliverableListing>;
  openDeliverable(workId: string, fileName: string): Promise<void>;
  revealDeliverable(workId: string, fileName: string): Promise<void>;
  copyDeliverable(workId: string, fileName: string): Promise<string | null>;
  /** Opens this work's folder in the system file manager. */
  revealWorkFolder(workId: string): Promise<string>;
  /** Copies chosen files into this work's folder. Returns what landed there. */
  importFiles(workId: string): Promise<string[]>;
  /** Roles one agent asked for on this work, still waiting on you. */
  listHandoffs(workId: string): Promise<HandoffRequest[]>;
  dismissHandoff(workId: string, fileName: string): Promise<void>;
  /** Skills shipped with Latte and whether each one is on. */
  listSkills(): Promise<AgentSkill[]>;
  setSkillEnabled(skillId: string, enabled: boolean): Promise<AgentSkill[]>;
  /** Learned-skill inbox. Empty while the installation flag is off. */
  listSkillCandidates(): Promise<SkillCandidate[]>;
  approveSkillCandidate(input: SkillReviewInput): Promise<SkillCandidate>;
  rejectSkillCandidate(input: SkillReviewInput): Promise<SkillCandidate>;
  promoteSkillCandidate(input: SkillPromoteInput): Promise<SkillCandidate>;
  /** Takes the agent's funnel proposal as the document's stages. */
  applyFunnelProposal(documentId: string): Promise<WorkDocument>;
  /** Drops the proposal and leaves the stages as they were. */
  dismissFunnelProposal(documentId: string): Promise<WorkDocument>;
  /** Toggles a funnel stage into/out of this work's out-of-scope set. Returns the updated work. */
  toggleOutOfScopeStage(workId: string, stage: FunnelStage): Promise<Work>;
  /** How much this work's team may do without asking. */
  getWorkPermissions(workId: string): Promise<WorkPermissionMode>;
  setWorkPermissions(workId: string, mode: WorkPermissionMode): Promise<WorkPermissionMode>;
  /** Adopts an existing file as a tracked document: versions, export, conflict check. */
  trackFile(workId: string, fileName: string): Promise<WorkDocument>;
  /**
   * Saves text from a conversation as a document of this work. The answer stops
   * being trapped in the chat and gains versions, export and conflict checks.
   */
  saveAsDocument(workId: string, kind: DocumentKind, title: string, content: string): Promise<WorkDocument>;
  /** Re-points a derived document at the current version of its base, after the human reviewed the change. */
  acknowledgeBase(documentId: string): Promise<WorkDocument>;
  /**
   * Points a work at a folder you already work in. Nothing is copied: that
   * folder becomes the work. Latte adds its managed context files and a
   * versions folder inside it, and agents get it as their directory.
   * Returns null when the user cancels the picker.
   */
  useFolder(workId: string): Promise<FolderLinkResult | null>;
  listDecisions(workId: string): Promise<Decision[]>;
  /** Decisions of every work of this brand. Each item keeps its originating workId. */
  listBrandDecisions(brandId: string): Promise<Decision[]>;
  addDecision(workId: string, text: string): Promise<Decision>;
  getDecisionAuthority(workId: string): Promise<DecisionAuthorityMode>;
  setDecisionAuthority(workId: string, mode: DecisionAuthorityMode): Promise<DecisionAuthorityMode>;
  approveDecision(decisionId: string, editedStatement?: string | null): Promise<Decision>;
  rejectDecision(decisionId: string): Promise<Decision>;
  archiveDecision(decisionId: string): Promise<Decision>;
  listBrandContextProposals(brandId: string): Promise<BrandContextProposal[]>;
  /** The fingerprint, proposals, works and history the Contexto view needs in one read. */
  brandContextStatus(brandId: string): Promise<BrandContextStatus>;
  /**
   * Writes `brand.context` by hand and propagates it to the brand's idle works.
   * `expectedFingerprint` is the value the editor loaded: when it no longer
   * matches, the write is refused (`CONTEXT_STALE`) and the draft survives.
   * `null` means the caller has nothing to compare against. An empty value is
   * refused (`CONTEXT_EMPTY`): emptying is the explicit `clearBrandContext`.
   */
  saveBrandContext(brandId: string, context: string, expectedFingerprint: string | null): Promise<BrandContextSaveResult>;
  /** The explicit clear: records a revision and refuses a stale fingerprint. */
  clearBrandContext(brandId: string, expectedFingerprint: string | null): Promise<BrandContextSaveResult>;
  /** The history of `brands.context`, newest first. */
  listBrandContextRevisions(brandId: string): Promise<BrandContextRevision[]>;
  /** Applies a past revision and records that restore as a new revision. */
  restoreBrandContextRevision(brandId: string, revisionId: string, expectedFingerprint: string | null): Promise<BrandContextSaveResult>;
  approveBrandContextProposal(id: string, edited: string | null, acceptStale?: boolean): Promise<BrandContextDecisionResult>;
  rejectBrandContextProposal(id: string): Promise<BrandContextDecisionResult>;
  requestBrandContextDraft(workId: string): Promise<ChatSession>;
  runtimeStatus(): Promise<RuntimeStatus[]>;
  startAgent(workId: string, provider: Provider): Promise<AgentSession>;
  writeAgent(sessionId: string, data: string): Promise<void>;
  resizeAgent(sessionId: string, cols: number, rows: number): Promise<void>;
  stopAgent(sessionId: string): Promise<void>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  readMemory(brandId: string): Promise<MemoryResult>;
  saveMemory(brandId: string, text: string): Promise<MemoryResult>;
  exportWork(workId: string): Promise<string | null>;
  // Structured chat
  chatStatus(): Promise<ChatRuntimeStatus>;
  /** Adds a neutral "assistant" member with the primary agent and opens it. Overrides exist for tests and advanced use; the UI never asks. */
  startChat(workId: string, model?: string | null, runtime?: ChatRuntime | null, accountId?: string | null): Promise<ChatSession>;
  // Team (roles per work)
  listRoles(): Promise<AgentRole[]>;
  listProfiles(): Promise<AgentProfile[]>;
  saveProfile(input: ProfileInput, expectedFingerprint: string | null): Promise<AgentProfile>;
  listTeam(workId: string): Promise<TeamMember[]>;
  /** Creates a member for the role (primary agent unless overridden) and opens its conversation. */
  addTeamMember(workId: string, roleId: string, options?: TeamMemberOptions | null): Promise<ChatSession>;
  /** Opens (or resumes) an existing member's conversation. Idempotent while it is already open. */
  openTeamMember(memberId: string): Promise<ChatSession>;
  /** Closes the conversation; the member stays listed and can be resumed. */
  pauseTeamMember(memberId: string): Promise<void>;
  /** Closes the conversation and marks the member as finished. */
  finishTeamMember(memberId: string): Promise<void>;
  /** Drops this member's conversation and starts a new one with the same role. */
  restartTeamMember(memberId: string): Promise<TeamMember>;
  /**
   * The hand-over for continuing this member's work with another agent or
   * account. Read-only: the member, its conversation and its account are only
   * read. The new member is created with addTeamMember (`continuedFrom`).
   */
  draftContinuation(memberId: string): Promise<ContinuationDraft>;
  removeTeamMember(memberId: string): Promise<void>;
  listChatMessages(chatId: string): Promise<ChatMessage[]>;
  sendChat(chatId: string, text: string): Promise<void>;
  abortChat(chatId: string): Promise<void>;
  stopChat(chatId: string): Promise<void>;
  replyPermission(chatId: string, requestId: string, reply: PermissionReply): Promise<void>;
  replyQuestion(chatId: string, requestId: string, answers: string[][] | null): Promise<void>;
  onChatEvent(callback: (event: ChatEvent) => void): () => void;
  /**
   * Tells the main process whether closing now would lose work. Electron does
   * not show a dialog for a cancelled `beforeunload`, so the window would just
   * refuse to close; the confirmation is a native dialog instead.
   */
  reportUnsaved(hasUnsavedWork: boolean): void;
  /** Title bar controls. The window is frameless, so the app draws its own. */
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  /** Fires when the window is maximised or restored, so the icon matches reality. */
  onWindowState(callback: (state: { maximized: boolean }) => void): () => void;
  // Providers
  listProviders(): Promise<ProviderInfo[]>;
  /** Stores an API key in the runtime's own credential store (Latte never persists it). */
  connectProviderKey(providerId: string, key: string): Promise<void>;
  disconnectProvider(providerId: string): Promise<void>;
  /** Starts an OAuth login; the URL is also opened in the system browser. */
  startProviderOAuth(providerId: string, methodIndex: number, inputs: Record<string, string>): Promise<ProviderOAuthStart>;
  /** Completes an OAuth login (code is required only when the start returned method "code"). */
  completeProviderOAuth(providerId: string, methodIndex: number, code: string | null): Promise<void>;
  // Primary agent + subscription runtimes (Claude Code, Codex)
  getPrimaryAgent(): Promise<PrimaryAgent | null>;
  setPrimaryAgent(choice: { runtime: ChatRuntime; model: string | null; accountId: string | null }): Promise<PrimaryAgent>;
  listAgentRuntimes(): Promise<AgentRuntimeInfo[]>;
  /** MCP servers each runtime has configured, with the real connection state it reports. */
  /** Omit the runtime for all three; pass one to get just that one, which lands sooner. */
  listMcpServers(runtime?: ChatRuntime | null): Promise<McpRuntimeTools[]>;
  addMcpServer(runtime: 'claude' | 'codex', input: McpServerInput): Promise<void>;
  removeMcpServer(runtime: 'claude' | 'codex', name: string): Promise<void>;
  /** Codex MCP OAuth through `mcpServer/oauth/login`. The URL is opened in the system browser. */
  loginMcpServer(runtime: 'codex', name: string): Promise<AccountLoginStart>;
  /**
   * Interactive `claude` in this work's folder with the account's CLAUDE_CONFIG_DIR,
   * so `/mcp` login tokens land where Latte's headless runs look.
   */
  authenticateClaudeMcp(workId: string, accountId: string | null): Promise<AccountLoginStart>;
  addAgentAccount(runtime: 'claude' | 'codex', label: string): Promise<AgentAccount>;
  removeAgentAccount(runtime: 'claude' | 'codex', accountId: string): Promise<void>;
  /** Starts the runtime's own login (browser OAuth). Claude runs inside an embedded terminal session; Codex returns a URL. */
  startAccountLogin(runtime: 'claude' | 'codex', accountId: string): Promise<AccountLoginStart>;
  logoutAccount(runtime: 'claude' | 'codex', accountId: string): Promise<void>;
  /**
   * The models this account can use. Asks the runtime when it has a catalog
   * (Codex answers `model/list` over its app-server); falls back to what Latte
   * can state as fact when it does not. Costs a process, so it is asked when
   * the Settings screen needs it, never on start.
   */
  listAccountModels(runtime: 'claude' | 'codex', accountId: string): Promise<AgentModelList>;
  /**
   * Changes the model of one conversation. The runtime restarts underneath —
   * neither Claude Code nor Codex can swap a model in place — and the same
   * conversation is resumed. `resumed` reports whether that worked, so the UI
   * never claims a history it does not have. `null` means the runtime's default.
   */
  setTeamMemberModel(memberId: string, model: string | null): Promise<MemberModelChange>;
  /**
   * Changes how hard one conversation works per answer. Same mechanics as
   * changing the model: the runtime restarts underneath and the conversation
   * is resumed when the runtime allows it.
   */
  setTeamMemberTier(memberId: string, tier: EffortTier): Promise<MemberModelChange>;
  // Updates
  /** Asks the update server whether there is a newer version. Never installs anything. */
  checkForUpdate(): Promise<UpdateState>;
  /** Downloads the offered version in the background. Work continues meanwhile. */
  downloadUpdate(): Promise<UpdateState>;
  /**
   * Restarts and installs. Refused while a document has unsaved changes, and
   * confirmed with a native dialog because it stops agents and terminals.
   */
  installUpdate(): Promise<InstallOutcome>;
  /** Fires on every phase change, including the progress of a download. */
  onUpdateState(callback: (state: UpdateState) => void): () => void;
  // Coordination (autonomous multi-agent runs) — per-Work settings only; the
  // run/task/dispatch surface arrives in a later phase.
  getCoordinationAuthority(workId: string): Promise<CoordinationAuthorityMode>;
  setCoordinationAuthority(workId: string, mode: CoordinationAuthorityMode): Promise<CoordinationAuthorityMode>;
  /**
   * `unset` means no budget was ever configured (`BUDGET_UNSET`) — never an
   * implicit unlimited default; `invalid` means the stored bytes cannot be
   * read, which is NOT "unset" (the dispatch path denies against those same
   * bytes). Writing a valid budget over an `invalid` one repairs it.
   */
  getCoordinationBudget(workId: string): Promise<CoordinationBudgetView>;
  setCoordinationBudget(workId: string, budget: CoordinationBudget): Promise<CoordinationBudget>;
  getCoordinatorGrant(workId: string): Promise<CoordinatorGrant>;
  /** `memberId: null` revokes the grant outright; granting to a new member implicitly revokes whoever held it before. */
  setCoordinatorGrant(workId: string, memberId: string | null): Promise<CoordinatorGrant>;
  // Coordination (Phase 3): run lifecycle, gates, bitácora, asks and the
  // handoff bridge — reachable only through IPC in this phase, no MCP yet.
  /** Starts a run for this Work. Throws `BUDGET_UNSET` unless a budget was already configured — no implicit unlimited run. */
  startCoordinationRun(workId: string): Promise<CoordinationRunView>;
  /** "Pausar equipo": in-flight dispatches finish and report; nothing new starts. */
  pauseCoordinationRun(runId: string): Promise<CoordinationRunView>;
  /** Unconditional: whether budget actually allows a next dispatch is re-checked at dispatch time, not here. */
  resumeCoordinationRun(runId: string): Promise<CoordinationRunView>;
  cancelCoordinationRun(runId: string): Promise<CoordinationRunView>;
  /** The Work's active run, or `null` when none is running. */
  getCoordinationRun(workId: string): Promise<CoordinationRunView | null>;
  listCoordinationGates(runId: string): Promise<CoordinationGateView[]>;
  /** `editedPrompt` only applies to a `dispatch` gate (edit-then-approve); ignored otherwise. */
  resolveCoordinationGate(gateId: string, decision: 'approve' | 'reject', editedPrompt?: string | null): Promise<CoordinationRunView>;
  /** The bitácora: one entry per `coordination_dispatch` lifecycle event, oldest first. */
  listCoordinationLog(runId: string): Promise<CoordinationLogEntryView[]>;
  /**
   * Las `latte_ask` todavía sin responder de un run. `listCoordinationGates`
   * excluye a propósito el motivo `all_blocked_on_ask` (una pregunta no es un
   * gate de aprobar/rechazar), así que sin esta lista un run suspendido por
   * una pregunta no tenía ninguna salida en la UI salvo cancelar.
   */
  listOpenCoordinationAsks(runId: string): Promise<CoordinationAskView[]>;
  answerCoordinationAsk(askId: string, answer: string): Promise<CoordinationAskView>;
  /** WHEN the Work has an active run, mints a `coordination_task` for the accepted handoff instead of only opening a chat draft. */
  acceptHandoffAsTask(workId: string, fileName: string): Promise<HandoffTaskBridgeResult>;
  /**
   * Manual dispatch settlement via IPC, zero MCP (task 3.19): a human reads
   * the worker's own chat and records the outcome directly, coherent with
   * `manual` authority mode where the human already IS the coordinator.
   * Enters through the exact same choke point `latte_report` uses, so
   * idempotency, wrong-reporter rejection, ledger settlement and the
   * dispatch's settling timestamp all behave identically to an agent's own
   * report.
   */
  settleCoordinationDispatch(taskId: string, outcome: 'succeeded' | 'failed', summary: string, files?: string | null): Promise<CoordinationTaskView>;
  /**
   * Per-member coordination/memory status for this Work (task 6.33): six
   * named degraded reasons, `canPropose` and `memoryInjected` reported
   * SEPARATELY. NOT gated by any coordination flag -- memory status matters
   * even with coordination off, so the coordination-specific reasons simply
   * come back empty/`null` rather than this method refusing to answer.
   */
  coordinationRuntimeSupport(workId: string): Promise<CoordinationMemberSupport[]>;
  /** The global "Equipos activos" strip: every active run across every Brand, newest-updated first. The only app-scoped read in this change. */
  listActiveCoordinationRuns(): Promise<CoordinationActiveRunSummary[]>;
  /** The OPTIONAL advanced app-wide dispatch cap, on top of (never instead of) each Work's own budget. `unset` = no extra cap applied -- never an invented limit; `invalid` = the stored value cannot be read, which is NOT "no cap" (the dispatch path denies against those same bytes). It counts the dispatches of the runs that are CURRENTLY active, not the install's whole history. */
  getCoordinationGlobalBudget(): Promise<CoordinationGlobalBudgetView>;
  /** `null` clears the cap (back to unset, no extra cap) -- a cap you cannot take off is a trap, not a setting. Any other value goes through the same validator every coordination budget does. */
  setCoordinationGlobalBudget(budget: CoordinationBudget | null): Promise<CoordinationBudget | null>;
  /**
   * Records that the person is looking at this Work's coordination panel right
   * now, and answers with the ISO instant stored. That instant is what
   * "since your last visit" is measured against — before this existed, that
   * card measured no visit at all. Calling it again overwrites the previous
   * visit: the last visit is the last one.
   */
  markCoordinationSeen(workId: string): Promise<string>;
  /**
   * The run's hires, oldest first: who joined the team, with which role, when.
   * The bitácora rendered hire rows from a prop nothing ever filled; this is
   * its source. An unreadable record reads as an empty list — a bitácora never
   * falls over because one stored value went bad.
   */
  listCoordinationHires(runId: string): Promise<CoordinationHireView[]>;
  /**
   * Lo que los miembros se escribieron entre sí (`latte_message`) en el run
   * activo del Trabajo, o en el último terminado si no hay ninguno vivo — el
   * mismo criterio que `getCoordinationRun`, para que la lectura no se vacíe
   * en cuanto el equipo termina. Oldest first. Sin ningún run, lista vacía:
   * "todavía no pasó nada" no es un error.
   */
  listCoordinationMessages(workId: string): Promise<CoordinationMessageView[]>;
  /** Fires on a run/task/dispatch/gate change, so the renderer can route an event from a Brand the person is not currently looking at (task 6.37). */
  onCoordinationEvent(callback: (event: CoordinationEvent) => void): () => void;
}
declare global { interface Window { latte?: LatteAPI } }
