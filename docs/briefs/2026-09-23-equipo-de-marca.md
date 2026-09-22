# El equipo es de la marca

Fecha: 2026-09-23 · Estado: propuesta para decidir · Autor: arquitectura

Gabriel: "Equipo que termina debería cerrarse... Tiene sentido que por marca podamos mantener el
equipo para seguir trabajando sobre cosas. El concepto de agregar miembros al equipo es lindo,
pero entonces habría que tener un chat global para hablar con el equipo: podés hablar con alguien
en particular o despertar al equipo completo. Incluso el despacho, cuando es con equipo creado por
mí, pasa a un chat global." Y: "creo que es una forma más interesante de presentar el modo Equipo,
aunque hoy ya es bastante funcional."

Eso último manda: **esto evoluciona lo que hay, no lo tira.** Las tres decisiones tomadas —el plantel
vive en la marca, plantel y procesos son cosas distintas, el chat de equipo ES el modo Equipo con un
composer abajo— no se rediscuten acá; se desarrollan contra el código. Conclusión corta: el modelo de
datos ya está a un salto (`team_members` es lo que hoy llamaríamos *convocatoria*, no *plantel*), el
cierre de run no apaga nada y eso son tres líneas, y la duplicación de chats no es un diseño: es que
el coordinador quedó como una pestaña más en un rail que no lo esperaba.

## 1. Cómo es hoy, con evidencia

### 1.1 El equipo vive en el TRABAJO, y sólo ahí

`team_members.work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE`
(`electron/storage/schema.ts:104-128`). No hay columna de marca en esa tabla, la única lectura de
lista es `listMembers(workId)` (`electron/storage/repository.ts:800-802`) y la marca se alcanza
sólo por el rodeo `member → work → brand` (`electron/services/latteService.ts:2324-2325`).

Dos datos buenos. Uno: **toda la SQL de `team_members` son diez métodos en un archivo**
(`repository.ts:798-863`); `rg team_members` fuera de tests da el esquema, el repositorio y el
README, nada más. Dos: la tabla ya distingue, sin haberlo nombrado, **identidad** de
**conversación** — `role_id`, `role_name`, `initial`, `runtime`, `account_id`, `tier` describen a
alguien; `session_id`, `done`, `usage_json`, `continued_from` describen un hilo (`:104-127`).

### 1.2 Al terminar un run no se apaga nada

`closeRun` (`electron/coordination/engine.ts:2578-2608`) hace tres cosas: avisa al coordinador,
borra el meta `coordination_coordinator:<workId>` y escribe el estado del run. **No toca un solo
proceso.** `hub.pauseMember` y `hub.finishMember` (`electron/agents/hub.ts:439-448`) no se llaman
desde ningún punto del motor. Resultado: terminado el run, cada miembro que participó sigue con su
proceso vivo —`liveMemberIds` los sigue contando (`hub.ts:348-351`)— ocioso, comiendo memoria y una
ranura de los techos de `limits.ts:106,136`, hasta que la persona lo pause a mano o cierre la app.

Las altas también quedan: un alta es una entrada en el JSON del meta `coordination_hires:<runId>`
(`engine.ts:1183-1192`), append-only por run, y la fila de `team_members` que la acompaña no se
borra nunca. Un trabajo con tres runs acumula miembros de los tres, con el mismo rol repetido.

### 1.3 Por qué se siente que hay dos chats

No hay una pestaña del coordinador *además* del modo Equipo. Hay algo peor: **el coordinador es una
pestaña más en la tira de miembros**, y la vida del equipo está en la otra mitad del rail, sin
manera de escribir.

- El rail es `'chat' | 'team'` (`src/TeamPanel.tsx:196`) y el toggle sólo aparece con
  `work && team.length > 0` (`:285-290`). `chat` monta la tira de `MemberTab` + `ChatPane`
  (`:335-368`); `team` monta `TeamView` (`:303-317`).
