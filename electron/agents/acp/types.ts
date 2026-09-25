/**
 * Lo que Latte lee y escribe del Agent Client Protocol (v1). Es un subconjunto
 * a propósito: sólo los campos que el adaptador usa, todos opcionales del lado
 * de lo que llega, porque un agente que omite uno no puede tirar abajo el chat.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** Un servidor MCP en `session/new` / `session/load`. `http` lleva `type`; `stdio` no (ACP lo toma por defecto). */
export type AcpMcpServer =
  | { type: 'http'; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

export interface AcpContentBlock {
  type?: string;
  text?: string;
}

/** Una opción de `session/request_permission`. Se elige por `kind`, nunca por id: cada agente usa ids propios. */
export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface AcpToolCallFields {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  _meta?: Record<string, unknown>;
}

export interface AcpSessionUpdate extends AcpToolCallFields {
  sessionUpdate: string;
  content?: unknown;
  used?: number;
  size?: number;
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { isRecord };
