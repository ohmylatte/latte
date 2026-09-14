# Latte: identidad de marca y aprendizaje de skills

Fecha: 2026-09-14. Estado: arquitectura y código de referencia propuestos; NO implementados ni ejecutados.

## Pedido y límite de esta sesión

El usuario quiere abordar juntos dos problemas: orientar los entregables con un kit opcional por marca y una configuración global de agencia; y adaptar el aprendizaje de skills de Hermes Agent (Nous Research) para conservar procedimientos útiles al encontrar patrones.

Primero pidió investigación y briefs persistentes; ahora solicita agregar arquitectura y código EN esos briefs. Esto no autoriza implementar producto. No ejecutar builds, pruebas, instalaciones ni lanzar la aplicación durante esta ampliación. No commit ni push solicitados.

## Documentos del paquete

- [Kit de marca y agencia](2026-09-14-brand-kits.md): contratos de identidad, resolución, recursos y propuesta de integración.
- [Skills aprendidas y evidencia Hermes](2026-09-14-adaptive-skills.md): formato, ciclo de vida, contratos, validación y controles.

Leer ambos completos antes de implementar. Los ejemplos TypeScript son propuestas de interfaces y lógica, no código verificado por ejecución. La revisión estática remota de Latte permite identificar puntos de integración; no reemplaza verificar el checkout de la aplicación y sus pruebas. La investigación inicial de Hermes no quedó fijada a un SHA: ese pendiente sigue vigente.

## Evidencia y límites

- `README.md` y `package.json` identifican este checkout como `latte-web`, sitio estático Astro. No contiene el runtime local de la aplicación.
- `origin` apunta a `gabogabucho/latte-web`; `upstream` a `ohmylatte/latte`. La presencia de upstream NO convierte este árbol en el código actual del producto.
- Se inspeccionó estáticamente código remoto de Latte en `cb5496db0361a3dda8035011cf34d447bba29dd0`. No se lanzó la aplicación ni se verificó su comportamiento en ejecución.
- En esa revisión, bootstrap conecta repositorio, archivos, hub y servicio; el evento de mensaje completado participa en procesar propuestas de decisiones. No equivale a éxito verificado del trabajo. [Fuente fijada: bootstrap.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/bootstrap.ts).
- Existe una capa de renderizado de instrucciones de workspace. Se propone extenderla, no crear un runtime paralelo. [Fuente fijada: instructions.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/workspace/instructions.ts).
- Estado inicial: `?? video/`. Es trabajo preexistente y debe permanecer intacto.
- No existe `.atl/skill-registry.md` y la búsqueda de `skill-registry` en Engram para MarketIA no devolvió registro.
- La estética atribuida a Claude/Codex es una observación reportada por el usuario, no un diagnóstico visual comprobado.

## Arquitectura compartida propuesta

Separar identidad de procedimientos: el kit define qué identidad aplicar; la skill describe cómo producir y validar un tipo de entregable. La skill recibe el kit seleccionado, sin copiar logos, secretos ni datos del cliente a instrucciones globales.

Arquitectura local-first **propuesta** (no es un mapa de módulos ya implementados):

```text
Renderer (no confiable)
  → IPC (remitente confiable ≠ payload autorizado)
    → LatteService (orquesta, deriva Work/brandId del repositorio)
      → dominio puro: resolveBrandContext / SkillResolver
      → repositorios SQLite (metadatos, heads, recibos, auditoría)
      → archivos inmutables (kits, snapshots; no .latte/context ni .latte/skills)
        → adaptador de contexto: proyecta el recibo al runtime existente
```

La configuración de agencia pertenece a la instalación local; no se introduce un modelo SaaS de tenants. `brandId` delimita selección y persistencia dentro de la aplicación, pero NO garantiza aislamiento de procesos, filesystem o herramientas. Una skill compartida requiere revisión explícita para eliminar datos de marca.

Las reglas de identidad viven en [Kit de marca y agencia](2026-09-14-brand-kits.md). El ciclo de candidatas, CAS y cola viven en [Skills aprendidas](2026-09-14-adaptive-skills.md). Este índice fija **capas, contratos de unión y el plan de integración** para que ambos no inventen un segundo runtime.

