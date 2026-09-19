import type {
  AccountLoginStart,
  AgentAccount,
  AppInfo,
  AgentRole,
  AgentSkill,
  HandoffRequest,
  AgentProfile,
  ProfileInput,
  DocumentPatch,
  FolderEntries,
  FunnelStage,
  AgentModelList,
  WorkPermissionMode,
  MemberModelChange,
  AgentRuntimeInfo,
  AgentSession,
  Brand,
  ChatMessage,
  ChatRuntime,
  ChatRuntimeStatus,
  ChatSession,
  ContinuationDraft,
  BrandContextDecisionResult,
  BrandContextMode,
  BrandContextProposal,
  BrandContextProposalInput,
  BrandContextRefreshReport,
  BrandContextRevision,
  BrandContextRevisionSource,
  BrandContextSaveResult,
  BrandContextStatus,
  CoordinationActiveRunSummary,
  CoordinationAskView,
  CoordinationAuthorityMode,
  CoordinationBudget,
  CoordinationBudgetView,
  CoordinationGlobalBudgetView,
  CoordinationEvent,
  CoordinationGateView,
  CoordinationHireView,
  CoordinationLogEntryView,
  CoordinationMemberSupport,
  CoordinationRunView,
  CoordinationTaskView,
  CoordinatorGrant,
  HandoffTaskBridgeResult,
  Decision,
  DecisionAuthorityMode,
  DecisionProposalInput,
  DecisionSource,
  DocumentContent,
  FolderLinkResult,
  DocumentKind,
  DocumentState,
  DocumentStatus,
  EffortTier,
  LatteAPI,
  McpRuntimeTools,
  McpServerInput,
  MemoryResult,
  PermissionReply,
  PrimaryAgent,
  Provider,
  ProviderInfo,
  ProviderOAuthStart,
  Revision,
  RevisionSource,
  RuntimeStatus,
  SaveOutcome,
  SkillCandidate,
  SkillPromoteInput,
  SkillReviewInput,
  TeamMember,
  TeamMemberOptions,
  UntrackedFile,
  Work,
  WorkDocument,
  WorkPatch,
  PrepareGenerationOutcome,
  WorkBrandChoiceInput,
  OnboardingDraft,
} from '../../shared/contracts';
import { isOnboardingDraft } from '../../shared/contracts';
import {
  type BrandContextPort,
  type SkillRef,
  type SkillResolverPort,
} from '../../shared/generationContracts';
import { featureEnabled, readFeatureFlags, requireFeature, type FeatureFlags } from '../core/features';
import { GenerationContractError } from '../generation/errors';
import { prepareGeneration as runPrepareGeneration } from '../generation/prepare';
import { pinGeneration } from '../generation/pin';
import { brandContextAdapter } from '../generation/adapters/brandContext';
import { skillResolverAdapter } from '../generation/adapters/skillResolver';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../core/atomicFile';
import { LatteError, NotFoundError, UnavailableError, ValidationError } from '../core/errors';
import { isValidId, newId, nowIso, slugify } from '../core/ids';
import { WORK_FILES } from '../core/paths';
import { EngramClient, memoryProjectFor } from '../memory/engram';
import { AccountStore } from '../agents/accounts';
import { isAccountRuntime, isChatRuntime, type AgentHub, type MemberContext } from '../agents/hub';
import { CoordinationEngine } from '../coordination/engine';
import { readStoredCoordinationBudget, requireCoordinationBudget } from '../coordination/budget';
import type { CoordinationInjectionPlanner } from '../coordination/injection';
import type { McpCatalog } from '../agents/mcp';
import { RoleCatalog } from '../agents/roles';
import { isEffortTier } from '../agents/tiers';
import type { ChatManager } from '../opencode/chatManager';
import { RuntimeDetector } from '../runtime/detect';
import { assertProvider } from '../runtime/providers';
import { TerminalManager } from '../runtime/terminalManager';
import { LearningService } from '../learning/service';
import type { SkillCandidateRecord } from '../learning/types';
import type { CandidateGenerator } from '../learning/worker';
import type { LearningRepository } from '../storage/learningRepository';
import { briefDocumentId, type CoordinationRunRecord, type DocumentRecord, type LatteRepository } from '../storage/repository';
import { collectBrandMemory, hasInheritedContent, type BrandMemorySnapshot } from '../workspace/brandMemory';
import { brandContextNudge, electBrandContextOwner } from '../workspace/brandContextNudge';
import { INSTRUCTIONS_MAX_CHARS, isManagedFile, renderInstructionBundle, renderOutcomeContext, showsCurrentOutcome, type InstructionPack, type PackSkill } from '../workspace/instructions';
import { checkFolder, contains, importFileName, kindFromFileName, readFunnelProposal, readHandoff, scanFolder, titleFromFileName } from '../workspace/linkFolder';
import { renderDocumentTemplate } from '../workspace/templates';
import { openItems, renderContinuation } from '../workspace/continuation';
import { DELIVERABLES_DIR, DeliverableFiles, deliverableName } from '../workspace/deliverables';
import { documentFileName, fingerprintOf, type DocumentOnDisk, type WorkspaceFiles } from '../workspace/workspace';
import { BRAND_CONTEXT_DRAFT_PROMPT_EN, BRAND_CONTEXT_DRAFT_PROMPT_ES, brandContextFingerprint, requireBrandContextInput } from '../workspace/brandContextProtocol';
import { composeBrandContext } from '../../shared/brandContext';
import { LIMITS, requireCleanContext, requireEditedPrompt, requireGateId, requireId, requireInt, requireLabel, requireRequestId, requireText } from './validation';
import { BrandingService } from '../branding/service';

