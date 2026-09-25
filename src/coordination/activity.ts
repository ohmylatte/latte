import { translate as t } from '../i18n';
import type { ChatMessage, ChatPart, CoordinationLogEntryView } from '../../shared/contracts';

/**
 * N1: LO QUE UN MIEMBRO ESTÁ HACIENDO AHORA, LEÍDO DE SU PROPIA SESIÓN.
 *
 * "Cada bot aislado, uno consolida": el modo Equipo no es un chat de todos,
 * pero tiene que mostrar que trabajan. La bitácora del run sólo sabe que hubo
 * un despacho y, mucho después, un reporte; en el medio el miembro lee,
 * busca y escribe, y todo eso ya llega al renderer como partes `tool` de su
 * conversación. Esto las traduce a una frase corta: un verbo y un objeto.
 *
 * Reglas del presupuesto de palabras: nunca una ruta (el nombre del archivo,
 * sin carpetas), nunca JSON, nunca el output de la herramienta ni el
 * razonamiento — eso es el chat, no esta pantalla.
 *
 * PURO: sin React ni DOM. Sin sesión ni transcripto no hay pasos, y no se
 * inventa ninguno.
 */

type ToolPart = Extract<ChatPart, { type: 'tool' }>;

export type StepKind = 'read' | 'search' | 'write' | 'run' | 'web' | 'memory' | 'connection' | 'coordinate' | 'other';

export interface ActivityStep {
  /** El id de la parte: estable entre renders. */
  id: string;
  kind: StepKind;
  /** Verbo + objeto, ya en el idioma de la interfaz. */
  text: string;
  /** El instante del mensaje que trajo la herramienta. Las partes no tienen hora propia. */
  at: string;
  /** La herramienta todavía no terminó. */
  running: boolean;
  failed: boolean;
}

/** El nombre legible de una Conexión a partir de su slug (`latte_conn_<slug>`). */
export type ConnectionLabel = (slug: string) => string | undefined;

/** Cuánto objeto entra en una fila. */
const OBJECT_MAX = 40;
/** Un nombre de archivo entra entero: cortarlo en el medio le saca la extensión, que es lo que dice qué es. */
const FILE_MAX = 80;

function clip(text: string, max = OBJECT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + '…' : flat;
}

/** El último segmento de una ruta, sea con `/` o con `\`. */
function baseName(path: string): string {
  const parts = path.trim().split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : '';
}

