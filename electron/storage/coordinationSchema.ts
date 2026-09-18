/**
 * Autonomous coordination tables (schema 12). Additive: no existing table is
 * altered. Registered from schema.ts like generation/branding/learning before it.
 *
 * `coordination_run` is one row per autonomous run started for a Work. The
 * partial unique index below is the one-active-run-per-Work invariant,
 * enforced by the database, never by application code: a Work cannot have two
 * rows with a live status at once, no matter which code path inserts.
 *
 * `coordination_task.in_plan` is what makes the 'plan' authority rule ("was
 * this task part of the approved plan snapshot?") a column lookup instead of
 * a JSON diff against `coordination_run.plan_json`.
 *
 * `coordination_task_dep` keeps edges in their own table, separate from any
 * JSON blob, so cycle detection is a graph query over rows, not a parse.
 *
 * `coordination_dispatch` is the bitácora's only source: every entry the UI
 * shows is derived from `created_at`/`started_at`/`settled_at` on this table,
 * never from narrative text that isn't backed by a row.
 *
 * `coordination_cost_reservations` / `coordination_cost_ledger` are
 * column-for-column the shape of `learning_cost_reservations` /
 * `learning_cost_ledger` (see learningSchema.ts), with the same immutability
 * triggers on the ledger: a spend, once recorded, is never rewritten or
 * dropped. `job_id` becomes `run_id` + `dispatch_id` + `member_id` (there is
 * no single "job" here); `provider` becomes `runtime`, Latte's own word for it.
 * `dispatches` sits on the ledger because `maxDispatches` is the primary,
 * always-countable budget unit — the cap is `SUM(dispatches) WHERE
 * kind='spend'`, computable with zero cost data (`ChatUsage.costUsd` is
 * nullable per runtime).
 */
export const COORDINATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordination_run (
  id                    TEXT PRIMARY KEY,
  work_id               TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  status                TEXT NOT NULL CHECK (status IN ('planning','running','suspended','done','cancelled')),
  coordinator_member_id TEXT,
  budget_json           TEXT NOT NULL,
  plan_json             TEXT,
  plan_approved_at      TEXT,
  suspend_reason        TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coordination_run_active ON coordination_run(work_id) WHERE status IN ('planning','running','suspended');
CREATE INDEX IF NOT EXISTS idx_coordination_run_work ON coordination_run(work_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coordination_task (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES coordination_run(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  role_id            TEXT NOT NULL,
  spec               TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending','ready','dispatched','running','done','failed','blocked')),
  depth              INTEGER NOT NULL DEFAULT 0,
  attempts           INTEGER NOT NULL DEFAULT 0,
  in_plan            INTEGER NOT NULL DEFAULT 0,
  assigned_member_id TEXT,
  result_summary     TEXT,
  result_files_json  TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coordination_task_run ON coordination_task(run_id, status);

-- Edges live on their own, so a cycle check is a graph query over rows, never
-- a JSON parse of some blob on the task itself.
CREATE TABLE IF NOT EXISTS coordination_task_dep (
  task_id       TEXT NOT NULL REFERENCES coordination_task(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES coordination_task(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

-- The bitácora's only source: one row per lifecycle event, derived from the
-- three timestamps below. No narrative text is ever stored that a row does
-- not back.
CREATE TABLE IF NOT EXISTS coordination_dispatch (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES coordination_run(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES coordination_task(id) ON DELETE CASCADE,
  member_id      TEXT NOT NULL,
  attempt        INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending_approval','dispatched','running','reported','failed','rejected','cancelled')),
  gate_id        TEXT,
  prompt         TEXT NOT NULL,
  outcome        TEXT,
  summary        TEXT,
  files_json     TEXT,
  reservation_id TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  settled_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_coordination_dispatch_run ON coordination_dispatch(run_id, created_at);

CREATE TABLE IF NOT EXISTS coordination_message (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES coordination_run(id) ON DELETE CASCADE,
  to_member_id   TEXT NOT NULL,
  from_member_id TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('task','answer','note')),
  body           TEXT NOT NULL,
  delivered_at   TEXT,
  created_at     TEXT NOT NULL
);
-- FIFO undelivered lookup is one index scan.
CREATE INDEX IF NOT EXISTS idx_coordination_message_undelivered ON coordination_message(run_id, to_member_id, created_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS coordination_ask (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES coordination_run(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES coordination_task(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT,
  deadline_at TEXT NOT NULL,
  answered_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coordination_ask_open ON coordination_ask(run_id) WHERE answered_at IS NULL;

-- Column-for-column learning_cost_reservations (learningSchema.ts). No
-- immutability trigger here either, matching the original: only the ledger
-- below is append-only.
CREATE TABLE IF NOT EXISTS coordination_cost_reservations (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES coordination_run(id) ON DELETE CASCADE,
  dispatch_id       TEXT REFERENCES coordination_dispatch(id) ON DELETE CASCADE,
  member_id         TEXT NOT NULL,
  runtime           TEXT NOT NULL,
  model             TEXT NOT NULL,
  max_input_tokens  INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  max_cost_micros   INTEGER NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('reserved','settled','uncertain')),
  usage_json        TEXT,
  created_at        TEXT NOT NULL,
  settled_at        TEXT
);

-- Column-for-column learning_cost_ledger, same immutability contract.
CREATE TABLE IF NOT EXISTS coordination_cost_ledger (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES coordination_run(id) ON DELETE CASCADE,
  reservation_id TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('spend','duplicate_spend','denied')),
  dispatches     INTEGER NOT NULL DEFAULT 0,
  cost_micros    INTEGER NOT NULL DEFAULT 0,
  detail_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coordination_cost_ledger_run ON coordination_cost_ledger(run_id, created_at);

CREATE TRIGGER IF NOT EXISTS coordination_cost_ledger_no_update
BEFORE UPDATE ON coordination_cost_ledger
BEGIN SELECT RAISE(ABORT, 'coordination cost ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS coordination_cost_ledger_no_delete
BEFORE DELETE ON coordination_cost_ledger
BEGIN SELECT RAISE(ABORT, 'coordination cost ledger is retained'); END;
`;
