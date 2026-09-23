import type { ChatMessage, ChatPart } from './contracts';

/**
 * The tools a runtime reports when it writes a file. Shared by the renderer
 * (who is editing a document right now, `src/active-edits.ts`) and the
 * backend (who wrote a handoff file, `LatteService.handoffAuthor`): one list,
 * so the two answers to "who wrote this" can never disagree.
 */
const EDIT_TOOL = /^(write|edit|multiedit|apply_patch|patch|str_replace|create_file|notebook_edit)$/i;

export function isEditTool(part: Extract<ChatPart, { type: 'tool' }>): boolean {
  if (EDIT_TOOL.test(part.tool)) return true;
  // Codex reports file changes as `edit`; a shell command is not an edit even
  // if it mentions the file, so commands are deliberately excluded.
  return part.tool.toLowerCase() === 'edit';
}

/**
 * Whether this conversation wrote `fileName` through a runtime tool, looking at
 * its recent messages only. Attribution, not a guess: a file written outside a
 * reported tool call is credited to nobody.
 */
export function wroteFile(messages: readonly ChatMessage[], fileName: string, recent = 20): boolean {
  const needle = fileName.toLowerCase();
  if (!needle) return false;
  return messages.slice(-recent).some((message) => message.parts.some((part) =>
    part.type === 'tool' && isEditTool(part) && `${part.title}\n${part.input}`.toLowerCase().includes(needle)));
}
