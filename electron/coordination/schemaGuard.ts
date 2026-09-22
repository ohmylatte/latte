/**
 * R6: EL VALIDADOR DEL SUBCONJUNTO DE JSON SCHEMA QUE ESTE SERVIDOR PUBLICA.
 *
 * `tools/list` publica un `inputSchema` por herramienta y `tools/call` no lo
 * hacía cumplir: los argumentos llegaban crudos hasta `tools.ts` y de ahí al
 * motor. Sólo `latte_request_coordination` validaba, y porque el motor lo hace
 * por su cuenta. Las consecuencias medidas:
 *
 * - `latte_report` con `outcome:"success"` —que el esquema prohíbe, sus dos
 *   únicos valores son `succeeded`/`failed`— caía en el `else` de `report()` y
 *   contaba como FRACASO, con un intento cobrado contra el tope de reintentos
 *   de la tarea. Un error de tipeo del agente hacía fracasar trabajo hecho.
 * - `summary`, `files` y `question` entraban sin tope de largo, hasta la base.
 *
 * Es un validador MÍNIMO a propósito: exactamente las DIEZ palabras clave que
 * los esquemas publicados usan (`type`, `required`, `enum`, `minimum`,
 * `minLength`, `maxLength`, `maxItems`, `items`, `properties`, `additionalProperties`,
 * `description`) y ni una más — la lista es `SUPPORTED_SCHEMA_KEYWORDS`, acá
 * abajo, y ésta es la prosa que la acompaña. Decía "siete" y enumeraba ocho,
 * sin `maxItems` ni `description`: el docstring describía una versión del
 * módulo que ya no existía. Un
 * validador genérico completo sería superficie sin cliente; éste cubre POR
 * CONSTRUCCIÓN todo lo que se publica, y el test estructural de
 * `coordination-mcp-arg-validation.test.ts` lo recorre esquema por esquema
 * para que agregar una palabra clave nueva sin implementarla no pueda pasar
 * desapercibido.
 *
 * Devuelve un mensaje que NOMBRA EL CAMPO, con su ruta (`plan[0].roleId`), o
 * `null` si el valor cumple. Nunca tira: un esquema roto o una palabra clave
 * desconocida se leen como "no tengo nada que objetar", porque este módulo
 * decide rechazos y un rechazo inventado es peor que uno que falta — el motor
 * sigue validando por su cuenta, en profundidad.
 */

/** Las palabras clave que este validador entiende. Nada fuera de esta lista puede aparecer en un esquema publicado sin que el test estructural lo note. */
export const SUPPORTED_SCHEMA_KEYWORDS = [
  'type', 'required', 'enum', 'minimum', 'minLength', 'maxLength', 'maxItems', 'items', 'properties', 'additionalProperties', 'description',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `type` puede ser una palabra o una lista de palabras (`['string','null']`, que `latte_report.files` publica). */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    // Una palabra que este validador no conoce no puede producir un rechazo
    // inventado: se acepta y el motor sigue siendo la defensa de fondo.
    default: return true;
  }
}

function typeNames(type: unknown): string[] | null {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type) && type.every((t) => typeof t === 'string')) return type as string[];
  return null;
}

/**
 * Valida `value` contra `schema`. `path` es la ruta legible del campo desde la
 * raíz de `arguments` (vacía en la raíz).
 */
export function validateAgainstSchema(schema: unknown, value: unknown, path = ''): string | null {
  if (!isRecord(schema)) return null;
  const field = path || 'arguments';

  const types = typeNames(schema.type);
  if (types && !types.some((t) => matchesType(value, t))) {
    return `${field} must be ${types.join(' or ')}`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    return `${field} must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  }

  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    return `${field} must be at least ${schema.minimum}`;
  }

  // R2: el piso, no sólo el techo. `latte_report` pedía `summary` pero no
  // pedía que dijera algo, así que `""` pasaba y liquidaba la tarea con el
  // resultado en blanco. Un mínimo publicado es un mínimo que el agente lee
  // en `tools/list` antes de mandar.
  if (typeof schema.minLength === 'number' && typeof value === 'string' && value.length < schema.minLength) {
    return `${field} must be at least ${schema.minLength} characters`;
  }

  if (typeof schema.maxLength === 'number' && typeof value === 'string' && value.length > schema.maxLength) {
    return `${field} must be at most ${schema.maxLength} characters`;
  }

  // Q6: el tope de una lista, publicado. `latte_plan_submit` lo descubría
  // escribiendo: el tope de tareas saltaba en la fila 201 con 200 ya guardadas.
  // Un límite que el agente puede leer en `tools/list` es un límite que puede
  // respetar antes de mandar.
  if (typeof schema.maxItems === 'number' && Array.isArray(value) && value.length > schema.maxItems) {
    return `${field} must have at most ${schema.maxItems} items`;
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i += 1) {
      const failed = validateAgainstSchema(schema.items, value[i], `${field}[${i}]`);
      if (failed) return failed;
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name !== 'string') continue;
        // Ausente y `undefined` son lo mismo: un JSON-RPC no puede transportar
        // `undefined`, así que la única forma de que llegue es que no venga.
        if (value[name] === undefined) return `${path ? `${path}.` : ''}${name} is required`;
      }
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, name)) return `${path ? `${path}.` : ''}${name} is not a known argument`;
      }
    }
    for (const [name, sub] of Object.entries(properties)) {
      if (value[name] === undefined) continue; // lo obligatorio ya se reclamó arriba; lo opcional ausente no se valida
      const failed = validateAgainstSchema(sub, value[name], `${path ? `${path}.` : ''}${name}`);
      if (failed) return failed;
    }
  }

  return null;
}
