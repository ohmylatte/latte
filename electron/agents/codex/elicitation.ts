import type { ChatQuestionItem } from '../../../shared/contracts';
import { isRecord } from './appServer';

export type FormFieldKind = 'string' | 'number' | 'boolean' | 'enum';

export interface ElicitationFormField {
  name: string;
  kind: FormFieldKind;
  required: boolean;
  /** Maps the option label shown in the card to the value sent on the wire. */
  valueByLabel?: Record<string, string>;
}

export type FormMapping =
  | { ok: true; questions: ChatQuestionItem[]; fields: ElicitationFormField[] }
  | { ok: false; reason: string };

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** `McpToolCallError` is `{ message }`; older payloads may still send a string. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return '';
}

/** Text blocks from `result.content`, else `structuredContent`, else the raw result. */
export function mcpToolOutput(result: unknown): string {
  if (!isRecord(result)) return stringify(result);
  const content = result.content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string' && block) texts.push(block);
      else if (isRecord(block) && typeof block.text === 'string' && block.text) texts.push(block.text);
    }
    if (texts.length > 0) return texts.join('\n');
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return stringify(result.structuredContent);
  }
  return stringify(result);
}

export function mapElicitationForm(schema: unknown): FormMapping {
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) {
    return { ok: false, reason: 'el esquema no es un objeto con properties' };
  }
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((n): n is string => typeof n === 'string') : [],
  );
  const questions: ChatQuestionItem[] = [];
  const fields: ElicitationFormField[] = [];
  for (const [name, raw] of Object.entries(schema.properties)) {
    const mapped = mapProperty(name, raw, required.has(name));
    if (!mapped) return { ok: false, reason: `el campo «${name}» no se puede mostrar (tipo no soportado)` };
    questions.push(mapped.question);
    fields.push(mapped.field);
  }
  if (questions.length === 0) return { ok: false, reason: 'el formulario no tiene campos' };
  return { ok: true, questions, fields };
}

export function contentFromAnswers(
  fields: ElicitationFormField[],
  answers: string[][],
): { ok: true; content: Record<string, string | number | boolean> } | { ok: false; error: string } {
  const content: Record<string, string | number | boolean> = {};
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const picked = (answers[i] ?? []).map((a) => a.trim()).filter(Boolean);
    if (picked.length === 0) {
      if (field.required) return { ok: false, error: `Falta ${field.name}` };
      continue;
    }
    const raw = picked[0];
    if (field.kind === 'boolean') {
      if (raw === 'true') content[field.name] = true;
      else if (raw === 'false') content[field.name] = false;
      else return { ok: false, error: `Valor booleano inválido para ${field.name}` };
    } else if (field.kind === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `Número inválido para ${field.name}` };
      content[field.name] = n;
    } else if (field.kind === 'enum') {
      content[field.name] = field.valueByLabel?.[raw] ?? raw;
    } else {
      content[field.name] = raw;
    }
  }
  return { ok: true, content };
}

function mapProperty(
  name: string,
  raw: unknown,
  required: boolean,
): { question: ChatQuestionItem; field: ElicitationFormField } | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  const title = typeof raw.title === 'string' && raw.title ? raw.title : name;
  const description = typeof raw.description === 'string' ? raw.description : '';
  const questionText = description || title;
  if (raw.type === 'array') return null;
  if (raw.type === 'boolean') {
    return {
      question: {
        header: title,
        question: questionText,
        options: [{ label: 'true', description: '' }, { label: 'false', description: '' }],
        multiple: false,
        custom: false,
        required,
      },
      field: { name, kind: 'boolean', required },
    };
  }
  if (raw.type === 'number' || raw.type === 'integer') {
    return {
      question: { header: title, question: questionText, options: [], multiple: false, custom: true, required },
      field: { name, kind: 'number', required },
    };
  }
  if (raw.type !== 'string') return null;
  const enumerated = enumLabels(raw);
  if (enumerated) {
    return {
      question: {
        header: title,
        question: questionText,
        options: enumerated.map(([label]) => ({ label, description: '' })),
        multiple: false,
        custom: false,
        required,
      },
      field: { name, kind: 'enum', required, valueByLabel: Object.fromEntries(enumerated) },
    };
  }
  return {
    question: { header: title, question: questionText, options: [], multiple: false, custom: true, required },
    field: { name, kind: 'string', required },
  };
}

function enumLabels(raw: Record<string, unknown>): Array<[string, string]> | null {
  if (Array.isArray(raw.enum) && raw.enum.every((v) => typeof v === 'string')) {
    const names = Array.isArray(raw.enumNames) ? raw.enumNames : null;
    return raw.enum.map((value, i) => {
      const label = names && typeof names[i] === 'string' && names[i] ? String(names[i]) : value;
      return [label, value] as [string, string];
    });
  }
  if (!Array.isArray(raw.oneOf)) return null;
  const options: Array<[string, string]> = [];
  for (const entry of raw.oneOf) {
    if (!isRecord(entry) || typeof entry.const !== 'string') return null;
    const label = typeof entry.title === 'string' && entry.title ? entry.title : entry.const;
    options.push([label, entry.const]);
  }
  return options.length > 0 ? options : null;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}