- El coordinador se identifica por `coordinationRun.coordinatorMemberId` y se abre con
  `openCoordinatorChat()` (`:252-256`), que salta al rail `chat`. `openWorkCoordination`, desde
  Inicio y desde la tira de equipos activos, hace lo mismo (`src/App.tsx:794-800`).
- **El único composer de toda la app está en `ChatPane`** (`src/ChatPane.tsx:211-212`). En
  `TeamView` no hay ninguno: el único campo de texto del modo Equipo es el `<input>` de una línea
  para contestar una pregunta abierta (`src/coordination/MemberDetail.tsx:84-87`).

O sea: **mirás en un lado y escribís en el otro**, y lo que escribís va a una pestaña que compite
con las de los demás. Eso produce "todo ocurre no sé dónde". No es una duplicación de pantallas:
es un composer que quedó del lado equivocado. Y el coordinador tampoco es una figura del modelo —
es el miembro al que un meta le dio permiso para este run (`engine.ts:2519-2521`, `:2600`).

### 1.4 Qué cuesta hoy reusar un equipo

Nada lo permite. Para "el mismo equipo en otro trabajo" hay que llamar `addTeamMember` de vuelta
(`latteService.ts:2202-2210`), que crea filas nuevas con ids nuevos. Se pierde la cara (el avatar es
propio y se deriva del id cuando el rol ya está tomado, `shared/contracts.ts:602-608`), el `usage`
acumulado (`schema.ts:122-124`), toda la conversación (`session_id` es del runtime y va con la fila)
y `continuedFrom`, que encima está validado como **del mismo trabajo** (`latteService.ts:2206-2209`).

Y "el equipo" tampoco se ve por marca: Inicio muestra runs del trabajo (`src/HomeView.tsx:135-143`)
y `ActiveTeamsStrip` muestra runs activos de todas las marcas (`src/ActiveTeamsStrip.tsx:39-51`,
montada en `src/App.tsx:1280`); ninguna pantalla contesta "¿quién trabaja para esta marca?". Lo que
sí es global son los **perfiles** (`ProfilesView` vive en Ajustes; `api.listProfiles()` no recibe
`brandId`): el rol es plantilla de la app, el miembro su instancia. Falta el escalón del medio.

## 2. El modelo objetivo

### 2.1 Tres escalones, no dos

| Escalón | Alcance | Qué es | Dónde vive hoy |
|---|---|---|---|
| Perfil / rol | app | la plantilla: alma, skills, cara por defecto | `RoleCatalog`, `packs/marketing-core/roles/` |
| **Plantel** | **marca** | **la persona: nombre, cara, rol, runtime, cuenta** | **no existe** |
| Convocatoria | trabajo | el hilo: sesión, uso, estado, continuación | `team_members` |

El plantel es lo que falta, y encaja con lo recién mergeado: las conexiones son
`scope: 'global' | 'brand'` con `brand_id` obligatorio si es de marca, validado por un `CHECK` de la
base (`electron/storage/connectionsSchema.ts:23-42`); la resolución es un `WHERE scope = 'global' OR
brand_id = ?` y **la de marca gana** (`electron/storage/connectionsRepository.ts:139-142`, doctrina
en `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md:229-236`); y ya hay pantalla **Marca →
Conexiones** (mismo brief, `:279-285`). Un plantel por marca cuelga del mismo eje: **el equipo de
una marca usa las conexiones de esa marca**, frase que hoy no se puede decir porque el equipo no es
de nadie.

### 2.2 Convocatoria: se elige, no vienen todos

Todos por defecto no se puede, y no es opinión: `DEFAULT_MAX_CONCURRENT = 3`
(`electron/coordination/limits.ts:33`), `MAX_COORDINATED_CODEX_MEMBERS_PER_RUN = 3` (`:94`),
`MAX_COORDINATED_CODEX_PROCESSES = 6` (`:106`), `MAX_CODEX_APP_SERVERS_TOTAL = 10` (`:136`); un
plantel de ocho convocado entero revienta los cuatro.

