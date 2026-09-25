import path from 'node:path';
import type { ChatQuestionItem, EffortTier } from '../../../shared/contracts';
import type { AdapterMcpServer, AdapterStartInput } from '../types';
import type { AcpConnection, AcpRpcError } from './connection';
import type { AcpMcpServer } from './types';

/** Los runtimes que Latte habla por ACP. */
export type AcpRuntime = 'grok' | 'hermes';

/**
 * Lo que un agente ACP reportó que consumió un turno, ya normalizado. Las
 * entradas son INCLUSIVAS de la caché (así las cuentan Grok y Hermes: el
 * `in=8923 … cache=7680/8923` del log de Hermes); el adaptador resta.
 */
export interface AcpUsageReading {
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Null cuando el agente no pone precio (Hermes). Latte no estima. */
  costUsd: number | null;
  /** El contexto de la ÚLTIMA llamada, si el agente lo da en la respuesta (Grok). */
  lastCallContext: number | null;
}

/** Lo que el perfil necesita para dejar lista una sesión recién abierta o cargada. */
export interface AcpSessionSetup {
  connection: AcpConnection;
  sessionId: string;
  input: AdapterStartInput;
  cwd: string;
  /** El resultado crudo de `session/new` o `session/load`. */
  opened: Record<string, unknown>;
  /** Los servidores tal como viajaron: el perfil de Hermes los necesita para su `session/load` de rescate. */
  mcpServers: AcpMcpServer[];
  /** El modelo que Ajustes eligió para este nivel de esfuerzo en este runtime, si hay uno. */
  tierModel: string | null;
  tier: EffortTier;
  timeoutMs: number;
  log: (line: string) => void;
  /**
   * Corre algo durante lo cual el agente puede reproducir la historia (un
   * `session/load` de rescate): lo que llegue mientras tanto no es un turno nuevo.
   */
  quietly<T>(work: () => Promise<T>): Promise<T>;
}

export interface AcpSessionSetupResult {
  /** El modelo que quedó andando, para mostrarlo; `null` = el del agente, sin nombre conocido. */
  model: string | null;
  /** Algo que la persona tiene que saber (un modelo que el agente rechazó). Se muestra como error, no bloquea. */
  notice?: string;
}

/** Preguntas nativas, para el agente que las tiene (Grok). */
export interface AcpQuestionBridge {
  /** El método del request que trae las preguntas. */
  method: string;
  parse(params: unknown): ChatQuestionItem[] | null;
  /** El `result` que el agente espera cuando la persona contestó. */
  answer(items: ChatQuestionItem[], answers: string[][]): unknown;
  /** Descartadas: el error con el que se contesta el request. */
  dismissed(): AcpRpcError;
}

/** Lo que el agente dijo sobre un servidor MCP (Grok: `_x.ai/mcp/server_status`, `_x.ai/mcp_initialized`). */
export type AcpMcpSignal = { kind: 'status'; name: string; ready: boolean } | { kind: 'initialized' };

export interface AcpEnvContext {
  /** El home de la cuenta gestionada. Nunca null: estos runtimes no se corren con el perfil del sistema. */
  accountHome: string;
  /** Un directorio de Latte para archivos de soporte (el `sitecustomize.py` de Hermes). */
  supportDir: string | null;
  platform: NodeJS.Platform;
}

/**
 * LA TABLA DE QUIRKS (brief 2026-09-25, 3.2). El adaptador habla ACP estándar;
 * todo lo que cada agente hace a su manera vive acá, un perfil por agente.
 */
export interface AcpProfile {
  runtime: AcpRuntime;
  /** Cómo lo nombra la interfaz. */
  label: string;
  /** Argumentos del ejecutable. Siempre el ejecutable directo, nunca un `.cmd` ni un shell. */
  args: string[];
  /** Cuánto esperar `initialize` y `session/new|load` (Hermes en frío: 53 s medidos). */
  startupTimeoutMs: number;
  /**
   * El entorno que aísla al proceso: el home de la cuenta y todo lo que hace
   * falta para que no arrastre la configuración global de la máquina. Nunca
   * lleva secretos.
   */
  env(ctx: AcpEnvContext): Record<string, string>;
  /** Deja el home de la cuenta como Latte lo necesita antes de cada arranque. Idempotente. */
  prepareHome?(ctx: AcpEnvContext): void;
  /** `_meta` de `session/new` y `session/load` (Grok: `rules`, `yoloMode`). */
  sessionMeta?(input: AdapterStartInput): Record<string, unknown> | undefined;
  /** Texto que va ANTES del primer mensaje de la conversación (Hermes: el rol, porque ACP no tiene dónde). */
  firstPromptPreamble?(input: AdapterStartInput): string | null;
  /** Esfuerzo, modelo y modo de permisos, después de abrir o cargar la sesión. */
  setupSession?(setup: AcpSessionSetup): Promise<AcpSessionSetupResult>;
  /** Consumo de un `PromptResponse`. Sin esto, el campo `usage` estándar de ACP. */
  readUsage?(result: Record<string, unknown>): AcpUsageReading | null;
  questions: AcpQuestionBridge | null;
  /**
   * Cuánto espera el agente una respuesta de permiso antes de negarlo solo
   * (Hermes: 60 s, fijo en su código). Null = espera lo que haga falta.
   */
  permissionTimeoutMs: number | null;
  /** Si el agente dice qué MCP levantó (ver `mcpSignal`). */
  confirmsMcpInjection: boolean;
  mcpSignal?(method: string, params: unknown): AcpMcpSignal | null;
  /** El nombre con el que el modelo ve una tool MCP (`latte__x` en Grok, `mcp__latte__x` en Hermes). */
  mcpToolName(server: string, tool: string): string;
}

/** El `~` que ve el proceso: un directorio vacío adentro de la cuenta (brief 7.1, punto 1). */
export function isolatedHome(accountHome: string): string {
  return path.join(accountHome, 'home');
}

/**
 * `AdapterMcpServer` → la forma de `session/new.mcpServers` de ACP. El bearer
 * va en un header: viaja por stdin, nunca por argv (`types.ts`).
 */
export function toAcpMcpServers(servers: AdapterMcpServer[] | undefined): AcpMcpServer[] {
  if (!servers) return [];
  return servers.map((server) => server.kind === 'http'
    ? { type: 'http' as const, name: server.name, url: server.url, headers: [{ name: 'Authorization', value: `Bearer ${server.token}` }] }
    : { name: server.name, command: server.command, args: [...server.args], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) });
}
