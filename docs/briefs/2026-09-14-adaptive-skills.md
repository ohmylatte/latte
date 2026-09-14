# Brief de investigación: skills que Latte aprende con el uso

Fecha: 2026-09-14. Estado: **propuesta para revisión, no aprobada ni implementada**.

## Pedido y límites

Investigar el sistema de auto-creación de skills de NousResearch/Hermes Agent y proponer su adaptación a Latte junto con kits de identidad de marca y agencia. Dejar un handoff persistente antes de implementar. La ampliación solicitada autoriza arquitectura y código ilustrativo dentro de este brief, NO implementación, builds, instalaciones ni cambios a skills existentes. El workspace MarketIA es el sitio Astro; se inspeccionó código remoto del producto fijado a una revisión, no se ejecutó su runtime.

## Conclusión ejecutiva

Conviene adoptar el concepto de memoria procedural y su paquete interoperable, **no copiar sin evaluación los defaults de autonomía ni el scheduler de Hermes**. MVP propuesto: Latte detecta señales, genera una candidata con evidencia, permite revisar el diff y sólo carga la versión aprobada. Un patrón aprendido no es una verdad validada por el hecho de que el modelo lo escriba.

## Evidencia verificada de Hermes

Fuentes oficiales de `main` y documentación pública consultadas el 2026-09-14 (fecha de consulta, no de publicación). No se obtuvo un SHA reproducible: los enlaces son mutables y deben fijarse antes de implementación. Se distinguió documentación actual de resultados de búsqueda antiguos.

### Formato y descubrimiento — documentado

Un paquete contiene `SKILL.md` con YAML (`name`, `description`, ejemplo con `version` y `metadata.hermes`) y Markdown. La estructura recomendada separa cuándo usar, procedimiento, fallos y verificación; puede agregar referencias, plantillas, scripts y assets. `skills_list` descubre el índice, `skill_view` carga cuerpo o referencia bajo demanda. `/learn` transforma fuentes o una conversación en un turno guiado que escribe mediante `skill_manage`; no es un motor separado de entrenamiento.

La escritura acepta `create`, `patch`, `edit`, `delete`, `write_file` y `remove_file`. `skills.write_approval` es **false por defecto**; al activarlo, las mutaciones se guardan pendientes para revisar diff, aprobar o rechazar. `external_dirs` no es una frontera de sólo lectura: si el proceso puede escribir, el agente puede modificar skills externas. No interpretar esta organización de carpetas como aislamiento entre clientes.

Fuente: [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).

### Disparadores — confirmado en código

- El prompt pide registrar workflows no triviales con `skill_manage`. El comentario conserva una redacción antigua de “5+ tool calls”; **no es un detector determinista actual de repetición**. [prompt_builder.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py), `SKILLS_GUIDANCE`, líneas 190–210.
- El valor inicial de `skills.creation_nudge_interval` es 10. [agent_init.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/agent_init.py), `_apply_agent_section`, líneas 1205–1209.
- El cierre de turno comprueba `_iters_since_skill >= _skill_nudge_interval`, intervalo positivo y disponibilidad de `skill_manage`; resetea el contador y solicita revisión con snapshot si hay respuesta, no hubo interrupción y no se deshabilitó la revisión. Por tanto, no afirmar “cada diez mensajes” ni “sólo después de éxito validado”: esta condición no comprueba `completed`. [turn_finalizer.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/turn_finalizer.py), líneas 557–584. Queda pendiente seguir todos los incrementos del contador.
- El prompt de revisión busca correcciones de estilo/proceso, técnicas reutilizables y skills desactualizadas. Prefiere actualizar la skill pertinente y exige no presentar intentos fallidos como métodos probados. También presiona a producir actualizaciones; esa presión puede incentivar ruido y **no se recomienda copiarla**. [background_review.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py), `_SKILL_REVIEW_PROMPT`, líneas 327–368.

### Escritura y seguridad — confirmado en código

`skill_manager_tool.py` valida frontmatter, nombre y cuerpo. El guard de aprobación intercepta mutaciones antes del handler; replay de una aprobación evita volver a staging. Hay captura de estado anterior para ledger, pero es telemetría best-effort: su fallo no impide mutar. El scanner `guard_agent_created` está apagado por defecto; además una excepción del scanner termina permitiendo continuar. **No trasladar ese comportamiento fail-open a Latte.** Sus directorios admitidos para `write_file/remove_file` son `references`, `templates`, `scripts`, `assets`, aunque otras partes de la documentación mencionan también `examples`: verificar compatibilidad por operación.

