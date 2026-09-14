import fs from 'node:fs';
import type { Database, SqlJsStatic } from 'sql.js';
import { writeFileAtomic } from '../core/atomicFile';
import { optionalRequire } from '../core/optionalRequire';
import type { SqlDriver, SqlParam, SqlRow } from './driver';

type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;

/**
 * WebAssembly SQLite fallback. Same schema, same SQL, zero native code.
 * The whole database lives in memory and is flushed atomically to disk after
 * every write, which is perfectly fine for metadata-sized workloads.
 */
export class SqlJsDriver implements SqlDriver {
  readonly kind = 'sql.js' as const;
  readonly file: string;
  private readonly db: Database;
  private depth = 0;
  private dirty = false;

  private constructor(file: string, db: Database) {
    this.file = file;
    this.db = db;
  }

  static async open(file: string): Promise<SqlJsDriver> {
    const loaded = optionalRequire<InitSqlJs>('sql.js');
    if (!loaded.ok) throw new Error(`sql.js unavailable: ${loaded.error}`);
    const SQL = await loaded.module();
    const existing = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
    const db = new SQL.Database(existing);
    db.run('PRAGMA foreign_keys = ON');
    return new SqlJsDriver(file, db);
  }

  exec(sql: string): void {
    this.db.exec(sql);
    this.markDirty();
  }

  run(sql: string, params: SqlParam[] = []): number {
    this.db.run(sql, params);
    // Read changes() on this connection BEFORE flush(). export() reopens the
    // handle and sqlite3_changes() resets to 0, which would turn a successful
    // INSERT ON CONFLICT DO NOTHING into a false VERSION_CONFLICT.
    const n = Number(this.get<{ n: number }>('SELECT changes() AS n')?.n ?? 0);
    this.markDirty();
    return n;
  }

  all<T extends SqlRow = SqlRow>(sql: string, params: SqlParam[] = []): T[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  get<T extends SqlRow = SqlRow>(sql: string, params: SqlParam[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN');
    this.depth += 1;
    try {
      const result = fn();
      this.db.run('COMMIT');
      this.depth -= 1;
      this.markDirty();
      return result;
    } catch (error) {
      this.db.run('ROLLBACK');
      this.depth -= 1;
      throw error;
    }
  }

  close(): void {
    this.flush();
    this.db.close();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.depth === 0) this.flush();
  }

  private flush(): void {
    if (!this.dirty) return;
    writeFileAtomic(this.file, this.db.export());
    // export() closes and reopens the connection internally, which resets
    // per-connection pragmas. Re-arm foreign keys or the fallback would be
    // weaker than the primary engine.
    this.db.run('PRAGMA foreign_keys = ON');
    this.dirty = false;
  }
}
