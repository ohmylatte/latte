import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../core/errors';
import { contains } from './linkFolder';
import { DeliverableFiles, deliverableName } from './deliverables';
import { isSafeRelativePath, normalizeRelativePath } from '../../shared/reportFiles';

/**
 * E2: PUBLICAR ES DEJAR UN SOLO VIGENTE.
 *
 * `entregables/` es la frontera: lo que está ahí es lo que el cliente puede
 * recibir. Nadie escribe ahí directo; Latte copia el archivo revisado y, en el
 * mismo acto, pliega en `entregables/.versiones/` todo lo que era "la misma
 * pieza" con otro nombre (la v1..v8, la "Final", la "corta" del caso real).
 *
 * "La misma pieza" es la misma extensión y el mismo nombre una vez que se le
 * sacan los sufijos de versión. No es magia: es la convención que el equipo ya
 * usaba para nombrar, leída al revés.
 */

export const VERSIONS_DIR = '.versiones';

const VERSION_SUFFIX = /[\s._-]*(?:v\s*\d+(?:[._-]\d+)*|versi[oó]n\s*\d+|final|definitiv[oa]|corta|larga|borrador|draft|copia|copy|nuev[oa]|\(\d+\)|\d{4}-\d{2}-\d{2})$/i;

/** La clave de "misma pieza": nombre sin sufijos de versión, en minúsculas, con su extensión. */
export function deliverableKey(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  let stem = fileName.slice(0, fileName.length - ext.length).trim().toLowerCase();
  for (let pass = 0; pass < 6; pass += 1) {
    const next = stem.replace(VERSION_SUFFIX, '').trim();
    if (next === stem || next === '') break;
    stem = next;
  }
  return `${stem.replace(/[\s._-]+/g, ' ').trim()}${ext}`;
}

export interface PublishResult {
  /** La ruta publicada, relativa al trabajo: `entregables/<nombre>`. */
  published: string;
  /** Lo que se plegó, relativo al trabajo: `entregables/.versiones/<nombre>`. */
  archived: string[];
}

function stamp(now: string): string {
  return now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
}

function uniqueTarget(dir: string, base: string, ext: string): string {
  let candidate = path.join(dir, `${base}${ext}`);
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(dir, `${base}-${n}${ext}`);
  return candidate;
}

/**
 * Publica `relativePath` (relativo a `workDir`) en `entregables/`.
 *
 * Tira `ValidationError` —y no toca nada— si la ruta se sale del trabajo, no
 * es un archivo real, apunta a la carpeta interna de Latte o tiene un formato
 * que `entregables/` no admite.
 */
export function publishDeliverable(workDir: string, relativePath: string, now: string): PublishResult {
  if (!isSafeRelativePath(relativePath)) throw new ValidationError(`Not a path inside this work: ${relativePath}`);
  const relative = normalizeRelativePath(relativePath);
  if (relative.split('/')[0] === '.latte') throw new ValidationError('Latte does not publish its own files');
  const root = fs.realpathSync(workDir);
  const source = path.resolve(root, ...relative.split('/'));
  let stat: fs.Stats;
  try { stat = fs.lstatSync(source); } catch { throw new ValidationError(`The reported file is not there: ${relative}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ValidationError(`Only a real file can be published: ${relative}`);
  const real = fs.realpathSync(source);
  if (!contains(root, real)) throw new ValidationError(`Not a path inside this work: ${relative}`);
  const name = deliverableName(path.basename(real));

  const deliverables = new DeliverableFiles(root);
  const dir = deliverables.directory();
  const target = path.join(dir, name);
  const key = deliverableKey(name);
  const archived: string[] = [];
  const versions = path.join(dir, VERSIONS_DIR);

  // La misma pieza, con cualquier nombre: se pliega. El origen, si ya vivía
  // en `entregables/` (alguien escribió ahí directo), se queda: es lo que se
  // publica.
  const siblings = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((entry) => deliverableKey(entry) === key)
    .filter((entry) => path.join(dir, entry) !== real);
  if (siblings.length > 0) fs.mkdirSync(versions, { recursive: true });
  for (const sibling of siblings) {
    const ext = path.extname(sibling);
    const base = sibling.slice(0, sibling.length - ext.length);
    const moved = uniqueTarget(versions, `${base} (${stamp(now)})`, ext);
    fs.renameSync(path.join(dir, sibling), moved);
    archived.push(`entregables/${VERSIONS_DIR}/${path.basename(moved)}`);
  }

  if (real !== target) {
    // `target` ya no existe: si había uno con el mismo nombre, se plegó arriba.
    fs.copyFileSync(real, target, fs.constants.COPYFILE_EXCL);
  }
  return { published: `entregables/${name}`, archived };
}
