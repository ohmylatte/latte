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
  BrandContextMode,
  BrandContextProposal,
  BrandContextProposalInput,
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
} from '../../shared/contracts';
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
import { briefDocumentId, type DocumentRecord, type LatteRepository } from '../storage/repository';
import { collectBrandMemory, type BrandMemorySnapshot } from '../workspace/brandMemory';
import { INSTRUCTIONS_MAX_CHARS, isManagedFile, renderInstructionBundle, renderOutcomeContext, showsCurrentOutcome, type InstructionPack, type PackSkill } from '../workspace/instructions';
import { checkFolder, contains, importFileName, kindFromFileName, readFunnelProposal, readHandoff, scanFolder, titleFromFileName } from '../workspace/linkFolder';
import { renderDocumentTemplate } from '../workspace/templates';
import { openItems, renderContinuation } from '../workspace/continuation';
import { DELIVERABLES_DIR, DeliverableFiles, deliverableName } from '../workspace/deliverables';
import { documentFileName, fingerprintOf, type DocumentOnDisk, type WorkspaceFiles } from '../workspace/workspace';
import { BRAND_CONTEXT_DRAFT_PROMPT_EN, BRAND_CONTEXT_DRAFT_PROMPT_ES, brandContextFingerprint } from '../workspace/brandContextProtocol';
import { BRAND_CONTEXT_INPUT_KEY_SET, composeBrandContext } from '../../shared/brandContext';
import { LIMITS, assertNoControlChars, requireId, requireInt, requireLabel, requireRequestId, requireText } from './validation';
import { BrandingService } from '../branding/service';

