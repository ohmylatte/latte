import fs from 'node:fs';
import path from 'node:path';
import { asEffortTier } from '../agents/tiers';
import { parseAvatar } from '../../shared/avatar';
import type { InstructionPack, PackRole, PackSkill } from './instructions';

interface PackManifest {
  id?: unknown;
  version?: unknown;
  title?: unknown;
  instructions?: unknown;
  base?: unknown;
  roles?: unknown;
  skills?: unknown;
}

const PACK_BODY_LIMIT = 40_000;
const ROLE_BODY_LIMIT = 8_000;
const ROLE_ID = /^[a-z][a-z0-9-]{0,40}$/;
const MARKDOWN_FILE = /^[a-zA-Z0-9._-]+\.md$/;

/**
 * Loads a versioned instruction pack shipped with the app (packs/<id>/).
 * Missing or malformed packs degrade to null: the agent still gets brand and
 * work context, just without the discipline layer.
 */
export function loadInstructionPack(packsDir: string, id = 'marketing-core'): InstructionPack | null {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) return null;
  const dir = path.join(packsDir, id);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as PackManifest;
    const file = typeof manifest.instructions === 'string' && MARKDOWN_FILE.test(manifest.instructions)
      ? manifest.instructions
      : 'instructions.md';
    const body = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, PACK_BODY_LIMIT);
    return {
      base: readOptional(dir, manifest.base, 'base.md'),
      id: typeof manifest.id === 'string' ? manifest.id : id,
      title: typeof manifest.title === 'string' ? manifest.title : id,
      version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
      body,
      roles: loadRoles(dir, manifest.roles),
      skills: loadSkills(dir, manifest.skills),
    };
  } catch {
    return null;
  }
}

/**
 * Roles live in packs/<id>/roles/<roleId>.md: a small front matter block
 * (name, initial, summary, and an optional avatar and tier) followed by the
 * instructions. A broken role file is skipped; it never takes the whole pack
 * down.
 */
function loadRoles(dir: string, declared: unknown): PackRole[] {
  if (!Array.isArray(declared)) return [];
  const roles: PackRole[] = [];
  const seen = new Set<string>();
  for (const entry of declared) {
    if (typeof entry !== 'string' || !ROLE_ID.test(entry) || seen.has(entry)) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, 'roles', `${entry}.md`), 'utf8').slice(0, ROLE_BODY_LIMIT);
      const role = parseRole(entry, raw);
      if (role) {
        roles.push(role);
        seen.add(entry);
      }
    } catch {
      /* skip this role */
    }
  }
  return roles;
}

/**
 * Skills live in packs/<id>/skills/<skillId>.md, with the same front matter
 * shape as roles. A role is who works; a skill is how everyone writes, so a
 * skill carries no initial and belongs to no single member.
 */
function loadSkills(dir: string, declared: unknown): PackSkill[] {
  if (!Array.isArray(declared)) return [];
  const skills: PackSkill[] = [];
  const seen = new Set<string>();
  for (const entry of declared) {
    if (typeof entry !== 'string' || !ROLE_ID.test(entry) || seen.has(entry)) continue;
    try {
      const parsed = parseRole(entry, fs.readFileSync(path.join(dir, 'skills', `${entry}.md`), 'utf8').slice(0, PACK_BODY_LIMIT));
      if (!parsed) continue;
      skills.push({ id: parsed.id, name: parsed.name, summary: parsed.summary, body: parsed.instructions });
      seen.add(entry);
    } catch {
      /* one broken skill never takes the pack down */
    }
  }
  return skills;
}

/** A missing or malformed behaviour file degrades to empty, never to a broken pack. */
function readOptional(dir: string, declared: unknown, fallback: string): string {
  const name = typeof declared === 'string' && MARKDOWN_FILE.test(declared) ? declared : fallback;
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8').slice(0, PACK_BODY_LIMIT).trim();
  } catch {
    return '';
  }
}

export function parseRole(id: string, raw: string): PackRole | null {
  const text = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    meta[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const name = (meta.name ?? '').slice(0, 40);
  if (!name) return null;
  const instructions = match[2].trim();
  if (!instructions) return null;
  return {
    id,
    name,
    initial: (meta.initial || name).slice(0, 1).toUpperCase(),
    summary: (meta.summary ?? '').slice(0, 200),
    // Optional, and tolerant: a pack written before avatars existed, or one
    // with a typo, gets the face its id deserves instead of no role at all.
    avatar: parseAvatar(meta.avatar) === null ? null : meta.avatar!.trim().toLowerCase(),
    // Optional, and never a reason to drop a role: a pack written before tiers
    // existed, or one with a typo in the value, opens at the default effort.
    tier: asEffortTier(meta.tier),
    instructions,
  };
}