**Convoca el coordinador, igual que hoy contrata.** El circuito no cambia
(`engine.ts:1043,1892`); cambia qué trae. Hoy "contratar" inventa a alguien de la nada; mañana
"convocar" trae a alguien del plantel que ya tiene cara, nombre e historia con esta marca. Si el
rol que hace falta no está, el alta lo **suma al plantel** y lo convoca en el mismo acto: la
propuesta ya le pregunta a la persona por los que faltan (`coord.proposal.hire`,
`src/coordination/TeamCards.tsx`), y esa pregunta pasa a significar algo que dura. La persona
también convoca a mano con el "Sumar un rol" de hoy (`src/TeamView.tsx:161-191`), sólo que el
selector muestra primero el plantel de la marca y después los roles libres.

### 2.3 Quién coordina

Hoy no es un rol sino una **capacidad**, y el contrato lo dice bien: *"A capability, not a role:
granting it never changes the member's roleId or prompt"* (`shared/contracts.ts:763-768`). Se la
queda el miembro que llamó a `latte_request_coordination` (`engine.ts:1425-1429`), se copia al meta
al aprobar el plan (`:978`), se resuelve en cada request (`resolveGrant`, `:524-528`) y se borra al
cerrar (`:2600`). Nada de eso se toca: es lo que impide que alguien amanezca coordinador de un run
que nadie le confió.

Se agrega un **default en el plantel**: la marca marca a uno de los suyos como coordinador habitual
(o deja el Asistente, el rol que siempre está, `electron/agents/roles.ts:29-50`). Ese default es lo
que le falta al camino directo `startRun(workId, coordinatorMemberId)` (`engine.ts:486-499`), que hoy
exige elegir a mano. El plantel dice quién *suele* coordinar; el meta sigue siendo la autoridad viva
del run. Poblar, no reemplazar.

### 2.4 Ciclo de vida de los procesos

Regla: **un proceso existe porque hay algo que hacer, y muere cuando se terminó.**

- **Arranque** bajo demanda, en el primer despacho o cuando la persona abre ese hilo. `openMember`
  ya es idempotente contra la sesión viva (`hub.ts:421-436`). Estar en el plantel no arranca nada:
  ésa es toda la gracia de separarlo.
- **Apagado**: `closeRun` apaga a los que el run convocó, con la primitiva que ya existe y es la
  correcta — `pauseMember` cierra la conversación y deja la fila viva y reanudable
  (`hub.ts:438-442`), no `finishMember`, que además marca `done`.
- **El que la persona abrió a mano no se apaga**: se apagan los que figuran en `listHires(runId)`
  (`engine.ts:1183-1192`) y no están en medio de un turno (`hub.isMemberBusy`, `hub.ts:365-367`).
  Al que nadie despachó, el run no lo convocó y no lo toca.

Un proceso no puede sobrevivir al trabajo aunque quisiéramos: `memberContext` fija su directorio en
`workDir(brandId, workId)` (`latteService.ts:2323-2340`), que puede ser una carpeta externa elegida
por la persona (`electron/core/paths.ts:96-101`). **Un proceso es de un trabajo, siempre.** Por eso
el plantel no puede ser procesos: sólo puede ser identidad.

### 2.5 El final del run

`RunHeader` ya tiene todos los datos y ninguno dice lo que Gabriel quiere leer: `coord.done.at` →
"Terminado a las {time}" (`src/coordination/RunHeader.tsx:128`, `src/i18n.tsx:913`) y
`coord.run.progress` → "{done} de {total} listas" (`RunHeader.tsx:137`, `i18n.tsx:851`), separados.
**Nuevo pedido** ya existe y ya es el único botón (`RunHeader.tsx:156`), y ya hay candado de que un
run terminado no ofrece Cancelar, Pausar ni Reanudar (`src/team-panel-run-exits.dom.test.tsx:108`).
O sea: **la decisión 2 no hay que construirla, hay que terminarla** — una línea del coordinador en
la conversación, "Terminamos · 4 de 4", fusionando esas dos claves, y el botón que ya está. La
pregunta "¿seguir o desconectar?" nunca llega a existir, y ése es el punto: desconectar lo hace
`closeRun` sin preguntar, porque ya no hay nada que hacer; seguir es escribir en el composer.

