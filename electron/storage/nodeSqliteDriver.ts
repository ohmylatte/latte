import type { DatabaseSync } from 'node:sqlite';
import { optionalRequire } from '../core/optionalRequire';
import type { SqlDriver, SqlParam, SqlRow } from './driver';

interface NodeSqliteModule {
  DatabaseSync: typeof DatabaseSync;
}

export function loadNodeSqlite(): { ok: true; module: NodeSqliteModule } | { ok: false; error: string } {
  const loaded = optionalRequire<NodeSqliteModule>('node:sqlite');
  if (!loaded.ok) return loaded;
  if (typeof loaded.module.DatabaseSync !== 'function') {
    return { ok: false, error: 'node:sqlite: DatabaseSync missing' };
  }
  return loaded;
}

/** Real file-backed SQLite through the Node.js builtin. Durable per statement. */
export class NodeSqliteDriver implements SqlDriver {
  readonly kind = 'node:sqlite' as const;
  readonly file: string;
  private readonly db: DatabaseSync;

  constructor(file: string, mod: NodeSqliteModule) {
    this.file = file;
    this.db = new mod.DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 3000');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: SqlParam[] = []): number {
    const info = this.db.prepare(sql).run(...params);
    return Number(info.changes);
  }

  all<T extends SqlRow = SqlRow>(sql: string, params: SqlParam[] = []): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  get<T extends SqlRow = SqlRow>(sql: string, params: SqlParam[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
