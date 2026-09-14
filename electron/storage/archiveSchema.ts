/**
 * Additive brand archive table. Registered from schema.ts.
 * Soft-delete only: a row here hides the brand from listBrands.
 * No ON DELETE CASCADE — nothing in this feature deletes a brand.
 */
export const ARCHIVE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS brand_archives (
  brand_id TEXT PRIMARY KEY REFERENCES brands(id),
  archived_at TEXT NOT NULL
);
`;
