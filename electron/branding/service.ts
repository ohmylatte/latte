import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LatteError, UnavailableError, ValidationError } from '../core/errors';
import { isValidId } from '../core/ids';
import { LattePaths, safeJoin } from '../core/paths';
import { requireText } from '../services/validation';
import type { LatteRepository } from '../storage/repository';
import type { WorkspaceFiles } from '../workspace/workspace';
import {
  parseManifest,
  requireAgencyPatch,
  requireChoice,
  requireExpectedRevision,
  requireExpectedVersion,
  requireWorkId,
  rulesLookUntrusted,
  type BrandManifest,
} from './payload';
import { copyVerified, publishImmutableDir, stageAssets, type StagedAsset } from './publish';
import { canonicalJson, composeBrandContext, kitsForAuthorizedWork, resolveBrandContext, sha256Utf8 } from './resolver';
import {
  FEATURE_BRAND_KITS,
  implicitWorkBrandPolicy,
  type BrandAccess,
  type BrandContextSnapshot,
  type Choice,
  type Kit,
  type Signature,
  type WorkBrandPolicy,
} from './types';

const KIT_ID_FILE = '.latte-kit-id';
const MAX_RULES = 60_000;

export type AgencyProfileView = {
  revision: number;
  hash: string;
  publicName: string;
  website: string | null;
  contact: string | null;
};

export type BrandKitDraftView = {
  kitId: string;
  ownerKind: 'brand' | 'agency';
  ownerBrandId: string | null;
  permitsAgencySignature: boolean;
  assetCount: number;
  warnings: string[];
};

export type BrandKitView = {
  kitId: string;
  version: number;
  hash: string;
  ownerKind: 'brand' | 'agency';
};

export type WorkBrandPolicyView = WorkBrandPolicy;

export type WorkBrandContextView = {
  receipt: ReturnType<typeof composeBrandContext>['receipt'];
  snapshot: BrandContextSnapshot;
  pinnedDir: string | null;
};

export interface BrandingServiceDeps {
  repo: LatteRepository;
  files: WorkspaceFiles;
  chooseFolder?: (title: string) => Promise<string | null>;
  clock: () => string;
}

export class BrandingService {
  private readonly paths: LattePaths;

  constructor(private readonly deps: BrandingServiceDeps) {
    this.paths = new LattePaths(deps.files.root);
  }

  private branding() {
    return this.deps.repo.branding;
  }

  private requireEnabled(): void {
    if (this.deps.repo.getMeta(FEATURE_BRAND_KITS) !== 'on') {
      throw new LatteError('FEATURE_DISABLED', 'Los kits de marca están desactivados en esta instalación');
    }
  }

  private access(): BrandAccess {
    const repo = this.deps.repo;
    const branding = this.branding();
    return {
      requireWork: (workId) => {
        const work = repo.getWork(workId);
        return { id: work.id, brandId: work.brandId };
      },
      policyForWork: (workId) => {
        const work = repo.getWork(workId);
        return branding.policyForWork(work.id, work.brandId);
      },
      approvedKitForBrand: (brandId) => branding.approvedKitForBrand(brandId),
      approvedAgencyKit: () => branding.approvedAgencyKit(),
      agencySignature: () => this.agencySignature(),
    };
  }

  private agencySignature(): Signature | null {
    const fromProfile = this.branding().agencySignatureFromProfile();
    if (!fromProfile) return null;
    const agencyKit = this.branding().approvedAgencyKit();
    const logoAsset = agencyKit?.assets.find((a) => a.usable && a.id.toLowerCase().includes('logo')) ?? null;
    return { ...fromProfile, logo: logoAsset };
  }

  async readAgencyProfile(): Promise<AgencyProfileView | null> {
    this.requireEnabled();
    const row = this.branding().currentAgencyProfile();
    if (!row) return null;
    const parsed = JSON.parse(row.publicJson) as { publicName: string; website: string | null; contact: string | null };
    return {
      revision: row.revision,
      hash: row.hash,
      publicName: parsed.publicName,
      website: parsed.website ?? null,
      contact: parsed.contact ?? null,
    };
  }

