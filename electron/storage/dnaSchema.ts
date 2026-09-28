/**
 * Additive Brand-DNA tables (Entrega 1B). Registered from schema.ts.
 *
 * El ADN de una marca en tres piezas: el borrador que se edita, las versiones
 * aprobadas (inmutables, con su fecha) y las propuestas que aprendieron de una
 * corrección y esperan el sí de la persona. No ON DELETE CASCADE hacia brands:
 * como los kits, una marca con ADN no se borra a ciegas.
 *
 * `brand_dna_drafts` no tiene fila mientras la marca no tiene ADN: ausencia de
 * fila = `draft: null`, nunca un objeto vacío inventado.
 */
export const DNA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS brand_dna_drafts (
  brand_id TEXT PRIMARY KEY REFERENCES brands(id),
  fields_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brand_dna_versions (
  brand_id TEXT NOT NULL REFERENCES brands(id),
  version INTEGER NOT NULL CHECK (version > 0),
  fields_json TEXT NOT NULL,
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  approved_at TEXT NOT NULL,
  PRIMARY KEY (brand_id, version)
);

CREATE TABLE IF NOT EXISTS brand_dna_heads (
  brand_id TEXT PRIMARY KEY REFERENCES brands(id),
  current_version INTEGER NOT NULL,
  FOREIGN KEY (brand_id, current_version) REFERENCES brand_dna_versions(brand_id, version)
);

CREATE TABLE IF NOT EXISTS brand_dna_proposals (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  work_id TEXT NOT NULL,
  field TEXT NOT NULL,
  next_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','superseded')),
  source_chat_id TEXT,
  source_message_id TEXT,
  source_member_id TEXT,
  source_role_id TEXT,
  source_runtime TEXT,
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_brand_dna_proposals_brand ON brand_dna_proposals(brand_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_dna_proposal_request
  ON brand_dna_proposals(brand_id, work_id, source_chat_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_dna_proposal_pending_field
  ON brand_dna_proposals(brand_id, field) WHERE status = 'pending';

CREATE TRIGGER IF NOT EXISTS brand_dna_versions_no_update
BEFORE UPDATE ON brand_dna_versions
BEGIN
  SELECT RAISE(ABORT, 'brand dna version is immutable');
END;
CREATE TRIGGER IF NOT EXISTS brand_dna_versions_no_delete
BEFORE DELETE ON brand_dna_versions
BEGIN
  SELECT RAISE(ABORT, 'brand dna version is immutable');
END;
`;
