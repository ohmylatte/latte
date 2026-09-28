import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ValidationError } from '../core/errors';
import { contains } from '../workspace/linkFolder';
import { sha256Bytes } from '../core/canonical';
import type { ManifestAsset } from './payload';

// E4: un manual de marca en PDF pesa más que un logo. 32 MB alcanza para los
// manuales reales sin dejar entrar cualquier cosa.
export const MAX_ASSET_BYTES = 32 * 1024 * 1024;
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

export function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '');
  if (/<svg[\s>/]/i.test(head)) return true;
  if (/^\s*<\?xml/i.test(head) && /<svg[\s>/]/i.test(bytes.subarray(0, 4096).toString('utf8'))) return true;
  return false;
}

function looksLikeXmlText(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 256).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('<') || head.startsWith('<?xml');
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isGif(bytes: Buffer): boolean {
  return bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
}

function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

export function validateAssetBytes(bytes: Buffer, relativePath: string): boolean {
  if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) return false;
  const raster = /\.(png|jpg|jpeg|gif|webp)$/i.test(relativePath);
  const namedSvg = /\.svg$/i.test(relativePath);
  const svgBytes = looksLikeSvg(bytes);
  if (namedSvg || svgBytes) {
    if (BLOCKED_SVG.test(bytes.toString('utf8'))) return false;
  }
  if (raster && (svgBytes || looksLikeXmlText(bytes))) return false;
  if (/\.png$/i.test(relativePath) && !isPng(bytes)) return false;
  if (/\.(jpg|jpeg)$/i.test(relativePath) && !isJpeg(bytes)) return false;
  if (/\.gif$/i.test(relativePath) && !isGif(bytes)) return false;
  if (/\.webp$/i.test(relativePath) && !isWebp(bytes)) return false;
  if (bytes.includes(0) && !/\.(png|jpg|jpeg|gif|webp|woff2?|ttf|otf|pdf)$/i.test(relativePath)) {
    if (/\.(md|txt|json|svg)$/i.test(relativePath)) return false;
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