  async saveAgencyProfile(expectedRevision: unknown, patch: unknown): Promise<AgencyProfileView> {
    this.requireEnabled();
    const expected = requireExpectedRevision(expectedRevision);
    const publicFields = requireAgencyPatch(patch);
    const publicJson = canonicalJson({
      schemaVersion: 1,
      publicName: publicFields.publicName,
      website: publicFields.website,
      contact: publicFields.contact,
    });
    const hash = sha256Utf8(publicJson);
    const createdAt = this.deps.clock();
    const newRevision = expected === 0 ? 1 : expected + 1;
    this.deps.repo.transaction(() => {
      this.branding().insertAgencyVersion(newRevision, hash, publicJson, createdAt);
      this.branding().casAgencyHead(expected, newRevision);
    });
    const view = await this.readAgencyProfile();
    if (!view) throw new LatteError('INTERNAL', 'Agency profile was not stored');
    return view;
  }

  async importBrandKit(workId: unknown): Promise<BrandKitDraftView | null> {
    this.requireEnabled();
    const id = requireWorkId(workId);
    const work = this.deps.repo.getWork(id);
    return this.importIntoDraft({
      ownerKind: 'brand',
      ownerBrandId: work.brandId,
      draftDir: this.paths.brandDraftDir(work.brandId),
      title: 'Elegí la carpeta brand/ de esta marca',
    });
  }

  async importAgencyKit(): Promise<BrandKitDraftView | null> {
    this.requireEnabled();
    return this.importIntoDraft({
      ownerKind: 'agency',
      ownerBrandId: null,
      draftDir: this.paths.agencyDraftDir(),
      title: 'Elegí la carpeta brand/ de la agencia',
    });
  }

  private async importIntoDraft(input: {
    ownerKind: 'brand' | 'agency';
    ownerBrandId: string | null;
    draftDir: string;
    title: string;
  }): Promise<BrandKitDraftView | null> {
    if (!this.deps.chooseFolder) throw new UnavailableError('Importar un kit requiere la aplicación de escritorio');
    const chosen = await this.deps.chooseFolder(input.title);
    if (!chosen) return null;
    const brandRoot = resolveBrandFolder(chosen);
    const { manifest, rules, warnings } = readDraftSources(brandRoot);
    const staged = stageAssets(brandRoot, manifest.assets);
    for (const asset of staged) {
      if (asset.required && !asset.usable) {
        throw new ValidationError(`Required asset is not usable: ${asset.id}`);
      }
    }
    copyDraft(input.draftDir, staged, rules, manifest);
    const kitId = readOrCreateKitId(input.draftDir, input.ownerKind, input.ownerBrandId, this.branding());
    return {
      kitId,
      ownerKind: input.ownerKind,
      ownerBrandId: input.ownerBrandId,
      permitsAgencySignature: manifest.permitsAgencySignature,
      assetCount: staged.filter((a) => a.usable).length,
      warnings: [...warnings, ...rulesLookUntrusted(rules)],
    };
  }

  async publishBrandKit(workId: unknown, expectedVersion: unknown): Promise<BrandKitView> {
    this.requireEnabled();
    const id = requireWorkId(workId);
    const work = this.deps.repo.getWork(id);
    return this.publishDraft({
      ownerKind: 'brand',
      ownerBrandId: work.brandId,
      draftDir: this.paths.brandDraftDir(work.brandId),
      expectedVersion: requireExpectedVersion(expectedVersion),
    });
  }

  async publishAgencyKit(expectedVersion: unknown): Promise<BrandKitView> {
    this.requireEnabled();
    return this.publishDraft({
      ownerKind: 'agency',
      ownerBrandId: null,
      draftDir: this.paths.agencyDraftDir(),
      expectedVersion: requireExpectedVersion(expectedVersion),
    });
  }

