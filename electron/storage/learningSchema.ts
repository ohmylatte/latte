/**
 * Additive learning tables. No ON DELETE CASCADE toward brands/works.
 * Authority lives here, never under .latte/context or .latte/skills.
 */
export const LEARNING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS learned_skills (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  active_version INTEGER,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
  UNIQUE (id, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_learned_skills_scope ON learned_skills(scope_key, lifecycle);

CREATE TABLE IF NOT EXISTS skill_candidates (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('draft','validating','needs_review','blocked','approved','rejected','superseded')),
  revision INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  markdown TEXT NOT NULL,
  base_version INTEGER,
  base_hash TEXT,
  validated_hash TEXT,
  pattern_key TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (skill_id, scope_key) REFERENCES learned_skills(id, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_skill_candidates_scope_state ON skill_candidates(scope_key, state, created_at);

CREATE TABLE IF NOT EXISTS learned_skill_versions (
  skill_id TEXT NOT NULL REFERENCES learned_skills(id),
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  markdown TEXT NOT NULL,
  approved_from TEXT NOT NULL UNIQUE REFERENCES skill_candidates(id),
  approved_at TEXT NOT NULL,
  PRIMARY KEY (skill_id, version)
);

CREATE TABLE IF NOT EXISTS learning_jobs (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  source_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('queued','running','done','no_candidate','deferred','failed')),
  lease_until TEXT,
  lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  candidate_id TEXT REFERENCES skill_candidates(id),
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scope_key, source_key)
);
CREATE INDEX IF NOT EXISTS idx_learning_jobs_state ON learning_jobs(state, lease_until);

CREATE TABLE IF NOT EXISTS skill_review_receipts (
  request_id TEXT PRIMARY KEY,
  command_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_audit (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES skill_candidates(id),
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_cost_reservations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES learning_jobs(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  max_input_tokens INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  max_cost_micros INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','settled','uncertain')),
  usage_json TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS learning_cost_ledger (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  reservation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('spend','duplicate_spend','denied')),
  cost_micros INTEGER NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_cost_ledger_job ON learning_cost_ledger(job_id, created_at);

CREATE TRIGGER IF NOT EXISTS learned_skill_versions_no_update
BEFORE UPDATE ON learned_skill_versions
BEGIN SELECT RAISE(ABORT, 'learned versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS learned_skill_versions_no_delete
BEFORE DELETE ON learned_skill_versions
BEGIN SELECT RAISE(ABORT, 'learned versions are retained'); END;

CREATE TRIGGER IF NOT EXISTS skill_review_receipts_no_update
BEFORE UPDATE ON skill_review_receipts
BEGIN SELECT RAISE(ABORT, 'review receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS skill_review_receipts_no_delete
BEFORE DELETE ON skill_review_receipts
BEGIN SELECT RAISE(ABORT, 'review receipts are retained'); END;

CREATE TRIGGER IF NOT EXISTS skill_audit_no_update
BEFORE UPDATE ON skill_audit
BEGIN SELECT RAISE(ABORT, 'skill audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS skill_audit_no_delete
BEFORE DELETE ON skill_audit
BEGIN SELECT RAISE(ABORT, 'skill audit is retained'); END;

CREATE TRIGGER IF NOT EXISTS learning_cost_ledger_no_update
BEFORE UPDATE ON learning_cost_ledger
BEGIN SELECT RAISE(ABORT, 'cost ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS learning_cost_ledger_no_delete
BEFORE DELETE ON learning_cost_ledger
BEGIN SELECT RAISE(ABORT, 'cost ledger is retained'); END;
`;
