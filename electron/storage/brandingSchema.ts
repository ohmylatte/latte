/**
 * Additive brand-kit / agency schema. Registered from schema.ts.
 * No ON DELETE CASCADE toward brands or works: deleting a brand that still
 * has kits or policies must fail until an explicit purge exists.
 */
export const BRANDING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agency_profile_versions (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  public_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agency_profile_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_revision INTEGER NOT NULL REFERENCES agency_profile_versions(revision)
);

CREATE TABLE IF NOT EXISTS brand_kit_versions (
  kit_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('brand','agency')),
  owner_brand_id TEXT REFERENCES brands(id),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  approved INTEGER NOT NULL CHECK (approved IN (0,1)),
  permits_agency_signature INTEGER NOT NULL CHECK (permits_agency_signature IN (0,1)),
  manifest_json TEXT NOT NULL,
  rules_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kit_id, version),
  CHECK (
    (owner_kind = 'agency' AND owner_brand_id IS NULL) OR
    (owner_kind = 'brand' AND owner_brand_id IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS brand_kit_assets (
  kit_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('logo','font','reference','other')),
  required INTEGER NOT NULL CHECK (required IN (0,1)),
  usable INTEGER NOT NULL CHECK (usable IN (0,1)),
  relative_path TEXT NOT NULL,
  PRIMARY KEY (kit_id, version, asset_id),
  FOREIGN KEY (kit_id, version) REFERENCES brand_kit_versions(kit_id, version)
);
CREATE TABLE IF NOT EXISTS brand_kit_heads (
  kit_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_brand_id TEXT,
  current_version INTEGER NOT NULL,
  FOREIGN KEY (kit_id, current_version)
    REFERENCES brand_kit_versions(kit_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_kit_heads_brand
  ON brand_kit_heads(owner_brand_id) WHERE owner_kind = 'brand';
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_kit_heads_agency
  ON brand_kit_heads(owner_kind) WHERE owner_kind = 'agency';

CREATE TABLE IF NOT EXISTS brand_kit_revocations (
  kit_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kit_id, version),
  FOREIGN KEY (kit_id, version) REFERENCES brand_kit_versions(kit_id, version)
);

CREATE TABLE IF NOT EXISTS work_brand_policies (
  work_id TEXT PRIMARY KEY REFERENCES works(id),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  identity TEXT NOT NULL CHECK (identity IN ('brand','agency','neutral')),
  signature TEXT NOT NULL CHECK (signature IN ('none','agency')),
  allow_neutral INTEGER NOT NULL CHECK (allow_neutral IN (0,1)),
  allow_agency_signature INTEGER NOT NULL CHECK (allow_agency_signature IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS agency_profile_versions_no_update
BEFORE UPDATE ON agency_profile_versions BEGIN
  SELECT RAISE(ABORT, 'agency profile version is immutable');
END;
CREATE TRIGGER IF NOT EXISTS agency_profile_versions_no_delete
BEFORE DELETE ON agency_profile_versions BEGIN
  SELECT RAISE(ABORT, 'agency profile version is immutable');
END;
CREATE TRIGGER IF NOT EXISTS brand_kit_versions_no_update
BEFORE UPDATE ON brand_kit_versions BEGIN
  SELECT RAISE(ABORT, 'kit version is immutable');
END;
CREATE TRIGGER IF NOT EXISTS brand_kit_versions_no_delete
BEFORE DELETE ON brand_kit_versions BEGIN
  SELECT RAISE(ABORT, 'kit version is immutable');
END;
CREATE TRIGGER IF NOT EXISTS brand_kit_assets_no_update
BEFORE UPDATE ON brand_kit_assets BEGIN
  SELECT RAISE(ABORT, 'kit assets are immutable');
END;
CREATE TRIGGER IF NOT EXISTS brand_kit_assets_no_delete
BEFORE DELETE ON brand_kit_assets BEGIN
  SELECT RAISE(ABORT, 'kit assets are immutable');
END;
`;