  private publishDraft(input: {
    ownerKind: 'brand' | 'agency';
    ownerBrandId: string | null;
    draftDir: string;
    expectedVersion: number;
  }): BrandKitView {
    const { manifest, rules } = readDraftSources(input.draftDir);
    const staged = stageAssets(input.draftDir, manifest.assets);
    if (staged.some((a) => a.required && !a.usable)) {
      throw new ValidationError('Required asset is not usable');
    }
    const kitId = readOrCreateKitId(input.draftDir, input.ownerKind, input.ownerBrandId, this.branding());
    const head = input.ownerKind === 'agency'
      ? this.branding().agencyHead()
      : this.branding().headForBrand(input.ownerBrandId!);
    const current = head ? Number(head.current_version) : 0;
    if (current !== input.expectedVersion) {
      throw new LatteError('VERSION_CONFLICT', 'El head del kit cambió; reintentá con la versión actual');
    }
    if (head && head.kit_id !== kitId) {
      throw new ValidationError('Esta marca ya tiene un kit publicado distinto');
    }
    const newVersion = current + 1;
    const usable = staged.filter((a) => a.usable);
    const kitHash = sha256Utf8(canonicalJson({
      schemaVersion: 1,
      kitId,
      version: newVersion,
      ownerKind: input.ownerKind,
      ownerBrandId: input.ownerBrandId,
      permitsAgencySignature: manifest.permitsAgencySignature,
      rules,
      assets: usable.map((a) => ({ id: a.id, hash: a.hash, kind: a.kind, relativePath: a.relativePath })).sort((a, b) => a.id.localeCompare(b.id)),
    }));
    const dest = this.paths.brandKitVersionDir(kitId, newVersion);
    publishImmutableDir(dest, [
      { relativePath: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest), 'utf8') },
      { relativePath: 'brand.md', bytes: Buffer.from(rules, 'utf8') },
      ...usable.map((a) => ({ relativePath: a.relativePath, bytes: a.bytes })),
    ]);
    try {
      this.deps.repo.transaction(() => {
        this.branding().insertKitVersion({
          kitId,
          version: newVersion,
          ownerKind: input.ownerKind,
          ownerBrandId: input.ownerBrandId,
          hash: kitHash,
          approved: true,
          permitsAgencySignature: manifest.permitsAgencySignature,
          manifestJson: JSON.stringify(manifest),
          rulesText: rules,
          createdAt: this.deps.clock(),
          assets: staged.map((a) => ({
            assetId: a.id,
            hash: a.hash,
            kind: a.kind,
            required: a.required,
            usable: a.usable,
            relativePath: a.relativePath,
          })),
        });
        this.branding().casHead(kitId, input.ownerKind, input.ownerBrandId, input.expectedVersion, newVersion);
      });
    } catch (error) {
      // Directory remains as a recoverable orphan without a head.
      throw error;
    }
    return { kitId, version: newVersion, hash: kitHash, ownerKind: input.ownerKind };
  }

  async revokeBrandKit(workId: unknown, version: unknown, reason: unknown): Promise<void> {
    this.requireEnabled();
    const id = requireWorkId(workId);
    const work = this.deps.repo.getWork(id);
    const ver = requireExpectedVersion(version);
    if (ver < 1) throw new ValidationError('version must be at least 1');
    const why = requireText(reason, 'reason', 500);
    const head = this.branding().headForBrand(work.brandId);
    if (!head) throw new ValidationError('No hay un kit publicado para esta marca');
    const record = this.branding().loadPublishedKit(head.kit_id, ver);
    if (!record || record.ownerBrandId !== work.brandId) {
      throw new ValidationError('Esa versión no pertenece a esta marca');
    }
    this.deps.repo.transaction(() => {
      this.branding().insertRevocation(head.kit_id, ver, why, this.deps.clock());
      this.branding().dropHeadIfCurrent(head.kit_id, ver);
    });
  }

  async setWorkBrandChoice(workId: unknown, choice: unknown, expectedRevision: unknown): Promise<WorkBrandPolicyView> {
    this.requireEnabled();
    const id = requireWorkId(workId);
    const work = this.deps.repo.getWork(id);
    const parsed = requireChoice(choice);
    const expected = requireExpectedRevision(expectedRevision);
    const current = this.branding().policyForWork(work.id, work.brandId);
    if (current.brandId !== work.brandId) {
      throw new ValidationError('La política no es de esta marca');
    }
    const allowNeutral = parsed.identity === 'neutral' ? true : current.revision === 0 ? true : current.allowNeutral;
    const allowAgencySignature = parsed.signature === 'agency' ? true : current.allowAgencySignature;
    return this.deps.repo.transaction(() =>
      this.branding().casWorkPolicy({
        workId: work.id,
        brandId: work.brandId,
        expectedRevision: expected,
        choice: parsed,
        allowNeutral,
        allowAgencySignature,
        updatedAt: this.deps.clock(),
      }),
    );
  }

  resolveForWork(workId: string, choiceOverride?: Choice): WorkBrandContextView {
    this.requireEnabled();
    const id = requireWorkId(workId);
    const loaded = kitsForAuthorizedWork(this.access(), id);
    const choice = choiceOverride ?? loaded.policy.defaultChoice;
    const resolution = resolveBrandContext({
      brandId: loaded.work.brandId,
      choice,
      brandKit: loaded.brandKit,
      agencyKit: loaded.agencyKit,
      agencySignature: loaded.agencySignature,
      policy: loaded.policy,
    });
    const generationId = `gen_${randomBytes(10).toString('hex')}`;
    const composed = composeBrandContext(
      generationId,
      loaded.work.id,
      loaded.work.brandId,
      choice,
      resolution,
      [],
    );
    const pinnedDir = this.pinSnapshot(loaded.work.brandId, loaded.work.id, composed.snapshot);
    return { receipt: composed.receipt, snapshot: composed.snapshot, pinnedDir };
  }

  async readWorkBrandContext(workId: unknown): Promise<WorkBrandContextView> {
    return this.resolveForWork(requireWorkId(workId));
  }

  /** Isolation helper for tests: kits listed for a work never include another brand's kit. */
  kitsVisibleForWork(workId: string): { brandKit: Kit | null; agencyKit: Kit | null } {
    this.requireEnabled();
    const loaded = kitsForAuthorizedWork(this.access(), workId);
    return { brandKit: loaded.brandKit, agencyKit: loaded.agencyKit };
  }

  implicitPolicy(workId: string, brandId: string): WorkBrandPolicy {
    return implicitWorkBrandPolicy(workId, brandId);
  }

  private pinSnapshot(
    brandId: string,
    workId: string,
    snapshot: BrandContextSnapshot,
  ): string | null {
    if (snapshot.assets.length === 0 && !snapshot.signature?.logo) return null;
    const workDir = this.deps.files.workDir(brandId, workId);
    const pinRoot = path.join(workDir, '.latte', 'brand-pin', snapshot.generationId);
    fs.mkdirSync(pinRoot, { recursive: true });
    const record = snapshot.sourceKit
      ? this.branding().loadPublishedKit(snapshot.sourceKit.kitId, snapshot.sourceKit.version)
      : null;
    for (const asset of snapshot.assets) {
      const relative = record?.assets.find((a) => a.assetId === asset.id)?.relativePath;
      if (!relative || !snapshot.sourceKit) continue;
      const source = path.join(this.paths.brandKitVersionDir(snapshot.sourceKit.kitId, snapshot.sourceKit.version), ...relative.split('/'));
      const dest = safeJoin(pinRoot, 'assets', asset.id);
      copyVerified(source, dest, asset.hash);
    }
    return pinRoot;
  }
}

