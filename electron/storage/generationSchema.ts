/**
 * Additive generation persistence. No ON DELETE CASCADE toward brands/works.
 * Recibo (generations) is immutable; delivery_evidence and artifact_checks
 * are separate audit tables, also insert-only.
 */
export const GENERATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS generations (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES works(id),
  brand_id     TEXT NOT NULL REFERENCES brands(id),
  context_json TEXT NOT NULL,
  context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generations_work ON generations(work_id, created_at);

CREATE TRIGGER IF NOT EXISTS generations_no_update
BEFORE UPDATE ON generations BEGIN
  SELECT RAISE(ABORT, 'generation receipt is immutable');
END;
CREATE TRIGGER IF NOT EXISTS generations_no_delete
BEFORE DELETE ON generations BEGIN
  SELECT RAISE(ABORT, 'generation receipt is immutable');
END;

CREATE TABLE IF NOT EXISTS delivery_evidence (
  id            TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES generations(id),
  runtime       TEXT NOT NULL,
  chat_id       TEXT,
  projected_at  TEXT NOT NULL,
  files_written TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_evidence_generation ON delivery_evidence(generation_id);

CREATE TRIGGER IF NOT EXISTS delivery_evidence_no_update
BEFORE UPDATE ON delivery_evidence BEGIN
  SELECT RAISE(ABORT, 'delivery evidence is immutable');
END;
CREATE TRIGGER IF NOT EXISTS delivery_evidence_no_delete
BEFORE DELETE ON delivery_evidence BEGIN
  SELECT RAISE(ABORT, 'delivery evidence is immutable');
END;

CREATE TABLE IF NOT EXISTS artifact_checks (
  id              TEXT PRIMARY KEY,
  generation_id   TEXT NOT NULL REFERENCES generations(id),
  relative_path   TEXT NOT NULL,
  file_hash       TEXT CHECK (file_hash IS NULL OR length(file_hash) = 64),
  checks_json     TEXT NOT NULL,
  brand_compliant INTEGER CHECK (brand_compliant IS NULL OR brand_compliant IN (0, 1)),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_checks_generation ON artifact_checks(generation_id);

CREATE TRIGGER IF NOT EXISTS artifact_checks_no_update
BEFORE UPDATE ON artifact_checks BEGIN
  SELECT RAISE(ABORT, 'artifact check is immutable');
END;
CREATE TRIGGER IF NOT EXISTS artifact_checks_no_delete
BEFORE DELETE ON artifact_checks BEGIN
  SELECT RAISE(ABORT, 'artifact check is immutable');
END;
`;