### Capas y dirección de dependencias

Dependencias hacia adentro: adaptadores conocen dominio; dominio no importa Electron, SQLite, renderer ni el modelo. UI y modelo nunca llaman repositorios.

| Capa | Responsabilidad propuesta | Puede importar | Límite de confianza |
|---|---|---|---|
| Renderer | Editar kit, elegir modo de identidad, revisar candidatas, mostrar versiones y conflictos | Contratos DTO, API preload | No decide aprobación, no abre paths, no envía `brandId` autoritativo |
| IPC | Transportar comandos; comprobar `isTrustedSender` y aridad | Contratos de preload | Remitente de ventana ≠ autorización de datos; validar runtime del payload |
| Servicio de aplicación (`LatteService` + orquestador nuevo) | Derivar Work/marca del repositorio, coordinar publicación, aprobar, preparar generación | Puertos de dominio y repositorios | No aceptar path, hash o `brandId` del renderer/modelo como autorización |
| Dominio puro | Resolver identidad/firma; seleccionar skills aprobadas; validar transiciones e invariantes | Nada de I/O | Testeable con fixtures; sin filesystem, SQLite ni LLM |
| Repositorios | Revisar, CAS de heads, recibos, jobs y auditoría | Driver SQLite existente | Transacción de metadatos; no transacción distribuida con el disco |
| Archivos inmutables | Staging → publicación exclusiva de recursos y snapshots por hash | Paths resueltos por backend | Importación controlada; jamás editar una revisión publicada |
| Adaptador de contexto | Proyectar el recibo a instrucciones/side files del runtime | `renderInstructionBundle`, `WorkspaceFiles` | Texto importado y candidatas no aprobadas no ganan autoridad por aparecer en contexto |

**Invariante de frontera:** un DTO cruzó IPC o salió del modelo → se revalida forma, enumeraciones, tamaños y campos desconocidos en el servicio. TypeScript no es esa validación.

### Flujo compartido de preparación

```text
comando prepareGeneration(workId)
  1. requireWork(workId) → { work, brandId } desde repositorio; IDs del renderer no autorizan
  2. leer elección persistida de identidad/firma para ese trabajo (no el último click suelto)
  3. resolveBrandContext puro → snapshot de identidad; fallar en vez de heredar agencia
  4. SkillResolver: autorizar scope brand:<brandId> y agency:local ANTES de indexar
  5. canonizar + hashear; persistir GenerationContext inmutable (recibo)
  6. proyectar copia mínima a .latte/generations/<generationId>/  (NUNCA a .latte/context o .latte/skills)
  7. si liveMemberCount(work) === 0: refreshInstructions con puntero compacto al recibo
     si hay miembros vivos: dejar pendiente; no reescribir CLAUDE.md/AGENTS.md debajo de ellos
  8. al cerrar: registrar evidencia de entrega y checks del artefacto en tablas distintas del recibo
```

El analog existente para “fijar un dato al abrir conversación, sin reescribir archivos compartidos” es `renderOutcomeContext` en `instructions.ts`. El pin de generación debe seguir esa idea: el recibo viaja con la generación; los archivos compartidos no se mutan con un miembro activo. Eso está comprobado en `memberContext` (`liveMemberCount === 0` antes de `refreshInstructions`).

### Contratos compartidos

**Código propuesto, no compilado ni ejecutado.** Punto de unión de ambos briefs. Los resolvers de marca y de skills implementan puertos; no redefinen este recibo.

