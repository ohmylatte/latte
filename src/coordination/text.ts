/**
 * C3: EL TEXTO DEL MOTOR, LEÍDO COMO LO QUE LA PERSONA TIENE QUE LEER.
 *
 * Los specs de tarea, los prompts de despacho y los resúmenes de reporte salen
 * de agentes que escriben Markdown. Esta pantalla no es un lector de Markdown:
 * es una línea de tiempo donde cada hecho entra en uno o dos renglones. Un
 * título que empieza con `#` no es un título con estilo, es un numeral suelto
 * en el medio de una frase — exactamente lo que la captura del dueño mostraba
 * ("despachó: # Piezas exactas…").
 *
 * Todo acá es PURO: sin React, sin i18n, sin DOM. Es lo único que hay que
 * poder probar sin montar medio panel.
 */

/**
 * El nombre de archivo, tal como un resumen lo nombra.
 *
 * NO se inventa una lista de archivos producidos: el modelo de datos no la
 * tiene. Lo único que existe es el texto del reporte, y si ese texto nombra
 * `piezas-para-produccion-cm.md`, eso es un hecho que se puede mostrar. Si no
 * lo nombra, no hay ficha.
 */
import { fileBaseName } from '../../shared/reportFiles';

const FILE_EXTENSIONS = [
  'md', 'txt', 'csv', 'json', 'yaml', 'yml',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'pdf', 'docx', 'xlsx', 'pptx', 'mp4', 'mov', 'zip',
] as const;

/** Un nombre de archivo es una palabra con punto y una extensión conocida. Nada de rutas absolutas ni ids. */
const FILE_PATTERN = new RegExp(
  String.raw`(?:^|[\s(\[<"'` + '`' + String.raw`])([A-Za-z0-9._-]+\.(?:${FILE_EXTENSIONS.join('|')}))(?![A-Za-z0-9])`,
  'gi',
);

/**
 * Los archivos que ESTE texto nombra, sin repetir y en el orden en que
 * aparecen. Vacío cuando no nombra ninguno — que es la mayoría de las veces, y
 * está bien: una ficha de archivo inventada sería peor que ninguna.
 */
/**
 * E2: los archivos de un reporte, de la LISTA que trajo cuando la trajo —y
 * sólo el nombre de cada uno: ninguna pantalla muestra rutas—; si no, los que
 * nombra el resumen, como siempre.
 */
export function reportFileNames(files: readonly string[] | null | undefined, text: string | null | undefined, max = 6): string[] {
  if (!files || files.length === 0) return fileNames(text, max);
  return [...new Set(files.map(fileBaseName))].slice(0, max);
}

export function fileNames(text: string | null | undefined, max = 6): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(FILE_PATTERN)) {
    const name = match[1]!;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * C3 BUG (a): EL NUMERAL DE MARKDOWN NO LLEGA A LA PANTALLA.
 *
 * Se limpia el encabezado (`#`…`######`), el énfasis (`**`, `*`, `_`, `` ` ``),
 * la viñeta de lista (`-`, `*`, `+`), la numeración (`1.`) y la cita (`>`).
 * Sólo del PRINCIPIO de la línea: un `#` en el medio de una frase es un
 * carácter que la persona escribió, no sintaxis.
 *
 * Se aplica en el puente (donde nace el título de la tarea) Y acá, en el
 * render: un título viejo, ya guardado con su numeral, sigue leyéndose bien.
 */
export function stripMarkdown(line: string): string {
  let out = line.trim();
  // Cita y viñeta pueden venir anidadas: `> - **Cosa**`.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = out;
    out = out.replace(/^#{1,6}\s+/, '');
    out = out.replace(/^>\s*/, '');
    out = out.replace(/^[-*+]\s+/, '');
    out = out.replace(/^\d+[.)]\s+/, '');
    if (out === before) break;
  }
  // El énfasis envuelve, no prefija: se saca de los dos extremos y del medio.
  out = out.replace(/\*\*(.+?)\*\*/g, '$1');
  out = out.replace(/__(.+?)__/g, '$1');
  out = out.replace(/`([^`]+)`/g, '$1');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Un `#` pelado que quedó solo al principio (sin espacio) tampoco es un título.
  out = out.replace(/^#+\s*/, '');
  return out.trim();
}

/**
 * La primera línea con contenido de un texto, ya limpia y recortada.
 *
 * `firstLine` de `./inbox` hace el recorte pero no la limpieza: existe desde
 * antes y la usa el buzón viejo. Acá se agrega la limpieza, que es lo que el
 * diseño nuevo pide para CADA título en pantalla.
 */
export function titleOf(text: string | null | undefined, max = 120): string {
  if (!text) return '';
  for (const raw of text.split(/\r?\n/)) {
    const line = stripMarkdown(raw);
    if (line === '') continue;
    return line.length > max ? line.slice(0, max).trimEnd() + '…' : line;
  }
  return '';
}

/**
 * El CUERPO de un texto: lo que sigue después del título, en una línea y en
 * gris. Vacío cuando el texto es una sola línea — y entonces el render no
 * dibuja un renglón vacío debajo del título.
 */
export function bodyOf(text: string | null | undefined, max = 200): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/).map(stripMarkdown).filter((l) => l !== '');
  if (lines.length <= 1) return '';
  const rest = lines.slice(1).join(' ');
  return rest.length > max ? rest.slice(0, max).trimEnd() + '…' : rest;
}

/**
 * Las iniciales de un nombre visible, para el avatar. Nunca un id: el avatar
 * es la forma más corta del nombre, no su clave.
 *
 * Una palabra da una letra; dos o más dan las dos primeras iniciales
 * ("Community Manager" → "CM", "Asistente" → "A").
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]!.slice(0, 1) + words[1]!.slice(0, 1)).toUpperCase();
}
