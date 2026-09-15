/**
 * Additive brand-context proposal table. Registered from schema.ts.
 * Agent suggestions stay pending until a human accepts them; nothing here
 * deletes a brand. No ON DELETE CASCADE.
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
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_brand_context_proposals_brand ON brand_context_proposals(brand_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_context_request ON brand_context_proposals(brand_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_context_pending ON brand_context_proposals(brand_id) WHERE status = 'pending';
`;
