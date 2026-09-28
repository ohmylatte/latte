import { LatteError, ValidationError } from '../core/errors';
import { assertId } from '../core/paths';
import { isValidId } from '../core/ids';
// Constantes puras, sin I/O: el MISMO número que `canAddTask`/`createTaskRow`
// aplican cuando la propuesta ya se aprobó. Una segunda copia del tope acá
// sería exactamente la forma de que los dos se separen.
import { MAX_CALLED_UP_MEMBERS_PER_RUN, MAX_DEPENDENCY_DEPTH, MAX_TASKS_PER_RUN } from '../coordination/limits';
import { TASK_TITLE_STORED } from '../../shared/taskTitle';
import { COORDINATION_TASK_AUDIENCES, type CoordinationTaskAudience } from '../../shared/contracts';

export const LIMITS = {
  name: 120,
  title: 160,
  context: 60_000,
  brief: 60_000,
  /** A description of the output, not a second brief: it rides every instruction file. */
  expectedOutput: 2_000,
  document: 2_000_000,
  decision: 4_000,
  memory: 20_000,
  terminalChunk: 64 * 1024,
  chatMessage: 100_000,
} as const;

/** OpenCode request ids (per_..., que_...): opaque but bounded and printable. */
export function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ValidationError('Invalid request id');
  return value;
}

export function requireText(value: unknown, name: string, max: number, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  if (value.includes('\0')) throw new ValidationError(`${name} contains a NUL byte`);
  if (value.length > max) throw new ValidationError(`${name} is too long (max ${max} characters)`);
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed.length === 0) throw new ValidationError(`${name} cannot be empty`);
  return value;
}

export function requireLabel(value: unknown, name: string, max: number): string {
  const text = requireText(value, name, max).trim().replace(/\s+/g, ' ');
  if (/[\r\n]/.test(text)) throw new ValidationError(`${name} cannot span lines`);
  return text;
}

export function requireId(value: unknown, name: string): string {
  assertId(value, name);
  return value;
}

/**
 * A coordination gate id (task 7.14 discovery): `engine.ts`'s `listGates()`
 * builds three of its four gate kinds as SYNTHETIC ids never persisted as a
 * row — `plan:<runId>`, `budget:<runId>`, `proposal:<runId>` — because there
 * is nothing to select by primary key for a gate derived from the run's own
 * state. Only a `dispatch` gate carries a real row id (`ID_PATTERN`, no
 * colon). The generic `requireId` rejected the other three outright, which
 * meant `resolveCoordinationGate` could approve a dispatch gate through IPC
 * but never a plan, budget or proposal gate — validated narrowly here
 * instead of loosening `ID_PATTERN`, which doubles as a filesystem-path
 * safety net for every other entity id in the app.
 */
export function requireGateId(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('gateId must be a string');
  const prefixed = value.match(/^(plan|budget|proposal):(.+)$/);
  if (prefixed) {
    if (!isValidId(prefixed[2])) throw new ValidationError('Invalid gateId');
    return value;
  }
  if (!isValidId(value)) throw new ValidationError('Invalid gateId');
  return value;
}

/**
 * El texto con el que la persona EDITA antes de aprobar un gate de
 * coordinación: el prompt de un despacho, o el JSON de la propuesta editada.
 *
 * Llegaba sin validar de ninguna clase hasta `hub.send`, o sea hasta un
 * agente levantado: un megabyte entraba entero, y una cadena vacía se
 * despachaba como "edición" pisando la especificación de la tarea. El tope es
 * el mismo que el repo le aplica al otro texto libre que la persona escribe y
 * que termina en un runtime, el mensaje de chat.
 */
export function requireEditedPrompt(value: unknown): string {
  return requireText(value, 'editedPrompt', LIMITS.chatMessage);
}

/** Brand context and rationale may include newlines and tabs, never other C0/C1 controls. */
export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

export function assertNoControlChars(value: string, name: string): void {
  if (hasControlChars(value)) {
    throw new ValidationError(`${name} contains control characters`);
  }
}

/** Trim + NFC + control-char check used by updateBrand and brand-context proposals. */
export function requireCleanContext(value: unknown, name: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  if (value.includes('\0')) throw new ValidationError(`${name} contains a NUL byte`);
  const clean = value.trim().normalize('NFC');
  if (!options.allowEmpty && clean.length === 0) throw new ValidationError(`${name} cannot be empty`);
  if (clean.length > LIMITS.context) throw new ValidationError(`${name} is too long (max ${LIMITS.context} characters)`);
  assertNoControlChars(clean, name);
  return clean;
}