/** Stable content identity; request identity handles retries, this flags similar proposals without merging them. */
export function decisionFingerprint(statement:string):string {
  return createHash('sha256').update(statement.normalize('NFC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('und'),'utf8').digest('hex').slice(0,24);
}

/** A propagation report with nothing in it, for a decision that changed no work. */
function emptyRefreshReport(): BrandContextRefreshReport {
  return { updated: [], unchanged: [], live: [], userOwned: [] };
}

/** Everything the renderer can call, minus the event subscriptions (wired in the preload). */
/**
 * What the backend answers. Everything that belongs to the application rather
 * than to the workspace — window controls, and the update flow, which needs to
 * quit and restart the app — is served by the main process directly.
 */
export type BackendApi = Omit<
  LatteAPI,
  | 'onAgentEvent'
  | 'onChatEvent'
  | 'onCoordinationEvent'
  | 'reportUnsaved'
  | 'windowControl'
  | 'onWindowState'
  | 'checkForUpdate'
  | 'downloadUpdate'
  | 'installUpdate'
  | 'onUpdateState'
>;

export interface LatteServiceDeps {
  repo: LatteRepository;
  learning: LearningRepository;
  learningGenerator?: CandidateGenerator;
  learningNow?: () => Date;
  files: WorkspaceFiles;
  detector: RuntimeDetector;
  terminal: TerminalManager;
  /** OpenCode runtime (providers, status). */
  chat: ChatManager;
  /** Routes chats across OpenCode / Claude Code / Codex and owns the primary agent. */
  hub: AgentHub;
  engram: EngramClient;
  /** sdd/autonomous-coordination, task 6.33: the SAME planner hub wiring uses, so `coordinationRuntimeSupport` reports what actually happened for a live member (`preview()`'s own claim-lookup) rather than a second, possibly-divergent guess. Absent (tests that never wire coordination) reports every member as unsupported. */
  injection?: CoordinationInjectionPlanner;
  /** Task 6.37: forwarded straight into this service's own `CoordinationEngine`, so an IPC-driven change (this engine) fires the same event a real MCP `tools/call` (the SEPARATE engine instance bootstrap.ts builds for the coordination MCP server) does. */
  emitCoordination?: (event: CoordinationEvent) => void;
  /** MCP servers, read and written through each runtime's own CLI. */
  mcp?: McpCatalog;
  /** Opens a native save dialog; returns the chosen path or null on cancel. */
  chooseExportPath: (suggestedFileName: string) => Promise<string | null>;
  /** Opens a native folder picker; returns the chosen folder or null on cancel. */
  chooseFolder?: (title: string) => Promise<string | null>;
  /** Opens a native multi-select file picker; returns the chosen absolute paths. */
  chooseFiles?: (title: string) => Promise<string[]>;
  /** Shows a folder in the system file manager. */
  revealPath?: (target: string) => Promise<void>;
  revealFile?: (target: string) => Promise<void>;
  confirmHtml?: (fileName: string) => Promise<boolean>;
  /** Discipline pack prepended to every generated instruction file. */
  pack?: InstructionPack | null;
  /** Opens an http(s) URL in the system browser (OAuth logins). */
  openExternal?: (url: string) => Promise<void>;
  /** Why the storage engine was chosen (shown read-only in Settings). */
  engineReason?: string;
  /** The running app's version, sourced from `app.getVersion()`; tests pass a fixed string. */
  version: string;
  clock?: () => string;
  /** Brand-kit worktree owns the real adapter; default is a no-op (neutral, no kit). */
  brandContext?: BrandContextPort;
  /** Learned-skills worktree owns the real adapter; default returns no learned refs. */
  skillResolver?: SkillResolverPort;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FINGERPRINT = /^[a-f0-9]{16}$/;
/** Per-work grant, kept in `meta` so no schema change is needed to add it. */
/** One messy client folder must not flood the renderer with thousands of names. */
const FOLDER_ENTRY_LIMIT = 200;
/** One drag must not import a disk: bounded in count and in size per file. */
const IMPORT_LIMIT = 50;
const IMPORT_MAX_BYTES = 64 * 1024 * 1024;

function fsStatSafe(target: string): import('node:fs').Stats | null {
  try { return nodeFs.statSync(target); } catch { return null; }
}
function fsExistsSafe(target: string): boolean {
  try { return nodeFs.existsSync(target); } catch { return true; }
}
function fsCopySafe(source: string, target: string): void {
  nodeFs.copyFileSync(source, target, nodeFs.constants.COPYFILE_EXCL);
}

const FOLDER_TRUST_KEY = 'trust-folder:';
/** Off is the exception, so only a disabled skill is written down. */
const SKILL_OFF_KEY = 'skill-off:';
const DOCUMENT_KINDS: DocumentKind[] = ['brief', 'strategy', 'calendar', 'research', 'copy', 'note'];
const DOCUMENT_STATUSES: DocumentStatus[] = ['draft', 'review', 'approved'];

/** A kind guessed from a file name is only accepted when Latte knows it. */
function kindOf(value: string): DocumentKind {
  return (DOCUMENT_KINDS as string[]).includes(value) ? (value as DocumentKind) : 'note';
}

function requireProviderId(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) throw new TypeError('Invalid provider id');
  return value;
}

/** Advanced overrides for a new member; every field is optional and strictly typed. */
function validateMemberOptions(options: unknown): { runtime: ChatRuntime | null; model: string | null; accountId: string | null; continuedFrom: string | null; tier: EffortTier | null } {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new TypeError('Invalid options');
  const { runtime, model, accountId, continuedFrom, tier } = options as Record<string, unknown>;
  const cleanRuntime = runtime === undefined || runtime === null ? null : runtime;
  if (cleanRuntime !== null && !isChatRuntime(cleanRuntime)) throw new TypeError('Unknown runtime');
  const cleanModel = model === undefined || model === null ? null : model;
  if (cleanModel !== null && (typeof cleanModel !== 'string' || cleanModel.length === 0 || cleanModel.length > 200 || /[\s\0]/.test(cleanModel))) throw new TypeError('Invalid model id');
  const cleanAccount = accountId === undefined || accountId === null ? null : accountId;
  if (cleanAccount !== null && !AccountStore.isValidId(cleanAccount)) throw new TypeError('Invalid account id');
  const cleanOrigin = continuedFrom === undefined || continuedFrom === null ? null : continuedFrom;
  if (cleanOrigin !== null && !isValidId(cleanOrigin)) throw new TypeError('Invalid member id');
  // Absent means "whatever the role says"; a word that is not a tier is a bug
  // in the caller, not something to silently round to the default.
  const cleanTier = tier === undefined || tier === null ? null : tier;
  if (cleanTier !== null && !isEffortTier(cleanTier)) throw new TypeError('Invalid effort tier');
  return { runtime: cleanRuntime, model: cleanModel as string | null, accountId: cleanAccount as string | null, continuedFrom: cleanOrigin as string | null, tier: cleanTier };
}

/**
 * Document model (matches the UI): `Work.brief` IS the editable Markdown
 * deliverable. On disk it lives in `brief.md`, which agents edit from their
 * sessions. The file is the single authority: every read path syncs the
 * database copy from disk, so agent edits show up in the UI on refresh.
 *
 * Instruction files (CLAUDE.md / AGENTS.md) are generated when a work is
 * created and rewritten when a NEW agent session starts. Edits made while a
 * session is running deliberately do not touch files that session is reading.
 */
export class LatteService implements BackendApi {
  private readonly clock: () => string;
  readonly branding: BrandingService;
  readonly learningService: LearningService;
  private readonly brandContextPort: BrandContextPort;
  private readonly skillResolverPort: SkillResolverPort;
  private readonly coordination: CoordinationEngine;

  constructor(private readonly deps: LatteServiceDeps) {
    this.clock = deps.clock ?? nowIso;
    this.coordination = new CoordinationEngine({
      repo: deps.repo,
      hub: deps.hub,
      clock: this.clock,
      memberContext: (workId) => this.memberContext(workId),
      emit: deps.emitCoordination,
      // Task 8.1: the real flag, off by default like every other feature.
      isCoordinationEnabled: () => featureEnabled((key) => deps.repo.getMeta(key), 'coordination'),
    });
    this.branding = new BrandingService({
      repo: deps.repo,
      files: deps.files,
      chooseFolder: deps.chooseFolder,
      clock: this.clock,
    });
    this.learningService = new LearningService({
      learning: deps.learning,
      works: { getWork: (id) => deps.repo.getWork(id) },
      meta: deps.repo,
      generator: deps.learningGenerator,
      now: deps.learningNow,
    });
    this.brandContextPort = deps.brandContext ?? brandContextAdapter(this.branding);
    this.skillResolverPort = deps.skillResolver ?? skillResolverAdapter(this.learningService);
  }

  /**
   * sdd/autonomous-coordination, task 6.33: attached AFTER construction, the
   * same reasoning as `AgentHub.attachCoordinationInjection` -- the planner
   * needs `this.memberContext` (via the coordination MCP server's own
   * `CoordinationEngine` instance), which needs this service to already
   * exist. Bootstrap.ts builds the planner once everything else is up and
   * hands it to both the hub and this service.
   */
  attachCoordinationInjection(planner: CoordinationInjectionPlanner): void {
    this.deps.injection = planner;
  }

  /**
   * Reescribe los archivos de instrucciones de UN Trabajo despues de que el
   * runtime confirmo (o desmintio) que inyecto los servidores MCP -- lo llama
   * `AgentHub` via `attachCoordinationInjection` (juicio #2, ronda 4).
   *
   * La regla de quietud se afloja EXACTAMENTE un paso, no mas: se reescribe
   * solo cuando este Trabajo tiene a lo sumo UN miembro vivo, o sea el que
   * se acaba de abrir. `memberContext` ya habia escrito el archivo un
   * instante antes (con `liveMemberCount === 0`) afirmando las herramientas
   * que el planificador habia DECIDIDO; si el runtime despues se nego, ese
   * mismo archivo queda mintiendole al unico proceso que lo va a leer, y
   * todavia no leyo nada. Con dos o mas miembros vivos NO se toca: la
   * garantia de que una conversacion en curso no ve cambiar sus archivos
   * compartidos por debajo sigue entera.
   */
  refreshInstructionsAfterInjection(workId: string): void {
    if (this.deps.hub.liveMemberCount(workId) > 1) return;
    // Y solo si la respuesta CAMBIO: sin una negativa real del runtime no hay
    // nada que corregir, y reescribir por reescribir pisaria los archivos
    // compartidos en cada apertura, cambio de modelo o de esfuerzo.
    const written = this.memoryClaimWritten.get(workId);
    if (written === (this.deps.injection?.memoryToolsInjectedForWork(workId) ?? false)) return;
    try {
      const work = this.deps.repo.getWork(workId);
      this.refreshInstructions(this.deps.repo.getBrand(work.brandId), work);
    } catch {
      // Mejor esfuerzo: una carpeta que ya no esta no puede tumbar una apertura.
    }
  }

  // App ---------------------------------------------------------------------

  async getUiLocale(): Promise<'es-AR' | 'en-US'> {
    const locale = this.deps.repo.getMeta('ui_locale');
    return locale === 'en-US' ? locale : 'es-AR';
  }

  async setUiLocale(locale: 'es-AR' | 'en-US'): Promise<'es-AR' | 'en-US'> {
    if (locale !== 'es-AR' && locale !== 'en-US') throw new TypeError('Invalid UI locale');
    this.deps.repo.setMeta('ui_locale', locale);
    return locale;
  }

  async getContentLocale(): Promise<'es-AR' | 'en-US'> {
    const locale = this.deps.repo.getMeta('content_locale');
    return locale === 'en-US' ? locale : 'es-AR';
  }

  async setContentLocale(locale: 'es-AR' | 'en-US'): Promise<'es-AR' | 'en-US'> {
    if (locale !== 'es-AR' && locale !== 'en-US') throw new TypeError('Invalid content locale');
    this.deps.repo.setMeta('content_locale', locale);
    return locale;
  }

  /** First-run gate flag, stored in `meta` like the locale settings (no migration). */
  async getOnboardingComplete(): Promise<boolean> {
    return this.deps.repo.getMeta('onboarding_complete') === '1';
  }

  async setOnboardingComplete(complete: boolean): Promise<boolean> {
    if (typeof complete !== 'boolean') throw new TypeError('Invalid onboarding flag');
    this.deps.repo.setMeta('onboarding_complete', complete ? '1' : '0');
    // The mid-flow draft only means something while onboarding is incomplete:
    // completing, skipping and replaying all start the next walk fresh.
    this.deps.repo.setMeta('onboarding_draft', '');
    return complete;
  }

  /**
   * Mid-flow progress, so a walk abandoned part-way resumes at the same step.
   * Null when there is nothing saved, when it cannot be read, or when the
   * terminal flag is already set (a stale draft never resurfaces).
   */
  async getOnboardingDraft(): Promise<OnboardingDraft | null> {
    if (this.deps.repo.getMeta('onboarding_complete') === '1') return null;
    const raw = this.deps.repo.getMeta('onboarding_draft');
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isOnboardingDraft(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async setOnboardingDraft(draft: OnboardingDraft): Promise<void> {
    if (!isOnboardingDraft(draft)) throw new TypeError('Invalid onboarding draft');
    // A draft saved after completion must not resurrect a finished walk.
    if (this.deps.repo.getMeta('onboarding_complete') === '1') return;
    this.deps.repo.setMeta('onboarding_draft', JSON.stringify(draft));
  }

  async clearOnboardingDraft(): Promise<void> {
    this.deps.repo.setMeta('onboarding_draft', '');
  }

  /** Read-only facts for the Settings screen. No secrets, no credentials. */
  async appInfo(): Promise<AppInfo> {
    return {
      dataDir: this.deps.files.root,
      engine: this.deps.repo.engine,
      engineReason: this.deps.engineReason ?? '',
      pack: this.deps.pack ? `${this.deps.pack.id}@${this.deps.pack.version}` : null,
      packRoles: this.deps.pack?.roles.length ?? 0,
      version: this.deps.version,
    };
  }

  // Brands ------------------------------------------------------------------

  async listBrands(): Promise<Brand[]> {
    return this.deps.repo.listBrands();
  }

  async getBrand(brandId: string): Promise<Brand> {
    return this.deps.repo.getBrand(requireId(brandId, 'brandId'));
  }

  async createBrand(name: string): Promise<Brand> {
    const cleanName = requireLabel(name, 'Brand name', LIMITS.name);
    const brand: Brand = { id: newId('brd'), name: cleanName, context: '', createdAt: this.clock(), archivedAt: null };
    this.deps.repo.insertBrand(brand);
    this.deps.files.ensureBrand(brand.id);
    return brand;
  }

  /**
   * The raw write, kept for the existing API surface and the QA script. It
   * propagates like every other brand-context write, but reports nothing; the
   * UI uses `saveBrandContext` when it needs the report.
   *
   * It stays the raw primitive on purpose: it accepts an empty value and does
   * not check a fingerprint. Emptying on purpose is `clearBrandContext`, and a
   * checked write is `saveBrandContext`.
   */
  async updateBrand(id: string, context: string): Promise<Brand> {
    return this.writeBrandContext(requireId(id, 'brandId'), context, null, 'human', null, true).brand;
  }

  /**
   * The human wrote the context by hand: persist it and tell them what reached
   * each work.
   *
   * An empty value is refused (`CONTEXT_EMPTY`) so a stray save cannot wipe the
   * brand context by accident, and a fingerprint that no longer matches is
   * refused (`CONTEXT_STALE`) so a change made underneath is never overwritten
   * in silence. Both refusals leave the draft in the editor.
   */
  async saveBrandContext(brandId: string, context: string, expectedFingerprint: string | null = null): Promise<BrandContextSaveResult> {
    return this.writeBrandContext(requireId(brandId, 'brandId'), context, expectedFingerprint, 'human', null, false);
  }

  /** The explicit clear: the only way an empty context is written on purpose. */
  async clearBrandContext(brandId: string, expectedFingerprint: string | null = null): Promise<BrandContextSaveResult> {
    return this.writeBrandContext(requireId(brandId, 'brandId'), '', expectedFingerprint, 'clear', null, true);
  }

  /** The history of `brands.context`, newest first. */
  async listBrandContextRevisions(brandId: string): Promise<BrandContextRevision[]> {
    const id = requireId(brandId, 'brandId');
    this.deps.repo.getBrand(id);
    return this.deps.repo.listBrandContextRevisions(id);
  }

  /**
   * Applies a past revision. The restore is itself a change, so it records a
   * new revision (pointing at the one it came from): a restore can be undone by
   * restoring what it replaced.
   */
  async restoreBrandContextRevision(brandId: string, revisionId: string, expectedFingerprint: string | null = null): Promise<BrandContextSaveResult> {
    const id = requireId(brandId, 'brandId');
    this.requireActiveBrand(id);
    const revision = this.deps.repo.getBrandContextRevision(requireId(revisionId, 'revisionId'));
    if (revision.brandId !== id) throw new ValidationError('That revision belongs to another brand');
    return this.writeBrandContext(id, revision.content, expectedFingerprint, 'restore', revision.id, true);
  }

  /** Everything the Contexto view needs about the brand context, in one read. */
  async brandContextStatus(brandId: string): Promise<BrandContextStatus> {
    const id = requireId(brandId, 'brandId');
    const brand = this.deps.repo.getBrand(id);
    const proposals = await this.listBrandContextProposals(id);
    const works = this.deps.repo.listWorks(id);
    return {
      brandId: id,
      fingerprint: brandContextFingerprint(brand.context),
      pending: proposals.find((proposal) => proposal.status === 'pending') ?? null,
      proposals,
      works: works.map((work) => ({ id: work.id, title: work.title, live: this.deps.hub.liveMemberCount(work.id) > 0 })),
      ownerWorkId: electBrandContextOwner(works),
      revisions: this.deps.repo.listBrandContextRevisions(id),
    };
  }

  /**
   * One write path for `brand.context`: the database commits first, the
   * instruction files are rewritten after, outside any transaction (a file
   * cannot be rolled back; the loop is idempotent and re-runnable).
   */
  private writeBrandContext(
    brandId: string,
    context: string,
    expectedFingerprint: string | null,
    source: BrandContextRevisionSource,
    origin: string | null,
    allowEmpty: boolean,
  ): BrandContextSaveResult {
    const brand = this.requireActiveBrand(brandId);
    this.assertContextUnchanged(brand, expectedFingerprint);
    const cleanContext = requireCleanContext(context, 'Brand context', { allowEmpty: true });
    if (!allowEmpty && cleanContext.length === 0) {
      throw new LatteError('CONTEXT_EMPTY', 'Brand context cannot be emptied by a save');
    }
    const at = this.clock();
    const next = this.deps.repo.transaction(() => {
      this.deps.repo.recordBrandContextRevision(brand, cleanContext, source, origin, at);
      return this.deps.repo.updateBrandContext(brand.id, cleanContext);
    });
    return { brand: next, refresh: this.refreshBrandWorksInstructions(next) };
  }

  /**
   * Refuses a write whose basis is no longer the persisted value. A null
   * fingerprint means the caller had nothing to compare against (the editor was
   * opened before the first read came back), which is the pre-CAS behaviour.
   */
  private assertContextUnchanged(brand: Brand, expectedFingerprint: string | null): void {
    if (expectedFingerprint === null || expectedFingerprint === undefined) return;
    if (typeof expectedFingerprint !== 'string') throw new ValidationError('Invalid context fingerprint');
    if (expectedFingerprint !== brandContextFingerprint(brand.context)) {
      throw new LatteError('CONTEXT_STALE', 'Brand context changed since it was loaded');
    }
  }

  async archiveBrand(id: string): Promise<Brand> {
    const brandId = requireId(id, 'brandId');
    this.deps.repo.getBrand(brandId);
    return this.deps.repo.archiveBrand(brandId, this.clock());
  }

  async restoreBrand(id: string): Promise<Brand> {
    const brandId = requireId(id, 'brandId');
    this.deps.repo.getBrand(brandId);
    return this.deps.repo.restoreBrand(brandId);
  }

  async listArchivedBrands(): Promise<Brand[]> {
    return this.deps.repo.listArchivedBrands();
  }

  private requireActiveBrand(brandId: string): Brand {
    const brand = this.deps.repo.getBrand(brandId);
    if (brand.archivedAt) throw new LatteError('BRAND_ARCHIVED', `Brand is archived: ${brandId}`);
    return brand;
  }

  async readAgencyProfile() {
    return this.branding.readAgencyProfile();
  }

  async saveAgencyProfile(expectedRevision: number, patch: { publicName: string; website?: string | null; contact?: string | null }) {
    return this.branding.saveAgencyProfile(expectedRevision, patch);
  }

  async importBrandKit(workId: string) {
    this.requireActiveBrand(this.deps.repo.getWork(requireId(workId, 'workId')).brandId);
    return this.branding.importBrandKit(workId);
  }

  async publishBrandKit(workId: string, expectedVersion: number) {
    this.requireActiveBrand(this.deps.repo.getWork(requireId(workId, 'workId')).brandId);
    return this.branding.publishBrandKit(workId, expectedVersion);
  }

  async revokeBrandKit(workId: string, version: number, reason: string) {
    return this.branding.revokeBrandKit(workId, version, reason);
  }

  async importAgencyKit() {
    return this.branding.importAgencyKit();
  }

  async publishAgencyKit(expectedVersion: number) {
    return this.branding.publishAgencyKit(expectedVersion);
  }

  async setWorkBrandChoice(workId: string, choice: WorkBrandChoiceInput, expectedRevision: number) {
    this.requireActiveBrand(this.deps.repo.getWork(requireId(workId, 'workId')).brandId);
    return this.branding.setWorkBrandChoice(workId, choice, expectedRevision);
  }

  async readWorkBrandContext(workId: string) {
    return this.branding.readWorkBrandContext(workId);
  }

  // Works -------------------------------------------------------------------

  async listWorks(brandId: string): Promise<Work[]> {
    const id = requireId(brandId, 'brandId');
    this.deps.repo.getBrand(id);
    return this.deps.repo.listWorks(id).map((work) => this.syncFromDisk(work));
  }

  async createWork(brandId: string, title: string): Promise<Work> {
    const id = requireId(brandId, 'brandId');
    const cleanTitle = requireLabel(title, 'Work title', LIMITS.title);
    const brand = this.requireActiveBrand(id);
    const initialDocument = `# ${cleanTitle}\n\n`;
    const work: Work = { id: newId('wrk'), brandId: id, title: cleanTitle, brief: initialDocument, folder: null, outOfScopeStages: [], updatedAt: this.clock() };
    this.deps.repo.insertWork(work);
    this.deps.repo.setMeta(`work_content_locale:${work.id}`, await this.getContentLocale());
    this.deps.repo.insertDocument({
      id: briefDocumentId(work.id),
      workId: work.id,
      kind: 'brief',
      title: cleanTitle,
      fileName: WORK_FILES.brief,
      status: 'draft',
      funnelStages: [],
      baseDocumentId: null,
      baseRevisionId: null,
      baseFingerprint: null,
      lastFingerprint: fingerprintOf(initialDocument),
      createdAt: work.updatedAt,
      updatedAt: work.updatedAt,
    });
    this.deps.files.ensureWork(id, work.id, initialDocument);
    this.refreshInstructions(brand, work);
    return work;
  }

  /**
   * The outcome of a work: what it should deliver and which Deliverables file
   * is its result. Brief, title and folder have their own paths and are
   * refused here. A link must point at a file that is there now; if it goes
   * away later, that is read from the folder, never stored as a state.
   *
   * Nothing is rewritten here. A conversation that opens afterwards gets the
   * current outcome from the shared instruction files, rewritten when no other
   * conversation of the work is live, or else in its own prompt when those
   * frozen files do not say it. One already open keeps its starting context.
   */
  async updateWork(workId: string, patch: WorkPatch): Promise<Work> {
    const id = requireId(workId, 'workId');
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new ValidationError('Invalid work patch');
    const unknown = Object.keys(patch).filter((key) => key !== 'expectedOutput' && key !== 'resultPath');
    if (unknown.length > 0) throw new ValidationError(`Only the expected output and the result can change here, not: ${unknown.join(', ')}`);
    const work = this.syncFromDisk(this.deps.repo.getWork(id));
    let expectedOutput = work.expectedOutput ?? null;
    if (patch.expectedOutput !== undefined) {
      expectedOutput = patch.expectedOutput === null ? null : requireText(patch.expectedOutput, 'Expected output', LIMITS.expectedOutput, { allowEmpty: true }).trim() || null;
    }
    let resultPath = work.resultPath ?? null;
    if (patch.resultPath !== undefined) {
      resultPath = patch.resultPath === null || patch.resultPath === '' ? null : this.existingDeliverable(id, patch.resultPath);
    }
    return this.deps.repo.setWorkOutcome(id, expectedOutput, resultPath, this.clock());
  }

  async prepareGeneration(workId: string): Promise<PrepareGenerationOutcome> {
    requireFeature((key) => this.deps.repo.getMeta(key), 'generation');
    const id = requireId(workId, 'workId');
    let work;
    try {
      work = this.deps.repo.getWork(id);
    } catch (error) {
      if (error instanceof NotFoundError) throw new GenerationContractError('WORK_NOT_FOUND', error.message);
      throw error;
    }
    if (this.deps.repo.getBrand(work.brandId).archivedAt) {
      throw new LatteError('BRAND_ARCHIVED', `Brand is archived: ${work.brandId}`);
    }
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    const result = runPrepareGeneration({
      works: {
        requireWork: (wid) => {
          const found = this.deps.repo.getWork(wid);
          return { id: found.id, brandId: found.brandId };
        },
      },
      brand: this.brandContextPort,
      skills: this.skillResolverPort,
      insert: (receipt) => this.deps.repo.insertGeneration(receipt),
      pin: ({ generationId, work: pinned, context, snapshot, contextHash }) => {
        pinGeneration({
          workDir: this.deps.files.workDir(pinned.brandId, pinned.id),
          generationId,
          context,
          snapshot,
          contextHash,
          assets: snapshot ? this.brandContextPort.pinAssets(snapshot) : [],
        });
      },
      liveMemberCount: (wid) => this.deps.hub.liveMemberCount(wid),
      refreshInstructions: (target) => {
        this.refreshInstructions(this.deps.repo.getBrand(target.brandId), this.deps.repo.getWork(target.id));
      },
      newId: () => newId('gen'),
      now: () => this.clock(),
      budgetChars: INSTRUCTIONS_MAX_CHARS,
    }, id);
    return {
      generationId: result.generationId,
      contextHash: result.contextHash,
      pending: result.pending,
      instructionsRefreshed: result.instructionsRefreshed,
    };
  }

  private generationEnabled(): boolean {
    return featureEnabled((key) => this.deps.repo.getMeta(key), 'generation');
  }

  async featureFlags(): Promise<FeatureFlags> {
    return readFeatureFlags((key) => this.deps.repo.getMeta(key));
  }

  /** A Deliverables file that is there right now, or a message that says why it cannot be linked. */
  private existingDeliverable(workId: string, name: unknown): string {
    const fileName = deliverableName(name);
    try {
      this.deliverables(workId).resolve(fileName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ValidationError(`${fileName} no está en entregables/. Actualizá la lista y elegí un archivo que exista.`);
      throw error;
    }
    return fileName;
  }

  /** Saves the work's brief document. Kept for the existing UI/API surface; it delegates to saveDocument. */
  async saveBrief(workId: string, brief: string, baseFingerprint: string | null = null): Promise<SaveOutcome> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    return this.saveDocument(briefDocumentId(id), brief, baseFingerprint);
  }

  // Documents ---------------------------------------------------------------

  async listDocuments(workId: string): Promise<WorkDocument[]> {
    const id = requireId(workId, 'workId');
    const work = this.deps.repo.getWork(id);
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    return this.deps.repo.listDocuments(id).map((record) => this.describeDocument(this.collectFunnelProposal(work.brandId, record)));
  }

  /**
   * Brand-scoped knowledge: every tracked document of every work of this brand.
   * Mutations stay on listDocuments / createDocument / saveDocument (work or document id).
   */
  async listBrandDocuments(brandId: string): Promise<WorkDocument[]> {
    const id = requireId(brandId, 'brandId');
    const brand = this.deps.repo.getBrand(id);
    for (const work of this.deps.repo.listWorks(id)) this.deps.files.ensureWork(brand.id, work.id, work.brief);
    return this.deps.repo.listDocumentsForBrand(id).map((record) => this.describeDocument(this.collectFunnelProposal(brand.id, record)));
  }

  /**
   * Picks up a funnel block the agent left on a document Latte already tracks.
   *
   * The block leaves the file the moment it is seen, so it never reaches the
   * editor, a saved version or an export: it was a message to Latte, not part
   * of the deliverable. What it said is kept as a PENDING proposal until the
   * human applies or dismisses it. Reading never classifies anything by itself.
   */
  private collectFunnelProposal(brandId: string, record: DocumentRecord): DocumentRecord {
    let disk: DocumentOnDisk;
    try { disk = this.deps.files.readDocument(brandId, record.workId, record.fileName); } catch { return record; }
    const proposal = readFunnelProposal(disk.content);
    if (proposal.stages.length === 0) return record;
    this.deps.files.writeDocument(brandId, record.workId, proposal.body, record.fileName);
    const clean = this.deps.files.readDocument(brandId, record.workId, record.fileName);
    return this.deps.repo.updateDocument(record.id, {
      proposedFunnelStages: proposal.stages,
      // The stripped file is what Latte now knows, so this does not read as an external edit.
      lastFingerprint: clean.fingerprint,
      updatedAt: this.clock(),
    });
  }

  /** Takes the agent's proposal as the document's stages. The human decides, always. */
  async applyFunnelProposal(documentId: string): Promise<WorkDocument> {
    const record = this.deps.repo.getDocument(requireId(documentId, 'documentId'));
    if (record.proposedFunnelStages.length === 0) throw new ValidationError('Ese documento no tiene una propuesta pendiente');
    return this.describeDocument(this.deps.repo.updateDocument(record.id, { funnelStages: record.proposedFunnelStages, proposedFunnelStages: [], updatedAt: this.clock() }));
  }

  /** Drops the proposal without touching the stages the document already had. */
  async dismissFunnelProposal(documentId: string): Promise<WorkDocument> {
    const record = this.deps.repo.getDocument(requireId(documentId, 'documentId'));
    return this.describeDocument(this.deps.repo.updateDocument(record.id, { proposedFunnelStages: [], updatedAt: this.clock() }));
  }

  /**
   * Marks or unmarks a funnel stage as out of scope for this work. Reversible:
   * toggling a marked stage removes it. Only a valid funnel stage is accepted
   * (the same list updateDocument uses); the work is read from disk first so a
   * stale copy is never persisted over a newer one.
   */
  async toggleOutOfScopeStage(workId: string, stage: FunnelStage): Promise<Work> {
    const id = requireId(workId, 'workId');
    if (!['discovery', 'consideration', 'conversion', 'retention'].includes(stage)) throw new TypeError('Invalid funnel stage');
    const work = this.syncFromDisk(this.deps.repo.getWork(id));
    const current = work.outOfScopeStages ?? [];
    const next = current.includes(stage) ? current.filter((s) => s !== stage) : [...current, stage];
    return this.deps.repo.setWorkOutOfScopeStages(id, next, this.clock());
  }

  async readDocument(documentId: string): Promise<DocumentContent> {
    return this.loadDocument(requireId(documentId, 'documentId'));
  }

  /** Cheap poll: the UI compares this fingerprint with the one it is editing. */
  async documentState(documentId: string): Promise<DocumentState> {
    const record = this.deps.repo.getDocument(requireId(documentId, 'documentId'));
    const work = this.deps.repo.getWork(record.workId);
    const disk = this.deps.files.readDocument(work.brandId, work.id, record.fileName);
    return { documentId: record.id, fingerprint: disk.fingerprint, modifiedAt: disk.modifiedAt, baseOutdated: this.isBaseOutdated(record) };
  }

  async createDocument(workId: string, kind: DocumentKind, title: string, baseDocumentId: string | null = null): Promise<DocumentContent> {
    const id = requireId(workId, 'workId');
    if (!DOCUMENT_KINDS.includes(kind)) throw new TypeError('Unknown document kind');
    const cleanTitle = requireLabel(title, 'Document title', LIMITS.title);
    const work = this.deps.repo.getWork(id);
    let base: DocumentRecord | null = null;
    if (baseDocumentId !== null) {
      base = this.deps.repo.getDocument(requireId(baseDocumentId, 'baseDocumentId'));
      if (base.workId !== work.id) throw new ValidationError('The base document belongs to another work');
    }
    const fileName = documentFileName(kind, this.deps.repo.usedFileNames(work.id));
    const now = this.clock();
    const locale = this.deps.repo.getMeta(`work_content_locale:${work.id}`) === 'en-US' ? 'en-US' : 'es-AR';
    const content = renderDocumentTemplate(kind, cleanTitle, work.title, base ? base.title : null, locale);
    // A derived document pins the exact base version it started from.
    const pinned = base ? this.pinBaseVersion(base) : null;
    const record: DocumentRecord = {
      id: newId('doc'),
      workId: work.id,
      kind,
      title: cleanTitle,
      fileName,
      status: 'draft',
      funnelStages: [],
      proposedFunnelStages: [],
      baseDocumentId: base ? base.id : null,
      baseRevisionId: pinned ? pinned.revisionId : null,
      baseFingerprint: pinned ? pinned.fingerprint : null,
      lastFingerprint: fingerprintOf(content),
      createdAt: now,
      updatedAt: now,
    };
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    this.deps.files.writeDocument(work.brandId, work.id, content, fileName);
    this.deps.repo.insertDocument(record);
    return this.loadDocument(record.id);
  }

  /**
   * Never overwrites a change Latte has not seen. When the file on disk moved
   * away from the base the caller edited, the disk version is stored as an
   * immutable revision (source "external": an outside write does not identify
   * its author) and the caller gets both variants back to resolve explicitly.
   */
  async saveDocument(documentId: string, content: string, baseFingerprint: string | null = null): Promise<SaveOutcome> {
    const id = requireId(documentId, 'documentId');
    const clean = requireText(content, 'Document', LIMITS.document, { allowEmpty: true });
    if (baseFingerprint !== null && !FINGERPRINT.test(baseFingerprint)) throw new TypeError('Invalid fingerprint');
    const record = this.deps.repo.getDocument(id);
    const work = this.deps.repo.getWork(record.workId);
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    const disk = this.deps.files.readDocument(work.brandId, work.id, record.fileName);
    const target = fingerprintOf(clean);
    const base = baseFingerprint ?? record.lastFingerprint ?? (record.fileName === WORK_FILES.brief ? fingerprintOf(work.brief) : null);
    const unseenChange = disk.modifiedAt !== null && base !== null && disk.fingerprint !== base && disk.fingerprint !== target;
    if (unseenChange) {
      const kept = this.storeRevision(work, record, disk.content, 'external');
      return { status: 'conflict', document: this.describeDocument(record), disk: this.contentFrom(record, disk), keptRevision: kept };
    }
    const now = this.clock();
    this.deps.files.writeDocument(work.brandId, work.id, clean, record.fileName);
    const updated = this.deps.repo.updateDocument(record.id, { lastFingerprint: target, updatedAt: now });
    const workRow = record.fileName === WORK_FILES.brief ? this.deps.repo.updateBrief(work.id, clean, now) : (this.deps.repo.touchWork(work.id, now), this.deps.repo.getWork(work.id));
    return { status: 'saved', document: this.describeDocument(updated), fingerprint: target, work: workRow };
  }

  async updateDocument(documentId: string, patch: DocumentPatch): Promise<WorkDocument> {
    const id = requireId(documentId, 'documentId');
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new TypeError('Invalid patch');
    const title = patch.title === undefined ? undefined : requireLabel(patch.title, 'Document title', LIMITS.title);
    if (patch.status !== undefined && !DOCUMENT_STATUSES.includes(patch.status)) throw new TypeError('Unknown document status');
    if (patch.funnelStages !== undefined && (!Array.isArray(patch.funnelStages) || patch.funnelStages.length > 4 || patch.funnelStages.some(s => !['discovery', 'consideration', 'conversion', 'retention'].includes(s)))) throw new TypeError('Invalid funnel stages');
    this.deps.repo.getDocument(id);
    return this.describeDocument(this.deps.repo.updateDocument(id, { title, status: patch.status, funnelStages: patch.funnelStages, updatedAt: this.clock() }));
  }

  async listDocumentRevisions(documentId: string): Promise<Revision[]> {
    const record = this.deps.repo.getDocument(requireId(documentId, 'documentId'));
    return this.deps.repo.listDocumentRevisions(record.workId, record.id);
  }

  /** Versions always come from disk, so taking one never writes the editor over an external change. */
  async snapshotDocument(documentId: string): Promise<Revision> {
    const record = this.deps.repo.getDocument(requireId(documentId, 'documentId'));
    const work = this.deps.repo.getWork(record.workId);
    const disk = this.syncDocumentFromDisk(work, record);
    return this.storeRevision(this.deps.repo.getWork(record.workId), record, disk.content, 'human');
  }

  /** Stores the human's text as a version. The file is untouched: this is how a conflict is resolved without losing either side. */
  async keepDraftAsVersion(documentId: string, content: string): Promise<Revision> {
    const record = this.deps.repo.getDocument(requireId(documentId, 'documentId'));
    const clean = requireText(content, 'Document', LIMITS.document, { allowEmpty: true });
    return this.storeRevision(this.deps.repo.getWork(record.workId), record, clean, 'human');
  }

  async exportDocument(documentId: string): Promise<string | null> {
    const record = this.deps.repo.getDocument(requireId(documentId, 'documentId'));
    const work = this.deps.repo.getWork(record.workId);
    const disk = this.syncDocumentFromDisk(work, record);
    const target = await this.deps.chooseExportPath(`${slugify(record.title, record.kind)}.md`);
    if (!target) return null;
    writeFileAtomic(target, disk.content);
    return target;
  }

  /**
   * Markdown an agent (or anyone) left in the work folder that Latte does not
   * track yet. An agent cannot register a document by itself: the managed
   * instruction files are Latte's, and letting a runtime edit them would make
   * the list of deliverables unverifiable. So Latte looks for the files and
   * offers to adopt them.
   */
  async listUntrackedFiles(workId: string): Promise<UntrackedFile[]> {
    const id = requireId(workId, 'workId');
    const work = this.syncFromDisk(this.deps.repo.getWork(id));
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    const directory = this.deps.files.workDir(work.brandId, work.id);
    const tracked = new Set(this.deps.repo.usedFileNames(work.id));
    const out: UntrackedFile[] = [];
    for (const name of scanFolder(directory).markdown) {
      if (tracked.has(name)) continue;
      // Latte's own README is not a deliverable; one the client already had is.
      if (name === WORK_FILES.readme && this.deps.files.readDocument(work.brandId, work.id, name).content.startsWith('# Latte work directory')) continue;
      const stat = this.deps.files.statDocument(work.brandId, work.id, name);
      // Read, never consumed: the human sees the proposal before deciding to adopt.
      const proposed = readFunnelProposal(this.deps.files.readDocument(work.brandId, work.id, name).content).stages;
      out.push({ fileName: name, title: titleFromFileName(name), kind: kindOf(kindFromFileName(name)), bytes: stat.bytes, modifiedAt: stat.modifiedAt, funnelStages: proposed });
    }
    return out;
  }

  /**
   * The rest of the folder: subfolders and files that are not tracked Markdown.
   *
   * Latte cannot turn these into documents — the importer stays at the top
   * level and on Markdown on purpose. But an agent opened here reads the whole
   * tree, so hiding it from the person would leave them trusting a folder they
   * cannot inspect. Listing is read-only: nothing here is adopted or converted.
   */
  /** Opens the work's folder in the file manager, so you can drop things in yourself. */
  async revealWorkFolder(workId: string): Promise<string> {
    const id = requireId(workId, 'workId');
    const work = this.deps.repo.getWork(id);
    if (!this.deps.revealPath) throw new UnavailableError('Abrir la carpeta requiere la aplicación de escritorio');
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    const directory = this.deps.files.workDir(work.brandId, work.id);
    await this.deps.revealPath(directory);
    return directory;
  }

  /**
   * Copies the client's own material into the work folder.
   *
   * A copy, never a move: what you pick stays where it was. The name is
   * sanitised and never overwrites — a second `propuesta.docx` lands as
   * `propuesta-2.docx`, because losing the first one silently would be worse
   * than an odd name. Markdown that arrives here is offered for adoption like
   * anything else in the folder; the rest is listed and read by your agent.
   */
  async importFiles(workId: string): Promise<string[]> {
    const id = requireId(workId, 'workId');
    const work = this.deps.repo.getWork(id);
    if (!this.deps.chooseFiles) throw new UnavailableError('Traer archivos requiere la aplicación de escritorio');
    const chosen = await this.deps.chooseFiles('Elegí los archivos que querés traer a este trabajo');
    if (chosen.length === 0) return [];
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    const directory = this.deps.files.workDir(work.brandId, work.id);
    const landed: string[] = [];
    for (const source of chosen.slice(0, IMPORT_LIMIT)) {
      const stat = nodePath.isAbsolute(source) ? fsStatSafe(source) : null;
      if (!stat || !stat.isFile() || stat.size > IMPORT_MAX_BYTES) continue;
      const name = importFileName(source);
      let target = nodePath.join(directory, name);
      const base = name.replace(/\.[^.]+$/, '');
      const extension = name.slice(base.length);
      for (let n = 2; fsExistsSafe(target) && n <= 99; n++) target = nodePath.join(directory, `${base}-${n}${extension}`);
      if (fsExistsSafe(target)) continue;
      if (!contains(directory, target)) continue;
      fsCopySafe(source, target);
      landed.push(nodePath.basename(target));
    }
    return landed;
  }

  /**
   * Roles one agent asked for, still waiting on you.
   *
   * Reading never opens anything: a handoff is a request, and the conversation
   * it asks for costs money and attention, so a human decides. The file stays
   * on disk until you accept or dismiss it.
   */
  async listHandoffs(workId: string): Promise<HandoffRequest[]> {
    const id = requireId(workId, 'workId');
    const work = this.deps.repo.getWork(id);
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    const roles = this.deps.hub.listRoles();
    const tracked = new Set(this.deps.repo.usedFileNames(work.id));
    const out: HandoffRequest[] = [];
    for (const name of scanFolder(this.deps.files.workDir(work.brandId, work.id)).markdown) {
      if (tracked.has(name)) continue;
      const handoff = readHandoff(this.deps.files.readDocument(work.brandId, work.id, name).content);
      if (!handoff) continue;
      const role = roles.find((r) => r.id === handoff.roleId);
      // A role Latte does not have is a typo, not an instruction: say so instead of guessing.
      out.push({ fileName: name, roleId: handoff.roleId, roleName: role?.name ?? handoff.roleId, known: Boolean(role), request: handoff.request });
    }
    return out;
  }

  /** Drops the ask. The file was a message to Latte, not a deliverable. */
  async dismissHandoff(workId: string, fileName: string): Promise<void> {
    const id = requireId(workId, 'workId');
    const work = this.deps.repo.getWork(id);
    const pending = await this.listHandoffs(id);
    if (!pending.some((h) => h.fileName === fileName)) throw new ValidationError('Ese pedido ya no está en la carpeta');
    const target = nodePath.join(this.deps.files.workDir(work.brandId, work.id), fileName);
    if (!contains(this.deps.files.workDir(work.brandId, work.id), target)) throw new ValidationError('Ruta inválida');
    try { nodeFs.rmSync(target, { force: true }); } catch { /* it may already be gone */ }
  }

  /** Shipped skills and their switch. On unless the human turned one off. */
  async listSkills(): Promise<AgentSkill[]> {
    return (this.deps.pack?.skills ?? []).map((s) => ({ id: s.id, name: s.name, summary: s.summary, enabled: this.skillEnabled(s.id) }));
  }

  async setSkillEnabled(skillId: string, enabled: boolean): Promise<AgentSkill[]> {
    const id = requireId(skillId, 'skillId');
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid skill switch');
    if (!(this.deps.pack?.skills ?? []).some((s) => s.id === id)) throw new ValidationError('Esa skill no viene con Latte');
    this.deps.repo.setMeta(SKILL_OFF_KEY + id, enabled ? '0' : '1');
    return this.listSkills();
  }

  async listSkillCandidates(): Promise<SkillCandidate[]> {
    const spend = this.learningService.duplicateSpendVisible().length > 0;
    return this.learningService.listInbox().map((row) => toSkillCandidate(row, spend));
  }

  async approveSkillCandidate(input: SkillReviewInput): Promise<SkillCandidate> {
    return toSkillCandidate(this.learningService.approve(input), false);
  }

  async rejectSkillCandidate(input: SkillReviewInput): Promise<SkillCandidate> {
    return toSkillCandidate(this.learningService.reject(input), false);
  }

  async promoteSkillCandidate(input: SkillPromoteInput): Promise<SkillCandidate> {
    return toSkillCandidate(this.learningService.promote(input), false);
  }

  private skillEnabled(skillId: string): boolean {
    return this.deps.repo.getMeta(SKILL_OFF_KEY + skillId) !== '1';
  }

  private enabledSkills(): PackSkill[] {
    return (this.deps.pack?.skills ?? []).filter((s) => this.skillEnabled(s.id));
  }

  async listFolderEntries(workId: string): Promise<FolderEntries> {
    const id = requireId(workId, 'workId');
    const work = this.deps.repo.getWork(id);
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    const scan = scanFolder(this.deps.files.workDir(work.brandId, work.id));
    const managed = new Set<string>([WORK_FILES.claude, WORK_FILES.agents, WORK_FILES.readme]);
    const otherFiles = scan.otherFiles.filter((name) => !managed.has(name));
    return {
      subfolders: scan.subfolders.slice(0, FOLDER_ENTRY_LIMIT),
      otherFiles: otherFiles.slice(0, FOLDER_ENTRY_LIMIT),
      truncated: scan.subfolders.length > FOLDER_ENTRY_LIMIT || otherFiles.length > FOLDER_ENTRY_LIMIT,
    };
  }

  private deliverables(workId: string): DeliverableFiles {
    const work = this.deps.repo.getWork(requireId(workId, 'workId'));
    return new DeliverableFiles(this.deps.files.workDir(work.brandId, work.id));
  }

  async listDeliverables(workId: string) { return this.deliverables(workId).list(); }

  async openDeliverable(workId: string, fileName: string): Promise<void> {
    const files = this.deliverables(workId);
    files.resolve(fileName);
    if (!this.deps.revealPath) throw new UnavailableError('Abrir requiere la aplicación de escritorio');
    if (/\.html?$/i.test(fileName) && (!this.deps.confirmHtml || !await this.deps.confirmHtml(fileName))) return;
    // The file may have changed while the native confirmation was open.
    await this.deps.revealPath(files.resolve(fileName));
  }

  async revealDeliverable(workId: string, fileName: string): Promise<void> {
    if (!this.deps.revealFile) throw new UnavailableError('Mostrar requiere la aplicación de escritorio');
    await this.deps.revealFile(this.deliverables(workId).resolve(fileName));
  }

  async copyDeliverable(workId: string, fileName: string): Promise<string | null> {
    const files = this.deliverables(workId);
    files.resolve(fileName);
    const target = await this.deps.chooseExportPath(fileName);
    if (!target) return null;
    files.copy(fileName, target);
    return target;
  }

  /** Adopts an existing file: from here it has versions, export and conflict checks. */
  async trackFile(workId: string, fileName: string): Promise<WorkDocument> {
    const id = requireId(workId, 'workId');
    const work = this.syncFromDisk(this.deps.repo.getWork(id));
    const candidates = await this.listUntrackedFiles(id);
    const candidate = candidates.find((c) => c.fileName === fileName);
    if (!candidate) throw new ValidationError('Ese archivo no está en la carpeta del trabajo o ya es un documento');
    const now = this.clock();
    // The agent's proposal is consumed here, before the first fingerprint, so
    // the version Latte starts tracking is the deliverable without the block.
    const funnelStages = this.consumeFunnelProposal(work.brandId, work.id, candidate.fileName);
    const disk = this.deps.files.readDocument(work.brandId, work.id, candidate.fileName);
    const record: DocumentRecord = {
      id: newId('doc'),
      workId: work.id,
      kind: candidate.kind,
      title: candidate.title,
      fileName: candidate.fileName,
      status: 'draft',
      funnelStages,
      proposedFunnelStages: [],
      baseDocumentId: null,
      baseRevisionId: null,
      baseFingerprint: null,
      lastFingerprint: disk.fingerprint,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.repo.insertDocument(record);
    this.refreshInstructions(this.deps.repo.getBrand(work.brandId), this.deps.repo.getWork(work.id));
    return this.describeDocument(record);
  }

  /**
   * Turns an answer that lives in a conversation into a document of the work.
   * A good answer is worth as much as a file, but only a file has versions,
   * export and conflict checking, so this is how one becomes the other.
   */
  async saveAsDocument(workId: string, kind: DocumentKind, title: string, content: string): Promise<WorkDocument> {
    const id = requireId(workId, 'workId');
    if (!DOCUMENT_KINDS.includes(kind)) throw new TypeError('Unknown document kind');
    const cleanTitle = requireLabel(title, 'Document title', LIMITS.title);
    const clean = requireText(content, 'Document', LIMITS.document);
    const work = this.syncFromDisk(this.deps.repo.getWork(id));
    const fileName = documentFileName(kind, this.deps.repo.usedFileNames(work.id));
    const now = this.clock();
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    this.deps.files.writeDocument(work.brandId, work.id, clean, fileName);
    const record: DocumentRecord = {
      id: newId('doc'),
      workId: work.id,
      kind,
      title: cleanTitle,
      fileName,
      status: 'draft',
      funnelStages: [],
      proposedFunnelStages: [],
      baseDocumentId: null,
      baseRevisionId: null,
      baseFingerprint: null,
      lastFingerprint: fingerprintOf(clean),
      createdAt: now,
      updatedAt: now,
    };
    this.deps.repo.insertDocument(record);
    this.refreshInstructions(this.deps.repo.getBrand(work.brandId), this.deps.repo.getWork(work.id));
    return this.describeDocument(record);
  }

  /** After the human reviewed the change, the derived document points at the base's current version. */
  async acknowledgeBase(documentId: string): Promise<WorkDocument> {
    const record = this.deps.repo.getDocument(requireId(documentId, 'documentId'));
    if (!record.baseDocumentId) throw new ValidationError('This document has no base version');
    const base = this.deps.repo.getDocument(record.baseDocumentId);
    const pinned = this.pinBaseVersion(base);
    return this.describeDocument(this.deps.repo.updateDocument(record.id, { baseRevisionId: pinned.revisionId, baseFingerprint: pinned.fingerprint, updatedAt: this.clock() }));
  }

  /**
   * Points a work at a folder the person already works in.
   *
   * Nothing is copied and nothing is moved: that folder becomes the work. In
   * exchange Latte writes its managed context files and a versions folder
   * inside it, and any agent opened for this work gets it as its working
   * directory. Markdown at the top level is registered so it gets versions and
   * export like any other deliverable.
   */
  async useFolder(workId: string): Promise<FolderLinkResult | null> {
    const id = requireId(workId, 'workId');
    const work = this.deps.repo.getWork(id);
    if (!this.deps.chooseFolder) throw new UnavailableError('Elegir una carpeta requiere la aplicación de escritorio');
    const chosen = await this.deps.chooseFolder('Elegí la carpeta de este trabajo');
    if (!chosen) return null;

    const check = checkFolder(chosen, this.deps.files.root);
    if (!check.ok) throw new ValidationError(check.reason ?? 'No se puede usar esa carpeta');
    const folder = nodePath.resolve(chosen);
    // Two works pointing at the same folder would fight over the same files.
    const taken = this.deps.repo.listWorks(work.brandId).find((w) => w.id !== work.id && w.folder && nodePath.resolve(w.folder) === folder);
    if (taken) throw new ValidationError('Esa carpeta ya la usa el trabajo "' + taken.title + '"');

    const scan = scanFolder(folder);
    this.deps.repo.setWorkFolder(work.id, folder, this.clock());
    this.deps.files.linkWork(work.id, folder);

    // From here on, every path of this work resolves inside the chosen folder.
    const brand = this.deps.repo.getBrand(work.brandId);
    this.deps.files.ensureWork(brand.id, work.id, work.brief);
    const now = this.clock();
    const documents: WorkDocument[] = [];
    const used = new Set(this.deps.repo.usedFileNames(work.id));
    for (const name of scan.markdown) {
      if (used.has(name)) continue;
      const proposed = this.consumeFunnelProposal(brand.id, work.id, name);
      const disk = this.deps.files.readDocument(brand.id, work.id, name);
      const record: DocumentRecord = {
        id: newId('doc'),
        workId: work.id,
        kind: kindFromFileName(name),
        title: titleFromFileName(name),
        fileName: name,
        status: 'draft',
        funnelStages: proposed,
        proposedFunnelStages: [],
        baseDocumentId: null,
        baseRevisionId: null,
        baseFingerprint: null,
        lastFingerprint: disk.fingerprint,
        createdAt: now,
        updatedAt: now,
      };
      this.deps.repo.insertDocument(record);
      used.add(name);
      documents.push(this.describeDocument(record));
    }
    const synced = this.syncFromDisk(this.deps.repo.getWork(work.id));
    this.refreshInstructions(brand, synced);
    return {
      work: synced,
      folder,
      documents,
      otherFiles: scan.otherFiles.slice(0, 100),
      subfolders: scan.subfolders.slice(0, 100),
      managedFiles: [WORK_FILES.claude, WORK_FILES.agents, WORK_FILES.metaDir + '/', WORK_FILES.readme],
    };
  }

  // Revisions (immutable snapshots) ----------------------------------------

  async listRevisions(workId: string): Promise<Revision[]> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    return this.deps.repo.listRevisions(id);
  }

  /** Version of the work's brief document (kept for the existing API surface). */
  async snapshot(workId: string): Promise<Revision> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    return this.snapshotDocument(briefDocumentId(id));
  }

  // Decisions ---------------------------------------------------------------

  async listDecisions(workId: string): Promise<Decision[]> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    return this.deps.repo.listDecisions(id);
  }

  /**
   * Brand-scoped knowledge: decisions of every work of this brand.
   * addDecision / approve / reject stay work- or decision-scoped.
   */
  async listBrandDecisions(brandId: string): Promise<Decision[]> {
    const id = requireId(brandId, 'brandId');
    this.deps.repo.getBrand(id);
    return this.deps.repo.listDecisionsForBrand(id);
  }

  async addDecision(workId: string, text: string): Promise<Decision> {
    const cleanText = requireText(text, 'Decision', LIMITS.decision).trim();
    const work = this.deps.repo.getWork(requireId(workId, 'workId'));
    const decision: Decision = { id: newId('dec'), workId: work.id, text: cleanText, rationale:'', alternativesRejected:[], evidenceRefs:[], status:'approved', source:{chatId:null,messageId:null,memberId:null,roleId:null,runtime:null}, clientRequestId:null, fingerprint:decisionFingerprint(cleanText), createdAt: this.clock(), decidedAt:this.clock() };
    this.deps.repo.insertDecision(decision);
    this.deps.repo.touchWork(work.id, decision.createdAt);
    return decision;
  }

  async getDecisionAuthority(workId:string):Promise<DecisionAuthorityMode> { const id=requireId(workId,'workId'); this.deps.repo.getWork(id); return this.readDecisionAuthority(id); }
  async setDecisionAuthority(workId:string,mode:DecisionAuthorityMode):Promise<DecisionAuthorityMode> { const id=requireId(workId,'workId'); this.deps.repo.getWork(id); if(mode!=='off'&&mode!=='suggest'&&mode!=='auto-record') throw new ValidationError('Invalid decision authority'); this.deps.repo.setMeta('decision_authority:'+id,mode); return mode; }

  /** Structured fallback used by every runtime. It never infers decisions from prose. */
  async proposeDecisionFromAgent(chatId:string,messageId:string,input:DecisionProposalInput):Promise<Decision|null> {
    const member=this.deps.repo.findMember(requireId(chatId,'chatId')); if(!member) throw new ValidationError('Unknown decision source');
    const mode=this.readDecisionAuthority(member.workId); if(mode==='off') return null;
    const request=requireRequestId(input.clientRequestId); const existing=this.deps.repo.findDecisionRequest(member.workId,chatId,request); if(existing) return existing;
    const statement=requireText(input.statement,'Decision statement',LIMITS.decision).trim().normalize('NFC');
    const rationale=typeof input.rationale==='string'?input.rationale.trim().normalize('NFC').slice(0,LIMITS.decision):'';
    const list=(v:unknown)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string').slice(0,20).map(x=>x.trim().normalize('NFC').slice(0,500)).filter(Boolean):[];
    const now=this.clock(); const source:DecisionSource={chatId,messageId:requireRequestId(messageId),memberId:member.id,roleId:member.roleId,runtime:member.runtime};
    const decision:Decision={id:newId('dec'),workId:member.workId,text:statement,rationale,alternativesRejected:list(input.alternativesRejected),evidenceRefs:list(input.evidenceRefs),status:mode==='auto-record'?'approved':'pending',source,clientRequestId:request,fingerprint:decisionFingerprint(statement),createdAt:now,decidedAt:mode==='auto-record'?now:null};
    this.deps.repo.insertDecisionProposal(decision); this.deps.repo.touchWork(member.workId,now); return decision;
  }
  async approveDecision(id:string,edited:string|null=null):Promise<Decision>{ const clean=edited==null?null:requireText(edited,'Decision',LIMITS.decision).trim().normalize('NFC'); return this.deps.repo.transitionDecision(requireId(id,'decisionId'),'approved',clean,this.clock()); }
  async rejectDecision(id:string):Promise<Decision>{ return this.deps.repo.transitionDecision(requireId(id,'decisionId'),'rejected',null,this.clock()); }
  async archiveDecision(id:string):Promise<Decision>{ return this.deps.repo.transitionDecision(requireId(id,'decisionId'),'archived',null,this.clock()); }

  // Brand context proposals -------------------------------------------------

  async listBrandContextProposals(brandId: string): Promise<BrandContextProposal[]> {
    const brand = this.deps.repo.getBrand(requireId(brandId, 'brandId'));
    const base = brandContextFingerprint(brand.context);
    return this.deps.repo.listBrandContextProposals(brandId).map((p) => ({ ...p, stale: p.baseFingerprint !== base }));
  }

  async proposeBrandContextFromAgent(chatId: string, messageId: string, input: BrandContextProposalInput): Promise<BrandContextProposal | null> {
    const member = this.deps.repo.findMember(requireId(chatId, 'chatId'));
    if (!member) throw new ValidationError('Unknown brand context source');
    const work = this.deps.repo.getWork(member.workId);
    const brand = this.requireActiveBrand(work.brandId);
    const authority = this.readDecisionAuthority(member.workId);
    if (authority === 'off') return null;
    const parsed = requireBrandContextInput(input);
    const existing = this.deps.repo.findBrandContextRequest(brand.id, work.id, chatId, parsed.clientRequestId);
    if (existing) return existing;
    const fingerprint = brandContextFingerprint(parsed.text);
    const pending = this.deps.repo.findPendingBrandContext(brand.id);
    if (pending && pending.fingerprint === fingerprint) return pending;
    this.assertComposedFits(brand.context, parsed.text, parsed.mode);
    const now = this.clock();
    const proposal: BrandContextProposal = {
      id: newId('bcp'),
      brandId: brand.id,
      workId: work.id,
      source: { chatId, messageId: requireRequestId(messageId), memberId: member.id, roleId: member.roleId, runtime: member.runtime },
      text: parsed.text,
      rationale: parsed.rationale,
      mode: parsed.mode,
      status: authority === 'auto-record' ? 'approved' : 'pending',
      fingerprint,
      baseFingerprint: brandContextFingerprint(brand.context),
      clientRequestId: parsed.clientRequestId,
      createdAt: now,
      decidedAt: authority === 'auto-record' ? now : null,
      decidedReason: authority === 'auto-record' ? 'auto-recorded' : null,
      supersededBy: null,
    };
    const stored = this.deps.repo.transaction(() => {
      // The older pending proposal is kept, marked superseded and pointed at
      // the newer one: the Contexto view shows the trail instead of silence.
      if (pending) this.deps.repo.rejectPendingBrandContext(brand.id, now, 'superseded', proposal.id);
      this.deps.repo.insertBrandContextProposal(proposal);
      if (proposal.status === 'approved') this.applyApprovedContext(brand, proposal.text, proposal.mode, proposal.id);
      return proposal;
    });
    // A new pending proposal flips every work's nudge; an auto-recorded one
    // rewrites every idle work's context. Either way: commit first, files after.
    this.refreshBrandWorksInstructions(this.deps.repo.getBrand(brand.id));
    return stored;
  }

  async approveBrandContextProposal(id: string, edited: string | null, acceptStale = false): Promise<BrandContextDecisionResult> {
    const proposalId = requireId(id, 'proposalId');
    const before = this.deps.repo.getBrandContextProposal(proposalId);
    const brand = this.requireActiveBrand(before.brandId);
    if (before.status === 'approved') return { proposal: before, brand, refresh: emptyRefreshReport() };
    if (before.status !== 'pending') throw new LatteError('PROPOSAL_DECIDED', `Brand context proposal already ${before.status}: ${proposalId}`);
    const clean = edited == null ? null : requireCleanContext(edited, 'Brand context');
    const text = clean ?? before.text;
    this.assertComposedFits(brand.context, text, before.mode);
    if (!acceptStale && before.baseFingerprint !== brandContextFingerprint(brand.context)) {
      throw new LatteError('PROPOSAL_STALE', 'Brand context changed since this proposal');
    }
    const proposal = this.deps.repo.transaction(() => {
      const current = this.deps.repo.getBrand(brand.id);
      const next = this.deps.repo.transitionBrandContextProposal(proposalId, 'approved', clean, this.clock());
      this.applyApprovedContext(current, next.text, next.mode, next.id);
      return next;
    });
    // DB first: the transaction above committed, then the files are rewritten.
    const nextBrand = this.deps.repo.getBrand(brand.id);
    return { proposal, brand: nextBrand, refresh: this.refreshBrandWorksInstructions(nextBrand) };
  }

  async rejectBrandContextProposal(id: string): Promise<BrandContextDecisionResult> {
    const proposalId = requireId(id, 'proposalId');
    const before = this.deps.repo.getBrandContextProposal(proposalId);
    const brand = this.requireActiveBrand(before.brandId);
    if (before.status === 'rejected') return { proposal: before, brand, refresh: emptyRefreshReport() };
    if (before.status !== 'pending') throw new LatteError('PROPOSAL_DECIDED', `Brand context proposal already ${before.status}: ${proposalId}`);
    const proposal = this.deps.repo.transitionBrandContextProposal(proposalId, 'rejected', null, this.clock());
    // Rejecting flips the nudge back to the owner, so the files must follow.
    return { proposal, brand, refresh: this.refreshBrandWorksInstructions(brand) };
  }

  async requestBrandContextDraft(workId: string): Promise<ChatSession> {
    const work = this.deps.repo.getWork(requireId(workId, 'workId'));
    this.requireActiveBrand(work.brandId);
    const team = this.deps.hub.listTeam(work.id);
    const strategists = team.filter((m) => m.roleId === 'strategist' && m.status !== 'ended');
    const available = strategists.find((m) => m.status !== 'working');
    if (strategists.length > 0 && !available) {
      throw new LatteError('MEMBER_BUSY', 'The strategist is already working on this work');
    }
    const session = available
      ? await this.deps.hub.openMember(available.id, this.memberContext(work.id))
      : await this.deps.hub.addMember({ ...this.memberContext(work.id), roleId: 'strategist' });
    const locale = this.deps.repo.getMeta(`work_content_locale:${work.id}`) === 'en-US' ? 'en-US' : 'es-AR';
    const prompt = locale === 'en-US' ? BRAND_CONTEXT_DRAFT_PROMPT_EN : BRAND_CONTEXT_DRAFT_PROMPT_ES;
    await this.deps.hub.send(session.id, prompt);
    return session;
  }

  private applyApprovedContext(brand: Brand, incoming: string, mode: BrandContextMode, origin: string | null): Brand {
    const next = this.assertComposedFits(brand.context, incoming, mode);
    // Approving IS a change of the brand context: it gets a revision like any
    // other, with the proposal as its origin.
    this.deps.repo.recordBrandContextRevision(brand, next, 'proposal', origin, this.clock());
    return this.deps.repo.updateBrandContext(brand.id, next);
  }

  private assertComposedFits(current: string, incoming: string, mode: BrandContextMode): string {
    const next = composeBrandContext(current, incoming, mode);
    if (next.length > LIMITS.context) {
      throw new LatteError('CONTEXT_TOO_LONG', `Brand context is ${next.length - LIMITS.context} characters over the ${LIMITS.context}-character limit`);
    }
    return requireCleanContext(next, 'Brand context', { allowEmpty: true });
  }

  private readDecisionAuthority(workId: string): DecisionAuthorityMode {
    const raw = this.deps.repo.getMeta('decision_authority:' + workId);
    return raw === 'off' || raw === 'auto-record' ? raw : 'suggest';
  }

  // Coordination (autonomous multi-agent runs) ------------------------------
  // Per-Work settings only, following `readDecisionAuthority` literally: a
  // closed union in `meta`, validated on write, safe default on an unset or
  // invalid read. The run/task/dispatch engine itself is a later phase.

  private readCoordinationAuthority(workId: string): CoordinationAuthorityMode {
    const raw = this.deps.repo.getMeta('coordination_authority:' + workId);
    return raw === 'plan' || raw === 'auto' ? raw : 'manual';
  }

  async getCoordinationAuthority(workId: string): Promise<CoordinationAuthorityMode> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    return this.readCoordinationAuthority(id);
  }

  async setCoordinationAuthority(workId: string, mode: CoordinationAuthorityMode): Promise<CoordinationAuthorityMode> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    if (mode !== 'manual' && mode !== 'plan' && mode !== 'auto') throw new ValidationError('Invalid coordination authority');
    this.deps.repo.setMeta('coordination_authority:' + id, mode);
    return mode;
  }

  /**
   * TRES estados, por el MISMO parser que usa el motor. Antes esto devolvía
   * `null` tanto para "nunca se configuró" como para "los bytes guardados no
   * se pueden leer", y la pantalla renderiza ese `null` como "sin presupuesto
   * configurado" — mientras el motor deniega cada despacho contra esos mismos
   * bytes. Es el crítico 8 un nivel más abajo.
   */
  private readCoordinationBudget(workId: string): CoordinationBudgetView {
    const read = readStoredCoordinationBudget(this.deps.repo.getMeta('coordination_budget:' + workId));
    if (read.kind === 'unset') return { state: 'unset' };
    if (read.kind === 'set') return { state: 'set', budget: read.budget };
    return { state: 'invalid' }; // los bytes crudos no cruzan IPC: no son dato de la persona, son basura
  }

  async getCoordinationBudget(workId: string): Promise<CoordinationBudgetView> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    return this.readCoordinationBudget(id);
  }

  async setCoordinationBudget(workId: string, budget: CoordinationBudget): Promise<CoordinationBudget> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    const valid = requireCoordinationBudget(budget);
    const json = JSON.stringify(valid);
    this.deps.repo.setMeta('coordination_budget:' + id, json);
    // A raised cap must also reach a run already in flight — the run's own
    // snapshot is never a live read, so it has to be written here too (design
    // decision 1: "raising a cap writes BOTH the run row and the Work default").
    this.deps.repo.updateActiveCoordinationRunBudget(id, json, this.clock());
    return valid;
  }

  /** `null`/empty stored value, or a member id that no longer belongs to this Work, both read back as "no coordinator". */
  private readCoordinatorGrant(workId: string): CoordinatorGrant {
    const raw = this.deps.repo.getMeta('coordination_coordinator:' + workId);
    if (!raw) return null;
    const member = this.deps.repo.findMember(raw);
    return member && member.workId === workId ? raw : null;
  }

  async getCoordinatorGrant(workId: string): Promise<CoordinatorGrant> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    return this.readCoordinatorGrant(id);
  }

  /**
   * A capability grant, not a role: this never touches the member's `roleId`
   * or prompt. Writing a new holder implicitly revokes whoever held it before
   * — the meta key holds exactly one id, so both can never be true at once.
   */
  async setCoordinatorGrant(workId: string, memberId: string | null): Promise<CoordinatorGrant> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    if (memberId === null) {
      this.deps.repo.setMeta('coordination_coordinator:' + id, '');
      return null;
    }
    const mid = requireId(memberId, 'memberId');
    const member = this.deps.repo.findMember(mid);
    if (!member || member.workId !== id) throw new ValidationError('Coordinator grant must reference a team member of this Work');
    this.deps.repo.setMeta('coordination_coordinator:' + id, mid);
    return mid;
  }

  // Coordination run lifecycle, gates, bitácora, asks and the handoff bridge.
  // Phase 3: IPC-only — `electron/coordination/engine.ts` is the single
  // dispatch choke point; nothing here reaches `hub.send` a second way.

  private toCoordinationRunView(run: CoordinationRunRecord): CoordinationRunView {
    return {
      id: run.id,
      workId: run.workId,
      status: run.status,
      coordinatorMemberId: run.coordinatorMemberId,
      budget: JSON.parse(run.budgetJson) as CoordinationBudget,
      planApproved: run.planApprovedAt != null,
      suspendReason: run.suspendReason,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      // El mismo conjunto que el índice único parcial y que la tira global:
      // `done`/`cancelled` quedan afuera, y por eso se marcan como no activos.
      active: run.status === 'planning' || run.status === 'running' || run.status === 'suspended',
      lastEventAt: this.lastCoordinationEventAt(run),
    };
  }

  /**
   * El instante del último hecho del run: el máximo entre su propio
   * `updatedAt` (que ya cubre el cierre, porque cerrar lo reescribe) y el
   * `createdAt` de la fila de despacho más nueva — que es también la de todo
   * gate de despacho pendiente. Un gate que nace no toca la fila del run, así
   * que con `updatedAt` solo "Desde tu última visita" se perdía justamente lo
   * que la persona tenía que ver.
   */
  private lastCoordinationEventAt(run: CoordinationRunRecord): string {
    let latest = run.updatedAt;
    try {
      for (const dispatch of this.deps.repo.listCoordinationDispatches(run.id)) {
        for (const at of [dispatch.createdAt, dispatch.startedAt, dispatch.settledAt]) {
          if (at && at > latest) latest = at;
        }
      }
    } catch { /* una bitácora ilegible no puede romper la vista del run */ }
    return latest;
  }

  async startCoordinationRun(workId: string): Promise<CoordinationRunView> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    const coordinatorMemberId = this.readCoordinatorGrant(id);
    const run = await this.coordination.startRun(id, coordinatorMemberId);
    return this.toCoordinationRunView(run);
  }

  async pauseCoordinationRun(runId: string): Promise<CoordinationRunView> {
    return this.toCoordinationRunView(this.coordination.pauseRun(requireId(runId, 'runId')));
  }

  async resumeCoordinationRun(runId: string): Promise<CoordinationRunView> {
    return this.toCoordinationRunView(this.coordination.resumeRun(requireId(runId, 'runId')));
  }

  async cancelCoordinationRun(runId: string): Promise<CoordinationRunView> {
    return this.toCoordinationRunView(this.coordination.cancelRun(requireId(runId, 'runId')));
  }

  /** The Work's active run, or `null` when none is running — never throws for "no run", that is the normal case. */
  async getCoordinationRun(workId: string): Promise<CoordinationRunView | null> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    // El run vivo si lo hay; si no, el ÚLTIMO terminado. Devolver `null` en
    // cuanto el run terminaba hacía que la interfaz limpiara bitácora, gates y
    // preguntas, así que la entrada de cierre `run_done` que el motor deriva
    // no se veía NUNCA. El `active: false` que lleva la vista es lo que impide
    // que un run terminado parezca vivo; un run nuevo lo reemplaza solo.
    const run = this.deps.repo.findActiveCoordinationRun(id) ?? this.deps.repo.findLatestFinishedCoordinationRun(id);
    return run ? this.toCoordinationRunView(run) : null;
  }

  async listCoordinationGates(runId: string): Promise<CoordinationGateView[]> {
    return this.coordination.listGates(requireId(runId, 'runId'));
  }

  async resolveCoordinationGate(gateId: string, decision: 'approve' | 'reject', editedPrompt: string | null = null): Promise<CoordinationRunView> {
    const clean = requireGateId(gateId);
    if (decision !== 'approve' && decision !== 'reject') throw new ValidationError('Invalid gate decision');
    // Crítico 12: esto cruzaba la frontera IPC sin un solo chequeo y llegaba
    // tal cual hasta `hub.send`. Se valida en la frontera (acá) y de nuevo,
    // defensivamente, adentro del motor.
    const cleanPrompt = editedPrompt == null ? undefined : requireEditedPrompt(editedPrompt);
    const resolved = await this.coordination.resolveGate(clean, decision, cleanPrompt);
    const runId = 'runId' in resolved ? resolved.runId : (resolved as CoordinationRunRecord).id;
    return this.toCoordinationRunView(this.coordination.getRun(runId));
  }

  async listCoordinationLog(runId: string): Promise<CoordinationLogEntryView[]> {
    return this.coordination.listLog(requireId(runId, 'runId'));
  }

  /**
   * Las contrataciones de este run, con el rol resuelto a NOMBRE. La bitácora
   * dibujaba filas de alta desde una prop que no llenaba nadie; ésta es su
   * fuente. El nombre sale del miembro real si sigue en el equipo, y si no del
   * catálogo de roles; en última instancia queda el id, que es lo único que
   * hay — nunca un nombre inventado.
   */
  async listCoordinationHires(runId: string): Promise<CoordinationHireView[]> {
    const id = requireId(runId, 'runId');
    const run = this.coordination.getRun(id);
    const byMember = new Map(this.deps.hub.listTeam(run.workId).map((m) => [m.id, m]));
    const roles = new Map(this.deps.hub.listRoles().map((role) => [role.id, role.name]));
    return this.coordination.listHires(id).map((hire) => ({
      memberId: hire.memberId,
      roleId: hire.roleId,
      roleName: byMember.get(hire.memberId)?.roleName ?? roles.get(hire.roleId) ?? hire.roleId,
      hiredAt: hire.hiredAt,
    }));
  }

  /** Las preguntas abiertas de un run, para que la persona pueda responderlas con `answerCoordinationAsk` en vez de quedarse sólo con "cancelar". */
  async listOpenCoordinationAsks(runId: string): Promise<CoordinationAskView[]> {
    return this.coordination.listOpenAsks(requireId(runId, 'runId'));
  }

  async answerCoordinationAsk(askId: string, answer: string): Promise<CoordinationAskView> {
    const clean = requireId(askId, 'askId');
    const cleanAnswer = requireText(answer, 'Answer', LIMITS.decision);
    return this.coordination.answerAsk(clean, cleanAnswer);
  }

  /**
   * WHEN the Work has an active run, mints a `coordination_task` for the
   * accepted handoff and attempts to dispatch it through the exact same
   * choke point `latte_dispatch` uses; the handoff file is then dismissed,
   * matching the existing "accepting consumes the request" behaviour.
   * Outside an active run this is a pure no-op: `listHandoffs`/`dismissHandoff`
   * are untouched, and the caller falls back to opening a chat draft exactly
   * as it did before this change.
   */
  async acceptHandoffAsTask(workId: string, fileName: string): Promise<HandoffTaskBridgeResult> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    if (!this.deps.repo.findActiveCoordinationRun(id)) return { bridged: false, task: null };
    const pending = await this.listHandoffs(id);
    const handoff = pending.find((h) => h.fileName === fileName);
    if (!handoff) throw new ValidationError('Ese pedido ya no está en la carpeta');
    const result = await this.coordination.bridgeHandoffToTask(id, handoff.roleId, handoff.request);
    if (!result.bridged) return { bridged: false, task: null };
    await this.dismissHandoff(id, fileName).catch(() => undefined);
    return { bridged: true, task: { id: result.task.id, roleId: result.task.roleId, spec: result.task.spec, status: result.task.status } };
  }

  /**
   * Manual dispatch settlement via IPC, zero MCP (task 3.19 — the "close"
   * half of the safety line): `latte_report` is called by the worker, but
   * without MCP no worker has tools, so nothing ever settled a dispatch. A
   * human reads the worker's own chat and records the outcome here instead —
   * coherent with `manual` authority mode, where the human already IS the
   * coordinator. Enters through `CoordinationEngine.settleDispatch`, which
   * re-enters `report()` — the exact function `latte_report` calls — so
   * idempotency, wrong-reporter rejection, ledger settlement and the
   * dispatch's settling timestamp all behave identically to an agent's own
   * report.
   */
  async settleCoordinationDispatch(taskId: string, outcome: 'succeeded' | 'failed', summary: string, files: string | null = null): Promise<CoordinationTaskView> {
    const id = requireId(taskId, 'taskId');
    if (outcome !== 'succeeded' && outcome !== 'failed') throw new ValidationError('Invalid dispatch outcome');
    const cleanSummary = requireText(summary, 'Summary', LIMITS.decision);
    const task = await this.coordination.settleDispatch(id, outcome, cleanSummary, files ?? null);
    return { id: task.id, runId: task.runId, roleId: task.roleId, spec: task.spec, status: task.status, attempts: task.attempts, resultSummary: task.resultSummary };
  }

  /**
   * Per-member coordination/memory status for this Work (task 6.33). Reuses
   * `CoordinationInjectionPlanner.preview` -- the SAME decision function hub
   * wiring's `open()` calls for real -- so a live member's row reports what
   * ACTUALLY happened (its committed claim), not a second, possibly-stale
   * guess; a paused/never-opened member gets an honest "if opened now"
   * preview. Deliberately NOT gated by any coordination flag: memory status
   * matters with coordination off, so with no `injection` wired at all
   * (only a test-harness reality; production always wires one) every row
   * simply reports "not supported here" rather than refusing to answer.
   */
  async coordinationRuntimeSupport(workId: string): Promise<CoordinationMemberSupport[]> {
    const id = requireId(workId, 'workId');
    const work = this.deps.repo.getWork(id);
    const members = this.deps.hub.listTeam(id);
    if (!this.deps.injection) {
      return members.map((m) => ({
        memberId: m.id, canPropose: false, memoryInjected: false, reason: null, runtimeConfirmed: false,
        runtimeReportsInjection: this.deps.hub.confirmsMcpInjection(m.runtime),
      }));
    }
    const out: CoordinationMemberSupport[] = [];
    for (const m of members) {
      const status = await this.deps.injection.preview({ memberId: m.id, workId: id, brandId: work.brandId, runtime: m.runtime, accountId: m.accountId });
      out.push({
        memberId: m.id, canPropose: status.canPropose, memoryInjected: status.memoryInjected, reason: status.reason,
        runtimeConfirmed: status.runtimeConfirmed,
        // La capacidad la declara el adaptador, no una lista paralela acá.
        runtimeReportsInjection: this.deps.hub.confirmsMcpInjection(m.runtime),
      });
    }
    return out;
  }

  /** The global "Equipos activos" strip (task 6.34) -- the only app-scoped read in this change. */
  async listActiveCoordinationRuns(): Promise<CoordinationActiveRunSummary[]> {
    // Y los que ACABAN de terminar (D18). Un equipo que termina desaparecía de
    // la tira en el mismo instante en que había algo que contar: Inicio no
    // podía decir "tu equipo terminó" porque la fuente ya no lo traía. Se
    // incluye el último run terminado de cada Trabajo mientras la persona no
    // haya pasado por ahí después de que cerró; su `active:false`/`status` es
    // lo que impide que parezca vivo.
    const finished = this.deps.repo.listLatestFinishedCoordinationRuns().filter((run) => {
      const seen = this.deps.repo.getMeta('coordination_last_seen:' + run.workId);
      return !seen || run.updatedAt > seen;
    });
    const runs = [...this.deps.repo.listActiveCoordinationRuns(), ...finished].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return runs.map((run) => {
      const work = this.deps.repo.getWork(run.workId);
      const brand = this.deps.repo.getBrand(work.brandId);
      // Lectura TOLERANTE POR FILA (crítico 4): un `budget_json` ilegible en
      // UNA marca hacía tirar este `map` entero, o sea que una fila rota
      // borraba de la pantalla los equipos activos de todas las demás marcas.
      // La fila rota se declara rota y el resto de la lista sobrevive.
      let dispatchesUsed = 0;
      let maxDispatches: number | null = null;
      let pendingGates = 0;
      let budgetInvalid = false;
      try {
        const budget = this.coordination.budgetBlockForEnvelope(run.id);
        dispatchesUsed = budget.dispatchesUsed;
        maxDispatches = budget.maxDispatches;
      } catch {
        budgetInvalid = true;
      }
      // Los gates se cuentan en su PROPIO try (D12): compartirlo con el
      // presupuesto hacía que un `budget_json` ilegible dejara `pendingGates`
      // en 0 — o sea, la tira decía "nada que decidir" justo en la fila que
      // tiene un problema y más necesita que la persona la mire.
      try {
        pendingGates = this.coordination.listGates(run.id).length;
      } catch { /* una fila rota no puede borrar el resto de la tira */ }
      return {
        runId: run.id,
        workId: run.workId,
        workTitle: work.title,
        brandId: brand.id,
        brandName: brand.name,
        status: run.status,
        dispatchesUsed,
        maxDispatches,
        pendingGates,
        budgetInvalid,
        updatedAt: run.updatedAt,
        lastEventAt: this.lastCoordinationEventAt(run),
        lastSeenAt: this.deps.repo.getMeta('coordination_last_seen:' + run.workId),
      };
    });
  }

  /**
   * Deja constancia de que la persona está mirando la coordinación de ESTE
   * Trabajo ahora mismo. Es el dato que faltaba: "Desde tu última visita" no
   * medía ninguna visita — no había timestamp persistido en ningún lado, así
   * que la tarjeta mostraba el estado ACTUAL bajo un título que habla del
   * pasado. Meta key namespaced, como `decisionAuthority`: sin subir de
   * versión de esquema.
   */
  async markCoordinationSeen(workId: string): Promise<string> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id); // un Trabajo que no existe no tiene visitas
    const at = this.clock();
    this.deps.repo.setMeta('coordination_last_seen:' + id, at);
    return at;
  }

  /**
   * The OPTIONAL advanced app-wide dispatch cap (task 6.35): same
   * `decisionAuthority`/`requireCoordinationBudget` precedent as every other
   * coordination budget, meta key `coordination_budget_global`. Unset ⇒
   * `null` and no extra cap applied -- never an invented limit. Unlike
   * `setCoordinationBudget`, there is no per-run snapshot to also update:
   * this cap is read fresh at dispatch time, app-wide, never copied into a
   * `coordination_run` row.
   *
   * Lo que cuenta son los despachos de los runs VIVOS, no el histórico de la
   * instalación; ver `CoordinationEngine.globalUsage`.
   */
  async getCoordinationGlobalBudget(): Promise<CoordinationGlobalBudgetView> {
    // EL MISMO parser que usa el camino de despacho (crítico 8). Devolver
    // `null` ante bytes ilegibles hacía que la pantalla dijera "sin tope
    // global" mientras cada despacho se denegaba contra ese mismo valor.
    const read = readStoredCoordinationBudget(this.deps.repo.getMeta('coordination_budget_global'));
    if (read.kind === 'unset') return { state: 'unset' };
    if (read.kind === 'set') return { state: 'set', budget: read.budget };
    return { state: 'invalid' }; // los bytes crudos no cruzan IPC: no son dato de la persona, son basura
  }

  /**
   * `null` BORRA el tope. Antes todo pasaba por `requireCoordinationBudget`,
   * que rechaza cualquier valor que signifique "sin tope", así que un tope
   * app-wide, una vez puesto, no había forma de sacarlo desde la interfaz: la
   * persona quedaba encerrada con su propio número. "Sin tope configurado" y
   * "tope ilimitado confirmado" siguen siendo cosas distintas — esto es la
   * primera, volver al estado de fábrica, no un ilimitado implícito.
   */
  async setCoordinationGlobalBudget(budget: CoordinationBudget | null): Promise<CoordinationBudget | null> {
    if (budget == null) {
      this.deps.repo.deleteMeta('coordination_budget_global');
      return null;
    }
    const valid = requireCoordinationBudget(budget);
    this.deps.repo.setMeta('coordination_budget_global', JSON.stringify(valid));
    return valid;
  }

  // Agents ------------------------------------------------------------------

  async runtimeStatus(): Promise<RuntimeStatus[]> {
    return this.deps.detector.status();
  }

  async startAgent(workId: string, provider: Provider): Promise<AgentSession> {
    assertProvider(provider);
    const work = this.syncFromDisk(this.deps.repo.getWork(requireId(workId, 'workId')));
    const brand = this.deps.repo.getBrand(work.brandId);
    const runtime = await this.deps.detector.resolve(provider);
    if (!runtime) throw new UnavailableError(`${provider} is not installed or not on PATH`);
    this.refreshInstructions(brand, work);
    return this.deps.terminal.start({
      workId: work.id,
      brandId: brand.id,
      provider,
      executable: runtime.executable,
      cwd: this.deps.files.workDir(work.brandId, work.id),
      extraEnv: { ENGRAM_PROJECT: memoryProjectFor(brand.id) },
    });
  }

  async writeAgent(sessionId: string, data: string): Promise<void> {
    const id = requireId(sessionId, 'sessionId');
    if (typeof data !== 'string') throw new TypeError('Terminal input must be a string');
    if (data.length > LIMITS.terminalChunk) throw new RangeError('Terminal input chunk too large');
    this.deps.terminal.write(id, data);
  }

  async resizeAgent(sessionId: string, cols: number, rows: number): Promise<void> {
    const id = requireId(sessionId, 'sessionId');
    this.deps.terminal.resize(id, requireInt(cols, 'cols', 1, 1000), requireInt(rows, 'rows', 1, 1000));
  }

  async stopAgent(sessionId: string): Promise<void> {
    this.deps.terminal.stop(requireId(sessionId, 'sessionId'));
  }

  // Structured chat (OpenCode) -----------------------------------------------

  async chatStatus(): Promise<ChatRuntimeStatus> {
    return this.deps.hub.status();
  }

  async startChat(workId: string, model: string | null = null, runtime: ChatRuntime | null = null, accountId: string | null = null): Promise<ChatSession> {
    const options = validateMemberOptions({ model, runtime, accountId });
    return this.deps.hub.start({ ...this.memberContext(workId), ...options });
  }

  // Team (roles per work) ---------------------------------------------------------

  async listProfiles(): Promise<AgentProfile[]> { return this.deps.hub.listProfiles(); }

  async saveProfile(input: ProfileInput, expectedFingerprint: string | null): Promise<AgentProfile> { return this.deps.hub.saveProfile(input, expectedFingerprint); }

  async listRoles(): Promise<AgentRole[]> {
    return this.deps.hub.listRoles();
  }

  async listTeam(workId: string): Promise<TeamMember[]> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    return this.deps.hub.listTeam(id);
  }

  async addTeamMember(workId: string, roleId: string, options: TeamMemberOptions | null = null): Promise<ChatSession> {
    if (!RoleCatalog.isValidId(roleId)) throw new TypeError('Invalid role id');
    const overrides = validateMemberOptions(options ?? {});
    const id = requireId(workId, 'workId');
    // A continuation only points at its origin, and only within the same work:
    // the origin's conversation, runtime and account are never touched.
    if (overrides.continuedFrom !== null && this.deps.repo.findMember(overrides.continuedFrom)?.workId !== id) throw new ValidationError('El miembro que se continúa no es de este trabajo');
    return this.deps.hub.addMember({ ...this.memberContext(id), roleId, ...overrides });
  }

  async openTeamMember(memberId: string): Promise<ChatSession> {
    const member = this.deps.hub.getMember(requireId(memberId, 'memberId'));
    return this.deps.hub.openMember(member.id, this.memberContext(member.workId));
  }

  async pauseTeamMember(memberId: string): Promise<void> {
    this.deps.hub.pauseMember(requireId(memberId, 'memberId'));
  }

  async finishTeamMember(memberId: string): Promise<void> {
    this.deps.hub.finishMember(requireId(memberId, 'memberId'));
  }

  /** Starts this member's conversation over. The member, its role and its runtime stay. */
  async restartTeamMember(memberId: string): Promise<TeamMember> {
    return this.deps.hub.restartMember(requireId(memberId, 'memberId'));
  }

  /**
   * The hand-over for continuing a member's work with another agent or
   * account, assembled from what Latte already keeps: the brief, the expected
   * output and linked result (whether that file is still there is read now),
   * the decision log, the tracked documents, the folder and whatever the
   * runtime exposes of the conversation. No model summarises anything, so the
   * same records give the same text; the human edits it before it is sent.
   *
   * A read, never a change: the member keeps its conversation, session,
   * account and status. Nothing is written as a new document either — files
   * are named, not pasted, and the conversation is quoted, not copied.
   */
  async draftContinuation(memberId: string): Promise<ContinuationDraft> {
    const member = this.deps.hub.getMember(requireId(memberId, 'memberId'));
    const work = this.syncFromDisk(this.deps.repo.getWork(member.workId));
    const brand = this.deps.repo.getBrand(work.brandId);
    const directory = this.deps.files.workDir(work.brandId, work.id);
    const records = this.deps.repo.listDocuments(work.id);
    const byId = new Map(records.map((r) => [r.id, r]));
    const documents = records.map((r) => ({
      fileName: r.fileName,
      title: r.title,
      kind: r.kind,
      status: r.status,
      baseFileName: r.baseDocumentId ? byId.get(r.baseDocumentId)?.fileName ?? null : null,
      baseOutdated: this.isBaseOutdated(r),
      proposalPending: r.proposedFunnelStages.length > 0,
      openItems: openItems(this.deps.files.readDocument(work.brandId, work.id, r.fileName).content),
    }));
    const asks = await this.listHandoffs(work.id);
    const askFiles = new Set(asks.map((a) => a.fileName));
    const untracked = (await this.listUntrackedFiles(work.id)).map((f) => f.fileName).filter((name) => !askFiles.has(name));
    const storedLocale = this.deps.repo.getMeta(`work_content_locale:${work.id}`);
    // Looked up without creating ./entregables/ on the way: drafting is a read.
    const resultExists = nodeFs.existsSync(nodePath.join(directory, DELIVERABLES_DIR)) && this.resultExists(work);
    const text = renderContinuation({
      locale: storedLocale === 'en-US' ? 'en-US' : 'es-AR',
      brandName: brand.name,
      workTitle: work.title,
      directory,
      ownFolder: work.folder !== null,
      source: { memberId: member.id, roleName: member.roleName, label: member.label, runtime: member.runtime, working: member.status === 'working' },
      brief: work.brief,
      outcome: { expectedOutput: work.expectedOutput ?? null, resultPath: work.resultPath ?? null, resultExists },
      decisions: this.deps.repo.listDecisions(work.id),
      documents,
      deliverables: this.existingDeliverables(directory),
      conversation: this.deps.hub.recentMessages(member.id),
      untracked,
      asks: asks.map((a) => ({ roleName: a.roleName, request: a.request })),
    });
    return { sourceMemberId: member.id, text };
  }

  /** Names in ./entregables/, without creating the folder just to look inside. */
  private existingDeliverables(directory: string): string[] {
    if (!nodeFs.existsSync(nodePath.join(directory, DELIVERABLES_DIR))) return [];
    try { return new DeliverableFiles(directory).list().files.map((f) => f.fileName); } catch { return []; }
  }

  /** Changes this conversation's model, resuming what was already said. */
  async setTeamMemberModel(memberId: string, model: string | null): Promise<MemberModelChange> {
    const member = this.deps.hub.getMember(requireId(memberId, 'memberId'));
    if (model !== null && (typeof model !== 'string' || model.trim().length > 200 || /[\s\\0]/.test(model.trim()))) throw new ValidationError('ID de modelo inválido');
    return this.deps.hub.setMemberModel(member.id, model, this.memberContext(member.workId));
  }

  /** Changes how hard this conversation works per answer, resuming what was already said. */
  async setTeamMemberTier(memberId: string, tier: EffortTier): Promise<MemberModelChange> {
    const member = this.deps.hub.getMember(requireId(memberId, 'memberId'));
    if (!isEffortTier(tier)) throw new ValidationError('Nivel de esfuerzo inválido');
    return this.deps.hub.setMemberTier(member.id, tier, this.memberContext(member.workId));
  }

  async removeTeamMember(memberId: string): Promise<void> {
    this.deps.hub.removeMember(requireId(memberId, 'memberId'));
  }

  /**
   * Everything a member's runtime needs to start inside the work directory.
   *
   * CLAUDE.md / AGENTS.md are shared by the whole team, so they are rewritten
   * only when no member of this work is running: a live session never sees its
   * context change underneath. This is a real guarantee about the managed
   * files, not about the work directory, which any process can still write.
   */
  /**
   * Public (not just internal) since sdd/autonomous-coordination task
   * 6.28+: bootstrap.ts needs it to build the SEPARATE `CoordinationEngine`
   * instance the coordination MCP server's `tools/call` path uses (kept
   * apart from this service's own private `this.coordination` to avoid a
   * hub<->engine<->service construction cycle -- both instances are
   * behaviourally identical, since `CoordinationEngine` holds no state of
   * its own beyond `deps`). Behaviour unchanged; visibility only.
   */
  memberContext(workId: string): MemberContext {
    const work = this.syncFromDisk(this.deps.repo.getWork(requireId(workId, 'workId')));
    const brand = this.deps.repo.getBrand(work.brandId);
    const refreshed = this.deps.hub.liveMemberCount(work.id) === 0;
    if (refreshed) this.refreshInstructions(brand, work);
    return {
      workId: work.id,
      brandId: brand.id,
      directory: this.deps.files.workDir(work.brandId, work.id),
      title: `${brand.name} · ${work.title}`,
      extraEnv: { ENGRAM_PROJECT: memoryProjectFor(brand.id) },
      trustedFolder: this.folderTrust(work.id),
      // Only to make up for shared files a live conversation keeps frozen.
      // Just rewritten, they already carry the outcome, and a copy in the
      // member's prompt would be paid again on every OpenCode turn.
      outcomeContext: refreshed ? null : this.outcomeForFrozenFiles(work),
    };
  }

  /**
   * What a conversation opening next to a live one must be told about the
   * expected output because the frozen shared files do not say it: the
   * current outcome when they show another one or none, a note when they
   * still show one the human removed, and nothing when they are current.
   * With no managed file left to read, the outcome itself, if there is one.
   */
  private outcomeForFrozenFiles(work: Work): string | null {
    const exists = this.resultExists(work);
    const dir = this.deps.files.workDir(work.brandId, work.id);
    const managed = [WORK_FILES.claude, WORK_FILES.agents]
      .map((name) => { try { return nodeFs.readFileSync(nodePath.join(dir, name), 'utf8'); } catch { return null; } })
      .filter((content): content is string => content !== null && isManagedFile(content));
    // Current only when there is a file to vouch for it: no readable managed
    // file (deleted, or the user's own) means the prompt is the only channel.
    if (managed.length > 0 && managed.every((content) => showsCurrentOutcome(content, work, exists))) return null;
    // With no file left to read, none can show an outcome the human removed.
    return renderOutcomeContext(work, exists, managed.length > 0);
  }

  /**
   * Reads the funnel block an agent left on a file and takes it out of the
   * file. Returns the stages it proposed, or none when there was no proposal —
   * in which case the file is not rewritten at all.
   */
  private consumeFunnelProposal(brandId: string, workId: string, fileName: string): FunnelStage[] {
    const proposal = readFunnelProposal(this.deps.files.readDocument(brandId, workId, fileName).content);
    if (proposal.stages.length === 0) return [];
    this.deps.files.writeDocument(brandId, workId, proposal.body, fileName);
    return proposal.stages;
  }

  /**
   * Reads the stored mode, understanding what older versions wrote: the grant
   * used to be a boolean, and `1` meant what `folder` means now.
   */
  private workPermissions(workId: string): WorkPermissionMode {
    const raw = this.deps.repo.getMeta(FOLDER_TRUST_KEY + workId);
    if (raw === 'auto') return 'auto';
    if (raw === 'folder' || raw === '1') return 'folder';
    return 'ask';
  }

  private folderTrust(workId: string): boolean {
    return this.workPermissions(workId) !== 'ask';
  }

  /**
   * Whether this work's team may read and write inside its own folder without
   * asking every time. Off by default: the human grants it, per work, and it
   * covers that folder only. Everything else keeps asking.
   */
  async getWorkPermissions(workId: string): Promise<WorkPermissionMode> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    return this.workPermissions(id);
  }

  /**
   * Grants are per work and never global: the folder you opened is the only
   * thing they cover. `auto` takes effect on the next request; `folder` is a
   * start-time flag of the runtime, so the UI reopens the conversations.
   */
  async setWorkPermissions(workId: string, mode: WorkPermissionMode): Promise<WorkPermissionMode> {
    const id = requireId(workId, 'workId');
    this.deps.repo.getWork(id);
    if (mode !== 'ask' && mode !== 'folder' && mode !== 'auto') throw new ValidationError('Modo de permisos inválido');
    this.deps.repo.setMeta(FOLDER_TRUST_KEY + id, mode);
    return mode;
  }

  /** Used by the event path to decide whether Latte answers a request itself. */
  autoApprovesChat(chatId: string): boolean {
    const member = this.deps.repo.findMember(chatId);
    return member ? this.workPermissions(member.workId) === 'auto' : false;
  }

  async listChatMessages(chatId: string): Promise<ChatMessage[]> {
    return this.deps.hub.listMessages(requireId(chatId, 'chatId'));
  }

  async sendChat(chatId: string, text: string): Promise<void> {
    const clean = requireText(text, 'Message', LIMITS.chatMessage).trim();
    await this.deps.hub.send(requireId(chatId, 'chatId'), clean);
  }

  async abortChat(chatId: string): Promise<void> {
    await this.deps.hub.abort(requireId(chatId, 'chatId'));
  }

  async stopChat(chatId: string): Promise<void> {
    this.deps.hub.stop(requireId(chatId, 'chatId'));
  }

  async replyPermission(chatId: string, requestId: string, reply: PermissionReply): Promise<void> {
    if (reply !== 'once' && reply !== 'always' && reply !== 'reject') throw new TypeError('Invalid permission reply');
    await this.deps.hub.replyPermission(requireId(chatId, 'chatId'), requireRequestId(requestId), reply);
  }

  // Primary agent + subscription runtimes ---------------------------------------

  async getPrimaryAgent(): Promise<PrimaryAgent | null> {
    return this.deps.hub.getPrimary();
  }

  async setPrimaryAgent(choice: { runtime: ChatRuntime; model: string | null; accountId: string | null }): Promise<PrimaryAgent> {
    if (typeof choice !== 'object' || choice === null) throw new TypeError('Invalid choice');
    if (!isChatRuntime(choice.runtime)) throw new TypeError('Unknown runtime');
    const model = choice.model === null || choice.model === undefined ? null : choice.model;
    if (model !== null && (typeof model !== 'string' || model.length === 0 || model.length > 200 || /[\s\0]/.test(model))) throw new TypeError('Invalid model id');
    const accountId = choice.accountId === null || choice.accountId === undefined ? null : choice.accountId;
    if (accountId !== null && !AccountStore.isValidId(accountId)) throw new TypeError('Invalid account id');
    return this.deps.hub.setPrimary({ runtime: choice.runtime, model, accountId });
  }

  async listAgentRuntimes(): Promise<AgentRuntimeInfo[]> {
    return this.deps.hub.listAgentRuntimes();
  }

  // MCP: shown and operated through each runtime's own CLI ---------------------

  /**
   * Without a runtime, all three. With one, only that one, so the screen can
   * fill in as each answers: Claude Code health-checks every server and takes
   * far longer than the other two, and waiting for it hid their results.
   */
  async listMcpServers(runtime: ChatRuntime | null = null): Promise<McpRuntimeTools[]> {
    if (!this.deps.mcp) return [];
    if (runtime === null) return this.deps.mcp.list();
    if (runtime !== 'claude' && runtime !== 'codex' && runtime !== 'opencode') throw new TypeError('Unknown runtime');
    return [await this.deps.mcp.listOne(runtime)];
  }

  async addMcpServer(runtime: 'claude' | 'codex', input: McpServerInput): Promise<void> {
    if (!isAccountRuntime(runtime)) throw new TypeError('Unknown runtime');
    if (!this.deps.mcp) throw new UnavailableError('MCP requiere la aplicación de escritorio');
    if (typeof input !== 'object' || input === null) throw new TypeError('Invalid input');
    const transport = input.transport === 'http' ? 'http' : 'stdio';
    const name = requireLabel(input.name, 'Server name', 64);
    const command = transport === 'stdio' ? requireLabel(input.command, 'Command', 400) : '';
    const url = transport === 'http' ? requireLabel(input.url, 'URL', 500) : '';
    if (transport === 'http' && !/^https?:\/\//.test(url)) throw new TypeError('La URL tiene que empezar con http:// o https://');
    const args = Array.isArray(input.args) ? input.args.slice(0, 30).map((a) => requireText(String(a), 'Argument', 300)) : [];
    const envPairs = Array.isArray(input.env) ? input.env.slice(0, 20).map((a) => requireText(String(a), 'Variable', 400)) : [];
    await this.deps.mcp.add(runtime, { name, transport, command, args, url, env: envPairs });
  }

  async removeMcpServer(runtime: 'claude' | 'codex', name: string): Promise<void> {
    if (!isAccountRuntime(runtime)) throw new TypeError('Unknown runtime');
    if (!this.deps.mcp) throw new UnavailableError('MCP requiere la aplicación de escritorio');
    await this.deps.mcp.remove(runtime, requireLabel(name, 'Server name', 64));
  }

  async loginMcpServer(runtime: 'codex', name: string): Promise<AccountLoginStart> {
    if (runtime !== 'codex') throw new TypeError('Unknown runtime');
    if (!this.deps.mcp) throw new UnavailableError('MCP requiere la aplicación de escritorio');
    const start = await this.deps.mcp.loginCodex(requireLabel(name, 'Server name', 64));
    if (start.mode === 'browser' && /^https?:\/\//.test(start.url)) await this.deps.openExternal?.(start.url);
    return start;
  }

  async authenticateClaudeMcp(workId: string, accountId: string | null): Promise<AccountLoginStart> {
    if (!this.deps.mcp) throw new UnavailableError('MCP requiere la aplicación de escritorio');
    const work = this.deps.repo.getWork(requireId(workId, 'workId'));
    if (accountId !== null && !AccountStore.isValidId(accountId)) throw new TypeError('Invalid account id');
    return this.deps.mcp.authenticateClaude(this.deps.files.workDir(work.brandId, work.id), accountId);
  }

  async addAgentAccount(runtime: 'claude' | 'codex', label: string): Promise<AgentAccount> {
    if (!isAccountRuntime(runtime)) throw new TypeError('Unknown runtime');
    return this.deps.hub.addAccount(runtime, requireLabel(label, 'Account label', 80));
  }

  async removeAgentAccount(runtime: 'claude' | 'codex', accountId: string): Promise<void> {
    if (!isAccountRuntime(runtime)) throw new TypeError('Unknown runtime');
    if (!AccountStore.isValidId(accountId)) throw new TypeError('Invalid account id');
    this.deps.hub.removeAccount(runtime, accountId);
  }

  async startAccountLogin(runtime: 'claude' | 'codex', accountId: string): Promise<AccountLoginStart> {
    if (!isAccountRuntime(runtime)) throw new TypeError('Unknown runtime');
    if (!AccountStore.isValidId(accountId)) throw new TypeError('Invalid account id');
    const start = await this.deps.hub.startLogin(runtime, accountId);
    if (start.mode === 'browser' && /^https?:\/\//.test(start.url)) await this.deps.openExternal?.(start.url);
    return start;
  }

  async logoutAccount(runtime: 'claude' | 'codex', accountId: string): Promise<void> {
    if (!isAccountRuntime(runtime)) throw new TypeError('Unknown runtime');
    if (!AccountStore.isValidId(accountId)) throw new TypeError('Invalid account id');
    await this.deps.hub.logout(runtime, accountId);
  }

  async listAccountModels(runtime: 'claude' | 'codex', accountId: string): Promise<AgentModelList> {
    if (!isAccountRuntime(runtime)) throw new TypeError('Unknown runtime');
    if (!AccountStore.isValidId(accountId)) throw new TypeError('Invalid account id');
    return this.deps.hub.listAccountModels(runtime, accountId);
  }

  async replyQuestion(chatId: string, requestId: string, answers: string[][] | null): Promise<void> {
    if (answers !== null) {
      if (!Array.isArray(answers) || answers.length > 20) throw new TypeError('Invalid answers');
      for (const answer of answers) {
        if (!Array.isArray(answer) || answer.length > 20 || answer.some((a) => typeof a !== 'string' || a.length > 2_000)) throw new TypeError('Invalid answers');
      }
    }
    await this.deps.hub.replyQuestion(requireId(chatId, 'chatId'), requireRequestId(requestId), answers);
  }

  // Providers (runtime credential store; Latte never persists secrets) --------

  async listProviders(): Promise<ProviderInfo[]> {
    return this.deps.chat.listProviders();
  }

  async connectProviderKey(providerId: string, key: string): Promise<void> {
    const id = requireProviderId(providerId);
    if (typeof key !== 'string') throw new TypeError('API key must be a string');
    const clean = key.trim();
    if (clean.length === 0 || clean.length > 4_096 || /[\r\n\0]/.test(clean)) throw new TypeError('API key looks invalid');
    await this.deps.chat.connectApiKey(id, clean);
  }

  async disconnectProvider(providerId: string): Promise<void> {
    await this.deps.chat.disconnectProvider(requireProviderId(providerId));
  }

  async startProviderOAuth(providerId: string, methodIndex: number, inputs: Record<string, string>): Promise<ProviderOAuthStart> {
    const id = requireProviderId(providerId);
    const method = requireInt(methodIndex, 'methodIndex', 0, 20);
    const cleanInputs: Record<string, string> = {};
    if (inputs !== undefined && inputs !== null) {
      if (typeof inputs !== 'object' || Array.isArray(inputs)) throw new TypeError('Invalid inputs');
      for (const [k, v] of Object.entries(inputs)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(k) || typeof v !== 'string' || v.length > 2_048) throw new TypeError('Invalid inputs');
        cleanInputs[k] = v;
      }
    }
    const started = await this.deps.chat.startOAuth(id, method, cleanInputs);
    if (/^https?:\/\//.test(started.url)) await this.deps.openExternal?.(started.url);
    return started;
  }

  async completeProviderOAuth(providerId: string, methodIndex: number, code: string | null): Promise<void> {
    const id = requireProviderId(providerId);
    const method = requireInt(methodIndex, 'methodIndex', 0, 20);
    if (code !== null && (typeof code !== 'string' || code.length === 0 || code.length > 2_048 || /[\r\n\0]/.test(code))) throw new TypeError('Invalid code');
    await this.deps.chat.completeOAuth(id, method, code === null ? null : code.trim());
  }

  // Memory ------------------------------------------------------------------

  async readMemory(brandId: string): Promise<MemoryResult> {
    const brand = this.deps.repo.getBrand(requireId(brandId, 'brandId'));
    return this.deps.engram.read(memoryProjectFor(brand.id));
  }

  async saveMemory(brandId: string, text: string): Promise<MemoryResult> {
    const clean = requireText(text, 'Memory', LIMITS.memory).trim();
    const brand = this.deps.repo.getBrand(requireId(brandId, 'brandId'));
    const firstLine = clean.split(/\r?\n/)[0].slice(0, 80);
    const title = `${brand.name}: ${firstLine}`;
    return this.deps.engram.save(memoryProjectFor(brand.id), title, clean);
  }

  // Export ------------------------------------------------------------------

  async exportWork(workId: string): Promise<string | null> {
    // Exports exactly what the user sees. An intentionally blank document
    // exports as blank; we never substitute older content.
    const work = this.syncFromDisk(this.deps.repo.getWork(requireId(workId, 'workId')));
    const content = work.brief;
    const target = await this.deps.chooseExportPath(`${slugify(work.title, 'deliverable')}.md`);
    if (!target) return null;
    writeFileAtomic(target, content);
    return target;
  }

  // Lifecycle ---------------------------------------------------------------

  shutdown(): void {
    // Antes de soltar los procesos: lo que quedó en vuelo se liquida acá, o
    // no se liquida nunca. Un fallo barriendo no puede impedir que la app
    // cierre sus recursos, así que se registra y se sigue.
    try {
      this.coordination.sweepUncertainDispatches();
    } catch { /* cerrar los recursos manda: el barrido de arranque lo vuelve a intentar */ }
    this.deps.hub.shutdown();
    this.deps.terminal.stopAll();
    this.deps.repo.close();
  }

  /**
   * El barrido de arranque, hermano del de `sweepStrayCodexServers`: reconcilia
   * los despachos que una caída o un cierre forzado dejó en vuelo. Lo llama
   * `createBackend` una sola vez, apenas la base está migrada.
   */
  sweepUncertainCoordinationDispatches(): number {
    const swept = this.coordination.sweepUncertainDispatches();
    // Y en el mismo arranque, la reparación del estado final: las bases que
    // dejó la versión sin `done` tienen runs `running` con todas sus tareas
    // terminales, ocupando un cupo app-wide para siempre. Va DESPUÉS del
    // barrido: éste puede devolver tareas a `ready`, y ésas no cierran nada.
    this.coordination.sweepFinishedRuns();
    return swept;
  }

  /**
   * La liquidación EN CALIENTE: el proceso de un miembro se murió y su despacho
   * en vuelo no lo va a reportar nadie nunca. Lo llama el único chokepoint por
   * el que pasa un `closed` de cualquier adaptador (`createBackend`), justo
   * después de `hub.stop`, que es donde el reclamo de inyección ya se soltó.
   * Nunca tira: la muerte de un proceso no puede tumbar el loop de eventos.
   */
  settleCoordinationDispatchesForMember(memberId: string, options: { incrementAttempts?: boolean } = {}): number {
    try {
      return this.coordination.settleMemberDispatches(memberId, options);
    } catch {
      return 0;
    }
  }

  /**
   * El turno de un miembro terminó. Si ese miembro es el coordinador y el
   * cierre del run había quedado esperándolo (D17), se re-evalúa ahora. Para
   * cualquier otro miembro es un no-op barato: `noteTurnEnded` mira primero si
   * había algo pendiente.
   */
  noteCoordinationTurnEnded(memberId: string): void {
    try {
      this.coordination.noteTurnEnded(memberId);
    } catch { /* el fin de un turno nunca puede voltear el evento de chat */ }
  }

  // Internals ---------------------------------------------------------------

  /**
   * deliverable.md wins over the database copy. If an agent (or the human, in
   * an editor) changed the file, the database is updated before anyone reads.
   */
  private describeDocument(record: DocumentRecord): WorkDocument {
    return {
      id: record.id,
      workId: record.workId,
      kind: (DOCUMENT_KINDS as string[]).includes(record.kind) ? (record.kind as DocumentKind) : 'note',
      title: record.title,
      fileName: record.fileName,
      status: (DOCUMENT_STATUSES as string[]).includes(record.status) ? (record.status as DocumentStatus) : 'draft',
      funnelStages: record.funnelStages,
      proposedFunnelStages: record.proposedFunnelStages,
      baseDocumentId: record.baseDocumentId,
      baseRevisionId: record.baseRevisionId,
      baseFingerprint: record.baseFingerprint,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private contentFrom(record: DocumentRecord, disk: DocumentOnDisk): DocumentContent {
    return { document: this.describeDocument(record), content: disk.content, fingerprint: disk.fingerprint, modifiedAt: disk.modifiedAt, baseOutdated: this.isBaseOutdated(record) };
  }

  private loadDocument(documentId: string): DocumentContent {
    const record = this.deps.repo.getDocument(documentId);
    const work = this.deps.repo.getWork(record.workId);
    const disk = this.syncDocumentFromDisk(work, record);
    return this.contentFrom(this.deps.repo.getDocument(documentId), disk);
  }

  /**
   * The file is the authority. Reading refreshes what Latte mirrors in the
   * database (the brief column, for the brief document) but never rewrites the
   * file, so an external edit survives a read.
   */
  private syncDocumentFromDisk(work: Work, record: DocumentRecord): DocumentOnDisk {
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    if (!this.deps.files.documentExists(work.brandId, work.id, record.fileName)) {
      // A tracked file someone deleted outside Latte: recreate it empty rather than lying about its content.
      this.deps.files.writeDocument(work.brandId, work.id, '', record.fileName);
    }
    const disk = this.deps.files.readDocument(work.brandId, work.id, record.fileName);
    if (record.fileName === WORK_FILES.brief && disk.content !== work.brief) {
      const updatedAt = disk.modifiedAt && disk.modifiedAt > work.updatedAt ? disk.modifiedAt : this.clock();
      this.deps.repo.updateBrief(work.id, disk.content, updatedAt);
    }
    return disk;
  }

  private storeRevision(work: Work, record: DocumentRecord, content: string, source: RevisionSource): Revision {
    const revision: Revision = { id: newId('rev'), workId: work.id, documentId: record.id, source, content, createdAt: this.clock() };
    return this.deps.repo.transaction(() => {
      this.deps.repo.insertRevision(revision);
      this.deps.files.writeSnapshot(work.brandId, work.id, revision.id, revision.createdAt, revision.content);
      this.deps.repo.touchWork(work.id, revision.createdAt);
      return revision;
    });
  }

  /**
   * Pins the current content of a base document as an immutable revision, so a
   * derived document can point at an exact version instead of a moving file.
   */
  private pinBaseVersion(base: DocumentRecord): { revisionId: string; fingerprint: string } {
    const work = this.deps.repo.getWork(base.workId);
    const disk = this.syncDocumentFromDisk(work, base);
    const existing = this.deps.repo.listDocumentRevisions(base.workId, base.id).find((r) => fingerprintOf(r.content) === disk.fingerprint);
    const revision = existing ?? this.storeRevision(work, base, disk.content, 'latte');
    return { revisionId: revision.id, fingerprint: disk.fingerprint };
  }

  /** True when the base document's file no longer matches the version this one declared. */
  private isBaseOutdated(record: DocumentRecord): boolean {
    if (!record.baseDocumentId || !record.baseFingerprint) return false;
    const base = this.deps.repo.findDocument(record.baseDocumentId);
    if (!base) return false;
    const work = this.deps.repo.getWork(base.workId);
    return this.deps.files.readDocument(work.brandId, work.id, base.fileName).fingerprint !== record.baseFingerprint;
  }

  private syncFromDisk(work: Work): Work {
    this.deps.files.ensureWork(work.brandId, work.id, work.brief);
    const onDisk = this.deps.files.readDocument(work.brandId, work.id);
    if (onDisk.modifiedAt === null || onDisk.content === work.brief) return work;
    const updatedAt = onDisk.modifiedAt > work.updatedAt ? onDisk.modifiedAt : this.clock();
    return this.deps.repo.updateBrief(work.id, onDisk.content, updatedAt);
  }

  /** Read at render time, never stored: a linked result that vanished is a fact about the folder. */
  private resultExists(work: Work): boolean {
    if (!work.resultPath) return false;
    try {
      new DeliverableFiles(this.deps.files.workDir(work.brandId, work.id)).resolve(work.resultPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lo ultimo que el archivo de instrucciones de este Trabajo AFIRMO sobre las
   * herramientas de engram. Es lo que deja a `refreshInstructionsAfterInjection`
   * reescribir solo cuando la respuesta CAMBIO, en vez de pisar los archivos
   * compartidos en cada apertura (juicio #2, ronda 4).
   */
  private readonly memoryClaimWritten = new Map<string, boolean>();

  private recordMemoryClaim(workId: string): boolean {
    const claim = this.deps.injection?.memoryToolsInjectedForWork(workId) ?? false;
    this.memoryClaimWritten.set(workId, claim);
    return claim;
  }

  private refreshInstructions(brand: Brand, work: Work): void {
    this.renderAndWriteInstructions(brand, work);
  }

  /**
   * Renders and writes ONE work's instruction files, returning what the write
   * did. The brand-context nudge is computed here, brand-scoped: only the
   * elected work of an empty brand may draft it, and the others get a reason.
   */
  private renderAndWriteInstructions(brand: Brand, work: Work) {
    // `memoryToolsInjected` (task 6.27) sale del planificador real, no de un
    // `undefined`: esa bandera decide si el archivo lleva la frase que sostiene
    // el aislamiento entre Marcas ("nunca pases un argumento `project`: uno
    // explícito pisa el default fijado y podría leer o escribir la memoria de
    // otra Marca"). Sin pasarla, esa frase no llegaba a NINGÚN agente.
    const decisions = this.deps.repo.listDecisions(work.id);
    const records = this.deps.repo.listDocuments(work.id);
    const byId = new Map(records.map((r) => [r.id, r]));
    const documents = records.map((r) => ({
      kind: r.kind,
      title: r.title,
      fileName: r.fileName,
      status: r.status,
      funnelStages: r.funnelStages,
      baseFileName: r.baseDocumentId ? byId.get(r.baseDocumentId)?.fileName ?? null : null,
    }));
    this.deps.files.ensureWork(brand.id, work.id, work.brief);
    const storedLocale = this.deps.repo.getMeta(`work_content_locale:${work.id}`);
    const outputLanguage = storedLocale === 'en-US' ? 'en-US' : 'es-AR';
    const decisionAuthority=this.readDecisionAuthority(work.id);
    const generation = this.generationEnabled() ? this.pinnedGenerationPointer(work.id) : null;
    const brandMemory = this.loadBrandMemory(brand, work);
    const nudge = brandContextNudge({
      context: brand.context,
      hasPendingProposal: this.deps.repo.findPendingBrandContext(brand.id) !== null,
      // Inherited KNOWLEDGE, not "another work exists": a brand whose siblings
      // left nothing durable still needs its elected work to draft the context.
      hasInheritedMemory: hasInheritedContent(brandMemory),
      workId: work.id,
      ownerWorkId: electBrandContextOwner(this.deps.repo.listWorks(brand.id)),
    });
    const bundle = renderInstructionBundle({ brand, work, resultExists: this.resultExists(work), decisions, documents, outputLanguage, decisionAuthority, pack: this.deps.pack ?? null, memoryProject: memoryProjectFor(brand.id), memoryToolsInjected: this.recordMemoryClaim(work.id), skills: this.enabledSkills(), team: this.deps.hub.listTeam(work.id).map((m) => ({ roleId: m.roleId, roleName: m.roleName, status: m.status })), available: this.deps.hub.listRoles().map((r) => ({ id: r.id, name: r.name, summary: r.summary })), generation, brandMemory, brandContextNudge: nudge });
    return this.deps.files.writeInstructions(brand.id, work.id, bundle.text, bundle.files);
  }

  /**
   * Makes a brand-context write reach every work of the brand.
   *
   * Sequential and human-triggered, never a background job. A work with a live
   * agent session is skipped and reported: the shared files must not change
   * under a conversation that is reading them, and that truth must be visible,
   * never silent. Called AFTER the database transaction committed — files
   * cannot be rolled back, so the loop is idempotent and re-runnable.
   */
  refreshBrandWorksInstructions(brand: Brand): BrandContextRefreshReport {
    const report = emptyRefreshReport();
    for (const work of this.deps.repo.listWorks(brand.id)) {
      if (this.deps.hub.liveMemberCount(work.id) > 0) {
        report.live.push(work.id);
        continue;
      }
      const result = this.renderAndWriteInstructions(brand, work);
      if (result.skipped.length > 0) report.userOwned.push(work.id);
      else if (result.written.length === 0 && !result.sideFilesChanged) report.unchanged.push(work.id);
      else report.updated.push(work.id);
    }
    return report;
  }

  /**
   * Local-db snapshot of other works of this brand. Never Engram, never another
   * brand. Called from refreshInstructions so every new/opened agent gets it.
   */
  private loadBrandMemory(brand: Brand, work: Work): BrandMemorySnapshot {
    const sources = this.deps.repo.listWorks(brand.id)
      .filter((other) => other.id !== work.id)
      .map((other) => ({
        work: other,
        decisions: this.deps.repo.listDecisions(other.id),
        documents: this.deps.repo.listDocuments(other.id).map((doc) => ({
          kind: doc.kind,
          title: doc.title,
          fileName: doc.fileName,
          status: doc.status,
          funnelStages: doc.funnelStages,
          content: this.deps.files.readDocument(brand.id, other.id, doc.fileName).content,
        })),
      }));
    return collectBrandMemory({ brand, currentWorkId: work.id, sources });
  }

  /** Latest receipt for this work. Not called when the feature flag is off. */
  private pinnedGenerationPointer(workId: string): { generationId: string; contextHash: string; kitHash: string | null; skillRefs: SkillRef[] } | null {
    const latest = this.deps.repo.listGenerationsForWork(workId)[0];
    if (!latest) return null;
    return {
      generationId: latest.id,
      contextHash: latest.contextHash,
      kitHash: latest.context.brandContext?.hash ?? null,
      skillRefs: latest.context.skillRefs,
    };
  }
}

function toSkillCandidate(row: SkillCandidateRecord, duplicateSpend: boolean): SkillCandidate {
  return {
    id: row.id,
    skillId: row.skillId,
    scopeKey: row.scopeKey,
    state: row.state,
    revision: row.revision,
    contentHash: row.contentHash,
    name: row.name,
    description: row.description,
    markdown: row.markdown,
    patternKey: row.patternKey,
    createdAt: row.createdAt,
    duplicateSpend,
  };
}
