import { ValidationError } from '../core/errors';
import { requireId, requireInt, requireLabel, requireText } from '../services/validation';
import { isSha256 } from './resolver';
import type { Choice } from './types';

const CHOICE_IDENTITIES = new Set(['brand', 'agency', 'neutral']);
const CHOICE_SIGNATURES = new Set(['none', 'agency']);
const ASSET_KINDS = new Set(['logo', 'font', 'reference', 'other']);
const ASSET_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const RELATIVE_PATH = /^(?!\/)(?![a-zA-Z]:)(?!.*\.\.)[a-zA-Z0-9._/-]+$/;

export function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new ValidationError(`${name} has unknown fields: ${extra.join(', ')}`);
}

export function requirePlainObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireChoice(value: unknown): Choice {
  const obj = requirePlainObject(value, 'choice');
  rejectUnknownKeys(obj, ['identity', 'signature'], 'choice');
  const { identity, signature } = obj;
  if (typeof identity !== 'string' || !CHOICE_IDENTITIES.has(identity)) {
    throw new ValidationError('choice.identity is invalid');
  }
  if (typeof signature !== 'string' || !CHOICE_SIGNATURES.has(signature)) {
    throw new ValidationError('choice.signature is invalid');
  }
  return { identity: identity as Choice['identity'], signature: signature as Choice['signature'] };
}

export function requireWorkId(value: unknown): string {
  return requireId(value, 'workId');
}

export function requireExpectedVersion(value: unknown): number {
  return requireInt(value, 'expectedVersion', 0, 1_000_000);
}

export function requireExpectedRevision(value: unknown): number {
  return requireInt(value, 'expectedRevision', 0, 1_000_000);
}

const SECRETISH = /password|secret|token|apikey|api_key|private_key|credential/i;

export function requireAgencyPatch(value: unknown): { publicName: string; website: string | null; contact: string | null } {
  const obj = requirePlainObject(value, 'agency patch');
  rejectUnknownKeys(obj, ['publicName', 'website', 'contact'], 'agency patch');
  for (const key of Object.keys(obj)) {
    if (SECRETISH.test(key)) throw new ValidationError('agency patch cannot carry secrets');
  }
  const publicName = requireLabel(obj.publicName, 'publicName', 120);
  const website = obj.website === undefined || obj.website === null || obj.website === ''
    ? null
    : requireText(obj.website, 'website', 500).trim();
  if (website !== null && !/^https?:\/\//i.test(website)) {
    throw new ValidationError('website must be an http(s) URL');
  }
  const contact = obj.contact === undefined || obj.contact === null || obj.contact === ''
    ? null
    : requireText(obj.contact, 'contact', 500).trim();
  if (contact && SECRETISH.test(contact)) {
    throw new ValidationError('contact cannot look like a secret');
  }
  return { publicName, website, contact };
}

export type ManifestAsset = {
  id: string;
  kind: 'logo' | 'font' | 'reference' | 'other';
  relativePath: string;
  required: boolean;
};

export type BrandManifest = {
  schemaVersion: 1;
  permitsAgencySignature: boolean;
  assets: ManifestAsset[];
};

export function parseManifest(raw: string): BrandManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('manifest.json is not valid JSON');
  }
  const obj = requirePlainObject(parsed, 'manifest');
  rejectUnknownKeys(obj, ['schemaVersion', 'permitsAgencySignature', 'assets', 'name'], 'manifest');
  if (obj.schemaVersion !== 1) throw new ValidationError('manifest.schemaVersion must be 1');
  if (typeof obj.permitsAgencySignature !== 'boolean') {
    throw new ValidationError('manifest.permitsAgencySignature must be a boolean');
  }
  if (!Array.isArray(obj.assets) || obj.assets.length > 50) {
    throw new ValidationError('manifest.assets must be an array of at most 50 items');
  }
  const assets: ManifestAsset[] = [];
  const seen = new Set<string>();
  for (const item of obj.assets) {
    const asset = requirePlainObject(item, 'manifest asset');
    rejectUnknownKeys(asset, ['id', 'kind', 'relativePath', 'required'], 'manifest asset');
    if (typeof asset.id !== 'string' || !ASSET_ID.test(asset.id)) throw new ValidationError('Invalid asset id');
    if (seen.has(asset.id)) throw new ValidationError(`Duplicate asset id: ${asset.id}`);
    seen.add(asset.id);
    if (typeof asset.kind !== 'string' || !ASSET_KINDS.has(asset.kind)) throw new ValidationError('Invalid asset kind');
    if (typeof asset.relativePath !== 'string' || !RELATIVE_PATH.test(asset.relativePath) || asset.relativePath.includes('\\') || asset.relativePath.includes('\0')) {
      throw new ValidationError(`Unsafe asset path: ${String(asset.relativePath)}`);
    }
    if (typeof asset.required !== 'boolean') throw new ValidationError('asset.required must be a boolean');
    assets.push({
      id: asset.id,
      kind: asset.kind as ManifestAsset['kind'],
      relativePath: asset.relativePath,
      required: asset.required,
    });
  }
  return {
    schemaVersion: 1,
    permitsAgencySignature: obj.permitsAgencySignature,
    assets,
  };
}

export function assertSha256(value: string, name: string): void {
  if (!isSha256(value)) throw new ValidationError(`Invalid ${name}`);
}

export function rulesLookUntrusted(rules: string): string[] {
  const warnings: string[] = [];
  const lower = rules.toLocaleLowerCase('und');
  if (/(le[eé]|read|exfiltrat|secret|api[_-]?key|password)/i.test(lower) && /(secret|clave|token|password)/i.test(lower)) {
    warnings.push('brand.md pide secretos; se guarda como dato y no cambia permisos');
  }
  if (/(habilit[aá]|enable|autoriz|allow).{0,40}(firma|signature|permiso|permission|auto)/i.test(lower)) {
    warnings.push('brand.md intenta cambiar firma o permisos; se ignora');
  }
  return warnings;
}