```ts
// Propuesta autocontenida. Validación de runtime adicional a TypeScript.

export type SchemaVersion = 1;
export type HexSha256 = string; // 64 hex minúsculas; no fingerprint corto de documentos
export type ContentHash = HexSha256;

export interface KitRef {
  kitId: string;      // ID lógico del snapshot RESUELTO (identidad + firma), no un archivo mutable
  version: number;    // entero > 0
  hash: ContentHash;
}

export interface SkillRef {
  skillId: string;
  version: number;
  hash: ContentHash;
}

export interface GenerationContext {
  schemaVersion: SchemaVersion;
  workId: string;
  brandId: string; // siempre Work.brandId del repositorio
  brandContext: KitRef | null;
  skillRefs: SkillRef[]; // sólo revisiones aprobadas y autorizadas para este trabajo
}

export type GenerationErrorCode =
  | 'SCHEMA_INVALID'
  | 'WORK_NOT_FOUND'
  | 'BRAND_SCOPE_MISMATCH'
  | 'HASH_INVALID'
  | 'VERSION_CONFLICT'
  | 'KIT_NOT_APPROVED'
  | 'SKILL_NOT_APPROVED'
  | 'REVOKED_REF'
  | 'LIVE_MEMBERS' // no reescribir instrucciones compartidas; el recibo igual se persiste
  | 'CANONICALIZE_FAILED';

export class GenerationContractError extends Error {
  constructor(readonly code: GenerationErrorCode) {
    super(code);
  }
}

export interface GenerationContextRepository {
  // Mismo ID + mismo contenido: idempotente. Mismo ID + otro contenido: rechazo.
  insert(generationId: string, context: GenerationContext): Promise<void>;
  find(generationId: string): Promise<GenerationContext | null>;
}

export interface WorkAuthority {
  requireWork(workId: string): { id: string; brandId: string };
}

export interface BrandContextPort {
  resolveForWork(work: { id: string; brandId: string }): {
    brandContext: KitRef | null;
    snapshot: unknown; // resolución completa; contrato detallado en el brief de marca
  };
}

export interface SkillSelectionPort {
  // Autorizar scope antes de buscar. Candidatas y shipped opt-out no se mezclan aquí.
  selectForWork(work: { id: string; brandId: string }): SkillRef[];
}

export interface ContextProjectionPort {
  // Escribe .latte/generations/<id>/ y, si no hay miembros vivos, un puntero en el bundle.
  project(generationId: string, context: GenerationContext): void;
}

export interface DeliveryEvidence {
  generationId: string;
  runtime: string;
  chatId: string | null;
  projectedAt: string;
  // Existencia de side files / bundle; NO implica que el modelo los leyó.
  filesWritten: string[];
}

export interface ArtifactCheck {
  generationId: string;
  relativePath: string;
  fileHash: ContentHash | null;
  checks: Array<{ name: string; passed: boolean; note: string }>;
  brandCompliant: boolean | null; // null = no se pudo comprobar ese formato
}

export interface PrepareGeneration {
  (input: { workId: string }): Promise<{
    generationId: string;
    context: GenerationContext;
  }>;
}
```

Reglas del contrato (la implementación futura debe validarlas en runtime):

1. `brandContext` referencia un snapshot **resuelto e inmutable** de identidad y firma, no la última fila mutable del editor. El brief de marca define la composición; `kitId` identifica esa resolución versionada. `null` sólo si no hay identidad ni firma; neutro con firma conserva referencia. No hay herencia implícita de agencia.
2. `skillRefs` sólo incluye revisiones seleccionadas **y** aprobadas del alcance autorizado. Shipped skills siguen el catálogo actual (`listSkills` / `skill-off:`); no se reescriben en este recibo como si fueran aprendidas.
3. `brandId` del recibo = `Work.brandId` leído en el servicio. Un `brandId` en el payload IPC se ignora como autorización.
4. Hash = SHA-256 de bytes UTF-8 de la serialización canónica: claves de objeto ordenadas, enteros JSON, hashes de recursos embebidos por referencia, `skillRefs` ordenados por `(skillId, version)`. **No** `JSON.stringify` incidental ni el fingerprint corto de documentos Markdown.
5. El contenido hasheado se retiene para inspección. Si al consumir falta el blob o el hash no coincide: conflicto, no “usar latest”.
6. Tres registros distintos, nunca colapsados:
   - **Recibo** (`GenerationContext`): qué se preparó.
   - **Entrega** (`DeliveryEvidence`): qué se proyectó al runtime.
   - **Chequeo** (`ArtifactCheck`): qué se pudo validar del artefacto.
