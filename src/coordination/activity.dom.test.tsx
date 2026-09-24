import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from '../i18n';
import type { ChatMessage, ChatPart } from '../../shared/contracts';

/**
 * N1: QUÉ ESTÁ HACIENDO AHORA, EN UN VERBO Y UN OBJETO.
 *
 * El dueño veía "Despacho de Asistente 19:18" y nada más, mientras en el chat
 * del miembro pasaban `Read`, `ToolSearch`, `mcp__latte_memory__mem_search` y
 * `Write`. Esto traduce cada herramienta a una frase corta que se lee de un
 * vistazo — nunca una ruta, nunca JSON.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('../i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('../i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { describeTool, activitySteps, activityLine } = await import('./activity');

type ToolPart = Extract<ChatPart, { type: 'tool' }>;
const tool = (name: string, input: unknown, patch: Partial<ToolPart> = {}): ToolPart => ({
  type: 'tool', id: 'p-' + name, tool: name, status: 'completed', title: '',
  input: typeof input === 'string' ? input : JSON.stringify(input), output: 'SECRETO DEL OUTPUT', error: '', ...patch,
});
const says = (name: string, input: unknown, patch: Partial<ToolPart> = {}) => { ui.locale = 'es-AR'; return describeTool(tool(name, input, patch)).text; };

describe('describeTool: el verbo por herramienta', () => {
  it('Read lee el archivo por su nombre, sin la ruta', () => {
    expect(says('Read', { file_path: 'C:\\Users\\gabog\\Latte\\Ayulem\\Cuestionario_Segmentacion_Mayorista_Meta.md' }))
      .toBe('Lee Cuestionario_Segmentacion_Mayorista_Meta.md');
    expect(says('read', { filePath: '/home/x/brief.md' })).toBe('Lee brief.md');
  });

  it('Glob y Grep buscan', () => {
    expect(says('Grep', { pattern: 'mayorista', path: '/a/b' })).toBe('Busca mayorista');
    expect(says('Glob', { pattern: '**/*.md' })).toBe('Busca **/*.md');
  });

  it('Write y Edit escriben, por nombre de archivo', () => {
    expect(says('Write', { file_path: '/w/Ayulem/estrategia-mayorista.md', content: 'todo el documento' })).toBe('Escribe estrategia-mayorista.md');
    expect(says('Edit', { file_path: 'D:/x/plan.md', old_string: 'a', new_string: 'b' })).toBe('Escribe plan.md');
    // Codex: `edit` con las rutas en el título.
    expect(says('edit', '', { title: 'w/a/calendario.md, w/b/otro.md' })).toBe('Escribe calendario.md');
  });

  it('Bash ejecuta, con el comando recortado y sin rutas', () => {
    expect(says('Bash', { command: 'wc -l C:/Users/gabog/Latte/Ayulem/estrategia.md' })).toBe('Ejecuta wc -l estrategia.md');
    const long = says('Bash', { command: 'python -c "print(1)" && echo una cosa muy larga que no entra en la fila' });
    expect(long.length).toBeLessThanOrEqual('Ejecuta '.length + 41);
    expect(long.endsWith('…')).toBe(true);
    expect(says('command', '', { title: 'ls -la' })).toBe('Ejecuta ls -la');
  });

  it('WebFetch y WebSearch consultan', () => {
    expect(says('WebFetch', { url: 'https://www.ayulem.com.ar/mayoristas?x=1', prompt: 'x' })).toBe('Consulta ayulem.com.ar');
    expect(says('WebSearch', { query: 'pastelería mayorista Córdoba' })).toBe('Consulta pastelería mayorista Córdoba');
  });

  it('la memoria de Latte, en los tres runtimes', () => {
    expect(says('mcp__latte_memory__mem_search', { query: 'Ayulem mayorista' })).toBe('Busca en memoria: Ayulem mayorista');
    expect(says('latte_memory/mem_search', { query: 'Ayulem' })).toBe('Busca en memoria: Ayulem');
    expect(says('latte_memory_mem_search', { query: 'Ayulem' })).toBe('Busca en memoria: Ayulem');
    expect(says('mcp__latte_memory__mem_save', { title: 'Decisión de tono', content: '...' })).toBe('Guarda en memoria: Decisión de tono');
  });

  it('una conexión se nombra por su conexión', () => {
    ui.locale = 'es-AR';
    const label = (slug: string) => (slug === 'theagentcy' ? 'The Agentcy' : undefined);
    expect(describeTool(tool('mcp__latte_conn_theagentcy__eco', { q: 1 }), label).text).toBe('Consulta The Agentcy');
    expect(describeTool(tool('latte_conn_theagentcy_eco', {}), label).text).toBe('Consulta The Agentcy');
    // Sin la lista de conexiones: el slug, legible.
    expect(says('mcp__latte_conn_theagentcy__eco', {})).toBe('Consulta Theagentcy');
  });

  it('la coordinación es "Coordina"', () => {
    expect(says('mcp__latte_coordination__latte_report', { taskId: 't1', summary: 'x' })).toBe('Coordina');
  });

  it('el resto: el nombre de la herramienta, humanizado', () => {
    expect(says('mcp__otro__crear_campana', { a: 1 })).toBe('Crear campana');
    expect(says('NotebookRead', {})).toBe('Notebook read');
  });

  it('nunca una ruta completa ni JSON', () => {
    const samples = [
      says('Read', { file_path: '/a/b/c/d.md' }),
      says('mcp__otro__x', { deep: { nested: [1, 2] } }),
      says('Grep', {}),
      says('WebFetch', 'no es json'),
    ];
    for (const text of samples) {
      expect(text).not.toMatch(/[{}[\]"]/);
      expect(text).not.toMatch(/\/a\/b/);
      expect(text).not.toContain('SECRETO');
    }
  });

  it('en inglés', () => {
    ui.locale = 'en-US';
    expect(describeTool(tool('Read', { file_path: '/x/brief.md' })).text).toBe('Reads brief.md');
    expect(describeTool(tool('mcp__latte_memory__mem_search', { query: 'Ayulem' })).text).toBe('Searches memory: Ayulem');
  });
});

const msg = (id: string, createdAt: string, parts: ChatPart[], role: 'user' | 'assistant' = 'assistant'): ChatMessage =>
  ({ id, chatId: 'cm', role, parts, createdAt, completed: true, error: null });

describe('activitySteps / activityLine', () => {
  const messages = [
    msg('old', '2026-09-24T18:00:00.000Z', [tool('Read', { file_path: '/x/viejo.md' })]),
    msg('u1', '2026-09-24T19:18:00.000Z', [{ type: 'text', id: 'u', text: 'Tarea: estrategia' }], 'user'),
    msg('a1', '2026-09-24T19:18:05.000Z', [{ type: 'reasoning', id: 'r', text: 'pienso' }, tool('Read', { file_path: '/x/brief.md' })]),
    msg('a2', '2026-09-24T19:19:00.000Z', [{ ...tool('Write', { file_path: '/x/estrategia.md' }), status: 'running' }]),
  ];

  it('sólo los pasos del despacho, en orden, con su hora', () => {
    ui.locale = 'es-AR';
    const steps = activitySteps(messages, '2026-09-24T19:18:00.000Z');
    expect(steps.map((s) => s.text)).toEqual(['Lee brief.md', 'Escribe estrategia.md']);
    expect(steps.map((s) => s.at)).toEqual(['2026-09-24T19:18:05.000Z', '2026-09-24T19:19:00.000Z']);
    expect(steps[1]!.running).toBe(true);
    expect(activitySteps(messages, '2026-09-24T19:18:00.000Z', '2026-09-24T19:18:30.000Z').map((s) => s.text)).toEqual(['Lee brief.md']);
  });

  it('la línea es la última herramienta; "Piensa…" sin herramienta; null sin nada', () => {
    ui.locale = 'es-AR';
    expect(activityLine(messages, '2026-09-24T19:18:00.000Z')).toBe('Escribe estrategia.md');
    const thinking = [...messages, msg('a3', '2026-09-24T19:20:00.000Z', [{ type: 'reasoning', id: 'r2', text: '...' }])];
    expect(activityLine(thinking, '2026-09-24T19:18:00.000Z')).toBe('Piensa…');
    expect(activityLine(messages, '2026-09-24T20:00:00.000Z')).toBeNull();
  });
});
