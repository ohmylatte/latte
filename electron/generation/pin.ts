import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, writeFileAtomic, writeImmutableFile } from '../core/atomicFile';
import { isValidId } from '../core/ids';
import { safeJoin, WORK_FILES } from '../core/paths';
import type { BrandContextSnapshot, BrandPinAsset, GenerationContext } from '../../shared/generationContracts';
import { GenerationContractError } from './errors';
import { canonicalJson } from './canon';

export type PinAsset = BrandPinAsset;

const PIN_ORIGINS = new Set(['identity', 'signature']);

export interface PinResult {
  directory: string;
  filesWritten: string[];
}

export function generationDirectory(workDir: string, generationId: string): string {
  if (!isValidId(generationId)) throw new GenerationContractError('SCHEMA_INVALID', 'generationId');
  return safeJoin(workDir, WORK_FILES.metaDir, WORK_FILES.generationsDir, generationId);
}

/**
 * Writes `.latte/generations/<id>/context.json` and real file copies under `assets/`.
 * Never creates symlinks or junctions. Exclusive: an existing pin directory is a conflict.
 */
export function pinGeneration(input: {
  workDir: string;
  generationId: string;
  context: GenerationContext;
  snapshot: BrandContextSnapshot | null;
  contextHash: string;
  assets?: PinAsset[];
}): PinResult {
  const dest = generationDirectory(input.workDir, input.generationId);
  const parent = safeJoin(input.workDir, WORK_FILES.metaDir, WORK_FILES.generationsDir);
  ensureDir(parent);
  try {
    fs.mkdirSync(dest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new GenerationContractError('VERSION_CONFLICT', 'Generation pin already exists');
    throw error;
  }

  const filesWritten: string[] = [];
  const envelope = canonicalJson({
    context: input.context,
    contextHash: input.contextHash,
    snapshot: input.snapshot,
  });
  const contextFile = safeJoin(dest, 'context.json');
  writeImmutableFile(contextFile, envelope);
  filesWritten.push(`${WORK_FILES.metaDir}/${WORK_FILES.generationsDir}/${input.generationId}/context.json`);

  const assetsDir = safeJoin(dest, 'assets');
  for (const asset of input.assets ?? []) {
    if (!PIN_ORIGINS.has(asset.origin)) {
      throw new GenerationContractError('SCHEMA_INVALID', `unsafe asset origin ${asset.origin}`);
    }
    if (!isValidId(asset.id) && !/^[a-zA-Z0-9._-]{1,64}$/.test(asset.id)) {
      throw new GenerationContractError('SCHEMA_INVALID', `unsafe asset id ${asset.id}`);
    }
    const file = safeJoin(assetsDir, asset.origin, asset.id);
    writeFileAtomic(file, asset.bytes);
    try { fs.chmodSync(file, 0o444); } catch { /* best-effort immutability */ }
    assertNotSymlink(file);
    filesWritten.push(`${WORK_FILES.metaDir}/${WORK_FILES.generationsDir}/${input.generationId}/assets/${asset.origin}/${asset.id}`);
  }
  assertNotSymlink(contextFile);
  assertNotSymlink(dest);
  return { directory: dest, filesWritten };
}

function assertNotSymlink(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new GenerationContractError('CANONICALIZE_FAILED', `refusing symlink at ${path.basename(target)}`);
  }
}

/** Copy bytes from a source file, rejecting traversal and outbound links. */
export function readPinSourceBytes(root: string, relative: string): Uint8Array {
  const segments = relative.split(/[/\\]/).filter((s) => s.length > 0);
  const resolved = safeJoin(root, ...segments);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new GenerationContractError('CANONICALIZE_FAILED', 'refusing to pin a symlink');
  }
  return fs.readFileSync(resolved);
}