### 2.6 El chat de equipo

**El modo Equipo recibe el composer, y la pestaña del coordinador desaparece.**

- El composer va al pie de `TeamView` (hoy ahí termina en `TeamAdvanced`, `src/TeamView.tsx:210`),
  con el mismo `<textarea>` que ya vive en `ChatPane.tsx:211-212`.
- **Ruteo por defecto: al coordinador**; sin run activo, al Asistente, que es quien puede pedir
  coordinación (`base.md:50-55`). Para el 90% de los mensajes no hace falta elegir destinatario: eso
  es lo que significa "hablarle al equipo".
- **Hablarle a uno sigue siendo su hilo.** La lista de la izquierda ya lo abre
  (`src/TeamView.tsx:161-191`) y ese hilo ya tiene su historia; meterle `@rol` al composer sería una
  segunda forma de hacer lo mismo, peor.
- **"A todos" no existe, a propósito.** Despertar N miembros a la vez choca con
  `DEFAULT_MAX_CONCURRENT = 3` (`limits.ts:33`) y con los techos de procesos (`:106,136`), y rompe el
  principio del brief anterior: *cada bot aislado, uno consolida*. El coordinador **es** el "a
  todos": le pedís al equipo, él despacha. Queda como decisión abierta (§8).
- **La línea de tiempo se vuelve conversación.** `inboxEvents` ya produce `dispatched`, `reported`,
  `dispatchFailed`, `dispatchClosed`, `sent`, `received`, `ask`, `answer`, `hired`
  (`src/coordination/inbox.ts:25-47,129-167`); se le intercalan por hora los mensajes de la persona
  y las respuestas del coordinador. Nada se saca.
- **Convergencia**: el rail deja de ser "conversación vs equipo" y pasa a ser **"uno vs el equipo"**.
  La tira de pestañas (`TeamPanel.tsx:335-368`) queda para los que no coordinan;
  `openWorkCoordination` (`App.tsx:794-800`) y `openCoordinatorChat` (`TeamPanel.tsx:252-256`) dejan
  de saltar al rail `chat` y abren el modo Equipo. Sin equipo todavía, el modo Equipo **es** el chat
  del Asistente, y el toggle aparece recién con más de uno — la condición ya está en `:285-290`.

**Lo que se mantiene tal cual**: gates y preguntas siguen donde están y como están
(`TeamCards.tsx`: `plan`, `budget`, `dispatch`, `proposal`, `AskCard`), y el motor, el DAG, el
presupuesto y el libro mayor no se tocan. El principio del cierre anterior se cumple mejor, no
peor: *pedís en el chat, aprobás en el chat* — ahora hay un solo chat donde pasan las dos cosas.

## 3. Modelo de datos y migración

### 3.1 Dos tablas, no una columna nullable

La alternativa barata es `team_members.work_id` nullable + `brand_id`, copiando el patrón de
`connections` (`connectionsSchema.ts:23-42`). **No sirve, y el motivo es del dato, no del gusto:**
un miembro del plantel convocado en tres trabajos tiene tres `session_id`, tres `usage_json`, tres
`done` y tres `continued_from`. Una fila con `work_id` nullable no puede ser plantel *y*
convocatoria a la vez: sería una cosa o la otra, y "la misma persona en dos trabajos" —que es justo
el requisito— quedaría sin representar. Entonces:

