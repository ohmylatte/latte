import { ValidationError } from '../core/errors';
import { ID_PATTERN } from '../core/ids';
import { isHexSha256 } from '../core/canonical';
import { isLearningId } from './ids';
import { MAX_MARKDOWN_BYTES, type CandidatePayload, type EvidenceRef } from './types';

const SKILL_NAME = /^[a-z][a-z0-9-]{1,62}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /api[_-]?key\s*[:=]\s*\S+/i,
  /bearer\s+[a-z0-9._\-+/=]{12,}/i,
  /ghp_[a-zA-Z0-9]{20,}/,
  /xox[baprs]-/,
  /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9._-]{10,}/,
];
const AUTO_APPROVE = /auto-?approve|skip(?:ping)? review|without human(?: review)?|self-?approv/i;
const HTML_OR_SCRIPT = /<\s*(script|iframe|object|embed|link|meta)\b/i;
const EXEC_FENCE = /```(?:bash|sh|zsh|powershell|pwsh|cmd|javascript|js|python|py|ruby|go|osascript)\b/i;
const REMOTE_FETCH = /https?:\/\/[^\s)]+/i;

export function requireHexSha256(value: unknown, name: string): string {
  if (!isHexSha256(value)) throw new ValidationError(`${name} must be a SHA-256 hex digest`);
  return value;
}

export function assertSafePackagePath(relative: string): void {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0')) {
    throw new ValidationError('Unsafe package path');
  }
  if (/^[a-zA-Z]:/.test(relative) || relative.startsWith('/') || relative.startsWith('\\\\')) {
    throw new ValidationError('Package path must stay relative');
  }
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.includes('..') || normalized.split('/').some((part) => part === '' || part === '.' || WINDOWS_RESERVED.test(part))) {
    throw new ValidationError('Package path traversal or reserved name');
  }
}

function rejectSecrets(text: string, field: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new ValidationError(`${field} looks like a secret; blocked before persist`);
  }
}

function rejectInjection(text: string, field: string): void {
  if (AUTO_APPROVE.test(text)) throw new ValidationError(`${field} must not instruct auto-approval`);
  if (HTML_OR_SCRIPT.test(text)) throw new ValidationError(`${field} must not contain active HTML`);
  if (EXEC_FENCE.test(text)) throw new ValidationError(`${field} must not include scripts in the MVP`);
}

function rejectUnsafeLinks(markdown: string): void {
  const link = /\[[^\]]*]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = link.exec(markdown))) {
    const href = match[1].trim();
    if (href.startsWith('javascript:') || href.startsWith('data:') || href.startsWith('file:')) {
      throw new ValidationError('Markdown link protocol is not allowed');
    }
    if (href.includes('..') || /^[a-zA-Z]:/.test(href) || href.startsWith('\\\\') || href.startsWith('/')) {
      throw new ValidationError('Markdown link escapes the package');
    }
    if (REMOTE_FETCH.test(href)) throw new ValidationError('Remote URLs are not imported in the MVP');
  }
}

export function validateCandidatePayload(value: unknown): CandidatePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Candidate payload must be an object');
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!['name', 'description', 'markdown', 'targetSkillId', 'base'].includes(key)) {
      throw new ValidationError(`Unknown field: ${key}`);
    }
  }
  if (typeof rec.name !== 'string' || !SKILL_NAME.test(rec.name) || WINDOWS_RESERVED.test(rec.name)) {
    throw new ValidationError('Invalid skill name');
  }
  if (typeof rec.description !== 'string' || rec.description.trim().length < 8 || rec.description.length > 500) {
    throw new ValidationError('Invalid skill description');
  }
  if (typeof rec.markdown !== 'string' || rec.markdown.trim().length < 24) {
    throw new ValidationError('Skill markdown is too short to be a reusable procedure');
  }
  const markdownBytes = Buffer.byteLength(rec.markdown, 'utf8');
  if (markdownBytes > MAX_MARKDOWN_BYTES) {
    throw new ValidationError(`Skill markdown exceeds ${MAX_MARKDOWN_BYTES} bytes`);
  }
  rejectSecrets(rec.name, 'name');
  rejectSecrets(rec.description, 'description');
  rejectSecrets(rec.markdown, 'markdown');
  rejectInjection(rec.description, 'description');
  rejectInjection(rec.markdown, 'markdown');
  rejectUnsafeLinks(rec.markdown);
  if (rec.markdown.includes('\0') || rec.description.includes('\0')) {
    throw new ValidationError('NUL byte is not allowed');
  }
  let targetSkillId: string | null = null;
  if (rec.targetSkillId !== null && rec.targetSkillId !== undefined) {
    if (!isLearningId(rec.targetSkillId, 'lsk')) {
      throw new ValidationError('targetSkillId must be a learned skill id; shipped skills cannot be overwritten');
    }
    targetSkillId = rec.targetSkillId;
  }
  let base: CandidatePayload['base'] = null;
  if (rec.base !== null && rec.base !== undefined) {
    if (typeof rec.base !== 'object' || rec.base === null || Array.isArray(rec.base)) {
      throw new ValidationError('Invalid base');
    }
    const baseRec = rec.base as Record<string, unknown>;
    if (typeof baseRec.version !== 'number' || !Number.isInteger(baseRec.version) || baseRec.version < 1) {
      throw new ValidationError('Invalid base version');
    }
    base = { version: baseRec.version, hash: requireHexSha256(baseRec.hash, 'base.hash') };
  }
  return {
    name: rec.name,
    description: rec.description.trim(),
    markdown: rec.markdown,
    targetSkillId,
    base,
  };
}

export function validateEvidenceRefs(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value)) throw new ValidationError('evidenceRefs must be an array');
  if (value.length > 32) throw new ValidationError('Too many evidence refs');
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ValidationError(`evidenceRefs[${index}] is invalid`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.documentId !== 'string' || !ID_PATTERN.test(rec.documentId)) {
      throw new ValidationError(`evidenceRefs[${index}].documentId is invalid`);
    }
    if (typeof rec.revisionId !== 'string' || !ID_PATTERN.test(rec.revisionId)) {
      throw new ValidationError(`evidenceRefs[${index}].revisionId is invalid`);
    }
    return {
      documentId: rec.documentId,
      revisionId: rec.revisionId,
      hash: requireHexSha256(rec.hash, `evidenceRefs[${index}].hash`),
    };
  });
}

export function validateSourceKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 240 || value.includes('\0')) {
    throw new ValidationError('Invalid sourceKey');
  }
  return value;
}
