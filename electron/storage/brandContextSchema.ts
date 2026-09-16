/**
 * Additive brand-context tables. Registered from schema.ts.
 *
 * Agent suggestions stay pending until a human accepts them; nothing here
 * deletes a brand. No ON DELETE CASCADE.
 *
 * `brand_context_revisions` is the history of `brands.context`, and it is
 * immutable by the same contract as `revisions`: no code path can update or
 * delete a row, so a wipe is always recoverable. `fingerprint` is the
 * canonical hash of `content`, stored so a restore can be reasoned about
 * without recomputing it.
 */
export const BRAND_CONTEXT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS brand_context_proposals (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  work_id TEXT NOT NULL,
  source_chat_id TEXT,
  source_message_id TEXT,
  source_member_id TEXT,
  source_role_id TEXT,
  source_runtime TEXT,
  text TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  base_fingerprint TEXT NOT NULL,
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_brand_context_proposals_brand ON brand_context_proposals(brand_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_context_request ON brand_context_proposals(brand_id, work_id, source_chat_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_context_pending ON brand_context_proposals(brand_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS brand_context_revisions (
  id          TEXT PRIMARY KEY,
  brand_id    TEXT NOT NULL REFERENCES brands(id),
  -- 'human' | 'proposal' | 'clear' | 'restore'
  source      TEXT NOT NULL,
  -- What produced it: a proposal id, the revision a restore came from, or NULL.
  origin      TEXT,
  content     TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brand_context_revisions_brand ON brand_context_revisions(brand_id, created_at);

CREATE TRIGGER IF NOT EXISTS brand_context_revisions_immutable_update
BEFORE UPDATE ON brand_context_revisions
BEGIN
  SELECT RAISE(ABORT, 'brand context revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS brand_context_revisions_immutable_delete
BEFORE DELETE ON brand_context_revisions
BEGIN
  SELECT RAISE(ABORT, 'brand context revisions are immutable');
END;
`;