/** Cada palabra que parece una ruta queda en su nombre de archivo: un comando no muestra carpetas. */
function scrubPaths(text: string): string {
  return text.split(/\s+/).map((word) => (/[\\/]/.test(word) && !/^[a-z]+:\/\//i.test(word) ? baseName(word.replace(/^["']|["']$/g, '')) : word)).join(' ');
}

function parseInput(input: string): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function field(input: Record<string, unknown> | null, keys: readonly string[]): string {
  if (!input) return '';
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

const FILE_KEYS = ['file_path', 'filePath', 'notebook_path', 'path', 'filename'] as const;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** `TodoWrite` → "Todo write", `crear_campana` → "Crear campana". */
function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** Servidor y herramienta, en los tres formatos de runtime: `mcp__s__t` (Claude), `s/t` (Codex), `s_t` (OpenCode). */
function splitTool(name: string, connectionLabel?: ConnectionLabel): { server: string | null; tool: string } {
  if (name.startsWith('mcp__')) {
    const rest = name.slice(5);
    const cut = rest.indexOf('__');
    return cut >= 0 ? { server: rest.slice(0, cut), tool: rest.slice(cut + 2) } : { server: rest, tool: '' };
  }
  const slash = name.indexOf('/');
  if (slash > 0) return { server: name.slice(0, slash), tool: name.slice(slash + 1) };
  for (const server of ['latte_memory', 'latte_coordination']) {
    if (name.startsWith(server + '_')) return { server, tool: name.slice(server.length + 1) };
  }
  if (name.startsWith('latte_conn_')) {
    // OpenCode une servidor y herramienta con `_`, y un slug puede tenerlo:
    // se prueba cada corte contra las conexiones conocidas, y si no, el primero.
    const rest = name.slice('latte_conn_'.length);
    for (let i = rest.indexOf('_'); i > 0; i = rest.indexOf('_', i + 1)) {
      if (connectionLabel?.(rest.slice(0, i))) return { server: 'latte_conn_' + rest.slice(0, i), tool: rest.slice(i + 1) };
    }
    const cut = rest.indexOf('_');
    return cut > 0 ? { server: 'latte_conn_' + rest.slice(0, cut), tool: rest.slice(cut + 1) } : { server: name, tool: '' };
  }
  return { server: null, tool: name };
}

const LOCAL: Record<string, StepKind | 'plan' | 'tools'> = {
  read: 'read', view: 'read',
  glob: 'search', grep: 'search', list: 'search', ls: 'search',
  write: 'write', edit: 'write', multiedit: 'write', notebookedit: 'write', patch: 'write', apply_patch: 'write',
  bash: 'run', command: 'run', shell: 'run',
  webfetch: 'web', websearch: 'web', web_search: 'web', fetch: 'web',
  todowrite: 'plan', todoread: 'plan',
  toolsearch: 'tools',
};

function withObject(what: string, full: Parameters<typeof t>[0], bare: Parameters<typeof t>[0]): string {
  return what ? t(full, { what }) : t(bare);
}

/** Qué hace una herramienta, en verbo + objeto. */
export function describeTool(part: ToolPart, connectionLabel?: ConnectionLabel): { kind: StepKind; text: string } {
  const input = parseInput(part.input);
  const { server, tool } = splitTool(part.tool, connectionLabel);

  if (server === 'latte_memory') {
    const what = clip(field(input, ['query', 'title', 'topic_key', 'content']));
    const saves = /save|update|capture|summary/i.test(tool);
    return { kind: 'memory', text: saves ? withObject(what, 'coord.step.memorySave', 'coord.step.memorySaveBare') : withObject(what, 'coord.step.memorySearch', 'coord.step.memorySearchBare') };
  }
  if (server === 'latte_coordination') return { kind: 'coordinate', text: t('coord.step.coordinate') };
  if (server?.startsWith('latte_conn_')) {
    const slug = server.slice('latte_conn_'.length);
    return { kind: 'connection', text: t('coord.step.connection', { name: connectionLabel?.(slug) || humanize(slug) }) };
  }
  if (server) return { kind: 'other', text: humanize(tool || server) };

  const kind = LOCAL[tool.toLowerCase()];
  switch (kind) {
    case 'read': {
      const what = clip(baseName(field(input, FILE_KEYS) || part.title), FILE_MAX);
      return { kind, text: withObject(what, 'coord.step.read', 'coord.step.readBare') };
    }
    case 'search': {
      const what = clip(field(input, ['pattern', 'query']) || baseName(field(input, FILE_KEYS)));
      return { kind, text: withObject(what, 'coord.step.search', 'coord.step.searchBare') };
    }
    case 'write': {
      const path = field(input, FILE_KEYS) || part.title.split(',')[0] || '';
      return { kind, text: withObject(clip(baseName(path), FILE_MAX), 'coord.step.write', 'coord.step.writeBare') };
    }
    case 'run': {
      const command = field(input, ['command', 'cmd']) || (input ? '' : part.input) || part.title;
      return { kind, text: withObject(clip(scrubPaths(command)), 'coord.step.run', 'coord.step.runBare') };
    }
    case 'web': {
      const url = field(input, ['url']);
      const what = clip(url ? hostOf(url) : field(input, ['query']) || (tool.toLowerCase() === 'web_search' ? part.title : ''));
      return { kind, text: withObject(what, 'coord.step.web', 'coord.step.webBare') };
    }
    case 'plan': return { kind: 'other', text: t('coord.step.plan') };
    case 'tools': return { kind: 'other', text: t('coord.step.tools') };
    default: return { kind: 'other', text: humanize(tool) };
  }
}

/** Los mensajes del miembro en la ventana `[from, to]`: su lado de la conversación, en orden. */
function assistantSince(messages: readonly ChatMessage[], from: string, to?: string | null): ChatMessage[] {
  return messages.filter((m) => m.role === 'assistant' && m.createdAt >= from && (!to || m.createdAt <= to));
}

/**
 * Los pasos de un despacho: una línea por herramienta, del más viejo al más
 * nuevo. `to` es el cierre del despacho, cuando ya volvió.
 */
export function activitySteps(messages: readonly ChatMessage[], from: string, to?: string | null, connectionLabel?: ConnectionLabel): ActivityStep[] {
  const out: ActivityStep[] = [];
  for (const message of assistantSince(messages, from, to)) {
    for (const part of message.parts) {
      if (part.type !== 'tool') continue;
      const { kind, text } = describeTool(part, connectionLabel);
      out.push({ id: part.id, kind, text, at: message.createdAt, running: part.status === 'running' || part.status === 'pending', failed: part.status === 'error' });
    }
  }
  return out;
}

/**
 * Qué hace AHORA, en una línea. La última herramienta si fue lo último que
 * pasó; "Piensa…" cuando después (o sin ninguna) vino razonamiento o texto; y
 * `null` cuando la sesión no trajo nada desde `from` — ahí el que llama dice
 * "Trabajando", a secas, en vez de inventar.
 */
export function activityLine(messages: readonly ChatMessage[], from: string, connectionLabel?: ConnectionLabel): string | null {
  const parts = assistantSince(messages, from).flatMap((m) => m.parts);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1]!;
  return last.type === 'tool' ? describeTool(last, connectionLabel).text : t('coord.step.thinking');
}

/** Los pasos de un despacho y si ya volvió: con el reporte, se pliegan. */
export interface DispatchSteps {
  steps: ActivityStep[];
  settled: boolean;
}

/**
 * Los pasos de CADA despacho de este miembro, por el id del hecho "le llegó
 * un despacho" del buzón (`<despacho>:dispatched`). Un despacho sin una sola
 * herramienta en su ventana no aparece: no hay pasos que mostrar.
 */
export function dispatchSteps(
  log: readonly CoordinationLogEntryView[] | undefined,
  memberId: string,
  messages: readonly ChatMessage[] | undefined,
  connectionLabel?: ConnectionLabel,
): Record<string, DispatchSteps> {
  const out: Record<string, DispatchSteps> = {};
  if (!messages || messages.length === 0) return out;
  for (const entry of log ?? []) {
    if (entry.kind === 'run_done' || entry.kind === 'run_cancelled') continue;
    if (entry.memberId !== memberId) continue;
    const steps = activitySteps(messages, entry.startedAt ?? entry.createdAt, entry.settledAt, connectionLabel);
    if (steps.length > 0) out[`${entry.id}:dispatched`] = { steps, settled: Boolean(entry.settledAt) };
  }
  return out;
}
