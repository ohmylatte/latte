/**
 * E2: LOS ARCHIVOS QUE PRODUJO UNA TAREA, COMO LISTA.
 *
 * `latte_report.files` era un texto libre y la interfaz sacaba los nombres del
 * resumen con una expresión regular. Ahora el agente puede mandar una lista de
 * rutas RELATIVAS al trabajo; se guarda como JSON en la misma columna, y un
 * reporte viejo (texto) sigue leyéndose como antes: `reportedFiles` devuelve
 * `null` y la pantalla cae en la regex de siempre.
 *
 * Vive en `shared/` porque la usan el motor (qué publicar), el servicio (la
 * bitácora) y la interfaz (qué mostrar), y dos lecturas distintas del mismo
 * campo es cómo la pantalla y el motor terminan hablando de archivos distintos.
 */

/** Cuántas rutas entran en un reporte. Un reporte con más no es un reporte: es un listado de carpeta. */
export const MAX_REPORTED_FILES = 50;
/** El largo de una ruta relativa. */
export const REPORTED_FILE_MAX = 500;

/** Una ruta relativa al trabajo, que no se sale de él: sin raíz, sin unidad, sin `..`. */
export function isSafeRelativePath(value: string): boolean {
  const path = value.trim().replace(/\\/g, '/');
  if (!path || path.length > REPORTED_FILE_MAX) return false;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.startsWith('~')) return false;
  if (path.includes('\0')) return false;
  const parts = path.split('/');
  return !parts.some((part) => part === '..');
}

/** La ruta en su forma de guardar: barras normales, sin `./` al principio. */
export function normalizeRelativePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

/**
 * Lo que se guarda en `files_json`: la lista normalizada, en JSON. Una lista
 * vacía es `null` (no produjo archivos), no `"[]"`.
 */
export function encodeReportedFiles(files: readonly string[]): string | null {
  const clean = [...new Set(files.map(normalizeRelativePath).filter(Boolean))];
  return clean.length === 0 ? null : JSON.stringify(clean);
}

/**
 * La lista, si el reporte la trajo como lista. `null` para un reporte sin
 * archivos o con el texto libre de antes: quien lee decide qué hacer con eso.
 */
export function reportedFiles(filesJson: string | null | undefined): string[] | null {
  if (!filesJson) return null;
  const text = filesJson.trim();
  if (!text.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

/** El nombre del archivo, sin carpetas: lo único que una pantalla muestra de una ruta. */
export function fileBaseName(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? value;
}
