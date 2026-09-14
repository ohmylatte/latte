import { LatteError, ValidationError } from '../core/errors';
import type { SqlDriver, SqlRow } from './driver';
import type { Choice, Kit, KitOwner, Signature, WorkBrandPolicy } from '../branding/types';
import { implicitWorkBrandPolicy } from '../branding/types';

interface KitVersionRow extends SqlRow {
  kit_id: string;
  version: number;
  owner_kind: string;
  owner_brand_id: string | null;
  hash: string;
  approved: number;
  permits_agency_signature: number;
  manifest_json: string;
  rules_text: string;
  created_at: string;
}

interface AssetRow extends SqlRow {
  kit_id: string;
  version: number;
  asset_id: string;
  hash: string;
  kind: string;
  required: number;
  usable: number;
  relative_path: string;
}

interface HeadRow extends SqlRow {
  kit_id: string;
  owner_kind: string;
  owner_brand_id: string | null;
  current_version: number;
}

interface PolicyRow extends SqlRow {
  work_id: string;
  brand_id: string;
  revision: number;
  identity: string;
  signature: string;
  allow_neutral: number;
  allow_agency_signature: number;
  updated_at: string;
}

interface AgencyVersionRow extends SqlRow {
  revision: number;
  hash: string;
  public_json: string;
  created_at: string;
}

export interface PublishedKitRecord {
  kitId: string;
  version: number;
  ownerKind: 'brand' | 'agency';
  ownerBrandId: string | null;
  hash: string;
  approved: boolean;
  permitsAgencySignature: boolean;
  manifestJson: string;
  rulesText: string;
  createdAt: string;
  assets: Array<{
    assetId: string;
    hash: string;
    kind: 'logo' | 'font' | 'reference' | 'other';
    required: boolean;
    usable: boolean;
    relativePath: string;
  }>;
}

export interface AgencyProfileRecord {
  revision: number;
  hash: string;
  publicJson: string;
  createdAt: string;
}

export class BrandingRepository {
  constructor(private readonly db: SqlDriver) {}