/**
 * La propuesta que la persona EDITÓ antes de aprobar, validada como propuesta.
 *
 * Llegaba a `resolveGate` como texto libre y entraba derecho a `JSON.parse` +
 * `commitProposal`, que la consume sin mirar: `{"plan":null}` reventaba con un
 * TypeError desde el fondo de la pila DESPUÉS de haber contratado y spawneado a
 * todo el equipo (las altas van antes de la transacción, por diseño); un
 * `{"plan":[]}` aprobaba un run sin una sola tarea; un `estimatedDispatches`
 * cualquiera escribía un `budget_json` que después denegaba todo despacho.
 *
 * La forma que se exige es exactamente la que `commitProposal` consume, ni una
 * más: objeto JSON, `plan` no vacío de `{roleId, spec}`, `membersToHire`
 * opcional de `{roleId}`, y un `estimatedDispatches` entero ≥ 1 — o la forma de
 * ilimitado que el motor ya acepta (`null` CON `unlimitedConfirmedAt`, la
 * confirmación humana explícita que `requireCoordinationBudget` exige).
 */
export function requireCoordinationProposal(raw: string): string {
  const text = requireText(raw, 'proposal', LIMITS.chatMessage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError('The edited proposal is not valid JSON');
  }
  assertCoordinationProposal(parsed);
  return text;
}

/**
 * La MISMA forma, sobre el objeto ya parseado (F4).
 *
 * La propuesta EDITADA se validaba; la ORIGINAL, la que el agente manda por
 * `latte_request_coordination` sobre MCP, no: `mcpServer` no valida contra el
 * `inputSchema` publicado y `tools.ts` pasa `args` tal cual. O sea que
 * `plan[].spec`, `plan[].roleId`, `membersToHire[].why` y `rationale` entraban
 * crudos —un objeto, un número, lo que fuera— y se guardaban en `plan_json`.
 * La pantalla de Decisiones los renderiza como hijos de React
 * (`{task.spec}`, `{proposal.rationale}`), así que un objeto ahí tiraba
 * "Objects are not valid as a React child"; sin ErrorBoundary, la app quedaba
 * en blanco y el run `planning` seguía ocupando el único cupo del Trabajo. Lo
 * que entra por MCP se valida como lo que entra por IPC.
 */