7. Un mensaje `completed` en `emitChat` no llena ninguno de los tres como éxito de marca ni como aprendizaje validado. El hook existente procesa propuestas de decisiones; el aprendizaje, si se observa, es una señal aparte y opt-in (brief de skills).

### Canonización ilustrativa (no ejecutada)

```ts
function assertHexSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new GenerationContractError('HASH_INVALID');
}

function canonicalGenerationContext(ctx: GenerationContext): string {
  if (ctx.schemaVersion !== 1) throw new GenerationContractError('SCHEMA_INVALID');
  const brand = ctx.brandContext;
  if (brand) {
    if (!Number.isInteger(brand.version) || brand.version < 1) {
      throw new GenerationContractError('SCHEMA_INVALID');
    }
    assertHexSha256(brand.hash);
  }
  const skillRefs = [...ctx.skillRefs]
    .map((s) => {
      if (!Number.isInteger(s.version) || s.version < 1) {
        throw new GenerationContractError('SCHEMA_INVALID');
      }
      assertHexSha256(s.hash);
      return { skillId: s.skillId, version: s.version, hash: s.hash };
    })
    .sort((a, b) => a.skillId.localeCompare(b.skillId) || a.version - b.version);
  return JSON.stringify({
    brandContext: brand
      ? { hash: brand.hash, kitId: brand.kitId, version: brand.version }
      : null,
    brandId: ctx.brandId,
    schemaVersion: 1,
    skillRefs,
    workId: ctx.workId,
  });
}

function prepareGeneration(deps: {
  works: WorkAuthority;
  brand: BrandContextPort;
  skills: SkillSelectionPort;
  repo: GenerationContextRepository;
  project: ContextProjectionPort;
  newId: () => string;
  sha256: (bytes: Uint8Array) => ContentHash;
}, workId: string): Promise<{ generationId: string; context: GenerationContext }> {
  const work = deps.works.requireWork(workId);
  const { brandContext } = deps.brand.resolveForWork(work);
  const skillRefs = deps.skills.selectForWork(work);
  const context: GenerationContext = {
    schemaVersion: 1,
    workId: work.id,
    brandId: work.brandId,
    brandContext,
    skillRefs,
  };
  canonicalGenerationContext(context); // valida forma; el hash del snapshot de marca ya viene del brief de kits
  const generationId = deps.newId();
  return deps.repo.insert(generationId, context).then(() => {
    deps.project.project(generationId, context);
    return { generationId, context };
  });
}
```

`prepareGeneration` no llama al modelo. No aprueba kits ni skills. Si `requireWork` falla, no se construye contexto. El hash del kit resuelto lo produce el publicador de marca; el de cada skill, el publicador de aprendizaje. Aquí sólo se **ensambla y sella** el recibo.

### Piezas existentes frente a nuevas

Inspección remota estática de `ohmylatte/latte` @ `cb5496db0361a3dda8035011cf34d447bba29dd0`. Revalidar en el checkout de producto antes de convertir esto en archivos.