```sql
CREATE TABLE IF NOT EXISTS brand_members (
  id          TEXT PRIMARY KEY,
  brand_id    TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL,  role_name TEXT NOT NULL,  initial TEXT NOT NULL,
  avatar      TEXT,                            -- override propio; NULL = la cara del rol
  runtime     TEXT NOT NULL,  model TEXT,  account_id TEXT,
  tier        TEXT NOT NULL DEFAULT 'balanced',
  coordinator INTEGER NOT NULL DEFAULT 0,      -- el coordinador habitual de esta marca
  retired_at  TEXT,                            -- se retira, no se borra: los runs viejos lo nombran
  created_at  TEXT NOT NULL,  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brand_members_brand ON brand_members(brand_id, created_at);
-- y team_members se queda donde está, con una columna más:
ALTER TABLE team_members ADD COLUMN brand_member_id TEXT;
```

`team_members` pasa a ser lo que siempre fue en los hechos: la convocatoria. Identidad arriba, hilo
abajo.

**El `id` del miembro no cambia**, y eso es lo que abarata todo: `coordination_dispatch.member_id`,
`coordination_message.to_member_id`/`from_member_id`, `coordination_ask.member_id` y
`coordination_cost_reservations.member_id` (`electron/storage/coordinationSchema.ts:77-139`) siguen
apuntando a lo mismo, igual que el JSON de `coordination_hires:<runId>` (`engine.ts:1183-1192`).
Cero churn en el motor. Conviene saber por qué es *tan* barato: **ninguna tabla `coordination_*`
tiene FK real contra `team_members`** — `member_id` es texto libre que resuelve el motor. Ventaja
acá, deuda en general, y un aviso: una migración que se equivoque no choca con ninguna barandilla.

**Overrides.** `model` y `tier` viven en el plantel y son nullable en la convocatoria: por default el
miembro trabaja como siempre, y en un trabajo puntual se lo puede bajar. `runtime` y `account_id`
sólo en el plantel, porque cambiar de runtime invalida el `session_id` y para eso ya está "continuar
con otro agente", que crea alguien nuevo (`contracts.ts:618`).

**Avatares.** Hoy la cara se resuelve miembro → rol → semilla del id
(`src/coordination/avatar-of.ts:21-40`) y "ninguna cara repetida en un equipo" se calcula dentro
del trabajo (`contracts.ts:602-608`). Con plantel se calcula **dentro de la marca**, que es más
estable: la cara de alguien deja de depender de a quién más convocaron ese día.

### 3.2 La migración 13 → 14

Precedente exacto en casa: v2→v3 convirtió cada `chat_sessions` en un miembro "assistant"
(`repository.ts:529-545`); esto es lo mismo un escalón más arriba. Por cada fila de `team_members`,
en orden de `created_at`: resolver la marca por `work_id`
(`works.brand_id`); buscar en `brand_members` uno de esa marca con el mismo
`(role_id, runtime, account_id)`; si no hay, crearlo copiando `role_id`, `role_name`, `initial`,
`runtime`, `model`, `account_id`, `tier` y la cara que hoy tiene el miembro; y escribir
`team_members.brand_member_id`.

O sea: **cada miembro de hoy se vuelve plantel de su marca, convocado en su trabajo.** Dos miembros
del mismo rol en trabajos distintos de la misma marca se funden en una persona, que es justo lo que
Gabriel quiere ver. Dos del mismo rol en el *mismo* trabajo (el caso de `continuedFrom`) siguen
siendo dos, porque difieren en runtime o cuenta.

**Hay que bumpear `SCHEMA_VERSION` a `'14'`** (`schema.ts:162`), y esta vez sí, a diferencia del
razonamiento de `schema.ts:136-161`: una tabla nueva con back-fill no es una columna que un build
viejo pueda ignorar, y el bump es lo único que hace que `prepareForMigration` saque el respaldo
—con el WAL al lado— antes de tocar nada (`electron/storage/backup.ts:40-66`). El precio es que un
build anterior rechaza la base (`isNewerSchema`, `:69-76`); es el precio correcto.

### 3.3 Contratos, en los cinco lugares de siempre

