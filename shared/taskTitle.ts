/**
 * N2: EL TÍTULO DE UNA TAREA, UNA SOLA VEZ PARA TODO EL PRODUCTO.
 *
 * El título salía de la primera línea del spec, y el coordinador arranca sus
 * pedidos con un bloque de contexto: las fichas de la tira, las filas y la
 * tarjeta de la propuesta decían "CONTEXTO. Ayulem Pastelería, cliente nuevo
 * (arranque 2026-09-14)…" en vez de lo que la tarea pide.
 *
 * El motor (lo que le dice a un agente) y el renderer (lo que lee la persona)
 * usan ESTA función: dos derivaciones distintas del mismo título es cómo una
 * tarea se llama de una forma en la tira y de otra en el aviso al coordinador.
 *
 * Orden: (1) el `title` que trajo la propuesta, si lo trajo; (2) si hay una
 * línea `Tarea:`/`Task:`, esa; (3) la primera línea que no es preámbulo; (4)
 * si todo es preámbulo, la primera línea con contenido. Recortado a `max`.
 */

/** Las fichas y las filas. */
export const TASK_TITLE_SHORT = 60;
/** El encabezado del run y la tarjeta grande. */
export const TASK_TITLE_LONG = 100;
/** Lo más largo que se guarda de un `title` que manda el coordinador. */
export const TASK_TITLE_STORED = 120;

/** El Markdown del principio de una línea y el énfasis: un título no lleva `#` ni `**`. */
function plain(line: string): string {
  let out = line.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = out;
    out = out.replace(/^#{1,6}\s*/, '').replace(/^>\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '');
    if (out === before) break;
  }
  return out
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Una línea que presenta el pedido pero no ES el pedido. */
function isPreamble(raw: string): boolean {
  const line = raw.trim();
  if (line.startsWith('#')) return true;
  if (/^\*\*(De|From):\*\*/i.test(line)) return true;
  if (/^(CONTEXTO|CONTEXT)\b/.test(line)) return true;
  return /^(contexto|context)\s*:/i.test(plain(line));
}

const TASK_LABEL = /^(tarea|task)\s*:\s*/i;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}

export function taskTitle(spec: string | null | undefined, title?: string | null, max: number = TASK_TITLE_SHORT): string {
  const given = typeof title === 'string' ? plain(title) : '';
  if (given) return clip(given, max);
  const lines = (spec ?? '').split(/\r?\n/).filter((line) => plain(line) !== '');
  if (lines.length === 0) return '';
  const labelled = lines.map(plain).find((line) => TASK_LABEL.test(line));
  if (labelled) {
    const rest = labelled.replace(TASK_LABEL, '').trim();
    if (rest) return clip(rest, max);
  }
  const first = lines.find((line) => !isPreamble(line)) ?? lines[0]!;
  return clip(plain(first), max);
}