| Pieza | Estado | Rol en la integración |
|---|---|---|
| `shared/contracts.ts` — `Brand`, `Work.brandId`, `WorkPatch`, `LatteAPI` | Existente | `Work.brandId` es el ancla de alcance. **No** extender `WorkPatch` ni `updateWork` con opciones de marca. Proponer métodos IPC nuevos. `listSkills`/`setSkillEnabled` cubren shipped; no heredar opt-out `skill-off:` a aprendidas. |
| `electron/bootstrap.ts` — `createBackend`, `emitChat` | Existente | Composición de `LatteService` + repo + files + hub. `completed` dispara `proposeDecisionFromAgent`; no reutilizar ese protocolo para aprendizaje ni para certificar entregable. |
| `electron/services/latteService.ts` — `memberContext`, `refreshInstructions`, `enabledSkills` | Existente | Único orquestador verificado. `memberContext` refresca instrucciones **sólo** si `liveMemberCount === 0`. Extender aquí `prepareGeneration`; no refrescar bundle desde el renderer. |
| `electron/workspace/instructions.ts` — `InstructionsInput`, `renderInstructionBundle`, `renderOutcomeContext` | Existente | Agregar puntero compacto al recibo (kit hash + skill refs), no binarios ni `SKILL.md` completos en cada turno. Skills shipped ya van como side file pointer. `INSTRUCTIONS_MAX_CHARS = 20_000`; restar pack/kit/shipped antes de learned. |
| `electron/workspace/workspace.ts` — `writeInstructions`, `syncSideFiles` | Existente | `SIDE_FILE_DIRS` = `context` y `skills` bajo `.latte/`; cada sync **borra** lo que ya no aplica. Snapshots y recibos **fuera** de esos dirs. `writeFileAtomic` no es transacción conjunta con SQLite. |
| `electron/storage/schema.ts` / `repository.ts` | Existente | `brands`, `works`, `meta`, revisiones inmutables por trigger. Tablas nuevas aditivas; `transaction(fn)` es síncrona: nada de LLM adentro. Activar foreign keys por driver. |
| `electron/ipc/register.ts` | Existente | `isTrustedSender` + cantidad de argumentos. El servicio sigue validando pertenencia y forma. |
| `electron/workspace/packs.ts` — `loadSkills` | Existente | Conservar pack `marketing-core`. Catálogo aprendido **separado**, IDs con namespace propio. |
| Dominio brand / learning y stores | NUEVO propuesto | Detalle en los briefs hermanos. Ubicación tentativa: `electron/branding/*`, `electron/learning/*`, `shared/generationContracts.ts`. |
| `.latte/generations/<generationId>/` | NUEVA ruta de datos | Copia mínima inmutable + `context.json`. Política de retención explícita **antes** de persistir. Nombre final a reservar: no chocar con `WORK_FILES`. |
| Feature flag (meta de instalación) | NUEVO propuesto | Off = comportamiento actual idéntico (shipped, instrucciones, sin recibo). |

## Reglas transversales de consistencia y seguridad

1. **Publicación atómica lógica:** escribir recursos en staging controlado, validar contenido y hash, moverlos a su ubicación inmutable y después confirmar referencias en una transacción SQLite. Un fallo antes del commit puede dejar huérfanos recuperables, pero no debe publicar referencias a archivos incompletos. Especificar recuperación y soporte real del filesystem antes de afirmar durabilidad.
2. **Versionado y concurrencia:** aprobar con versión esperada; rechazar revisiones obsoletas. No sobrescribir contenido activo. Capturar una selección consistente y hacer inmutables sus referencias antes de iniciar la generación. Las modificaciones posteriores afectan generaciones futuras.
3. **Revocación:** impedir nuevas selecciones de revisiones revocadas; preservar historial. El MVP no promete cancelar procesos ya iniciados ni retirar instrucciones de su contexto.
4. **Confianza:** importar texto/archivos como datos no confiables. Una instrucción de marca no puede elevar permisos y una candidata no puede autoaprobarse. Sanitizar secretos antes de persistir candidatos, no solamente antes de compartirlos.
5. **Proyección:** construirla desde snapshots; no usar carpetas regeneradas por el workspace como almacén de autoridad. No modificar instrucciones compartidas mientras haya miembros activos sin definir la estrategia de aislamiento/turno en el checkout real.
6. **Trazabilidad:** relacionar recibo, versión de kit, revisiones de skill, aprobación y evidencia de validación. No prometer reproducción binaria exacta de salidas del modelo.
7. **Portabilidad:** bloquear traversal, enlaces fuera del directorio permitido y referencias remotas no importadas. Las comprobaciones de paths deben considerar Windows y no reemplazan un sandbox.

## Alternativas y tradeoffs

| Alternativa | Ventaja | Costo o riesgo | Propuesta |
|---|---|---|---|
| Todo en Markdown/carpetas | Fácil edición y versionado humano | Difícil coordinar aprobación, concurrencia y auditoría | Formato de intercambio, no única autoridad |
| SQLite + recursos inmutables | Revisión transaccional y archivos accesibles | Requiere protocolo de publicación y recuperación | Base local-first recomendada |
| Todo como blobs en SQLite | Atomicidad más simple entre datos y recursos | Base grande y extracción para herramientas | Considerar si los recursos son pequeños |
| Servicio remoto multiusuario | Sincronización y control centralizado | Autenticación, costos y aislamiento nuevos | Fuera del MVP; no necesario para agencia global local |
| Activar skills automáticamente | Menos intervención | Amplifica procedimientos erróneos o inyectados | No en MVP: crear candidatas, aprobar explícitamente |