Fuente: [skill_manager_tool.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_manager_tool.py), líneas 36–58, 74–80, 115–118, 556–584 y 687–722.

### Memoria, revisión y mantenimiento — documentado

La memoria declarativa usa `MEMORY.md`/`USER.md` con límites; el historial se consulta separadamente. La revisión de fondo puede usar herramientas de memoria, skills y lectura; no se debe confundir aislamiento de conversación con aislamiento del filesystem. `auxiliary.background_review.enabled: false` desactiva forks automáticos, mientras `/refine` sigue disponible. Ocultar notificaciones **no** apaga el aprendizaje. Cambiar el modelo de revisión también cambia el costo y el contexto disponible; requiere medición propia.

Fuente: [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).

El Curator mantiene actividad, archiva y permite restaurar. Su consolidación LLM es opt-in; dispone de snapshots y ledger. La marca `created_by: agent` funciona como autorización para mantenimiento autónomo, no como prueba histórica de autoría: actualmente se aplica a creación de background review, no a toda creación en conversación. No inferir ownership a partir de frecuencia de edición. La propia página contiene intervalos de archivo contradictorios en distintas secciones; no adoptar valores sin revisar código fijado.

Fuente: [Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator).

## Antecedente de integración de Latte — investigación inicial

El README público documenta skills Markdown del pack `marketing-core`, declaración en manifest y composición en `CLAUDE.md`/`AGENTS.md` al iniciar o reanudar sesiones. Eso da un punto conceptual de carga, **no prueba que exista ya descubrimiento progresivo ni un hook de aprendizaje**. Investigar el runtime real antes de elegir archivos/clases de implementación. No migrar ni sobrescribir `packs/marketing-core/skills/*.md`.

