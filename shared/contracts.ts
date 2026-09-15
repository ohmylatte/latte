export type Provider = 'claude' | 'codex' | 'opencode';
export type UiLocale = 'es-AR' | 'en-US';
export type ContentLocale = UiLocale;
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
  status: 'connected' | 'failed' | 'pending' | 'disabled' | 'configured';
  detail: string;
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
  chatId: string | null;
  messageId: string | null;
  text: string;
  rationale: string;
  mode: BrandContextMode;
  status: BrandContextProposalStatus;
  fingerprint: string;
  clientRequestId: string | null;
  createdAt: string;
  decidedAt: string | null;
}
export interface BrandContextProposalInput { text: string; rationale: string; mode: BrandContextMode; clientRequestId: string }
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

export interface UpdateState {
  phase: UpdatePhase;
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
export interface ChatPermission { id: string; permission: string; patterns: string[]; always: string[]; title: string }
export interface ChatQuestionOption { label: string; description: string }
export interface ChatQuestionItem { header: string; question: string; options: ChatQuestionOption[]; multiple: boolean; custom: boolean }
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

export interface LatteAPI {
  getUiLocale(): Promise<UiLocale>;
  setUiLocale(locale: UiLocale): Promise<UiLocale>;
  getContentLocale(): Promise<ContentLocale>;
  setContentLocale(locale: ContentLocale): Promise<ContentLocale>;
  appInfo(): Promise<AppInfo>;
  listBrands(): Promise<Brand[]>;
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
  addDecision(workId: string, text: string): Promise<Decision>;
  getDecisionAuthority(workId: string): Promise<DecisionAuthorityMode>;
  setDecisionAuthority(workId: string, mode: DecisionAuthorityMode): Promise<DecisionAuthorityMode>;
  approveDecision(decisionId: string, editedStatement?: string | null): Promise<Decision>;
  rejectDecision(decisionId: string): Promise<Decision>;
  archiveDecision(decisionId: string): Promise<Decision>;
  listBrandContextProposals(brandId: string): Promise<BrandContextProposal[]>;
  approveBrandContextProposal(id: string, edited: string | null): Promise<BrandContextProposal>;
  rejectBrandContextProposal(id: string): Promise<BrandContextProposal>;
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
}
declare global { interface Window { latte?: LatteAPI } }