## Plan de integración futuro

Este orden alinea las etapas A–D del brief de marca y el rollout 1–5 del brief de skills. **No autoriza ejecutarlas en esta sesión.** Cada etapa es revisable por separado; flag off deja el producto como está.

| Etapa | Qué se integra | Contra qué (SHA fijado, revalidar) | No tocar | Listo cuando |
|---|---|---|---|---|
| 0. Checkout | Repo de producto, no este Astro. Fijar Hermes. | README, migraciones, drivers, `WORK_FILES` | Remotos, worktrees, `video/` | Rutas reales y SHA de Hermes en este índice |
| 1. Contratos puros | `GenerationContext`, canon, errores, tests de fixtures | Nada de I/O | IPC, UI, schema | Fixtures de marca A/B y neutro+firma rechazan casos del contrato |
| 2. Persistencia aditiva | Tablas de kits, generations, learned; triggers inmutables; CAS heads | `schema.ts`, `repository.transaction` | Cascades a `brands`/`works`; blobs grandes innecesarios | Conflicto de versión visible; huérfano de disco no queda head |
| 3. Identidad | Importar/publicar kit, resolver, snapshot | `LatteService`, diálogo nativo de archivos, `meta` para agencia | `WorkPatch`, `Brand.context` como única fuente mutable de generación | `prepareGeneration` sella `brandContext`; editar kit no muda recibos viejos |
| 4. Proyección | Puntero en bundle + `.latte/generations/` | `instructions.ts`, `workspace.ts`, `memberContext` | `.latte/context`, `.latte/skills` como almacén; reescritura con miembros vivos | `syncSideFiles` no borra generaciones; resume conserva hash |
| 5. Aprendizaje manual | Candidatas, bandeja, aprobación CAS | `bootstrap.emitChat` sólo como señal opt-in aparte; IPC nuevos | Pack shipped, IDs `skill-off:`, protocolo `latte-decision` | Candidata nunca entra al bundle; una de dos aprobaciones concurrentes gana |
| 6. Skills en el recibo | `SkillResolver` alimenta `skillRefs` | `enabledSkills` se queda para shipped; learned se suma después del presupuesto | Truncar una skill a mitad para que entre | Marca B no ve learned de A; resume no adopta versión nueva |
| 7. Evidencia y UI | `DeliveryEvidence`, `ArtifactCheck`, revisión humana | Settings / vista de candidatas a localizar | Prometer QA estética ni sandbox de SO | Recibo válido + artefacto fuera de marca = chequeo fallido, no éxito |

**Secuencia de un trabajo nuevo (cuando esté implementado):** publicar kit aprobado → (opcional) aprobar skill learned → `prepareGeneration` → abrir miembro (`memberContext`) → generar en `entregables/` → registrar checks → sólo entonces una señal de aprendizaje puede crear candidata.

**Feature flag:** meta de instalación, default off. Con off: `refreshInstructions` actual, shipped on-by-default, sin tablas leídas en el hot path. Desactivar después de usarlo conserva datos pero no introduce learned ni kit en generaciones **nuevas**; no reescribe recibos viejos.

**Recuperación (definir en etapa 2, no improvisar en 4):** staging en el mismo volumen; rename exclusivo al destino inmutable; commit SQLite después; crash intermedio = huérfano recuperable sin head; al leer, verificar hash. `rename` de archivo no atomiciza DB+disco. Drivers SQLite distintos: comprobar foreign keys y rollback reales.

**Presupuesto de instrucciones (política nueva, no límite verificado de Latte):** `INSTRUCTIONS_MAX_CHARS` es 20_000 en el compositor actual; pack `base`, brief y reglas no se recortan. Restar shipped + puntero de kit; si no cabe learned, excluir learned y decirlo. No silenciar shipped para meter aprendizaje.