function newKitId(): string {
  const id = `kit_${randomBytes(10).toString('hex')}`;
  if (!isValidId(id)) throw new ValidationError('Failed to allocate kit id');
  return id;
}

function readOrCreateKitId(
  draftDir: string,
  ownerKind: 'brand' | 'agency',
  ownerBrandId: string | null,
  branding: import('../storage/brandingRepository').BrandingRepository,
): string {
  const file = path.join(draftDir, KIT_ID_FILE);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (!isValidId(existing)) throw new ValidationError('Stored kit id is invalid');
    return existing;
  }
  const fromHead = ownerKind === 'agency' ? branding.agencyHead() : ownerBrandId ? branding.headForBrand(ownerBrandId) : undefined;
  const kitId = fromHead?.kit_id && isValidId(fromHead.kit_id) ? fromHead.kit_id : newKitId();
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(file, kitId, { encoding: 'utf8', flag: 'wx' });
  return kitId;
}

function resolveBrandFolder(chosen: string): string {
  const resolved = path.resolve(chosen);
  const directManifest = path.join(resolved, 'manifest.json');
  const nested = path.join(resolved, 'brand');
  if (fs.existsSync(directManifest)) return fs.realpathSync(resolved);
  if (fs.existsSync(path.join(nested, 'manifest.json'))) return fs.realpathSync(nested);
  throw new ValidationError('La carpeta tiene que ser brand/ con manifest.json');
}

function readDraftSources(root: string): { manifest: BrandManifest; rules: string; warnings: string[] } {
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new ValidationError('Falta manifest.json');
  const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
  const rulesPath = path.join(root, 'brand.md');
  const rules = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8') : '';
  if (rules.length > MAX_RULES) throw new ValidationError('brand.md is too long');
  if (rules.includes('\0')) throw new ValidationError('brand.md contains a NUL byte');
  return { manifest, rules, warnings: [] };
}

function copyDraft(to: string, assets: StagedAsset[], rules: string, manifest: BrandManifest): void {
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(to, 'brand.md'), rules);
  for (const asset of assets) {
    const dest = path.resolve(to, ...asset.relativePath.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, asset.bytes);
  }
}
