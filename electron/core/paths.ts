import path from 'node:path';
import { ValidationError } from './errors';
import { isValidId } from './ids';

/**
 * Joins path segments under a root and guarantees the result stays inside it.
 * Segments must be app-generated ids or fixed file names; anything containing
 * a separator, a drive letter or ".." is rejected before touching the disk.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.length === 0) {
      throw new ValidationError('Empty path segment');
    }
    const hasSeparator = segment.includes('/') || segment.includes('\\');
    const looksLikeDrive = /^[a-zA-Z]:/.test(segment);
    if (segment === '.' || segment === '..' || hasSeparator || looksLikeDrive || segment.includes('\0')) {
      throw new ValidationError(`Unsafe path segment: ${JSON.stringify(segment)}`);
    }
  }
  const target = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ValidationError('Path escapes the Latte data directory');
  }
  return target;
}

export const WORK_FILES = {
  brief: 'brief.md',
  claude: 'CLAUDE.md',
  agents: 'AGENTS.md',
  metaDir: '.latte',
  snapshotsDir: 'snapshots',
  readme: 'README.md',
  /** Full copies of sections the instruction files had to truncate (brand context, decisions). */
  contextDir: 'context',
  /** Full bodies of skills the instruction files reference by pointer instead of inlining. */
  skillsDir: 'skills',
  /**
   * Pinned generation receipts. Not a side-file dir: syncSideFiles must never
   * walk or delete this name. Do not reuse snapshots/context/skills.
   */
  generationsDir: 'generations',
} as const;

export class LattePaths {
  readonly root: string;
  readonly dbFile: string;
  readonly brandsDir: string;
  /**
   * Works linked to a folder the user picked. Latte then works IN that folder
   * instead of keeping a copy: no duplicate of the client's material.
   */
  private readonly linked = new Map<string, string>();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.dbFile = path.join(this.root, 'latte.db');
    this.brandsDir = path.join(this.root, 'brands');
  }

  /** Registers an external folder for a work. The path is validated by the caller. */
  linkWork(workId: string, directory: string): void {
    assertId(workId, 'workId');
    this.linked.set(workId, path.resolve(directory));
  }

  isLinked(workId: string): boolean {
    return this.linked.has(workId);
  }

  brandDir(brandId: string): string {
    assertId(brandId, 'brandId');
    return safeJoin(this.brandsDir, brandId);
  }

  workDir(brandId: string, workId: string): string {
    assertId(workId, 'workId');
    const linked = this.linked.get(workId);
    if (linked) return linked;
    return safeJoin(this.brandDir(brandId), 'works', workId);
  }

  workFile(brandId: string, workId: string, file: string): string {
    return safeJoin(this.workDir(brandId, workId), file);
  }

  snapshotsDir(brandId: string, workId: string): string {
    return safeJoin(this.workDir(brandId, workId), WORK_FILES.metaDir, WORK_FILES.snapshotsDir);
  }

  snapshotFile(brandId: string, workId: string, fileName: string): string {
    return safeJoin(this.snapshotsDir(brandId, workId), fileName);
  }
}

export function assertId(value: unknown, name: string): asserts value is string {
  if (!isValidId(value)) {
    throw new ValidationError(`Invalid ${name}`);
  }
}