**IPC propuesto (nombres tentativos, no existen hoy):** `prepareGeneration(workId)`, más los métodos de marca y de revisión de skills de los briefs hermanos. El diálogo nativo entrega la ruta al proceso main; no exponer `readFile(path)` al renderer.

**Rollback de diseño:** borrar o ignorar tablas nuevas y la carpeta `generations`; restaurar `refreshInstructions` actual. No hay migración de shipped. No hay 301 ni cambios en este sitio Astro.

Este plan organiza trabajo pendiente; no autoriza ejecutarlo en esta sesión.

## Matriz de pruebas propuesta — NO ejecutada

| Área | Escenario mínimo | Resultado esperado |
|---|---|---|
| Identidad | Marca incompleta; firma de agencia deshabilitada | No completar silenciosamente con identidad de agencia |
| Contrato | Versión de schema inválida, hash inválido o marca ajena | Rechazo antes de construir contexto |
| Versionado | Editar kit después de preparar generación | La generación conserva el snapshot original |
| Concurrencia | Dos aprobaciones con la misma versión esperada | Una gana; la otra recibe conflicto explícito |
| Recuperación | Corte entre publicación de archivos y commit SQLite | Sin revisiones activas incompletas; huérfanos recuperables |
| Skills | Mensaje completado pero entrega fallida | No convertir fin de mensaje en validación de skill |
| Confianza | Candidata con secretos o instrucciones de autoaprobación | Bloqueo/redacción; nunca activación implícita |
| Aislamiento lógico | Trabajo de marca A busca skills privadas de B | No se seleccionan; no confundir esto con sandbox |
| Revocación | Revisión revocada antes de otra generación | Exclusión de nuevas selecciones, historial conservado |
| Integración | Regeneración del workspace y miembros concurrentes | Snapshots retenidos, sin sobrescribir contexto activo |
| Miembros vivos | `prepareGeneration` con `liveMemberCount > 0` | Recibo se persiste; `CLAUDE.md`/`AGENTS.md` no se reescriben; cambio queda pendiente |
| Canon | Dos objetos equivalentes con distinta inserción de claves | Mismo SHA-256; `JSON.stringify` incidental no es contrato |
| Resultado | Recibo válido pero artefacto fuera de marca | Validación informa incumplimiento; recibo no certifica conformidad |

No usar clientes reales ni consumir inferencia paga sin autorización. Cuando se autorice implementar, ejecutar pruebas acotadas y revisión de tipos según las instrucciones aplicables, **sin builds**.

## Key Learnings:

1. El join de marca y skills es un recibo inmutable `GenerationContext`; no un bundle regenerable ni un mensaje `completed`.
2. `memberContext` ya serializa la reescritura de instrucciones a “cero miembros vivos”; el pin de generación tiene que respetar esa frontera, no inventar un bus paralelo.
3. `syncSideFiles` borra `.latte/context` y `.latte/skills`: autoridad y snapshots van a SQLite + `.latte/generations/`, nunca a esos dirs.
4. Tres registros distintos: recibo (qué se preparó), evidencia de entrega (qué se proyectó), chequeo de artefacto (qué se validó). Colapsarlos fabrica éxitos falsos.

## Checklist para retomar

- [ ] Leer este índice y los dos briefs, incluidas fuentes y pendientes.
- [ ] Confirmar alcance de implementación aprobado; no interpretar código de ejemplo como autorización.
- [ ] Fijar Hermes y revalidar fuentes externas y revisión de Latte.
- [ ] Ubicar repo real antes de convertir rutas propuestas en archivos.
- [ ] Preservar `video/` y cualquier cambio ajeno.
- [ ] Mantener aprendizaje por marca aislado y no confundir instrucciones con sandbox.
- [ ] Resolver recuperación, retención de snapshots y migración de datos antes de activar persistencia.

## Memoria complementaria

Engram, proyecto `marketia`: `product/brand-kits`, `product/adaptive-skills`, `workflow/research-before-brand-skills`, `research/brand-skills-workspace`.
Antecedente histórico del producto: proyecto `latte`, observación #3812, `architecture/shipped-skills`; recuperar contenido completo y revalidar contra código antes de usarlo.