Igual que las conexiones: `shared/contracts.ts` (`TeamMember` gana `brandMemberId`; nacen
`BrandMember`, `listBrandTeam(brandId)`, `addBrandMember`, `retireBrandMember`,
`callUpMember(workId, brandMemberId)`), `electron/ipc/channels.ts:130-136,270-276`,
`electron/preload.cjs:130-136`, `electron/services/latteService.ts:2196-2228` y el falso de
`src/browser-api.ts:346`. `listTeam(workId)` sobrevive con la misma firma.

## 4. Impacto en la coordinación

- **`coordinatorOf`** (`engine.ts:2519-2521`): sin cambios. Lo único que cambia es de dónde sale el
  default al arrancar un run: del plantel de la marca en vez del primer miembro a mano.
- **Altas**: `recordHire` (`engine.ts:1183-1192`) sigue anotando por run, porque el alta es un hecho
  del run. Cambia lo de arriba: cuando el motor necesita un rol que no está convocado, mira primero
  el plantel; si está, lo convoca; si no, lo crea ahí **y** lo convoca. `compensateHire` (`:2087-2112`)
  hoy llama a `hub.removeMember` —borra la fila entera— y mañana compensa **la convocatoria, nunca
  el plantel**: si un spawn se colgó, lo que sobra es un hilo, no una persona. Eso cierra de costado
  un resto conocido (`docs/briefs/2026-09-20-coordinacion-autonoma-cierre.md:86-88`: "la
  compensación del primero puede despedir al proceso del segundo").
- **Liveness**: `liveMemberIds(workId)` (`hub.ts:348-351`) no se toca; sigue por trabajo, porque los
  procesos son por trabajo (§2.4).
- **`limits.ts`**: **el plantel no lleva tope** — estar ahí no corre nada, y un tope sería inventar
  escasez. Los de procesos se quedan donde están (`limits.ts:33,94,106,125,136`). El que falta es
  **cuántos convocados vivos puede tener un run**, que hoy sólo existe para Codex
  (`MAX_COORDINATED_CODEX_MEMBERS_PER_RUN`, `:94`): con plantel se vuelve fácil pedir seis de una, y
  conviene que sea explícito y no una consecuencia del techo de `app-server`.
- **Tools MCP**: la respuesta ya está escrita. `resolveMessageTarget` (`engine.ts:3322-3347`)
  resuelve `"coordinator"`, un `memberId` del equipo vivo o un `roleId`; y a un `memberId` real **de
  otro Trabajo** le contesta `FORBIDDEN` con *"That member belongs to another Work"* (`:3335-3337`),
  nunca `NOT_FOUND`, para enseñar el límite. Un miembro del plantel no convocado cae exactamente ahí
  y por la misma razón: escribirle arrancaría un proceso que nadie pidió, en un trabajo al que no
  pertenece; la salida es que el coordinador lo convoque. Se mantiene **"A message never leaves this
  Work"** (`mcpServer.ts:202-206`). `latte_dispatch`, `latte_check` y `latte_request_coordination`
  no cambian.
- **Prompts**: `base.md` mide **7497 caracteres** (7495 tras el `.trim()` que es lo que viaja,
  `electron/agents/roles.ts:51`) contra el candado `toBeLessThan(7_500)`
  (`tests/backend/prompts.test.ts:57`): **cinco caracteres de margen, y va en el prompt de TODOS los
  roles** (`roles.ts:110-126`, spawneado en `hub.ts:662`). El cambio necesario está en "The team,
  and who actually did the work" (`base.md:42-64`): el equipo preexiste al trabajo, y pedir a
  alguien no convocado es pedirle al coordinador que lo convoque. Se paga fundiendo el bullet de "no
  side channels" (`:62-65`) con el de `latte_dispatch` (`:50-55`), que hoy dicen dos veces lo mismo:
  no inventes el trabajo de otro, despachalo. Ojo, es texto para el modelo: se mide antes de mergear.

## 5. Renderer

**Nace** una pantalla, **Marca → Equipo**: el plantel con caras, espejo de Marca → Conexiones
(`docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md:279-285`), donde se suma, se retira, se
cambia la cara y se marca quién coordina. Reusa `Avatar`, `AvatarPicker` y `role-color`. **Cambian**:

- `TeamView` (`src/TeamView.tsx`): el composer al pie; la columna derecha, cuando el hilo es el del
  coordinador, deja de ser sólo timeline (`MemberDetail`) y pasa a ser conversación con los eventos
  de `inboxEvents` intercalados; "Sumar un rol" (`:161-191`) muestra primero el plantel.
- `RunHeader` (`src/coordination/RunHeader.tsx:125-139`): "Terminamos · N de M" fusionando
  `coord.done.at` y `coord.run.progress`; "Nuevo pedido" queda como está.
- `TeamPanel` (`src/TeamPanel.tsx:196,252-256,285-317,335-368`): el rail pasa a ser "uno vs el
  equipo"; el coordinador sale de la tira de pestañas; `openCoordinatorChat` abre el modo Equipo.
- `App.tsx`: `openWorkCoordination` (`:794-800`) deja de saltar al rail `chat`; `addMember`
  (`:1081`) gana la variante "convocar del plantel"; `loadTeam` (`:359-370`) no cambia de firma.
- `i18n.tsx`: nacen `team.roster.*` y `coord.done.together`; se ajustan `team.view.*` y
  `coord.empty.*`.

**Se elimina** la pestaña del coordinador en la tira de miembros, y con ella la razón de que
`wantCoordinatorRef` (`App.tsx:397-403`) exista. **Candados** — el grueso del costo, porque 36 tests
DOM y ~90 de backend tocan esta superficie:

- Cambian de significado entero `src/team-rail.dom.test.tsx:63-146` (el toggle arranca en `chat`,
  "Ver hilo" salta de rail), `src/team-view.dom.test.tsx:104-396` ("Conversación" abre el chat,
  `:234` — deja de existir: ya estás en la conversación) y `src/team-member-tabs.dom.test.tsx:71-151`.
- `src/app-views.test.ts:106-110,173-194` asertan **por regex contra el cuerpo real** de
  `openWorkCoordination`, `openActiveRun` y `selectMember`: se rompen sí o sí.
- Se **amplían**, no se reescriben, `src/team-panel-run-exits.dom.test.tsx:100-166` y
  `src/team-cards-finished-run.dom.test.tsx:42-64`: al "un run terminado no ofrece Cancelar/Pausar/
  Reanudar" se le suma "y dejó los procesos apagados".
- Nacen `tests/backend/brand-roster.test.ts` (plantel, convocatoria, migración 13→14) y
  `coordination-close-stops.test.ts`. Uno **no se puede romper**: `coordination-finished-run.test.ts`
  ("un run terminado se sigue viendo, con su bitácora") — apagar procesos no puede llevarse puesto el
  log: el miembro se pausa, la fila queda. Igual con `coordination-hires.test.ts` y
  `coordination-member-death.test.ts`, que ya prueba que la muerte de un proceso liquida su
  despacho: apagar al cerrar tiene que verse como cierre, no como muerte.

## 6. Riesgos y alternativas consideradas

**Mantener por trabajo y agregar "copiar equipo".** La opción de una tarde. No sirve: copia la fila
y no la conversación, porque `session_id` es del runtime y va pegado a la fila (`schema.ts:113`) y
el `usage` es por fila (`:122-124`). Un equipo copiado es un equipo con amnesia: la misma cara sin
una sola cosa recordada. Y multiplica filas por trabajo, el desorden del que se quiere ir.

**Plantel global de la app.** Choca con lo que la app ya decidió dos veces: las conexiones son por
marca o globales y la de marca gana (`docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md:229-236`),
y el contexto de marca es **autoridad** sobre el trabajo del equipo (`base.md:66-70`). Un estratega
compartido entre marcas tiene dos autoridades en la cabeza. El nivel global ya existe: los perfiles.

**Procesos compartidos entre trabajos.** No es una decisión, es imposible: `memberContext` fija el
cwd en `workDir(brandId, workId)` (`latteService.ts:2331`), que puede ser una carpeta externa
(`paths.ts:96-101`), y `CLAUDE.md`/`AGENTS.md` se reescriben por trabajo y sólo cuando no hay nadie
vivo (`:2310-2327`). Un proceso en dos trabajos vería su contexto cambiar debajo.

**Riesgos que quedan.** (1) La migración funde miembros del mismo rol de distintos trabajos: si se
equivoca, dos historias quedan bajo una cara — de ahí el respaldo obligatorio y una prueba con la
base real de Gabriel antes de mergear. (2) El composer hace trivial escribirle al equipo, y eso puede
disparar más runs de los que los techos toleran: el tope de convocados por run (§4) es la contención.
(3) `base.md` con cinco caracteres de margen: el recorte se mide, no se estima. (4) Todo sigue detrás
de `feature:coordination` y sin QA con procesos reales
(`docs/briefs/2026-09-20-coordinacion-autonoma-cierre.md:74-114`): esto suma superficie a ese QA.

## 7. Cómo ejecutarlo

La evidencia pide ordenarlo por **qué mergea solo sin romper lo de hoy**, no por fases: los dos
primeros bloques no tocan el esquema y se sueltan esta semana; recién el tercero es el grande.

| # | Bloque | Toca esquema | Mergea solo | Días de agente |
|---|---|---|---|---|
| 1 | `closeRun` apaga a los convocados (`pauseMember` sobre `listHires`, salvo `isMemberBusy`) + "Terminamos · N de M" en `RunHeader` | no | **sí** | 1 |
| 2 | Composer en el modo Equipo, ruteo al coordinador, la pestaña del coordinador sale, timeline y conversación en una sola lista | no | **sí** | 3–4 |
| 3 | `brand_members` + `brand_member_id`, migración 13→14 con respaldo, contratos en los cinco lugares, pantalla Marca → Equipo | sí | sí | 4–5 |
| 4 | El alta del motor convoca del plantel en vez de contratar de la nada; tope de convocados por run; recorte de `base.md` | no | tras 3 | 2 |
| 5 | Reescribir los candados del renderer y sumar los de backend | no | con cada bloque | 2–3 |

Total: **12 a 15 días de agente**, con la mitad del riesgo en el bloque 5, que no es opcional: varios
de esos tests asertan por regex contra el cuerpo real de las funciones de `App.tsx`
(`src/app-views.test.ts:106-110,173-194`). El bloque 1 es el que más devuelve por lo que cuesta: es
literalmente lo que Gabriel pidió primero ("equipo que termina debería cerrarse"), y hoy no pasa por
falta de tres líneas en `closeRun`.

## 8. Decisiones abiertas para el dueño

Sólo estas tres; todo lo demás lo decide la evidencia.

1. **"Despertar al equipo completo": ¿existe o no?** La recomendación es que no, y que el
   coordinador sea el "a todos" (§2.6): despertar N procesos a la vez pelea con
   `DEFAULT_MAX_CONCURRENT = 3` y con los techos de `limits.ts:106,136`, y rompe *cada bot aislado,
   uno consolida*. Pero es tu palabra la que está en el pedido, así que decidilo vos.
2. **Qué pasa con un miembro del plantel al que nadie convocó en meses**: ¿se retira solo, se
   muestra en gris, o queda igual para siempre? La tabla trae `retired_at`; la política es tuya.
3. **¿Se puede convocar a alguien de OTRA marca para un trabajo puntual?** La recomendación es que
   no —el contexto de marca es autoridad (`base.md:66-70`) y una persona con dos autoridades es un
   problema—, pero es una restricción de producto, no técnica.