Fuente: [README oficial de Latte](https://raw.githubusercontent.com/ohmylatte/latte/main/README.md).

Antecedente histórico proporcionado por el coordinador: Engram `latte` #3812, diseño del 2026-09-07, leído completo por él. Menciona `electron/workspace/packs.ts` (`loadSkills`), `electron/workspace/instructions.ts` (`PackSkill`/render), `electron/services/latteService.ts` (`listSkills`/`setSkillEnabled`/`enabledSkills`), `src/SkillsView.tsx`, `src/SettingsScreen.tsx` y `packs/marketing-core/skills/writing.md`. **Revalidar en el repo de producto:** no son archivos comprobados en este checkout. El antecedente describe shipped skills activadas por defecto y desactivación `skill-off:<id>='1'`; no heredar ese default en candidatas aprendidas. También registra un presupuesto de instrucciones `base.md` menor de 6000 caracteres: verificarlo antes de expandir contexto.

## Diseño propuesto para Latte — NO describe Hermes existente

### Separar cuatro clases de información

1. **Kit de marca:** logo, tipografía, paleta, tono y reglas aprobadas; fuente de identidad, no skill generada.
2. **Configuración de agencia:** identidad global, web y firma; aplicable sólo cuando corresponde.
3. **Memoria:** preferencias/factos durables con alcance explícito.
4. **Skill:** procedimiento reutilizable de una clase de tarea, que recibe el kit resuelto como entrada.

Ejemplo: “armar informe mensual” puede reutilizarse entre clientes sin copiar logos, métricas, nombres ni rutas privadas del cliente original. “Esta marca usa determinada paleta” pertenece al kit. Una corrección visual puede proponer modificar el kit, pero requiere aprobación separada y no debe convertirse en regla de agencia.

### Lifecycle

`señal → candidata → validada técnicamente → pendiente de aprobación → activa → revisión → archivada`

- Señales: workflow exitoso no trivial, corrección explícita durable o recurrencia de una secuencia útil. Repetición por sí sola no demuestra calidad.
- Examinar primero las skills existentes del alcance autorizado: proponer patch de una aprendida o extensión separada; nunca escribir sobre una shipped/manual sin autorización explícita.
- Candidata incluye pasos generalizados, disparador, precondiciones, validación, límites, evidencia y por qué sería reutilizable. Un resultado incompleto sólo permite proponer un hallazgo etiquetado, nunca un procedimiento “validado”.
- Evidencia/auditoría en sidecar separado del procedimiento: referencias locales a resultados autorizados, no transcripciones ni secretos incorporados a `SKILL.md`.
- Validación determinista comprueba esquema, enlaces dentro del paquete, tamaño, ausencia de secretos conocidos, colisiones, alcance y permisos. El escaneo semántico es una señal adicional, no una garantía.
- Revisión humana presenta contenido y diff, alcance, evidencia resumida y riesgo. Rechazar no activa; aprobar publica una versión inmutable. Un diff pendiente queda obsoleto si cambió su versión base.
- En una nueva sesión se resuelven sólo versiones activas autorizadas; registrar IDs/versiones efectivamente usadas. No mutar retroactivamente el contexto de un entregable en curso.
- Registrar aceptación, correcciones y verificación separadas de simple lectura. Nada se promueve a agencia porque “se usó mucho”.
- Archivar conserva restauración; MVP sin borrado ni consolidación autónoma.

### Alcance, marca y agencia

Propuesta: cada candidata nace en el proyecto/marca que aportó evidencia. Una skill genérica de agencia requiere promoción explícita, sanitización y revisión de confidencialidad. Usar IDs estables y ownership independiente de nombre/carpeta. Resolver autorización **antes** de buscar o indexar: impedir que incluso la descripción de otra marca entre al prompt.

Identidad y firma son entradas independientes del entregable. Si falta un kit, usar neutral o pedir el dato cuando sea imprescindible; nunca completar automáticamente con estética de agencia. La preferencia del usuario para este entregable no reescribe globalmente la marca ni una skill reutilizable.

### Formato candidato, sin comprometer compatibilidad

Mantener un paquete `SKILL.md` con `name`, `description` y secciones de uso, entradas, procedimiento, excepciones y verificación. Guardar estado de aprobación, scope/owner, origen, versión base/hash, evidencia y métricas en registro/sidecar de Latte: **son extensiones propuestas, no campos estándar Hermes**. Probar un adaptador hacia los manifests actuales antes de decidir migraciones. Scripts generados quedan fuera del MVP para no convertir captura de conocimiento en ejecución arbitraria.

### Alternativas y tradeoffs

| Opción | Beneficio | Costo / riesgo |
|---|---|---|
| Sólo comando explícito “guardá este proceso” | Consentimiento claro y poco ruido | Menos captura automática |
| Candidatas automáticas + aprobación (recomendada) | Aprende sin afectar silenciosamente entregables | Bandeja de revisión y posible acumulación |
| Activación automática | Menor fricción | Contaminación, secretos, regresiones y difícil atribución |

Arranque sugerido: captura manual y candidatas automáticas con presupuesto bajo, configurable y apagable. Un límite de tokens/trabajos explícito evita gasto invisible. Definir deduplicación por evidencia + clase de tarea, no contar cinco llamadas como “skill descubierta”.

## Criterios de aceptación propuestos

- Una tarea trivial o fallida no publica una skill.
- Una señal pertinente produce como máximo una candidata o patch deduplicado, con evidencia y alcance visible.
- Rechazar, apagar aprendizaje o superar presupuesto impide nuevas activaciones; apagar captura no impide usar skills ya aprobadas.
- Candidatas no entran al índice/runtime; aprobar activa una versión trazable en la próxima resolución.
- Proyecto B nunca descubre contenido, descripciones ni evidencia privada de A.
- Promover a agencia requiere aprobación distinta y sanitización; no sucede por recurrencia.
- Kits y firma se resuelven por entregable; una skill genérica no copia identidad del cliente fuente.
- Skills shipped y manuales permanecen intactas; conflictos de base/ediciones concurrentes no pisan contenido.
- Reiniciar conserva pendientes y decisiones; recuperación/rollback restaura la versión anterior.
- Una skill malformada, ruta traversal, symlink fuera del scope o sospecha de secretos queda bloqueada para revisión, sin fail-open.
- Registrar cuándo se consultó versus cuándo se aplicó y con qué resultado; demostrar con un caso positivo, uno negativo y uno de aislamiento por scope.

## Riesgos y pendientes

- Injection persistente: datos externos pueden intentar convertirse en instrucciones durables. Separar confianza de la fuente y aplicar permisos fuera del prompt.
- Sobreaprendizaje y biblioteca ruidosa: deduplicar, permitir “nada que guardar” y medir utilidad real.
- Filtración entre marcas: almacenamiento, búsqueda, exportación, sincronización y telemetría deben conservar scope.
- Costo/latencia: revisión de fondo no es gratis; no copiar frecuencias ni promesas de ahorro de Hermes.
- Compatibilidad: el renderer de Latte podría inyectar skills completas; progressive disclosure requiere capacidades reales del runner, no sólo una carpeta nueva.
- Reproducibilidad pendiente: obtener SHA de Hermes, revisar tests de guards y los incrementos del contador; confirmar el codepath exacto de cierre de sesión de Latte.
- Producto pendiente: dónde se revisan candidatas, rol que puede promover a agencia, política de retención, exportación y preferencia inicial de automatización.

## Handoff antes de implementar producto

1. Revisar este brief y el de identidad; acordar alcance del MVP.
2. Contrastar el mapa fijado de la ampliación con el checkout del producto donde se implemente; confirmar drivers, migraciones y permisos.
3. Fijar revisiones de fuentes y resolver las discrepancias documentadas; no trasladar defaults por intuición.
4. Revisar los contratos y las transacciones propuestas abajo, completar adaptadores y mantener migración cero para shipped skills.
5. Recién con aprobación, convertir aceptación en plan de pruebas e implementación. **No ejecutar build.**

## Ampliación: arquitectura y código propuesto (sin ejecutar)

Todos los tipos, tablas y servicios de esta sección son **nuevos contratos propuestos**, no APIs existentes. Los fragmentos ilustran responsabilidades; no son una implementación pegable ni fueron compilados o probados. No se modifica el producto desde este checkout.

### 1. Mapa comprobado y puntos de extensión

Revisión del producto: `cb5496db0361a3dda8035011cf34d447bba29dd0`.

| Fuente fijada | Evidencia y uso propuesto |
|---|---|
| [bootstrap.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/bootstrap.ts) | `emitChat` observa mensajes assistant completados y procesa propuestas de decisiones. Agregar observación ligera, sin reutilizar el protocolo de decisiones ni inferir éxito de `completed`. |
| [packs.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/workspace/packs.ts) | `loadSkills` recorre IDs declarados y convierte archivos del pack a `PackSkill`. Preservar este cargador; agregar catálogo aprendido separado. |
| [instructions.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/workspace/instructions.ts) | El bundle referencia side files por skill, no concatena todos sus cuerpos. El texto exige leerlas antes del copy final; no equivale a selección semántica. Adaptar mensajes para triggers y selección acotada. |
| [latteService.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/services/latteService.ts) | `listSkills`, `setSkillEnabled`, `enabledSkills` operan sobre shipped skills, habilitadas salvo opt-out. `memberContext` refresca archivos compartidos cuando no hay miembros vivos. Agregar métodos específicos de candidatas y snapshot por generación, sin heredar opt-out. |
| [repository.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/storage/repository.ts) | Expone `transaction(fn)` síncrona y persistencia de propuestas/eventos de decisiones. Extender repositorio con tablas propias; jamás esperar una llamada al modelo dentro de la transacción. |

Esto reemplaza la incertidumbre del antecedente sobre carga completa de cuerpos. No demuestra que exista ya aprendizaje, una cola durable, aislamiento de procesos o APIs de aprobación de skills. Hermes sigue documentado arriba con fuentes mutables: **no quedó revalidado a un SHA en esta ampliación**.

### 2. Componentes y ubicación futura

```text
evento completado / acción humana de captura
  -> LearningService.observe: política + scope + dedup + outbox
  -> LearningWorker: claim/lease -> reserva de costo -> resumen autorizado
  -> CandidateGenerator: devuelve JSON, sin tools de escritura/ejecución
  -> CandidateValidator: contrato + rutas + tamaño + contenido + alcance
  -> revisión humana: diff + evidencias + versión/hash
  -> publicación transaccional: versión inmutable + puntero activo + auditoría
  -> SkillResolver: autoriza primero, selecciona después, aplica presupuesto
  -> GenerationContext fijado -> proyección a instrucciones del trabajo
```

| Archivo futuro en producto | Responsabilidad |
|---|---|
| `shared/learningContracts.ts` | DTOs de candidatas, revisión, política y versiones; validación runtime en backend. |
| `electron/learning/service.ts` | Ingreso de señales y acciones humanas; no llama modelos desde eventos de UI. |
| `electron/learning/worker.ts` | Cola persistida, leases, reintentos limitados, cancelación y reserva de costo. |
| `electron/learning/validator.ts` | Formato, límites, reglas de paquete y bloqueo ante fallas de scanner. |
| `electron/learning/resolver.ts` | Filtra alcance/aprobación, verifica hash y entrega referencias inmutables. |
| `electron/storage/learningRepository.ts` | Puerto/adaptador futuro con CAS y transacciones; definir cómo se integra al repositorio actual. |
| `electron/storage/learningSchema.ts` | DDL propuesto; conectar al mecanismo real de migraciones tras inspeccionarlo. |
| `src/SkillCandidatesView.tsx` | Bandeja, diff, evidencia local y confirmación explícita; no confía en estado enviado por renderer. |
| `electron/bootstrap.ts`, `electron/services/latteService.ts`, `electron/workspace/instructions.ts` | Cableado verificado que se ampliaría; no registrar un supuesto hook universal de “trabajo exitoso”. |

También habrá que ampliar contracts/preload/IPC y sus validadores en los archivos reales que corresponda localizar. No queda autorizado un endpoint arbitrario desde el agente para aprobar. La agencia significa **esta instalación local**, no un tenant SaaS; no inventar roles corporativos. Una UI humana puede aprobar o promover; el alcance de marca se obtiene del trabajo en backend, nunca del JSON del modelo.

### 3. Señales, identidad y contratos

Primera fase: captura manual y observación de mensaje completado opt-in. La segunda sólo es elegible si contiene una propuesta de procedimiento o corrección explícita relevante; un mensaje terminado no certifica validación del resultado. Recurrencia sirve para priorizar evidencia, no para activar. Un clasificador determinista puede descartar señales triviales antes del modelo. Agregar detección automática más sofisticada después de medir ruido.

```ts
type Scope = { kind: 'brand'; brandId: string } | { kind: 'agency' };
type CandidateState = 'draft' | 'validating' | 'needs_review'
  | 'blocked' | 'approved' | 'rejected' | 'superseded';
type SkillRef = { skillId: string; version: number; hash: string };
type GenerationContext = {
  schemaVersion: 1;
  workId: string;
  brandId: string;
  brandContext: { kitId: string; version: number; hash: string } | null;
  skillRefs: SkillRef[];
};
type LearningSignal = {
  sourceKey: string; // JSON canónico de runtime/chatId/messageId o ID de acción humana
  workId: string;
  kind: 'explicit_capture' | 'durable_correction' | 'procedure_proposal';
  evidenceRefs: { documentId: string; revisionId: string; hash: string }[];
  verification: 'human_confirmed' | 'check_passed' | 'unverified';
};
type CandidatePayload = {
  name: string;
  description: string; // incluye cuándo aplicar y cuándo NO aplicar
  markdown: string;
  targetSkillId: string | null; // sólo learned autorizado, nunca shipped
  base: { version: number; hash: string } | null;
};
type ReviewCommand = {
  requestId: string;
  candidateId: string;
  expectedRevision: number;
  expectedHash: string;
  decision: 'approve' | 'reject';
};
```

Hash = SHA-256 de bytes UTF-8 canónicos del paquete validado, incluyendo referencias permitidas ordenadas por ruta y contenido. No confundir con fingerprint corto de documentos existentes. Registrar scope/target/base junto al hash revisado; cualquier edición incrementa `revision`, invalida la validación anterior y exige nueva revisión.

Deduplicar entregas del mismo evento por `(scope_key, source_key)` y revisión del trabajo, conservando evidencia adicional como referencias. Separar eso de `pattern_key`: hash de clase de tarea + procedimiento normalizado + scope + versión del algoritmo. Dos procedimientos parecidos sólo generan sugerencia de merge; nunca deduplicar semánticamente borrando evidencia o reactivar un rechazo porque cambió el texto. Una propuesta nueva sobre un rechazo debe aparecer como tal y explicar la nueva evidencia.

Payload de generación ilustrativo (los límites son defaults de producto propuestos):

```json
{
  "schemaVersion": 1,
  "task": "propose_reusable_procedure_or_none",
  "limits": { "maxCandidates": 1, "maxMarkdownBytes": 12288 },
  "allowedInputs": ["resolvedBrandContext", "authorizedEvidenceSummary"],
  "rules": ["Sin datos del cliente", "Sin scripts", "No declarar éxitos no verificados"],
  "response": { "kind": "none", "reason": "No hay procedimiento reutilizable" }
}
```

`none` es una salida válida y terminal de la evaluación; no insistir hasta fabricar una skill. En salida candidata, el backend determina origen y scope y valida el DTO; ningún campo del modelo puede decidir aprobación, gasto o permisos.

### 4. Persistencia, estados y publicación atómica

DDL conceptual para SQLite, a adaptar/verificar contra **cada driver soportado**; no es una migración aplicada. La autoridad es la DB local, no los side files que el compositor puede reemplazar. Para el MVP guardar cuerpos Markdown pequeños en DB permite aprobar sin transacción distribuida filesystem/DB. Exportar `SKILL.md` es una proyección posterior regenerable.

```sql
CREATE TABLE learned_skills (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL, -- brand:<id> o agency:local
  active_version INTEGER,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
  UNIQUE (id, scope_key)
);
CREATE TABLE skill_candidates (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES learned_skills(id),
  scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('draft','validating','needs_review','blocked','approved','rejected','superseded')),
  revision INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  markdown TEXT NOT NULL,
  base_version INTEGER,
  base_hash TEXT,
  validated_hash TEXT,
  pattern_key TEXT NOT NULL,
  FOREIGN KEY (skill_id, scope_key) REFERENCES learned_skills(id, scope_key)
);
CREATE TABLE learned_skill_versions (
  skill_id TEXT NOT NULL REFERENCES learned_skills(id),
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  markdown TEXT NOT NULL,
  approved_from TEXT NOT NULL UNIQUE REFERENCES skill_candidates(id),
  approved_at TEXT NOT NULL,
  PRIMARY KEY (skill_id, version)
);
CREATE TABLE learning_jobs (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  source_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('queued','running','done','no_candidate','deferred','failed')),
  lease_until TEXT,
  lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  candidate_id TEXT REFERENCES skill_candidates(id),
  evidence_json TEXT NOT NULL,
  UNIQUE (scope_key, source_key)
);
CREATE TABLE skill_review_receipts (
  request_id TEXT PRIMARY KEY,
  command_hash TEXT NOT NULL,
  result_json TEXT NOT NULL
);
CREATE TABLE skill_audit (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES skill_candidates(id),
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER learned_skill_versions_no_update
BEFORE UPDATE ON learned_skill_versions
BEGIN SELECT RAISE(ABORT, 'Las versiones aprobadas son inmutables'); END;
CREATE TRIGGER learned_skill_versions_no_delete
BEFORE DELETE ON learned_skill_versions
BEGIN SELECT RAISE(ABORT, 'Las versiones aprobadas se conservan'); END;
```

Activar foreign keys por conexión según driver; el esquema es un núcleo, faltan tablas concretas de reservas de costo y snapshots al convertirlo en migración. `active_version = NULL` significa que ese ID aún no tiene versión publicada. Validar en repositorio que el puntero sólo referencia una versión existente del mismo ID. No usar “fila existe” como “aprobada”.

Transiciones permitidas: `draft -> validating -> needs_review | blocked`; `needs_review -> approved | rejected | superseded`; una edición crea nueva revisión `draft`; `blocked -> draft` sólo tras corrección explícita. Una skill publicada tiene versiones inmutables y lifecycle independiente `active -> archived -> active`, con restauración humana de una versión aprobada. Una base obsoleta pasa a `superseded`, no sobrescribe la activa. Rechazo y archivo mantienen auditoría; no hay borrado automático.

Aprobación SQL de referencia dentro de **una transacción de escritura**, después de releer y autorizar scope, validar hash actual y comparar base versión/hash:

```sql
UPDATE skill_candidates
SET state = 'approved', revision = revision + 1
WHERE id = :candidate_id AND state = 'needs_review'
  AND revision = :expected_revision
  AND content_hash = :expected_hash
  AND validated_hash = :expected_hash;
-- Exigir exactamente 1 fila; si no, ROLLBACK/conflicto.

INSERT INTO learned_skill_versions
  (skill_id, version, content_hash, markdown, approved_from, approved_at)
SELECT skill_id, :next_version, content_hash, markdown, id, :now
FROM skill_candidates WHERE id = :candidate_id;

UPDATE learned_skills SET active_version = :next_version
WHERE id = :skill_id AND scope_key = :authorized_scope
  AND lifecycle = 'active'
  AND (active_version = :base_version
       OR (active_version IS NULL AND :base_version IS NULL));
-- Exigir exactamente 1 fila; si no, ROLLBACK de TODA la publicación.
-- INSERT auditoría + receipt de request_id en la misma transacción; COMMIT.
```

El adaptador calcula `next_version = MAX(version) + 1` bajo lock; la base debe ser el puntero activo leído, con hash coincidente en `learned_skill_versions`. Comparar NULL no basta si se omite esa validación. Un replay de `requestId` devuelve el receipt sólo si coincide `command_hash`; reutilizar ID con otro comando es conflicto. Una carrera entre revisores produce un ganador; una carrera entre dos candidatas de igual base vuelve obsoleta la segunda. Ninguna llamada LLM ni materialización de archivos ocurre en esta transacción.

### 5. Cola, recuperación y costo por proveedor

`observe` persiste el job y la evidencia autorizada antes de retornar; no copia transcripciones enteras. Inicialmente es captura de **eventos observados**, no garantía de entrega de todos los eventos del runtime: para cerrar la ventana “mensaje completado / crash antes de enqueue” hace falta incorporar outbox a la persistencia del mensaje o reconciliación de mensajes completados, cuyo camino debe inspeccionarse antes de implementar. No prometer exactly-once.

Worker: claim atómico con lease y token de intento; verifica captura habilitada antes de reservar, antes del envío y antes de persistir resultado. Al reiniciar retoma `queued` y leases expirados, respetando máximo de intentos. Publica resultado y `job.done` en una transacción; el CAS exige `state = 'running'`, `lease_token = :attempt_token` y `lease_until > :now`, con exactamente una fila afectada o rollback de toda la publicación. Cada claim reemplaza el token: un worker con lease viejo no puede persistir. Crash después del request pero antes de guardar puede repetir gasto externo: reutilizar idempotency key sólo si el proveedor la soporta, o dejar `deferred` para revisión cuando el resultado/gasto es incierto.

```ts
// Puertos nuevos: implementar adaptadores explícitos, no asumir métodos actuales.
interface ReviewCostGate {
  reserve(input: {
    jobId: string; provider: string; model: string;
    maxInputTokens: number; maxOutputTokens: number;
    maxCostMicros: number;
  }): Promise<{ kind: 'reserved'; reservationId: string }
    | { kind: 'denied'; reason: string }>;
  settle(reservationId: string, usage: {
    inputTokens: number; outputTokens: number; costMicros: number;
  } | null): Promise<void>; // null mantiene gasto/reserva conservadora, no libera gratis
}
```

Default propuesto: auto-captura apagada, sin proveedor auxiliar implícito; manual disponible con confirmación del proveedor y gasto. Si se activa: máximo un job simultáneo, input 8000 tokens, output 2000, dos intentos; tope diario monetario configurable y reserva atómica por instalación. Tarifas deben venir de configuración verificada y versionada, **no de números del brief**. Si una CLI no expone límites/costo suficientes, bloquear revisión automática para ese adaptador; ofrecer captura manual sin llamada de fondo. Pausar por gasto no desactiva skills aprobadas. Cancelar puede no evitar un cobro de una llamada ya enviada: mostrarlo.

### 6. Carga autorizada y contexto fijado

Resolver primero `brand:<work.brandId>` y `agency:local`, después filtrar lifecycle activo + versión aprobada + toggles específicos learned. Sólo entonces indexar/describir/rankear. Candidatas nunca se proyectan dentro del directorio del trabajo. La promoción marca -> agencia crea **otra candidata/ID**, elimina evidencia privada del paquete exportable y exige revisión separada; no cambia `scope_key` de la original.

Presupuesto inicial propuesto para learned: hasta tres seleccionadas por tarea, 900 tokens de índice y 6000 tokens de cuerpos por generación, con tamaño individual máximo 12 KiB. Es política nueva, no límites verificados de Latte. Medir tokens con adaptador del modelo; sin contador fiable usar límite conservador de bytes. Restar primero instrucciones obligatorias, kit y shipped; si no cabe, excluir learned completas y explicarlo, nunca truncar una validación a mitad. No alterar silenciosamente comportamiento shipped para que entre el nuevo catálogo.

El resolver devuelve refs y cuerpos verificados; el compositor genera pointers y side files para las seleccionadas. Una skill puede ser “seleccionada”, no necesariamente “leída” o “aplicada”: sólo registrar esas métricas con evidencia del runtime, nunca inferirlas de que exista el archivo.

`GenerationContext.brandContext` referencia la composición resuelta e inmutable de identidad y firma: `kitId` es el ID lógico de esa resolución, no necesariamente el ID de un kit fuente. Es `null` sólo sin identidad ni firma; neutral con firma tiene referencia no nula. Los kits fuente se registran por separado en la resolución del brief de marca.

Persistir `GenerationContext` antes de arrancar cada generación y asociarlo a chat/miembro/entregable mediante un ID de generación. Proyectar contenido inmutable en una ubicación propuesta `.latte/generations/<generationId>/`; la DB conserva autoridad. **No almacenar candidatas ni snapshots autoritativos bajo `.latte/context` o `.latte/skills`**, áreas de proyección regenerable. La estrategia exacta de directorios compartidos está coordinada con el brief de marca y debe verificarse en `workspace.ts` antes de implementarla.

Reanudar una generación usa las mismas refs y hashes, aunque exista una aprobación nueva; no reescribe compartidos mientras hay sesiones vivas. Una nueva generación puede resolver nuevas versiones. Si falta una versión o cambió el hash, detener carga con conflicto; no sustituir por latest. Archivar evita nueva selección; revocar por riesgo además bloquea resume y requiere una generación nueva sin esa skill, con advertencia de que el contexto que el proveedor ya vio no se puede retirar retroactivamente. Los chats existentes sin snapshot siguen modo legacy hasta nueva generación explícita: no atribuirles retrospectivamente versiones que no se registraron.

### 7. Formato y frontera de seguridad

Ejemplo de **paquete futuro aprendido**, no reemplaza los `.md` shipped:

````markdown
---
name: informe-mensual-comprobable
description: Crear informes mensuales con métricas autorizadas y trazables; no usar para estimar datos faltantes.
---
# Informe mensual comprobable
## Entradas
Período, métricas autorizadas y contexto de marca resuelto (puede ser neutral).
## Procedimiento
1. Comprobar período y procedencia de cada métrica.
2. Separar observaciones, inferencias y datos faltantes.
3. Redactar usando el kit recibido; no incorporar identidades del historial.
## Verificación
Cada cifra tiene fuente autorizada; no se inventaron valores ni branding.
## Límites
Detener la sección que requiera datos inexistentes; indicar qué falta.
````

`references/` y `assets/` son opcionales para fase posterior; MVP sólo Markdown sin scripts ni HTML activo, sin URLs remotas que se descarguen automáticamente. Estado, scope, aprobaciones, costo y evidencia van en DB, no en frontmatter confiable por el agente. Validar rutas normalizadas/realpath, rechazar traversal, symlinks/junctions externos y nombres reservados antes de exportar; hash y comparación deben usar los mismos bytes validados. Fallo de scanner -> `blocked`, nunca allow.

La validación no elimina prompt injection: una skill es instrucción persistente y una evidencia externa puede ser maliciosa. El revisor de fondo debe recibir resumen mínimo y carecer de tools de red/filesystem/ejecución. **La separación lógica de catálogo no es sandbox de SO**: agentes CLI con permisos al disco pueden leer/modificar DB o archivos si se les permite. El MVP no puede prometer protección contra un proceso local hostil del mismo usuario; aislamiento fuerte exige permisos/sandbox de proceso revisados por runtime. El hash detecta deriva accidental, no manipulación hostil de DB y hash juntos. No enviar evidencia de otra marca a prompts, telemetría o exportaciones; aprobación humana reduce riesgo, no lo demuestra ausente.

### 8. Pruebas propuestas, NO ejecutadas, y rollout

Ejemplo de especificación de tests con un arnés **a implementar**, sin introducir dependencia concreta:

```ts
interface LearningScenario {
  emitSameSignalTwice(): Promise<number>; // cantidad persistida de jobs
  approveConcurrently(): Promise<('approved' | 'conflict')[]>;
  resolveOtherBrand(): Promise<string[]>; // IDs aprendidos visibles
  restartWithExpiredLease(): Promise<number>; // claims nuevos válidos
  resumePinnedAfterNewApproval(): Promise<boolean>; // conserva versión anterior
}
async function acceptance(s: LearningScenario): Promise<void> {
  const assert = (ok: boolean) => { if (!ok) throw new Error('Contrato incumplido'); };
  assert(await s.emitSameSignalTwice() === 1);
  const results = await s.approveConcurrently();
  assert(results.filter(x => x === 'approved').length === 1);
  assert(results.filter(x => x === 'conflict').length === 1);
  assert((await s.resolveOtherBrand()).length === 0);
  assert(await s.restartWithExpiredLease() === 1);
  assert(await s.resumePinnedAfterNewApproval());
}
```

Agregar fixtures: scanner falla; candidato cambia tras review; base obsoleta; requestId repetido con distinto hash; budget agotado/uso desconocido; respuesta `none`; proceso cae en cada frontera; evidencia pertenece a otra marca; token budget insuficiente; hash corrupto; ruta Windows/junction; revocación al resume; scoped promotion; DB driver sin rollback compatible. Verificar invariantes DB y proyección, no sólo capturas de UI.

Rollout: (1) esquema aditivo y feature flag off; (2) captura manual y bandeja; (3) publicación/carga aprendida opt-in; (4) worker automático con reservas; (5) evaluar ruido/aceptación y recién después recurrencia más amplia. Con flag off, comportamiento y archivos shipped actuales deben quedar iguales. No convertir `packs/marketing-core/skills/*.md`, no cambiar IDs/toggles `skill-off:`, no convertir manuales en autoría del agente. Prefijar IDs learned con namespace separado y adaptar a los IDs permitidos por compositor. Desactivar feature deja datos conservados pero no introduce learned en generaciones nuevas; no elimina versiones fijadas en generaciones anteriores.

## Key Learnings:

1. En Hermes, el formato de skill es sólo una pieza: prompt, disparador de revisión, herramienta de escritura y control de activación son mecanismos distintos.
2. Recurrencia o cantidad de llamadas no certifica que un procedimiento sea correcto ni apto para compartirse entre marcas.
3. Un kit de identidad es dato gobernado; una skill es un procedimiento que lo consume sin apropiarse de sus datos.