export function assertCoordinationProposal(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('The edited proposal must be a JSON object');
  }
  const proposal = parsed as Record<string, unknown>;

  const estimated = proposal.estimatedDispatches;
  if (estimated === null || estimated === undefined) {
    // "Sin tope" sólo existe con la confirmación humana al lado: es la MISMA
    // regla que `requireCoordinationBudget` aplica, re-afirmada acá para que un
    // JSON editado no pueda inventarse un ilimitado implícito.
    const confirmed = proposal.unlimitedConfirmedAt;
    if (typeof confirmed !== 'string' || confirmed.trim().length === 0) {
      throw new ValidationError('estimatedDispatches must be an integer of at least 1, or unlimited with an explicit confirmation');
    }
  } else {
    requireInt(estimated, 'estimatedDispatches', 1, Number.MAX_SAFE_INTEGER);
  }

  if (!Array.isArray(proposal.plan) || proposal.plan.length === 0) {
    throw new ValidationError('The edited proposal must keep at least one task in `plan`');
  }
  // N5: EL LARGO SE MIDE ACÁ, por el mismo motivo que la profundidad.
  //
  // `assertCoordinationProposal` no miraba `plan.length` contra
  // `MAX_TASKS_PER_RUN`. Por MCP el esquema publicado lo corta antes
  // (`maxItems`), pero por IPC —la propuesta EDITADA que manda la pantalla— no
  // hay esquema: 201 tareas pasaban la validación entera, `resolveGate`
  // contrataba al equipo y levantaba los procesos, y recién `commitProposal`
  // tiraba `TASK_CAP` con la gente ya contratada. Exactamente el agujero que
  // O1 tapó para la profundidad, abierto para el largo.
  if (proposal.plan.length > MAX_TASKS_PER_RUN) {
    throw new LatteError('TASK_CAP', `The plan has ${proposal.plan.length} tasks; a team may carry at most ${MAX_TASKS_PER_RUN}`);
  }
  // O1: LA PROFUNDIDAD SE MIDE ACÁ, donde todavía no se contrató a nadie.
  //
  // `createTaskRow` aplica `MAX_DEPENDENCY_DEPTH` (`canAddTask` → `DEPTH_CAP`)
  // y este validador no la miraba: una cadena más larga que el tope pasaba la
  // validación entera, `resolveGate` contrataba al equipo y levantaba los
  // procesos —las altas van ANTES de la transacción, por diseño— y recién
  // adentro de `commitProposal` la fila que cruzaba el tope tiraba `DEPTH_CAP`.
  // La persona quedaba con miembros contratados y sin run. La misma cuenta que
  // `computeTaskDepth` hace, sobre los índices que se acaban de validar.
  const depths: number[] = [];
  for (const [index, item] of proposal.plan.entries()) {
    if (typeof item !== 'object' || item === null) throw new ValidationError(`Plan task ${index} must be an object`);
    const task = item as Record<string, unknown>;
    requireText(task.roleId, `Plan task ${index} roleId`, LIMITS.name);
    requireText(task.spec, `Plan task ${index} spec`, LIMITS.chatMessage);
    // N2: el título es opcional; si viene, es texto y corto.
    if (task.title !== undefined && task.title !== null) requireText(task.title, `Plan task ${index} title`, TASK_TITLE_STORED);
    // E1: la audiencia es opcional; si viene, es una de las dos. Un valor
    // inventado ("cliente", "todos") no se lee como interno en silencio: se
    // rechaza, porque decide si algo pasa por la revisión antes de publicarse.
    if (task.audience !== undefined && task.audience !== null && !COORDINATION_TASK_AUDIENCES.includes(task.audience as CoordinationTaskAudience)) {
      throw new ValidationError(`Plan task ${index} audience must be "internal" or "client"`);
    }
    if (task.dependsOn !== undefined) {
      if (!Array.isArray(task.dependsOn)) throw new ValidationError(`Plan task ${index} dependsOn must be an array`);
      // Q6: SÓLO HACIA ATRÁS. Un índice hacia adelante —o hacia sí misma—
      // pasaba este validador y moría en `commitProposal`, que resuelve los
      // índices contra las tareas YA creadas: se contrataba a todo el equipo,
      // se levantaban los procesos y recién ahí la transacción tiraba. La
      // persona quedaba con miembros contratados y sin plan. Un índice que
      // apunta a una tarea que todavía no existe no es una dependencia, es un
      // error de forma, y la forma se valida acá. `commitProposal` sigue
      // defensivo: es la frontera autoritativa.
      for (const dep of task.dependsOn) {
        requireInt(dep, `Plan task ${index} dependsOn`, 0, proposal.plan.length - 1);
        if ((dep as number) >= index) {
          throw new ValidationError(`Plan task ${index} dependsOn must point to an earlier task (got ${dep})`);
        }
      }
    }
    // Los índices ya son hacia atrás y están en rango, así que `depths` está
    // completo hasta `index - 1`: la profundidad de ésta es una más que la de
    // su dependencia más profunda, exactamente como `computeTaskDepth`.
    const deps = (task.dependsOn as number[] | undefined) ?? [];
    const depth = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => depths[dep]!)) + 1;
    if (depth > MAX_DEPENDENCY_DEPTH) {
      // N5: `DEPTH_CAP`, no `VALIDATION`. El tope tiene una frase escrita para
      // la persona —"Este plan encadena demasiadas dependencias seguidas.
      // Acortá la cadena y volvé a proponerlo"— y un `ValidationError`
      // genérico la reemplazaba por "Algo de lo que se mandó no es válido.
      // Revisá los datos", que no dice qué revisar. Es el MISMO código que
      // `canAddTask` tira cuando el plan ya se aprobó: el hecho es el mismo,
      // la frase tiene que ser la misma.
      throw new LatteError('DEPTH_CAP', `Plan task ${index} chains more than ${MAX_DEPENDENCY_DEPTH} dependencies in a row`);
    }
    depths.push(depth);
  }

  const hires = proposal.membersToHire;
  if (hires !== undefined && hires !== null) {
    if (!Array.isArray(hires)) throw new ValidationError('membersToHire must be an array');
    for (const [index, item] of hires.entries()) {
      if (typeof item !== 'object' || item === null) throw new ValidationError(`membersToHire ${index} must be an object`);
      requireText((item as Record<string, unknown>).roleId, `membersToHire ${index} roleId`, LIMITS.name);
      // El "por qué" de un alta es lo ÚNICO que la persona lee para decidir si
      // la aprueba: tiene que ser texto, y texto que diga algo.
      requireText((item as Record<string, unknown>).why, `membersToHire ${index} why`, LIMITS.decision);
    }
    // El tope de convocados por run (limits.ts), antes de convocar a nadie: la
    // frase dice el número, así el agente sabe cuánto recortar.
    if (hires.length > MAX_CALLED_UP_MEMBERS_PER_RUN) {
      throw new ValidationError(`membersToHire has ${hires.length} people; one run may call up at most ${MAX_CALLED_UP_MEMBERS_PER_RUN}. Reuse who is already on this Work, or split the request.`);
    }
  }

  // El párrafo que la tarjeta de la propuesta muestra tal cual. Un objeto acá
  // era la pantalla en blanco.
  requireText(proposal.rationale, 'rationale', LIMITS.decision);
}

export function requireInt(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ValidationError(`${name} must be an integer`);
  if (value < min || value > max) throw new ValidationError(`${name} must be between ${min} and ${max}`);
  return value;
}
