import { ARCHIVE_SCHEMA_SQL } from './archiveSchema';
import { BRAND_CONTEXT_SCHEMA_SQL } from './brandContextSchema';
import { BRANDING_SCHEMA_SQL } from './brandingSchema';
import { CONNECTIONS_SCHEMA_SQL } from './connectionsSchema';
import { COORDINATION_SCHEMA_SQL } from './coordinationSchema';
import { GENERATION_SCHEMA_SQL } from './generationSchema';
import { LEARNING_SCHEMA_SQL } from './learningSchema';

/**
 * Schema is applied idempotently on every start. Revisions are immutable by
 * contract AND by database triggers: no code path can update or delete them.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS brands (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  context    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS works (
  id         TEXT PRIMARY KEY,
  brand_id   TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  brief      TEXT NOT NULL DEFAULT '',
  -- Absolute folder chosen by the user, or NULL for a folder Latte manages.
  dir        TEXT,
  updated_at TEXT NOT NULL
  -- expected_output and result_path (the outcome of a work) are added by
  -- LatteRepository.migrate(), for new and existing databases alike.
);
CREATE INDEX IF NOT EXISTS idx_works_brand ON works(brand_id, updated_at DESC);

-- A work holds one or more tracked Markdown documents. brief.md is the default
-- one (kind 'brief') and keeps its path, so existing work folders need no move.
CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,
  work_id        TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'brief',
  title          TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft',
  funnel_stages  TEXT NOT NULL DEFAULT '[]',
  -- What the agent proposed and the human has not answered yet. Never applied on its own.
  proposed_stages TEXT NOT NULL DEFAULT '[]',
  base_doc_id    TEXT,
  base_rev_id    TEXT,
  base_print     TEXT,
  last_print     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_work ON documents(work_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_file ON documents(work_id, file_name);

-- document_id NULL means "the work's brief document" (rows written before v4;
-- revisions are immutable by trigger, so they are never back-filled).
CREATE TABLE IF NOT EXISTS revisions (
  id          TEXT PRIMARY KEY,
  work_id     TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  document_id TEXT,
  source      TEXT NOT NULL DEFAULT 'human',
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_work ON revisions(work_id, created_at);

CREATE TRIGGER IF NOT EXISTS revisions_immutable_update
BEFORE UPDATE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS revisions_immutable_delete
BEFORE DELETE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;

CREATE TABLE IF NOT EXISTS decisions (
  id         TEXT PRIMARY KEY,
  work_id    TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_work ON decisions(work_id, created_at);

-- Agent suggestions are first-class and auditable. The legacy decisions table
-- remains untouched so existing databases migrate without rewriting history.
CREATE TABLE IF NOT EXISTS decision_proposals (
  id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  statement TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '', alternatives TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL, source_chat_id TEXT, source_message_id TEXT, source_member_id TEXT, source_role_id TEXT, source_runtime TEXT,
  client_request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_request ON decision_proposals(work_id, source_chat_id, client_request_id);
CREATE INDEX IF NOT EXISTS idx_decision_proposals_work ON decision_proposals(work_id, created_at);
CREATE TABLE IF NOT EXISTS decision_events (
  id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES decision_proposals(id) ON DELETE CASCADE,
  action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_events_decision ON decision_events(decision_id, created_at);

CREATE TABLE IF NOT EXISTS team_members (
  id         TEXT PRIMARY KEY,
  work_id    TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  role_id    TEXT NOT NULL,
  role_name  TEXT NOT NULL,
  initial    TEXT NOT NULL,
  runtime    TEXT NOT NULL,
  model      TEXT,
  account_id TEXT,
  session_id TEXT NOT NULL DEFAULT '',
  done       INTEGER NOT NULL DEFAULT 0,
  -- Member of the same work this one continues. A plain reference, not a key:
  -- removing the origin later leaves the continuation standing.
  continued_from TEXT,
  -- How hard this member works per answer. Latte's own word, translated by
  -- each adapter; an older build simply never writes it and gets the default.
  tier TEXT NOT NULL DEFAULT 'balanced',
  -- Everything this member consumed, as the runtimes reported it. A whole
  -- ChatUsage as JSON, because it is read and written as one thing and no
  -- query ever needs a single field of it. NULL = nothing measured yet.
  usage_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_members_work ON team_members(work_id, created_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
` + GENERATION_SCHEMA_SQL + BRANDING_SCHEMA_SQL + LEARNING_SCHEMA_SQL + ARCHIVE_SCHEMA_SQL + BRAND_CONTEXT_SCHEMA_SQL + COORDINATION_SCHEMA_SQL + CONNECTIONS_SCHEMA_SQL;

/**
 * Not bumped for works.expected_output / works.result_path / works.out_of_scope_stages
 * (nor for team_members.continued_from, tier and usage_json) on purpose:
 * columns an older build simply ignores, because every insert names its columns
 * and the new ones are nullable or defaulted. A bump would make that older
 * build refuse the database as "newer" (see isNewerSchema), which is the
 * opposite of backward compatible.
 * The outcome and out-of-scope columns are added by migrate(), the same path
 * for a new database and an existing one, so the works table above stays
 * exactly what schema 7 defined. Schema 8 adds generation receipts, brand-kit
 * tables and learned-skill tables.
 * Schema 9 adds brand_archives (soft-delete, no ALTER on brands).
 * Schema 10 adds brand_context_proposals (agent drafts of Brand.context).
 * Schema 11 adds brand_context_revisions (the immutable history of Brand.context).
 * Schema 12 adds the coordination_* tables (autonomous coordination runs).
 * No ALTER is needed for this bump: every coordination column ships in its
 * table's initial CREATE TABLE, so there is nothing to gate on
 * pragma_table_info yet — that path is reserved for a later nullable column
 * on one of these same tables, the same way documents/works/team_members grew
 * columns above.
 * Schema 13 adds connections + connection_tokens (conexiones MCP: el gateway
 * local es dueño de las credenciales del proveedor). Mismo razonamiento que
 * 12: todo viaja en el CREATE TABLE inicial de cada tabla, así que no hay
 * ningún ALTER que gatear. Los secretos viven en una tabla APARTE a propósito
 * -- ver `connectionsSchema.ts`.
 */
export const SCHEMA_VERSION = '13';