  insertKitVersion(input: {
    kitId: string;
    version: number;
    ownerKind: 'brand' | 'agency';
    ownerBrandId: string | null;
    hash: string;
    approved: boolean;
    permitsAgencySignature: boolean;
    manifestJson: string;
    rulesText: string;
    createdAt: string;
    assets: PublishedKitRecord['assets'];
  }): void {
    const existing = this.db.get<KitVersionRow>(
      'SELECT * FROM brand_kit_versions WHERE kit_id = ? LIMIT 1',
      [input.kitId],
    );
    if (existing) {
      if (existing.owner_kind !== input.ownerKind || existing.owner_brand_id !== input.ownerBrandId) {
        throw new ValidationError('Un kit_id conserva el mismo dueño en todas sus versiones');
      }
    }
    this.db.run(
      `INSERT INTO brand_kit_versions
        (kit_id, version, owner_kind, owner_brand_id, hash, approved, permits_agency_signature, manifest_json, rules_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.kitId,
        input.version,
        input.ownerKind,
        input.ownerBrandId,
        input.hash,
        input.approved ? 1 : 0,
        input.permitsAgencySignature ? 1 : 0,
        input.manifestJson,
        input.rulesText,
        input.createdAt,
      ],
    );
    for (const asset of input.assets) {
      this.db.run(
        `INSERT INTO brand_kit_assets
          (kit_id, version, asset_id, hash, kind, required, usable, relative_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.kitId, input.version, asset.assetId, asset.hash, asset.kind, asset.required ? 1 : 0, asset.usable ? 1 : 0, asset.relativePath],
      );
    }
  }

  casHead(kitId: string, ownerKind: 'brand' | 'agency', ownerBrandId: string | null, expectedVersion: number, newVersion: number): void {
    if (expectedVersion === 0) {
      this.db.run(
        'INSERT INTO brand_kit_heads(kit_id, owner_kind, owner_brand_id, current_version) VALUES (?, ?, ?, ?)',
        [kitId, ownerKind, ownerBrandId, newVersion],
      );
      return;
    }
    this.db.run(
      'UPDATE brand_kit_heads SET current_version = ? WHERE kit_id = ? AND current_version = ?',
      [newVersion, kitId, expectedVersion],
    );
    const head = this.db.get<HeadRow>('SELECT * FROM brand_kit_heads WHERE kit_id = ?', [kitId]);
    if (!head || Number(head.current_version) !== newVersion) {
      throw new LatteError('VERSION_CONFLICT', 'El head del kit cambió; reintentá con la versión actual');
    }
  }

  dropHeadIfCurrent(kitId: string, version: number): void {
    this.db.run('DELETE FROM brand_kit_heads WHERE kit_id = ? AND current_version = ?', [kitId, version]);
  }

  insertRevocation(kitId: string, version: number, reason: string, createdAt: string): void {
    this.db.run(
      'INSERT INTO brand_kit_revocations(kit_id, version, reason, created_at) VALUES (?, ?, ?, ?)',
      [kitId, version, reason, createdAt],
    );
  }

  isRevoked(kitId: string, version: number): boolean {
    return Boolean(this.db.get('SELECT kit_id FROM brand_kit_revocations WHERE kit_id = ? AND version = ?', [kitId, version]));
  }

  headForBrand(brandId: string): HeadRow | undefined {
    return this.db.get<HeadRow>(
      "SELECT * FROM brand_kit_heads WHERE owner_kind = 'brand' AND owner_brand_id = ?",
      [brandId],
    );
  }

  agencyHead(): HeadRow | undefined {
    return this.db.get<HeadRow>("SELECT * FROM brand_kit_heads WHERE owner_kind = 'agency'");
  }

  getVersion(kitId: string, version: number): KitVersionRow | undefined {
    return this.db.get<KitVersionRow>(
      'SELECT * FROM brand_kit_versions WHERE kit_id = ? AND version = ?',
      [kitId, version],
    );
  }

  listAssets(kitId: string, version: number): AssetRow[] {
    return this.db.all<AssetRow>(
      'SELECT * FROM brand_kit_assets WHERE kit_id = ? AND version = ? ORDER BY asset_id',
      [kitId, version],
    );
  }

  loadPublishedKit(kitId: string, version: number): PublishedKitRecord | null {
    const row = this.getVersion(kitId, version);
    if (!row) return null;
    return this.toRecord(row);
  }

  private toRecord(row: KitVersionRow): PublishedKitRecord {
    return {
      kitId: row.kit_id,
      version: Number(row.version),
      ownerKind: row.owner_kind === 'agency' ? 'agency' : 'brand',
      ownerBrandId: row.owner_brand_id,
      hash: row.hash,
      approved: Number(row.approved) === 1,
      permitsAgencySignature: Number(row.permits_agency_signature) === 1,
      manifestJson: row.manifest_json,
      rulesText: row.rules_text,
      createdAt: row.created_at,
      assets: this.listAssets(row.kit_id, Number(row.version)).map((a) => ({
        assetId: a.asset_id,
        hash: a.hash,
        kind: a.kind as PublishedKitRecord['assets'][number]['kind'],
        required: Number(a.required) === 1,
        usable: Number(a.usable) === 1,
        relativePath: a.relative_path,
      })),
    };
  }

  approvedKitForBrand(brandId: string): Kit | null {
    const head = this.headForBrand(brandId);
    if (!head) return null;
    return this.kitFromHead(head);
  }

  approvedAgencyKit(): Kit | null {
    const head = this.agencyHead();
    if (!head) return null;
    return this.kitFromHead(head);
  }

  private kitFromHead(head: HeadRow): Kit | null {
    const record = this.loadPublishedKit(head.kit_id, Number(head.current_version));
    if (!record || !record.approved) return null;
    const revoked = this.isRevoked(record.kitId, record.version);
    const owner: KitOwner = record.ownerKind === 'agency'
      ? { kind: 'agency' }
      : { kind: 'brand', brandId: record.ownerBrandId! };
    return {
      ref: { kitId: record.kitId, version: record.version, hash: record.hash },
      owner,
      approved: record.approved,
      revoked,
      permitsAgencySignature: record.permitsAgencySignature,
      assets: record.assets.map((a) => ({
        id: a.assetId,
        hash: a.hash,
        required: a.required,
        usable: a.usable,
      })),
      rules: record.rulesText,
    };
  }

  policyForWork(workId: string, brandId: string): WorkBrandPolicy {
    const row = this.db.get<PolicyRow>('SELECT * FROM work_brand_policies WHERE work_id = ?', [workId]);
    if (!row) return implicitWorkBrandPolicy(workId, brandId);
    return {
      workId: row.work_id,
      brandId: row.brand_id,
      revision: Number(row.revision),
      defaultChoice: {
        identity: row.identity as Choice['identity'],
        signature: row.signature as Choice['signature'],
      },
      allowNeutral: Number(row.allow_neutral) === 1,
      allowAgencySignature: Number(row.allow_agency_signature) === 1,
    };
  }

  casWorkPolicy(input: {
    workId: string;
    brandId: string;
    expectedRevision: number;
    choice: Choice;
    allowNeutral: boolean;
    allowAgencySignature: boolean;
    updatedAt: string;
  }): WorkBrandPolicy {
    if (input.expectedRevision === 0) {
      this.db.run(
        `INSERT INTO work_brand_policies
          (work_id, brand_id, revision, identity, signature, allow_neutral, allow_agency_signature, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        [
          input.workId,
          input.brandId,
          input.choice.identity,
          input.choice.signature,
          input.allowNeutral ? 1 : 0,
          input.allowAgencySignature ? 1 : 0,
          input.updatedAt,
        ],
      );
      return this.policyForWork(input.workId, input.brandId);
    }
    this.db.run(
      `UPDATE work_brand_policies
       SET brand_id = ?, revision = ?, identity = ?, signature = ?, allow_neutral = ?, allow_agency_signature = ?, updated_at = ?
       WHERE work_id = ? AND revision = ? AND brand_id = ?`,
      [
        input.brandId,
        input.expectedRevision + 1,
        input.choice.identity,
        input.choice.signature,
        input.allowNeutral ? 1 : 0,
        input.allowAgencySignature ? 1 : 0,
        input.updatedAt,
        input.workId,
        input.expectedRevision,
        input.brandId,
      ],
    );
    const row = this.db.get<PolicyRow>('SELECT * FROM work_brand_policies WHERE work_id = ?', [input.workId]);
    if (!row || Number(row.revision) !== input.expectedRevision + 1) {
      throw new LatteError('VERSION_CONFLICT', 'La política del trabajo cambió; reintentá con la revisión actual');
    }
    return this.policyForWork(input.workId, input.brandId);
  }

  insertAgencyVersion(revision: number, hash: string, publicJson: string, createdAt: string): void {
    this.db.run(
      'INSERT INTO agency_profile_versions(revision, hash, public_json, created_at) VALUES (?, ?, ?, ?)',
      [revision, hash, publicJson, createdAt],
    );
  }

  casAgencyHead(expectedRevision: number, newRevision: number): void {
    if (expectedRevision === 0) {
      this.db.run('INSERT INTO agency_profile_head(id, current_revision) VALUES (1, ?)', [newRevision]);
      return;
    }
    this.db.run(
      'UPDATE agency_profile_head SET current_revision = ? WHERE id = 1 AND current_revision = ?',
      [newRevision, expectedRevision],
    );
    const head = this.db.get<{ current_revision: number }>('SELECT current_revision FROM agency_profile_head WHERE id = 1');
    if (!head || Number(head.current_revision) !== newRevision) {
      throw new LatteError('VERSION_CONFLICT', 'El perfil de agencia cambió; reintentá con la revisión actual');
    }
  }

  currentAgencyProfile(): AgencyProfileRecord | null {
    const head = this.db.get<{ current_revision: number }>('SELECT current_revision FROM agency_profile_head WHERE id = 1');
    if (!head) return null;
    const row = this.db.get<AgencyVersionRow>(
      'SELECT * FROM agency_profile_versions WHERE revision = ?',
      [head.current_revision],
    );
    if (!row) return null;
    return { revision: Number(row.revision), hash: row.hash, publicJson: row.public_json, createdAt: row.created_at };
  }

  agencySignatureFromProfile(): Signature | null {
    const profile = this.currentAgencyProfile();
    if (!profile) return null;
    let parsed: { publicName?: unknown; website?: unknown };
    try {
      parsed = JSON.parse(profile.publicJson) as { publicName?: unknown; website?: unknown };
    } catch {
      return null;
    }
    if (typeof parsed.publicName !== 'string' || parsed.publicName.trim().length === 0) return null;
    const website = typeof parsed.website === 'string' && parsed.website.length > 0 ? parsed.website : undefined;
    return {
      agencyRevision: profile.revision,
      hash: profile.hash,
      publicName: parsed.publicName,
      website,
      logo: null,
    };
  }
}