/** Stable content identity; request identity handles retries, this flags similar proposals without merging them. */
export function decisionFingerprint(statement:string):string {
  return createHash('sha256').update(statement.normalize('NFC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('und'),'utf8').digest('hex').slice(0,24);
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

  constructor(private readonly deps: LatteServiceDeps) {
    this.clock = deps.clock ?? nowIso;
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

  async createBrand(name: string): Promise<Brand> {
    const cleanName = requireLabel(name, 'Brand name', LIMITS.name);
    const brand: Brand = { id: newId('brd'), name: cleanName, context: '', createdAt: this.clock(), archivedAt: null };
    this.deps.repo.insertBrand(brand);
    this.deps.files.ensureBrand(brand.id);
    return brand;
  }

  async updateBrand(id: string, context: string): Promise<Brand> {
    const brandId = requireId(id, 'brandId');
    const cleanContext = requireText(context, 'Brand context', LIMITS.context, { allowEmpty: true });
    return this.deps.repo.updateBrandContext(brandId, cleanContext);
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
    const work: Work = { id: newId('wrk'), brandId: id, title: cleanTitle, brief: initialDocument, folder: null, updatedAt: this.clock() };
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
    const content = renderDocumentTemplate(kind, cleanTitle, work.title, base ? base.title : null);
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
    this.deps.repo.getBrand(requireId(brandId, 'brandId'));
    return this.deps.repo.listBrandContextProposals(brandId);
  }

  async proposeBrandContextFromAgent(chatId: string, messageId: string, input: unknown): Promise<BrandContextProposal | null> {
    const member = this.deps.repo.findMember(requireId(chatId, 'chatId'));
    if (!member) throw new ValidationError('Unknown brand context source');
    const work = this.deps.repo.getWork(member.workId);
    const brand = this.requireActiveBrand(work.brandId);
    const authority = this.readDecisionAuthority(member.workId);
    if (authority === 'off') return null;
    const parsed = requireBrandContextInput(input);
    const existing = this.deps.repo.findBrandContextRequest(brand.id, parsed.clientRequestId);
    if (existing) return existing;
    const fingerprint = brandContextFingerprint(parsed.text);
    const pending = this.deps.repo.findPendingBrandContext(brand.id);
    if (pending && pending.fingerprint === fingerprint) return pending;
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
      clientRequestId: parsed.clientRequestId,
      createdAt: now,
      decidedAt: authority === 'auto-record' ? now : null,
    };
    const stored = this.deps.repo.transaction(() => {
      if (pending) this.deps.repo.rejectPendingBrandContext(brand.id, now);
      this.deps.repo.insertBrandContextProposal(proposal);
      if (proposal.status === 'approved') this.applyApprovedContext(brand, proposal.text, proposal.mode);
      return proposal;
    });
    if (stored.status === 'approved') this.refreshBrandWorks(this.deps.repo.getBrand(brand.id));
    return stored;
  }

  async approveBrandContextProposal(id: string, edited: string | null): Promise<BrandContextProposal> {
    const proposalId = requireId(id, 'proposalId');
    const before = this.deps.repo.getBrandContextProposal(proposalId);
    const brand = this.requireActiveBrand(before.brandId);
    if (before.status === 'approved') return before;
    if (before.status !== 'pending') throw new LatteError('PROPOSAL_DECIDED', `Brand context proposal already ${before.status}: ${proposalId}`);
    const clean = edited == null ? null : this.requireBrandContextText(edited);
    const updated = this.deps.repo.transaction(() => {
      const next = this.deps.repo.transitionBrandContextProposal(proposalId, 'approved', clean, this.clock());
      this.applyApprovedContext(brand, next.text, next.mode);
      return this.deps.repo.getBrandContextProposal(proposalId);
    });
    this.refreshBrandWorks(this.deps.repo.getBrand(brand.id));
    return updated;
  }

  async rejectBrandContextProposal(id: string): Promise<BrandContextProposal> {
    const proposalId = requireId(id, 'proposalId');
    const before = this.deps.repo.getBrandContextProposal(proposalId);
    this.requireActiveBrand(before.brandId);
    if (before.status === 'rejected') return before;
    if (before.status !== 'pending') throw new LatteError('PROPOSAL_DECIDED', `Brand context proposal already ${before.status}: ${proposalId}`);
    return this.deps.repo.transitionBrandContextProposal(proposalId, 'rejected', null, this.clock());
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

  private requireBrandContextText(value: string): string {
    const clean = requireText(value, 'Brand context', LIMITS.context).normalize('NFC');
    assertNoControlChars(clean, 'Brand context');
    return clean;
  }

  private applyApprovedContext(brand: Brand, incoming: string, mode: BrandContextMode): Brand {
    const next = composeBrandContext(brand.context, incoming, mode);
    const clean = requireText(next, 'Brand context', LIMITS.context, { allowEmpty: true });
    assertNoControlChars(clean, 'Brand context');
    return this.deps.repo.updateBrandContext(brand.id, clean);
  }

  private readDecisionAuthority(workId: string): DecisionAuthorityMode {
    const raw = this.deps.repo.getMeta('decision_authority:' + workId);
    return raw === 'off' || raw === 'auto-record' ? raw : 'suggest';
  }

  private refreshBrandWorks(brand: Brand): void {
    for (const work of this.deps.repo.listWorks(brand.id)) {
      if (this.deps.hub.liveMemberCount(work.id) === 0) this.refreshInstructions(brand, work);
    }
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
  private memberContext(workId: string): MemberContext {
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
    this.deps.hub.shutdown();
    this.deps.terminal.stopAll();
    this.deps.repo.close();
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

  private refreshInstructions(brand: Brand, work: Work): void {
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
    const bundle = renderInstructionBundle({ brand, work, resultExists: this.resultExists(work), decisions, documents, outputLanguage, decisionAuthority, pack: this.deps.pack ?? null, memoryProject: memoryProjectFor(brand.id), skills: this.enabledSkills(), team: this.deps.hub.listTeam(work.id).map((m) => ({ roleId: m.roleId, roleName: m.roleName, status: m.status })), available: this.deps.hub.listRoles().map((r) => ({ id: r.id, name: r.name, summary: r.summary })), generation, brandMemory });
    this.deps.files.writeInstructions(brand.id, work.id, bundle.text, bundle.files);
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

function requireBrandContextInput(input: unknown): BrandContextProposalInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Invalid brand context proposal');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !BRAND_CONTEXT_INPUT_KEY_SET.has(key))) throw new ValidationError('Unknown brand context proposal field');
  const text = requireText(record.text, 'Brand context', LIMITS.context).normalize('NFC');
  assertNoControlChars(text, 'Brand context');
  const rationale = requireText(record.rationale, 'Rationale', LIMITS.context, { allowEmpty: true }).normalize('NFC');
  assertNoControlChars(rationale, 'Rationale');
  if (record.mode !== 'replace' && record.mode !== 'append') throw new ValidationError('Invalid brand context mode');
  return { text, rationale, mode: record.mode, clientRequestId: requireRequestId(record.clientRequestId) };
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
