# Brief: kits de marca y perfil de agencia para Latte

Fecha: 2026-09-14. Estado: propuesta para revisión; NO es una especificación de una implementación existente ni autorización para implementarla.

## 1. Pedido y evidencia disponible

El usuario quiere que los entregables puedan adoptar la identidad de cada marca mediante una carpeta `brand/`, cuando exista, y que haya configuración global de agencia: logo, web y datos relacionados. Reporta que hoy percibe una estética asociada a Claude o Codex; esa percepción todavía no fue contrastada con entregables reales.

También pidió investigar la creación progresiva de skills de Hermes Agent de Nous Research y dejar briefs persistidos ANTES de programar. Este documento cubre identidad; el comportamiento real de Hermes debe sustentarse en el brief de investigación correspondiente, no inferirse de esta propuesta.

Evidencia local reportada por la exploración del coordinador: `README.md` y `package.json` identifican este checkout (`C:/Users/gabog/orca/projects/MarketIA`) como el sitio estático `latte-web`, hecho con Astro. No se ha localizado aquí el runtime de la aplicación Latte. Por lo tanto, las entidades, carpetas y puntos de integración de abajo son CONCEPTUALES. No tocar landing, rutas, estilos ni componentes para simular una integración ausente.

Contexto documentado, no verificación del runtime: el [README público de Latte](https://raw.githubusercontent.com/ohmylatte/latte/main/README.md), verificado por el coordinador, describe `entregables/` como catálogo binario sin edición, conversión ni versionado, y aplica skills al iniciar o reanudar sesiones, no a un chat ya abierto. Las instrucciones no constituyen un sandbox. La propuesta requiere comprobar estos límites en código; no deducir soporte de plataformas de documentos históricos contradictorios.

## 2. Problema y resultado esperado

Un logo por sí solo no define una identidad. El generador necesita instrucciones visuales, recursos válidos y reglas de uso. El resultado esperado es que un entregable pueda explicar qué kit y versión usó, qué reglas aplicó y qué faltó, sin inventar identidad ni mezclar clientes.

Separar dos decisiones:

- **Identidad visual y verbal:** marca, agencia o estilo neutro.
- **Firma de agencia:** ninguna o una firma explícitamente habilitada, independiente de la identidad principal.

Ejemplos: propuesta comercial propia con identidad de agencia; pieza de cliente con identidad de marca; informe con identidad de marca y una firma discreta de agencia autorizada. Tener configurado un logo global NO autoriza insertarlo en todos los entregables.

## 3. Alcance MVP propuesto

1. Perfil de agencia a nivel instalación local: nombre, web, logo y contacto opcional; identidad propia opcional.
2. Kit opcional por marca: nombre, logos y variantes, paleta con roles, tipografías y alternativas autorizadas, tono, referencias, usos prohibidos y condiciones de firma.
3. Selección explícita de identidad y firma por entregable, con valores predeterminados visibles a nivel proyecto.
4. Resolución del contexto de marca antes de generar y reporte posterior de cumplimiento/limitaciones.
5. Versionado e identificación de recursos para trazar qué contexto usó cada entregable y evitar que una actualización altere silenciosamente trabajos previos. Esto no garantiza reproducir exactamente la salida del modelo.

No incluye en MVP: editor visual de marca, extracción automática desde sitios web, entrenamiento de modelos, marketplace de kits, reconstrucción de logos, sustitución automática de fuentes pagas, migración del sitio Astro ni garantía automática de calidad estética para cualquier formato.

## 4. Modelo conceptual: no es API ni ruta existente

```text
workspace/
  agency/
    profile.json             # identidad/contacto globales de la instalación local
    brand/                   # kit propio, opcional
  brands/
    <brand-id>/
      brand/
        brand.md             # reglas humanas, contexto declarativo
        manifest.json        # versión, referencias, roles y permisos
        assets/
          logos/
          fonts/
          references/
```

El almacenamiento real podría ser archivos, base de datos y object storage, o una combinación. Esta estructura comunica responsabilidades; NO prescribe crearla en este repositorio.

Entidades mínimas propuestas:

- `AgencyProfile`: instalación local, nombre y campos públicos autorizados.
- `BrandKit`: marca propietaria (o agencia local), versión inmutable, estado borrador/aprobado/retirado, reglas y recursos.
- `Asset`: identificador, checksum, tipo validado, variante/uso, procedencia y metadatos de licencia conocidos.
- `DeliverableBrandContext`: marca seleccionada, versión del kit, modo de identidad, firma autorizada, overrides explícitos y limitaciones.

La primera edición puede combinar `brand.md` legible con un manifiesto pequeño para lo verificable. No hace falta diseñar un lenguaje de estilos universal antes de probar dos formatos reales.

## 5. Reglas de resolución propuestas

1. Verificar workspace, proyecto y marca autorizados; nunca resolver por nombre de archivo parecido ni buscar kits de otros clientes.
2. Seleccionar identidad del entregable. Si es de cliente, usar solamente su kit aprobado; no heredar colores o fuentes de agencia como relleno implícito.
3. Fijar versión del kit y recursos para esa generación/sesión. Si cambia durante una sesión, mostrar un aviso y no asumir que el chat abierto recibió el nuevo contexto. Un kit actualizado aplica a trabajos nuevos o a una regeneración explícita con contexto confirmado. Este versionado se propone para el contexto de marca; no se presenta como capacidad existente del catálogo de entregables.
4. Aplicar overrides visibles del entregable únicamente dentro de permisos y restricciones de marca. Un override no puede eludir aislamiento ni licencias.
5. Resolver firma de agencia por separado. Si está deshabilitada, no filtrar logo, contacto ni web de agencia en el resultado.
6. Si falta un dato opcional, usar una alternativa previamente autorizada o declarar ausencia. Si falta un recurso obligatorio, detener ese entregable o producir un borrador marcado según política elegida; nunca afirmar cumplimiento total.
7. Generar con un contexto compacto que referencie los recursos autorizados y las reglas pertinentes al formato, sin cargar indiscriminadamente toda la carpeta.
8. Validar y registrar kit, versión, recursos, firma, advertencias y resultado de revisión. Permitir aprobación humana antes de publicar o entregar.

Sin kit: ofrecer o aplicar el estilo neutro que el proyecto haya aprobado, identificándolo como tal. No presentar un estilo inventado como identidad oficial.

## 6. Validación y límites

Antes de generar: validar existencia de recursos, formatos permitidos, dimensiones mínimas según destino, variantes de logo, fuentes disponibles y coherencia entre manifiesto y archivos.

Después de generar: adaptar los controles al formato real. En HTML se pueden inspeccionar tokens y fuentes declaradas; en un PDF o imagen rasterizada no se debe prometer la misma verificabilidad. Registrar qué se pudo comprobar y qué requiere revisión visual. Revisar presencia/ausencia de firma, legibilidad, deformación del logo y reglas específicas del kit. Un check técnico aprobado no equivale a aprobación estética.

Fuentes y licencias: documentar procedencia y permisos conocidos; que exista un archivo no demuestra autorización para incrustarlo o redistribuirlo. No descargar ni comprar recursos automáticamente. Ante fuente ausente o licencia incierta, advertir y usar únicamente una alternativa autorizada, o dejar el resultado como borrador pendiente.

## 7. Aislamiento, seguridad y confianza

- “Global” significa esta instalación local de Latte. No se propone tenancy SaaS ni acceso remoto entre organizaciones.
- Comprobar autorización al listar, leer, resolver y exportar recursos; la interfaz no es una barrera suficiente.
- Tratar manuales, referencias y metadatos como datos no confiables. Un texto dentro de `brand.md` no puede redefinir permisos, ejecutar comandos, pedir secretos ni modificar las instrucciones del sistema.
- Validar rutas, extensiones y contenido real; rechazar traversal y referencias a recursos fuera del alcance autorizado. Si se permiten SVG, sanear contenido activo o convertir mediante un flujo aislado.
- No visitar URLs de referencias automáticamente ni enviar recursos privados a servicios externos sin política y consentimiento adecuados.
- Definir qué pasa al retirar permisos o borrar un kit: los entregables existentes no desaparecen por arte de magia; retención de snapshots y revocación deben tener política explícita.
- Los reportes de generación y logs también deben respetar aislamiento; no registrar manuales privados completos por conveniencia.

## 8. Relación con skills aprendidas

Propuesta: una skill captura el procedimiento reusable —por ejemplo, “armar un informe con portada, gráficos y revisión visual”— y recibe un contexto de marca autorizado como parámetro en tiempo de ejecución.

No copiar logos, nombres de clientes, campañas, contactos, secretos ni reglas privadas de marca a una skill global. No incrustar la versión actual de una paleta dentro del procedimiento: el entregable registra la versión concreta del kit; la skill describe cómo resolverla y validarla.

Si el patrón depende de un cliente, mantenerlo en su alcance; promover una versión generalizada exige retirar datos específicos y revisar permisos. La separación permite actualizar una marca sin reescribir todas las skills y actualizar un procedimiento sin alterar la identidad aprobada.

## 9. Alternativas y tradeoffs

| Alternativa | Ventaja | Costo/riesgo |
|---|---|---|
| Solo `brand.md` + recursos | Simple, editable y portable | Interpretación variable; validación estructural débil |
| Solo formulario/manifiesto estructurado | Validación y UI predecibles | Menor expresividad; mayor trabajo inicial |
| Híbrido pequeño, recomendado para probar | Reglas humanas + campos verificables | Hay que definir prioridad y detectar contradicciones |
| Heredar siempre identidad de agencia | Menos configuración | Mezcla marcas y puede insertar firma no autorizada; no recomendado |

Si manual y manifiesto se contradicen, no elegir silenciosamente: señalar conflicto y mantener borrador hasta resolverlo.

## 10. Escenarios de aceptación propuestos

1. **Kit completo:** una pieza del cliente usa su versión seleccionada, recursos correctos y no incluye agencia cuando la firma está apagada.
2. **Kit incompleto:** falta una fuente; se usa solo el fallback autorizado y se informa, sin heredar la tipografía de agencia.
3. **Sin kit:** el resultado declara estilo neutro y no inventa colores “oficiales”.
4. **Propuesta de agencia:** identidad de agencia seleccionada, sin recursos privados de clientes.
5. **Firma habilitada:** informe de cliente mantiene su identidad y agrega únicamente los datos autorizados de agencia.
6. **Aislamiento:** una resolución asociada al trabajo A no obtiene recursos de la marca B mediante IDs conocidos o rutas manipuladas; esto no aísla procesos con acceso directo al disco.
7. **Actualización:** cambiar el kit no modifica retrospectivamente el contexto registrado de un entregable previo.
8. **Documento malicioso:** instrucciones incrustadas para leer secretos o ejecutar herramientas se ignoran y se reportan; no cambian permisos.
9. **Licencia/activo inválido:** no se publica como aprobado un entregable que necesita un recurso obligatorio no disponible o no autorizado.
10. **Skill reusable:** ejecutar la misma skill para dos marcas usa sus respectivos contextos y no conserva datos de la primera en la segunda.

## 11. Decisiones abiertas para revisión posterior

- Qué formatos de entregable entran primero y cuáles son sus validadores reales.
- Quién, en la UI, edita/aprueba kits; la autorización de firma y neutro por trabajo ya tiene tabla propuesta (`work_brand_policies`).
- Valores predeterminados al crear un trabajo (hoy no hay kit: identity=`neutral` exigiría `allow_neutral=1`, o bloquear hasta importar).
- Purga/exportación real de marcas: el SQL propuesto **bloquea** delete mientras haya kits o generaciones; el CASCADE actual de `works` es incompatible hasta diseñar esa purga.
- Fuente de verdad cuando se edita un manifiesto desde UI y desde archivos: importación explícita + aprobación, no watch automático.
- Capacidad de declarar restricciones de uso/licencia sin prometer verificación jurídica automática.
- Ubicación del checkout de producto para implementar; la inspección remota quedó fijada a `cb5496db`.

No son preguntas bloqueantes para esta investigación; deben resolverse antes de implementar las partes afectadas.

## 12. Plan por etapas y handoff

**Etapa 0 — ahora:** conservar este brief, revisar investigación de Hermes y localizar el repositorio real de la aplicación. Solo documentación; no implementación autorizada en este turno.

**Etapa 1 — descubrimiento del runtime:** mapear generación de entregables, contexto del agente, tenancy, almacenamiento, permisos y formatos con evidencia de archivos. Actualizar este brief con puntos de integración verificados; NO inventar rutas en `latte-web`.

**Etapa 2 — diseño revisable:** decidir esquema mínimo, resolución, aprobación y validadores para dos formatos representativos. Preparar fixtures ficticios de dos marcas y una agencia, sin datos privados.

**Etapa 3 — implementación autorizada:** incorporar aislamiento y resolución antes de conectar generación; añadir controles específicos de formato y trazabilidad. Diseñar las pruebas con el stack real identificado.

**Etapa 4 — skills:** conectar procedimientos parametrizados por contexto de marca; evaluar generalización y evitar promoción de información de clientes a alcance global.

**Etapa 5 — piloto:** comparar entregables con y sin kit usando una rúbrica humana y mediciones de cumplimiento comprobables. Medir consistencia, correcciones manuales y contaminación entre marcas; no atribuir mejoras a un proveedor sin evidencia.

### Para retomar sin contexto

- Leer este archivo y los demás briefs de `docs/briefs/` creados para el pedido del 2026-09-14.
- Este documento contiene propuestas, no código implementado ni contratos existentes.
- El checkout actual corresponde al sitio Astro; el runtime público fue inspeccionado parcialmente por HTTP en el commit fijado en la sección 13.
- El usuario pidió investigar y dejar briefs antes de programar. No interpretar este plan como aprobación de implementación.
- Restricción vigente: **nunca ejecutar builds**. Este trabajo no requiere tests, instalación, commits ni cambios en `src/`, `public/` o videos.

## Key Learnings:

1. La identidad de marca y la firma de agencia deben resolverse por separado para evitar mezclas y atribuciones no autorizadas.
2. Una skill reusable debería recibir el kit de marca como contexto autorizado, no almacenar datos de clientes en su procedimiento global.
3. El runtime inspeccionado tiene Brand/Work, instrucciones por sesión y archivos auxiliares con limpieza automática; el snapshot debe quedar fuera de `.latte/context`, `.latte/skills` y no reutilizar `.latte/snapshots` (Markdown de documentos).
4. Autorización, resolver puro y compositor de snapshot son tres funciones: mezclar flags IPC o `WorkPermissionMode` dentro del resolver vuelve a confundir grant de tools con pertenencia de kit.
5. Triggers `no_delete` sobre generaciones chocan con `ON DELETE CASCADE` de `works`; el MVP tiene que restringir el borrado, no silenciarlo con cascades.

## 13. Arquitectura concreta propuesta — ampliación del 2026-09-14

**Autorización vigente: ampliar documentación con arquitectura y ejemplos de código; NO implementar ni ejecutar builds.** Los fragmentos siguientes son ilustrativos y no ejecutados. No son una API disponible. Esta sección actualiza el diagnóstico inicial: se localizó e inspeccionó parcialmente el runtime público, aunque este checkout sigue siendo Astro. No se auditó toda la aplicación ni sus adaptadores.

### 13.1 Evidencia fijada y puntos de integración

Inspección de seis archivos del repositorio oficial `ohmylatte/latte`, commit `cb5496db0361a3dda8035011cf34d447bba29dd0`:

| Archivo existente | Evidencia e integración propuesta |
|---|---|
| [shared/contracts.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/shared/contracts.ts) | `Brand` tiene contexto textual y `Work.brandId` vincula trabajo y marca. `WorkPatch` solo permite resultado esperado y ruta del resultado: NO agregar opciones de marca informalmente a ese método. Proponer contratos específicos. |
| [electron/storage/schema.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/storage/schema.ts) | Hay tablas `brands`, `works`, `meta` y revisiones inmutables por triggers. Proponer perfil de agencia pequeño en `meta` y tablas nuevas para kits/snapshots; no convertir revisiones Markdown en versiones binarias. |
| [electron/ipc/register.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/ipc/register.ts) | Verifica `isTrustedSender` y cantidad de argumentos. Eso NO valida pertenencia de un kit al trabajo: el servicio debe resolverla y validar datos. |
| [electron/services/latteService.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/services/latteService.ts) | `memberContext` resuelve marca desde trabajo y refresca instrucciones solo sin miembros activos. `refreshInstructions` arma el bundle. `appInfo` expone datos de instalación para Settings; no es un editor de agencia existente. Proponer orquestación del snapshot antes de abrir una sesión nueva. |
| [electron/workspace/instructions.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/workspace/instructions.ts) | `InstructionsInput` y `renderInstructionBundle` ya combinan marca, trabajo, decisiones y skills. Hay excerpt de marca y archivos auxiliares; agregar referencia compacta al contexto fijado, no insertar binarios ni manuales completos en cada turno. |
| [electron/workspace/workspace.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/workspace/workspace.ts) | `writeInstructions` preserva archivos humanos no administrados; `syncSideFiles` limpia auxiliares no requeridos en `.latte/context` y `.latte/skills`. Un archivo histórico NO debe vivir allí. Hay escritura atómica y snapshots de Markdown; no asumir transacción conjunta SQLite/disco. |

**Corrección del modelo inicial:** `workspace` significa almacenamiento local, no organización SaaS. El alcance verificable es instalación → marca → trabajo. El perfil global es de **esta instalación**; sincronización entre dispositivos o agencias queda fuera del MVP. Las secciones iniciales que pedían localizar el runtime quedan parcialmente satisfechas por esta inspección; siguen pendientes adaptadores, migraciones completas y validadores de formatos.

### 13.2 Capas y flujo mínimo

```text
Configuración local de agencia / editor de kit por marca (UI propuesta)
  → IPC existente + contratos explícitos nuevos
  → LatteService: valida entrada, obtiene Work y deriva brandId
  → BrandKitStore nuevo: importa recursos y publica revisión aprobada
  → resolveBrandContext puro: identidad + firma + faltantes
  → GenerationSnapshotStore nuevo: fija referencias y contexto completo
  → memberContext / renderInstructionBundle: referencia de sesión
  → agente genera en entregables/ → revisión y registro de checks reales
```

Sin event bus, workers remotos ni object storage para el MVP. `brand/` es la carpeta editable/importable por marca; no es la fuente mutable que un trabajo histórico vuelve a leer. UI y edición externa convergen mediante importación explícita, validación y aprobación de una revisión. No vigilar un archivo y aprobar cambios automáticamente.

Rutas **propuestas**, a construir desde IDs internos validados mediante el servicio de rutas existente:

```text
<datos-locales>/brands/<brandId>/brand/         # borrador importable
<datos-locales>/brand-kits/<kitId>/<version>/   # recursos aprobados inmutables
<trabajo>/.latte/generations/<generationId>/   # copia mínima fijada + contexto
```

`.latte/generations` no integra los directorios efímeros actuales. **No reutilizar** `.latte/snapshots` (revisiones Markdown de documentos, fingerprint SHA-1 recortado) ni `.latte/context` / `.latte/skills` (`WorkspaceFiles.syncSideFiles` borra lo que no pidió el compositor). El nombre `generations` debe reservarse en `WORK_FILES` antes de implementarlo. Copiar solo recursos requeridos y autorizados: no symlinks hacia el kit global, ni acceso del agente a todas las marcas. Una copia fijada no significa aislamiento del SO; agentes con permisos de disco amplios pueden salir del directorio.

### 13.3 Contratos TypeScript: autorización, resolver y compositor

Tres funciones puras distintas. Mezclarlas es el error a evitar: el resolver no abre archivos, no lee SQLite y no confía en el renderer; la autorización ocurre antes; el compositor produce el snapshot que entra en `GenerationContext.brandContext`.

El resumen compartido con el brief de skills no reemplaza el contexto completo. `brandContext` referencia el snapshot **resuelto e inmutable** de identidad y firma, no la configuración mutable ni solamente el kit fuente. `brandId` siempre es el del trabajo. En ese resumen, `kitId` identifica la **composición** resuelta, `version` su revisión y `hash` su contenido canónico. Firma, modo neutro, restricciones, advertencias y hashes de recursos se conservan en el snapshot completo. Neutro con firma requiere referencia no nula; `null` se reserva para neutro sin ningún input de marca/agencia. `Resolution.sourceKit`, en cambio, identifica el kit fuente, que queda dentro de esa composición.

`WorkPermissionMode` (`ask` | `folder` | `auto`, hoy en `meta` como `trust-folder:<workId>`) **no autoriza kits**. Es el grant de herramientas sobre la carpeta de ESTE trabajo. No listar, no resolver y no exportar un kit porque el modo sea `folder` o `auto`.

```ts
// Propuesta autocontenida; sin imports ni dependencias externas.
// SHA-256 hex de 64 caracteres. No reutilizar fingerprintOf (sha1 recortado)
// ni decisionFingerprint (sha256 recortado a 24).
type Sha256 = string;
type KitRef = Readonly<{ kitId: string; version: number; hash: Sha256 }>;
type SkillRef = Readonly<{ skillId: string; version: number; hash: Sha256 }>;
type GenerationContext = Readonly<{
  schemaVersion: 1;
  workId: string;
  brandId: string;
  brandContext: KitRef | null;
  skillRefs: readonly SkillRef[];
}>;
type Asset = Readonly<{
  id: string;
  hash: Sha256;
  required: boolean;
  // Calculado por el importador sobre bytes copiados. NO confiar el valor
  // declarado en renderer, brand.md ni manifest de origen.
  usable: boolean;
}>;
type KitOwner =
  | Readonly<{ kind: 'brand'; brandId: string }>
  | Readonly<{ kind: 'agency' }>;
type Kit = Readonly<{
  ref: KitRef;
  owner: KitOwner;
  approved: boolean;
  revoked: boolean;
  permitsAgencySignature: boolean;
  assets: readonly Asset[];
  rules: string;
}>;
type Signature = Readonly<{
  agencyRevision: number;
  hash: Sha256;
  publicName: string;
  website?: string;
  logo: Asset | null;
}>;
type Choice = Readonly<{
  identity: 'brand' | 'agency' | 'neutral';
  signature: 'none' | 'agency';
}>;
type WorkBrandPolicy = Readonly<{
  workId: string;
  brandId: string;
  revision: number;
  defaultChoice: Choice;
  allowNeutral: boolean;
  allowAgencySignature: boolean;
}>;
type Resolution = Readonly<{
  identity: Choice['identity'];
  sourceKit: KitRef | null;
  rules: string;
  assets: readonly Asset[];
  signature: Signature | null;
  warnings: readonly string[];
}>;
type BrandError =
  | 'KIT_MISSING'
  | 'KIT_NOT_APPROVED'
  | 'KIT_REVOKED'
  | 'KIT_SCOPE_MISMATCH'
  | 'NEUTRAL_NOT_APPROVED'
  | 'REQUIRED_ASSET_MISSING'
  | 'SIGNATURE_NOT_APPROVED'
  | 'SIGNATURE_ASSET_MISSING'
  | 'WORK_BRAND_MISMATCH'
  | 'UNAUTHORIZED';

class BrandKitError extends Error {
  constructor(readonly code: BrandError, message: string) {
    super(message);
  }
}

const NEUTRAL_RULES = 'Estilo neutro; no afirmar identidad oficial.';

function selectKit(choice: Choice, brandKit: Kit | null, agencyKit: Kit | null): Kit | null {
  if (choice.identity === 'brand') return brandKit;
  if (choice.identity === 'agency') return agencyKit;
  return null;
}

function assertOwner(selected: Kit, identity: Choice['identity'], brandId: string): void {
  if (identity === 'brand' &&
      (selected.owner.kind !== 'brand' || selected.owner.brandId !== brandId)) {
    throw new BrandKitError('KIT_SCOPE_MISMATCH', 'El kit no pertenece a esta marca');
  }
  if (identity === 'agency' && selected.owner.kind !== 'agency') {
    throw new BrandKitError('KIT_SCOPE_MISMATCH', 'Identidad de agencia exige kit de agencia');
  }
}

/** Puro: identidad + firma. Sin I/O, sin IPC, sin licencias, sin fallback de agencia. */
function resolveBrandContext(input: {
  brandId: string;
  choice: Choice;
  brandKit: Kit | null;
  agencyKit: Kit | null;
  agencySignature: Signature | null;
  policy: WorkBrandPolicy;
}): Resolution {
  if (input.policy.brandId !== input.brandId) {
    throw new BrandKitError('WORK_BRAND_MISMATCH', 'La política no es de esta marca');
  }
  const { choice } = input;
  const selected = selectKit(choice, input.brandKit, input.agencyKit);
  if (choice.identity !== 'neutral' && !selected) {
    throw new BrandKitError('KIT_MISSING', 'Elegí neutro explícitamente o importá un kit');
  }
  if (selected) {
    if (!selected.approved) throw new BrandKitError('KIT_NOT_APPROVED', 'El kit no está aprobado');
    if (selected.revoked) throw new BrandKitError('KIT_REVOKED', 'El kit está revocado');
    assertOwner(selected, choice.identity, input.brandId);
  }
  if (choice.identity === 'neutral' && !input.policy.allowNeutral) {
    throw new BrandKitError('NEUTRAL_NOT_APPROVED', 'Este trabajo no autoriza estilo neutro');
  }
  const assets = selected?.assets ?? [];
  if (assets.some((a) => a.required && !a.usable)) {
    throw new BrandKitError('REQUIRED_ASSET_MISSING', 'Falta un recurso obligatorio usable');
  }
  const warnings = assets.filter((a) => !a.usable).map((a) => `Recurso opcional omitido: ${a.id}`);
  let signature: Signature | null = null;
  if (choice.signature === 'agency') {
    const kitForbids = Boolean(selected && !selected.permitsAgencySignature);
    const workForbids = !input.policy.allowAgencySignature;
    if (workForbids || kitForbids || !input.agencySignature) {
      throw new BrandKitError('SIGNATURE_NOT_APPROVED', 'Firma de agencia no autorizada');
    }
    signature = input.agencySignature;
    if (signature.logo && !signature.logo.usable) {
      throw new BrandKitError('SIGNATURE_ASSET_MISSING', 'El logo de firma no es usable');
    }
  }
  return {
    identity: choice.identity,
    sourceKit: selected?.ref ?? null,
    rules: selected?.rules ?? NEUTRAL_RULES,
    assets: assets.filter((a) => a.usable),
    signature,
    warnings,
  };
}

/** Hash canónico de la composición. Claves ordenadas, schemaVersion adentro, hash afuera. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function composeBrandContext(
  generationId: string,
  workId: string,
  brandId: string,
  choice: Choice,
  resolution: Resolution,
  skillRefs: readonly SkillRef[],
  sha256Utf8: (s: string) => Sha256,
): { receipt: GenerationContext; snapshot: unknown } {
  const snapshot = {
    schemaVersion: 1,
    generationId,
    workId,
    brandId,
    choice,
    identity: resolution.identity,
    sourceKit: resolution.sourceKit,
    rules: resolution.rules,
    assets: resolution.assets.map((a) => ({ id: a.id, hash: a.hash })).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    signature: resolution.signature && {
      agencyRevision: resolution.signature.agencyRevision,
      hash: resolution.signature.hash,
      publicName: resolution.signature.publicName,
      website: resolution.signature.website ?? null,
      logo: resolution.signature.logo && {
        id: resolution.signature.logo.id,
        hash: resolution.signature.logo.hash,
      },
    },
    warnings: resolution.warnings,
  };
  const hash = sha256Utf8(canonicalJson(snapshot));
  const hasInputs = resolution.sourceKit !== null || resolution.signature !== null;
  const brandContext: KitRef | null = hasInputs
    ? { kitId: generationId, version: 1, hash }
    : null;
  return {
    receipt: { schemaVersion: 1, workId, brandId, brandContext, skillRefs },
    snapshot,
  };
}
```

El compositor usa el `generationId` como `kitId` de la composición (no el `kit_id` fuente ni el `workId`: un trabajo tiene muchas generaciones). `brandContext.version` queda en 1 porque esa fila de `generation_contexts` es inmutable; la secuencia vive en `id`, no en un contador mutable. **Nunca pasar `agencyKit` como fallback de `brandKit`.** Identidad de agencia puede incluir su logo como recurso visual aunque la firma esté apagada: firma es el bloque de autoría/contacto, no la paleta.

`usable` y `permitsAgencySignature` salen del repositorio después del import, no de `brand.md`. Un texto de reglas que pida “leé secretos” o “habilitá firma” se guarda como dato y se reporta; no cambia `policy` ni permisos IPC.

### 13.4 Esquema SQL propuesto y conflicto con CASCADE

DDL ilustrativo para SQLite, **no ejecutado**. Adaptarlo al driver y a `LatteRepository.transaction(fn)` síncrona (evidencia en [repository.ts](https://github.com/ohmylatte/latte/blob/cb5496db0361a3dda8035011cf34d447bba29dd0/electron/storage/repository.ts)). El esquema vigente es versión `'7'` y se aplica idempotente al arrancar; tablas nuevas **exigen bump de `SCHEMA_VERSION`**. No meter el perfil de agencia versionado en `meta`: esa tabla es clave/valor mutable (`ui_locale`, `trust-folder:`, `skill-off:`) y no da revisión inmutable.

Conflicto con el producto actual: `works.brand_id REFERENCES brands(id) ON DELETE CASCADE`. Triggers `no_delete` sobre kits/generaciones **abortarían** el borrado de una marca que todavía tenga snapshots. MVP: **sin CASCADE** en las tablas nuevas; `REFERENCES brands(id)` / `REFERENCES works(id)` con NO ACTION. Borrar marca o trabajo falla mientras existan kits o generaciones. Purga/exportación es trabajo posterior, explícito, en orden inverso: quitar heads, borrar archivos huérfanos verificados, y recién entonces filas. No silenciar esto con `ON DELETE CASCADE`.

```sql
-- Activar foreign_keys por conexión, como el resto del producto.
CREATE TABLE IF NOT EXISTS agency_profile_versions (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  public_json TEXT NOT NULL, -- nombre, web, contacto opcional; sin secretos
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agency_profile_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_revision INTEGER NOT NULL REFERENCES agency_profile_versions(revision)
);

CREATE TABLE IF NOT EXISTS brand_kit_versions (
  kit_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('brand','agency')),
  owner_brand_id TEXT REFERENCES brands(id), -- NULL sólo si owner_kind='agency'
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  approved INTEGER NOT NULL CHECK (approved IN (0,1)),
  permits_agency_signature INTEGER NOT NULL CHECK (permits_agency_signature IN (0,1)),
  manifest_json TEXT NOT NULL,
  rules_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kit_id, version),
  CHECK (
    (owner_kind = 'agency' AND owner_brand_id IS NULL) OR
    (owner_kind = 'brand' AND owner_brand_id IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS brand_kit_assets (
  kit_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('logo','font','reference','other')),
  required INTEGER NOT NULL CHECK (required IN (0,1)),
  usable INTEGER NOT NULL CHECK (usable IN (0,1)),
  relative_path TEXT NOT NULL,
  PRIMARY KEY (kit_id, version, asset_id),
  FOREIGN KEY (kit_id, version) REFERENCES brand_kit_versions(kit_id, version)
);
CREATE TABLE IF NOT EXISTS brand_kit_heads (
  kit_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_brand_id TEXT,
  current_version INTEGER NOT NULL,
  FOREIGN KEY (kit_id, current_version)
    REFERENCES brand_kit_versions(kit_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_kit_heads_brand
  ON brand_kit_heads(owner_brand_id) WHERE owner_kind = 'brand';
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_kit_heads_agency
  ON brand_kit_heads(owner_kind) WHERE owner_kind = 'agency';

CREATE TABLE IF NOT EXISTS brand_kit_revocations (
  kit_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kit_id, version),
  FOREIGN KEY (kit_id, version) REFERENCES brand_kit_versions(kit_id, version)
);

CREATE TABLE IF NOT EXISTS work_brand_policies (
  work_id TEXT PRIMARY KEY REFERENCES works(id),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  identity TEXT NOT NULL CHECK (identity IN ('brand','agency','neutral')),
  signature TEXT NOT NULL CHECK (signature IN ('none','agency')),
  allow_neutral INTEGER NOT NULL CHECK (allow_neutral IN (0,1)),
  allow_agency_signature INTEGER NOT NULL CHECK (allow_agency_signature IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_contexts (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  context_json TEXT NOT NULL, -- recibo GenerationContext + snapshot completo
  context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generation_contexts_work
  ON generation_contexts(work_id, created_at);
CREATE TABLE IF NOT EXISTS work_generation_heads (
  work_id TEXT PRIMARY KEY REFERENCES works(id),
  current_generation_id TEXT NOT NULL REFERENCES generation_contexts(id),
  pending_choice_json TEXT -- identidad pedida mientras hay miembros vivos; NULL si no hay
);

CREATE TRIGGER IF NOT EXISTS agency_profile_versions_no_update
BEFORE UPDATE ON agency_profile_versions BEGIN
  SELECT RAISE(ABORT, 'agency profile version is immutable');
END;
CREATE TRIGGER IF NOT EXISTS agency_profile_versions_no_delete
BEFORE DELETE ON agency_profile_versions BEGIN
  SELECT RAISE(ABORT, 'agency profile version is immutable');
END;
CREATE TRIGGER IF NOT EXISTS brand_kit_versions_no_update
BEFORE UPDATE ON brand_kit_versions BEGIN
  SELECT RAISE(ABORT, 'kit version is immutable');
END;
CREATE TRIGGER IF NOT EXISTS brand_kit_versions_no_delete
BEFORE DELETE ON brand_kit_versions BEGIN
  SELECT RAISE(ABORT, 'kit version is immutable');
END;
CREATE TRIGGER IF NOT EXISTS brand_kit_assets_no_update
BEFORE UPDATE ON brand_kit_assets BEGIN
  SELECT RAISE(ABORT, 'kit assets are immutable');
END;
CREATE TRIGGER IF NOT EXISTS brand_kit_assets_no_delete
BEFORE DELETE ON brand_kit_assets BEGIN
  SELECT RAISE(ABORT, 'kit assets are immutable');
END;
CREATE TRIGGER IF NOT EXISTS generation_contexts_no_update
BEFORE UPDATE ON generation_contexts BEGIN
  SELECT RAISE(ABORT, 'generation context is immutable');
END;
CREATE TRIGGER IF NOT EXISTS generation_contexts_no_delete
BEFORE DELETE ON generation_contexts BEGIN
  SELECT RAISE(ABORT, 'generation context is immutable');
END;
```

Invariantes de repositorio, no sólo CHECK:

1. Un `kit_id` conserva el mismo `owner_kind` / `owner_brand_id` en todas sus versiones.
2. `brand_kit_heads` apunta sólo a filas con `approved = 1` y sin fila en `brand_kit_revocations`. Los borradores no tienen head.
3. A lo sumo un head `agency` y a lo sumo un head aprobado por `owner_brand_id`.
4. `work_brand_policies.brand_id` coincide siempre con `works.brand_id` al escribir; si alguien mueve un trabajo de marca (hoy no hay API para eso), la política se invalida, no se hereda.
5. Revocar inserta en `brand_kit_revocations` y puede anular el head; **no** altera `brand_kit_versions`. Generaciones ya fijadas siguen leyendo esa versión.

Publicación CAS, misma transacción que el INSERT de la versión (después de haber publicado el directorio en disco):

```sql
INSERT INTO brand_kit_versions
  (kit_id, version, owner_kind, owner_brand_id, hash, approved,
   permits_agency_signature, manifest_json, rules_text, created_at)
VALUES
  (:kit_id, :new_version, :owner_kind, :owner_brand_id, :hash, 1,
   :permits, :manifest, :rules, :now);

UPDATE brand_kit_heads
SET current_version = :new_version
WHERE kit_id = :kit_id AND current_version = :expected_version;
-- changes == 1 o ROLLBACK. Primer head: INSERT OR FAIL, no UPSERT ciego.
```

Agencia: `UPDATE agency_profile_head SET current_revision = :new WHERE id = 1 AND current_revision = :expected`. Política de trabajo: `WHERE work_id = :id AND revision = :expected`. Si `changes != 1`, conflicto visible. El repositorio existente expone `transaction(fn)` síncrona: **nada de I/O de modelo ni diálogos nativos dentro**.

Hashes SHA-256 completos sobre bytes de cada recurso y sobre `canonicalJson` del manifiesto (claves ordenadas, `schemaVersion` incluida, sin el campo hash). SHA-256 identifica contenido; no prueba autoría ni licencia.

### 13.5 Snapshots de generación: disco, pin y retención

Tres árboles distintos. Confundirlos pierde historia o la borra el compositor.

| Árbol | Quién lo escribe | Mutabilidad | Relación con el agente |
|---|---|---|---|
| `<dataDir>/brands/<brandId>/brand/` | humano / importador | borrador mutable | el agente del trabajo **no** lo usa como fuente |
| `<dataDir>/brand-kits/<kitId>/<version>/` | publicación aprobada | inmutable; rename exclusivo | no es cwd del agente |
| `<trabajo>/.latte/generations/<generationId>/` | pin de generación | inmutable para esa generación | copia mínima autorizada + `context.json` |
| `<trabajo>/.latte/snapshots/` | existente: revisiones Markdown | inmutable de documentos | **no** guardar kits aquí |
| `<trabajo>/.latte/context/` y `skills/` | `syncSideFiles` | regenerable, se limpia | punteros, nunca autoridad |

Un trabajo vinculado (`useFolder`) vive **fuera** de `dataDir`. El pin tiene que copiar los recursos autorizados al `.latte/generations` de ESA carpeta: si sólo quedaran en `dataDir/brand-kits`, el agente no los ve sin cruzar marcas o el data directory. `checkFolder` ya impide enlazar una carpeta dentro de `dataDir`; no relajar eso para “alcanzar” kits.

Layout propuesto del pin:

```text
<trabajo>/.latte/generations/<generationId>/
  context.json      # recibo + snapshot canónico
  assets/<assetId>  # copias reales, no symlinks ni junctions
```

Secuencia, un escritor por instalación, inicios de sesión serializados por `workId`:

1. Autorizar trabajo y cargar kits (sección 13.6). Resolver y componer en memoria.
2. Staging en el mismo volumen del destino, límites de cantidad/tamaño, tipo real (no sólo extensión). Rutas vía `safeJoin` / `contains` del backend; rechazar traversal, `..`, drive letters, NUL, symlinks/junctions que salgan de la raíz. Revalidar destino al escribir.
3. Copiar bytes, hashear, comparar con el manifiesto aprobado. Rechazar referencias absolutas, URLs remotas y paths fuera del kit. Nunca editar una versión ya publicada en `brand-kits/`.
4. `mkdir` exclusivo + rename al destino `generations/<id>/` **antes** del COMMIT SQLite. `rename` no atomiciza DB+disco; el adaptador Windows/POSIX tiene que documentar fallos (destino existente, antivirus, volumen distinto).
5. Transacción: `INSERT generation_contexts` + CAS de `work_generation_heads`. Conflicto → rollback; el directorio huérfano no se usa ni se considera aprobado.
6. Recuperación: borrar staging/huérfanos sólo si no hay fila que los referencie. Al consumir, verificar existencia y hash; si falta o cambió, bloquear. **No** reconstruir desde el kit mutable ni desde `brand.md`.

Miembros vivos: `memberContext` hoy reescribe CLAUDE.md/AGENTS.md sólo si `liveMemberCount === 0`. El pin de generación sigue esa regla. Nuevos miembros del mismo trabajo reutilizan `current_generation_id`. Cambiar `work_brand_policies` con sesiones abiertas escribe `pending_choice_json` y no mueve el head. Activar otra identidad exige pausar/cerrar todos los miembros y abrir una generación nueva. Reanudar historia del proveedor conserva el contexto que ya vio el modelo; reescribir AGENTS.md no lo borra.

Retención MVP: no borrar generaciones. Un check técnico del artefacto (hash del binario al revisar, controles realmente hechos) se guarda en un reporte **aparte**; no vive dentro de `context.json` y no modifica `DeliverableFile`.

### 13.6 Permisos: cuatro capas que no se sustituyen

| Capa | Qué cubre | Qué no cubre |
|---|---|---|
| 1. Remitente IPC (`isTrustedSender`) | Esta ventana de Electron | Pertenencia de un kit a un trabajo |
| 2. `WorkPermissionMode` (`ask`/`folder`/`auto`) | Preguntar o no por tools en la carpeta del trabajo | Leer kits de otras marcas, firmar, aprobar, exportar |
| 3. Autorización de marca (servicio + tablas nuevas) | Listar, importar, publicar, resolver, pin, exportar | Sandbox de proceso ni disco del SO |
| 4. Permisos del runtime CLI (`.claude/`, prompts “always”) | Lo que el agente ya obtuvo del usuario | Política de Latte; no se sincroniza sola con la capa 3 |

Reglas de la capa 3:

- En operaciones ligadas a trabajo, el renderer manda `workId` (y un `choice` opcional). **Nunca un `brandId` autoritativo**, ni un path, ni un hash como prueba de acceso. El servicio hace `requireId` + `getWork` y deriva `brandId`.
- Agencia: métodos globales de instalación (`readAgencyProfile`, `saveAgencyProfile(expectedRevision, patch)`). No es un permiso que una skill, un `brand.md` o un modo `auto` puedan conceder.
- Importar: diálogo nativo → ruta al proceso main. No existe `readFile(path)` genérico para el renderer.
- Exportar un kit o un snapshot sólo después de la misma autorización que para resolverlo. No empaquetar recursos de otra marca porque el usuario “conoce el id”.
- `brand.md` y el manifiesto de origen son datos. Pueden contradecirse: conflicto visible, borrador, sin auto-elección. No redefinen `allow_agency_signature`, no ejecutan tools, no piden secretos.
- Listar kits de marca B desde un trabajo de marca A devuelve vacío, no un error que confirme que B existe, cuando la operación es “kits de este trabajo”. Métodos de Settings que listan marcas ya existentes (`listBrands`) siguen siendo el inventario de la instalación, no un dump de recursos.
- `folder`/`auto` no amplían el alcance a `<dataDir>/brand-kits` ni a otras marcas. Las instrucciones actuales dicen “Stay inside this directory”; eso es texto, no enforcement. El pin copia lo autorizado al trabajo para no enseñarle al agente la ruta global.

```ts
interface BrandAccess {
  requireWork(workId: string): { id: string; brandId: string };
  policyForWork(workId: string): WorkBrandPolicy;
  approvedKitForBrand(brandId: string): Kit | null;
  approvedAgencyKit(): Kit | null;
  agencySignature(): Signature | null;
}

function authorizeWork(access: BrandAccess, workId: string): {
  work: { id: string; brandId: string };
  policy: WorkBrandPolicy;
} {
  const work = access.requireWork(workId);
  const policy = access.policyForWork(work.id);
  if (policy.workId !== work.id || policy.brandId !== work.brandId) {
    throw new BrandKitError('WORK_BRAND_MISMATCH', 'Política desalineada del trabajo');
  }
  return { work, policy };
}

function kitsForAuthorizedWork(access: BrandAccess, workId: string): {
  work: { id: string; brandId: string };
  policy: WorkBrandPolicy;
  brandKit: Kit | null;
  agencyKit: Kit | null;
  agencySignature: Signature | null;
} {
  const { work, policy } = authorizeWork(access, workId);
  const brandKit = access.approvedKitForBrand(work.brandId);
  if (brandKit && (brandKit.owner.kind !== 'brand' || brandKit.owner.brandId !== work.brandId)) {
    throw new BrandKitError('KIT_SCOPE_MISMATCH', 'Head de marca apunta a otro dueño');
  }
  const agencyKit = access.approvedAgencyKit();
  if (agencyKit && agencyKit.owner.kind !== 'agency') {
    throw new BrandKitError('KIT_SCOPE_MISMATCH', 'Head de agencia no es de agencia');
  }
  return {
    work,
    policy,
    brandKit,
    agencyKit,
    agencySignature: access.agencySignature(),
  };
}
```

Validar en runtime cada payload IPC: enumeraciones de `Choice`, tamaños, `schemaVersion`, campos desconocidos rechazados, hashes de 64 hex. TypeScript en el contrato no valida el puente. Los códigos `BrandError` se mapean a `LatteError` / envelope `{ ok: false, code }` como el IPC actual; no filtrar paths internos al renderer.

### 13.7 Servicio, IPC y ciclo de sesión

Nuevos métodos **propuestos**, no presentes en `LatteAPI`: `readAgencyProfile`, `saveAgencyProfile(expectedRevision, patch)`, `importBrandKit(workId)`, `publishBrandKit(workId, expectedVersion)`, `setWorkBrandChoice(workId, choice, expectedRevision)`, `readWorkBrandContext(workId)`. `WorkPatch` sigue siendo sólo resultado esperado y ruta del resultado; **no** colgar la identidad ahí.

Orquestación al abrir conversación nueva, después de `authorizeWork`:

1. Si hay `current_generation_id` y miembros vivos → reutilizar ese snapshot.
2. Si no hay miembros vivos y hay `pending_choice_json` o no hay head → resolver, pin, CAS del head, recién entonces `refreshInstructions`.
3. Proyectar en el bundle un puntero compacto (kit/firma/hash/advertencias), no binarios ni el manual completo. El excerpt de `Brand.context` existente permanece; el kit no lo reemplaza hasta que el producto decida migrar ese campo.

Esto evita adaptar tres canales de prompt a la vez. Alternativa posterior: inyectar el pin por canal propio, como `outcomeContext` hoy, inspeccionando cada adaptador. Las instrucciones compartidas no se reescriben bajo un miembro activo.

Registrar el contexto de sesión **no** demuestra que un binario aplicó el kit.

### 13.8 Pruebas futuras y plan de archivos

Casos ilustrativos, **no ejecutados**:

```ts
const futureCases: ReadonlyArray<{ name: string; expected: BrandError | string }> = [
  { name: 'marca sin kit, agencia disponible, identity=brand', expected: 'KIT_MISSING' },
  { name: 'kit de otra marca inyectado como brandKit', expected: 'KIT_SCOPE_MISMATCH' },
  { name: 'marca válida, signature=none', expected: 'signature === null' },
  { name: 'firma pedida, allowAgencySignature=false', expected: 'SIGNATURE_NOT_APPROVED' },
  { name: 'firma pedida, kit.permitsAgencySignature=false', expected: 'SIGNATURE_NOT_APPROVED' },
  { name: 'recurso obligatorio usable=false', expected: 'REQUIRED_ASSET_MISSING' },
  { name: 'neutro no autorizado', expected: 'NEUTRAL_NOT_APPROVED' },
  { name: 'neutro autorizado sin kit ni firma', expected: 'brandContext === null' },
  { name: 'neutro autorizado con firma', expected: 'brandContext !== null && sourceKit === null' },
  { name: 'identity=agency usa agencyKit, no brandKit', expected: 'sourceKit === agencyKit.ref' },
  { name: 'policy.brandId distinto', expected: 'WORK_BRAND_MISMATCH' },
  { name: 'kit revocado aunque aprobado', expected: 'KIT_REVOKED' },
];
```

Además: dos `publishBrandKit` con el mismo `expectedVersion` → un éxito y un conflicto; caída entre rename y COMMIT → sin head; junction/traversal no se importan; `syncSideFiles` no borra `.latte/generations`; editar el kit mutable no cambia `context_hash` previo; resume no adopta otro kit; A no ve assets de B; `WorkPermissionMode=auto` no inserta firma; borrar marca con generaciones existentes aborta; `canonicalJson` es estable ante el orden de claves. Convertir al runner del producto cuando se autorice, **sin build**.

| Etapa | Archivos del runtime a modificar/proponer después | Resultado |
|---|---|---|
| A | `shared/contracts.ts`; nuevos `electron/branding/types.ts`, `resolver.ts` y tests de resolver | Contratos runtime-validados, autorización y composición separadas. |
| B | `electron/storage/schema.ts` (bump de versión), repositorio/migraciones; `kitStore.ts`, `snapshotStore.ts` | Perfil local con revisión, SQL sin CASCADE, pin recuperable. |
| C | `electron/services/latteService.ts`, canales/preload | API estrecha, import nativo, `brandId` derivado del trabajo. |
| D | `electron/workspace/instructions.ts`, `workspace.ts` (`WORK_FILES`); hub | Pin por generación; `syncSideFiles` no toca `generations/`. |
| E | Settings y editor de marca | Agencia local, kit editable, firma visible por trabajo. |
| F | Tests de persistencia, IPC y sesión; validadores por formato | Aislamiento de servicio y trazabilidad, sin sandbox ni QA estética automática. |

**Orden recomendado:** A–D con un formato simple y fixtures ficticios; E mínima; F acompaña cada etapa. Dos formatos representativos en piloto. La documentación de esta sección es el entregable actual; ninguna de estas rutas nuevas fue creada.
