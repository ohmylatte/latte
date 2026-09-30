import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../core/errors';
import type { ManifestAsset } from './payload';

/**
 * E4: LA IDENTIDAD DE UNA MARCA COMO ARNÉS, NO COMO PLANTILLA.
 *
 * Lo que vive acá es puro manejo de archivos:
 *  - cómo se nombra un archivo que la persona trae al kit (el manifest del
 *    módulo exige ids y rutas seguras; la persona trae "logo ayulem.png" y
 *    "Ayulem mayoristas (1).pdf");
 *  - cómo se proyecta el kit APROBADO a cada trabajo, en `identidad/`, donde
 *    los agentes lo leen con nombres normales.
 *
 * Por qué `identidad/` y no el snapshot de generations: el mecanismo de
 * generations exige dos banderas apagadas por defecto (`generation` y
 * `brandKits`) y una política de identidad por trabajo que arranca en
 * neutral, y deja los archivos en `.latte/generations/<id>/assets/` con el id
 * del asset como nombre (sin extensión). Una carpeta con `IDENTIDAD.md` y los
 * archivos con su nombre es lo que un agente lee sin instrucciones extra, y es
 * el menor cambio que funciona con lo que el módulo ya tiene (tablas, borrador,
 * versiones, `publishDraft`). La evidencia sí usa `generations` +
 * `delivery_evidence`: ahí queda el hash del kit que tenía el trabajo.
 */

export const IDENTITY_DIR = 'identidad';
export const IDENTITY_DOC = 'IDENTIDAD.md';
export const IDENTITY_DOC_ASSET_ID = 'identidad';
/** Latte escribe esto en `identidad/`: es lo que distingue la carpeta que mantiene Latte de una que armó la persona. */
const MARKER = '.latte-identidad';

const LOGO_HINT = /logo|isotipo|isologo|imagotipo|marca/i;

export function isIdentityDocName(name: string): boolean {
  return name.trim().toLowerCase() === IDENTITY_DOC.toLowerCase();
}

/** Un nombre de archivo que cumple el manifest: letras, dígitos, `.`, `_`, `-`. Sin acentos, sin espacios, sin paréntesis. */
export function safeFileName(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const stem = path.basename(name, path.extname(name))
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${stem || 'archivo'}${ext}`.slice(0, 120);
}

export function assetKindOf(name: string): ManifestAsset['kind'] {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) return LOGO_HINT.test(name) ? 'logo' : 'reference';
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) return 'font';
  if (['pdf', 'md', 'txt', 'json', 'ase', 'aco', 'csv'].includes(ext)) return 'reference';
  return 'other';
}

/** El id de un asset nuevo: minúsculas, arranca con letra, único en el manifest. */
export function assetIdFor(name: string, taken: ReadonlySet<string>): string {
  let base = path.basename(name, path.extname(name))
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `f-${base}`;
  base = base.slice(0, 56) || 'archivo';
  let id = base;
  for (let n = 2; taken.has(id) || id === IDENTITY_DOC_ASSET_ID; n += 1) id = `${base}-${n}`;
  return id;
}

/** La ruta de un asset nuevo adentro del borrador, única. */
export function assetPathFor(name: string, taken: ReadonlySet<string>): string {
  const safe = safeFileName(name);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = `assets/${safe}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `assets/${stem}-${n}${ext}`;
  return candidate;
}

/** El kit aprobado de una marca, como lo necesita la proyección. */
export interface ApprovedIdentity {
  kitId: string;
  version: number;
  hash: string;
  /** La carpeta inmutable de esa versión del kit. */
  dir: string;
  /** Las rutas relativas (a `dir`) de los archivos usables. */
  files: string[];
}

/**
 * Deja `identidad/` del trabajo igual al kit aprobado, o la saca si no hay
 * kit aprobado. Idempotente: con la marca de Latte al día no toca nada.
 *
 * Una carpeta `identidad/` que no tiene la marca la armó la persona: no se
 * borra nunca; se escribe adentro (los archivos del kit pisan los del mismo
 * nombre) y desde ahí la mantiene Latte.
 */
export function projectIdentity(workDir: string, kit: ApprovedIdentity | null): { hash: string; files: string[] } | null {
  const dir = path.join(workDir, IDENTITY_DIR);
  const marker = path.join(dir, MARKER);
  let stat: fs.Stats | null = null;
  try { stat = fs.lstatSync(dir); } catch { stat = null; }
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new ValidationError('identidad/ tiene que ser una carpeta real, no un archivo ni un enlace');
  const ours = stat !== null && fs.existsSync(marker);
  if (!kit) {
    if (ours) fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const names = kit.files.map((file) => path.basename(file));
  if (ours) {
    try {
      const current = JSON.parse(fs.readFileSync(marker, 'utf8')) as { hash?: string };
      if (current.hash === kit.hash) return { hash: kit.hash, files: names };
    } catch { /* una marca ilegible se reescribe */ }
    // Otra versión del kit: se rearma de cero, que es lo que la marca promete.
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const file of kit.files) {
    const source = path.join(kit.dir, ...file.split('/'));
    const target = path.join(dir, path.basename(file));
    try { fs.chmodSync(target, 0o644); } catch { /* no existía */ }
    fs.copyFileSync(source, target);
    // El kit publicado es de sólo lectura y la copia hereda el atributo: sin
    // esto, rearmar la carpeta con la versión siguiente no podría borrarla.
    try { fs.chmodSync(target, 0o644); } catch { /* best-effort */ }
  }
  fs.writeFileSync(marker, JSON.stringify({ kitId: kit.kitId, version: kit.version, hash: kit.hash }));
  return { hash: kit.hash, files: names };
}

/**
 * E4: el pedido de "Extraer identidad con el equipo". En inglés, como todo lo
 * que Latte le dice a un agente; el documento que produce va en el idioma del
 * trabajo, como cualquier entregable.
 */
export function identityExtractionSpec(brandName: string, sources: readonly string[]): string {
  return [
    `Task: extract the brand identity of ${brandName} into ./borradores/identidad/IDENTIDAD.md.`,
    '',
    `Sources, copied into this work for you: ${sources.map((name) => `./borradores/identidad/fuentes/${name}`).join(', ')}. Read every one. For a PDF, extract its text (pdftotext, pypdf or whatever is available) and look at the pages that show colours, type and logo use.`,
    '',
    'Write IDENTIDAD.md, in the language of this work, with:',
    '- Palette: every colour as hex, with its name and what it is used for.',
    '- Typography: families and weights, and where each one goes.',
    '- Logo: versions, minimum size, clear space, backgrounds, and what not to do.',
    '- Tone of voice, if the sources say it.',
    '- For every item, the source it came from (file and page).',
    '',
    'Do not invent anything the sources do not say: write "no consta" instead. When two sources disagree (for example a colour in a manual and another in a brand kit you can read through your tools, like The Agentcy), do not pick one: write both with their sources under a "Conflictos" heading, and ask the person which one rules with latte_ask.',
    '',
    'Report with latte_report and files ["borradores/identidad/IDENTIDAD.md"]. Latte adds it to the brand identity kit; the person approves it.',
  ].join('\n');
}
