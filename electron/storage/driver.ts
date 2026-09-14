export type SqlParam = string | number | null;

export type SqlRow = Record<string, string | number | null>;

/**
 * Minimal synchronous SQL surface shared by both SQLite engines.
 * Keeping it tiny is the point: the repository speaks plain SQL and never
 * knows which engine is underneath.
 */
export interface SqlDriver {
  readonly kind: 'node:sqlite' | 'sql.js';
  readonly file: string;
  exec(sql: string): void;
  /** Affected rows of this statement. Callers that need CAS must use this, not `SELECT changes()` after a flush. */
  run(sql: string, params?: SqlParam[]): number;
  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): T[];
  get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): T | undefined;
  transaction<T>(fn: () => T): T;
  close(): void;
}
