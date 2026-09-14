import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ValidationError } from '../core/errors';
import { contains } from '../workspace/linkFolder';
import { sha256Bytes } from './resolver';
import type { ManifestAsset } from './payload';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const BLOCKED_SVG = /<script|onload\s*=|onerror\s*=|javascript:|<foreignObject|<iframe|<embed|<object/i;

export type StagedAsset = {
  id: string;
  kind: ManifestAsset['kind'];
  required: boolean;
  usable: boolean;
  relativePath: string;
  hash: string;
  bytes: Buffer;
};

function isLink(stat: fs.Stats): boolean {
  return stat.isSymbolicLink();
}

export function assertContainedFile(root: string, candidate: string): string {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(candidate);
  } catch {
    throw new ValidationError(`Asset missing: ${path.basename(candidate)}`);
  }
  if (isLink(lstat)) {
    throw new ValidationError('Symlinks and junctions are not imported');
  }
  const real = fs.realpathSync(candidate);
  if (real !== resolvedRoot && !contains(resolvedRoot, real)) {
    throw new ValidationError('Asset path escapes the brand folder');
  }
  if (!lstat.isFile()) throw new ValidationError('Asset must be a regular file');
  return real;
}

function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 256).toString('utf8');
  return /<svg[\s>]/i.test(head) || head.includes('<?xml');
}

export function validateAssetBytes(bytes: Buffer, relativePath: string): boolean {
  if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) return false;
  if (bytes.includes(0) && !/\.(png|jpg|jpeg|gif|webp|woff2?|ttf|otf|pdf)$/i.test(relativePath)) {
    // text-like assets must not contain NUL
    if (/\.(md|txt|json|svg)$/i.test(relativePath)) return false;
  }
  if (/\.svg$/i.test(relativePath) || looksLikeSvg(bytes) && /\.svg$/i.test(relativePath)) {
    if (BLOCKED_SVG.test(bytes.toString('utf8'))) return false;
  }
  return true;
}

export function stageAssets(brandRoot: string, assets: ManifestAsset[]): StagedAsset[] {
  const staged: StagedAsset[] = [];
  for (const asset of assets) {
    const joined = path.resolve(brandRoot, ...asset.relativePath.split('/'));
    const real = assertContainedFile(brandRoot, joined);
    const bytes = fs.readFileSync(real);
    const usable = validateAssetBytes(bytes, asset.relativePath);
    staged.push({
      id: asset.id,
      kind: asset.kind,
      required: asset.required,
      usable,
      relativePath: asset.relativePath,
      hash: sha256Bytes(bytes),
      bytes,
    });
  }
  return staged;
}

/** Staging on the same volume, then exclusive rename into an immutable destination. */
export function publishImmutableDir(destDir: string, files: Array<{ relativePath: string; bytes: Buffer }>): void {
  const parent = path.dirname(destDir);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(destDir)) {
    throw new ValidationError(`Immutable kit path already exists: ${path.basename(destDir)}`);
  }
  const staging = path.join(parent, `.staging-${process.pid}-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(staging);
  try {
    for (const file of files) {
      const target = path.resolve(staging, ...file.relativePath.split('/'));
      if (target !== staging && !contains(staging, target)) {
        throw new ValidationError('Staged path escaped staging');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes);
    }
    fs.renameSync(staging, destDir);
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* orphan staging is recoverable */ }
    throw error;
  }
  try {
    markTreeReadOnly(destDir);
  } catch {
    // Best-effort; some volumes ignore chmod.
  }
}

function markTreeReadOnly(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markTreeReadOnly(full);
    else fs.chmodSync(full, 0o444);
  }
}

export function readAndVerify(filePath: string, expectedHash: string): Buffer {
  const bytes = fs.readFileSync(filePath);
  const actual = sha256Bytes(bytes);
  if (actual !== expectedHash) {
    throw new ValidationError('Stored asset hash does not match bytes on disk');
  }
  return bytes;
}

export function copyVerified(source: string, dest: string, expectedHash: string): void {
  const bytes = readAndVerify(source, expectedHash);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) throw new ValidationError('Pinned asset already exists');
  fs.writeFileSync(dest, bytes);
  const copied = sha256Bytes(fs.readFileSync(dest));
  if (copied !== expectedHash) throw new ValidationError('Copied asset hash mismatch');
}
