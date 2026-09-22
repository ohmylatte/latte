# Conexiones MCP: arquitectura

Fecha: 2026-09-23 · Estado: propuesta para decidir · Autor: arquitectura

Gabriel: "no hay forma de conectar el MCP de theagentcy, ni siquiera por el CLI, y ahora tengo
problemas con el de Meta. Cuando el MCP se loguea por OAuth, ¿cómo usamos diferentes MCP por
cuenta (por marca)?"

Evidencia medida, no hipótesis. Conclusión corta: **el camino que Latte usa hoy (delegar en el
registro global del CLI) no puede funcionar, y "Latte es el cliente OAuth" es correcta a medias:
la parte de OAuth sí, la de inyectar el token del proveedor en cada miembro no.** La
recomendación es un gateway MCP local; el porqué está en la sección 4.

## 1. Diagnóstico con evidencia

Todo contra Claude Code 2.1.280 y Codex 0.154.0 en la máquina de Gabriel; comandos y salidas, en
el apéndice.

### 1.1 Lo que SÍ funciona: `--mcp-config` con `headers`

Levanté un servidor MCP streamable-http de juguete que exige `Authorization: Bearer secreto` y
expone una tool `ping`. Un `claude -p --mcp-config` con `headers` lo conecta y lo usa: el init trae
`{"name":"toy_ok","status":"connected","source":"dynamic"}` y la tool corre y devuelve bien.

Es exactamente el camino de `latte_coordination` (`claudeAdapter.ts:420-470`). **Anda, es por
miembro, no toca ningún registro global y no necesita navegador.** Ese hallazgo ordena todo lo
demás. Detalle útil: el `system/init` marca `source` (`dynamic` para `--mcp-config`, `user` para
el registro del CLI); Latte lo ignora y no debería.

### 1.2 Lo que NO funciona: OAuth de un servidor del registro en modo `-p`

Mismo servidor, ahora en modo OAuth estándar MCP: 401 con `WWW-Authenticate: Bearer
resource_metadata="..."`, well-knowns con `registration_endpoint` y PKCE. Un `claude -p` contra
eso da `[{"name":"toy_oauth","status":"needs-auth","source":"dynamic"}]`, y el log del servidor
muestra qué hizo: un `GET /.well-known/oauth-protected-resource`, un `GET
/.well-known/oauth-authorization-server`, un `POST /mcp` — y **cero** intentos a `/register`
(registro dinámico) y **cero** a `/authorize` (navegador). **Hipótesis confirmada:** `claude -p`
hace el descubrimiento completo y ahí se planta; no cuelga, no abre navegador, no registra
cliente. La doc lo dice igual: *"In non-interactive mode there's no `/mcp` panel, so Claude Code
can't run the OAuth flow for you."*

### 1.3 Dónde viven los tokens de Claude Code, y que un `-p` SÍ los reutiliza

Esto la doc no lo dice; lo medí. Viven en `~/.claude/.credentials.json`, bajo
`mcpOAuth["<nombre>|<hash de la url>"]`, con `serverUrl`, `accessToken`, `refreshToken`,
`expiresAt`, `clientId`, `redirectUri` e `issuer`.

Inyecté un token de juguete válido en esa entrada y volví a correr el mismo `claude -p
--mcp-config` **sin headers**: `status: "connected"`, y el servidor recibió 6 requests con
`auth=BEARER-OK`. **Un `-p` posterior sí reutiliza el token guardado,** siempre que coincidan
nombre y URL y `expiresAt` esté en el futuro. Si renombrás el servidor o le cambiás la URL, el
token se pierde en silencio.

### 1.4 La trampa que le está pasando a Gabriel ahora mismo

En `~/.claude/mcp-needs-auth-cache.json` de esta máquina hay tres entradas: `the-agentcy`,
`Theagentcy`, `The-agentcy`. Tres intentos con tres nombres distintos: el rastro de Gabriel
probando. Esa caché está **indexada sólo por nombre, no por URL**, y cortocircuita la conexión:
mientras la entrada está fresca el CLI marca `needs-auth` sin abrir el socket. Verificado: con
la entrada presente, cero requests; vaciándola, sale. Reintentar con el mismo nombre no sirve.

### 1.5 Lo que Latte hace mal hoy, paso a paso

Cuando Gabriel agrega theagentcy desde Ajustes → Herramientas: (1) `ToolsView.tsx` pide nombre,
transporte y URL — **no hay campo de headers**. (2) `claudeAddArgs` (`mcp.ts:~173`) arma `claude
mcp add --scope user --transport http <nombre> <url>`; el CLI acepta `--header`, `--client-id`,
`--client-secret` y `--callback-port` y **Latte no pasa ninguno**, así que sin token no hay
forma de que conecte. (3) `claude mcp list` devuelve `Needs authentication` y la UI ofrece
"Autenticar". (4) `authenticateClaude` (`mcp.ts:~126`) abre una terminal embebida con `claude`
interactivo para que la persona escriba `/mcp`: **hoy es el único camino que puede terminar el
OAuth, y pasa por una terminal adentro de la app.**

Y un bug de perfil: `listFor`/`add` usan `accountEnv(runtime, null)` (`mcp.ts:163`), el perfil
**system**, mientras `authenticateClaude` usa el `CLAUDE_CONFIG_DIR` de la cuenta del agente
primario. Si el primario es una cuenta gestionada, **el servidor se registra en un perfil y el
login se hace en otro**: `/mcp` no lista nada. Silencioso.

### 1.6 Dos marcas, y el 401 que no avisa

Los servidores del usuario viven en el registro global (`--scope user`). Latte ya aísla por
**cuenta de CLI** (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, `accounts.ts:30`), pero una cuenta es la
identidad de facturación de Claude o Codex, no una marca. Probé dos nombres distintos apuntando
a la **misma URL** con headers distintos en un mismo proceso: `agentcy_ambar` quedó `connected`
(BEARER-OK) y `agentcy_latte` `failed` (BEARER-WRONG). Conviven sin pisarse: **namespacear el
nombre resuelve el proceso compartido**; ojo que el nombre se filtra al de la tool
(`mcp__agentcy_ambar__ping`). Y el dato que más pesa en la decisión: con un header inválido el
estado es `failed`, **no** `needs-auth`. Cuando un token inyectado vence a mitad de un run, el
runtime no dice "necesita login": dice que falló la conexión. **Nadie le va a avisar al miembro
que se tiene que volver a loguear.**

## 2. Qué soporta cada runtime

| | Claude Code 2.1.280 | Codex 0.154.0 | OpenCode 1.18.x |
|---|---|---|---|
| Config por invocación | `--mcp-config <archivo>` ✅ | `-c mcp_servers.<n>....` ✅ | `OPENCODE_CONFIG_CONTENT` (env, inline) ✅ |
| Headers estáticos http | `headers: {...}` ✅ | `http_headers`, `env_http_headers` ✅ | `headers`, con `{env:VAR}` ✅ |
| OAuth headless completo | ❌ sólo descubre y para | ❌ devuelve URL, el login es browser | ❌ igual |
| OAuth interactivo | `/mcp` o `claude mcp login [--no-browser]` | `codex mcp login <n> [--scopes]` | `opencode mcp auth <n>` |
| Registro dinámico (RFC 7591) | sí en `mcp login`, no en `-p` | sí, en su flujo propio | sí, documentado |
| Dónde guarda tokens | `~/.claude/.credentials.json` → `mcpOAuth["<nombre>\|<hash url>"]` | `~/.codex/secrets/mcp_oauth.age` (o keyring), por servidor+url | `~/.local/share/opencode/mcp-auth.json` |
| Aislamiento por perfil | `CLAUDE_CONFIG_DIR` ✅ | `CODEX_HOME` ✅ | `OPENCODE_CONFIG` / dirs |
| Latte inyecta hoy | sí (`claudeAdapter.ts:420-470`) | sí (`mcpFingerprint.ts:51-81`) | **no** (`chatManager.ts:78`: `mcpInjection = 'none'`) |

## 3. Los dos servidores reales

**theagentcy — `https://theagentcy.app/api/mcp`.** OAuth estándar MCP (401 con
`WWW-Authenticate` + `resource_metadata`), registro dinámico en
`https://theagentcy.app/api/mcp/oauth/register`, PKCE `S256`, scope único `mcp`, refresh sí,
cliente público sin secreto. **Latte puede conectarlo sin que Gabriel registre nada en ningún
lado**: que hoy no funcione es culpa del camino que elegimos, no del servidor.

**Meta — `https://mcp.facebook.com/ads`.** Es el **oficial** (developers.facebook.com, "Ads MCP
Server"); los `meta-ads-mcp` de GitHub son de terceros y piden token manual. El 401 al
`initialize` trae `WWW-Authenticate: Bearer
resource_metadata=".../.well-known/oauth-protected-resource/ads"` con los scopes. Metadatos
completos, PKCE `S256`, refresh sí, `token_endpoint_auth_methods` `["none"]`;
`authorization_endpoint` es el diálogo normal de FB (`/v26.0/dialog/oauth`) y el AS vive en
`https://www.facebook.com/.well-known/oauth-authorization-server/ads`. **Los well-known sólo
responden en forma path-aware**; el genérico da 404, así que un cliente que pruebe sólo la forma
genérica no descubre nada.

**Y acá está el hallazgo que corrige la versión anterior de este documento.** Meta publica
`registration_endpoint` pero **no hace registro dinámico**. Lo probé de verdad, con cuatro
cuerpos distintos:

| `redirect_uris` enviado | Respuesta |
|---|---|
| `http://127.0.0.1:45789/callback`, `http://localhost:45789/callback` y `https://ohmylatte.app/mcp/callback` | las tres idénticas: 400 `invalid_client_metadata` · *"Dynamic registration is not available for this client."* |
| (ausente) | 400 `invalid_redirect_uri` · *"redirect_uris must contain at least one URI."* |

El endpoint valida la forma del pedido y después rechaza **todo** registro, sea loopback o
https. No es el esquema del redirect: Meta no abre DCR a nadie. Lo confirma el mundo exterior —
al menos seis issues abiertas en `anthropics/claude-code` por esto (#55002, #55556, #57114,
#57191, #58054, #59924), todas con *"The provided redirect_uris are not registered for this
client"* y la misma conclusión: Meta sólo acepta redirects pre-registrados, y hoy funcionan los
de claude.ai web y Claude Desktop.

La doc oficial lo dice en positivo: crear o reusar una app en developers.facebook.com, agregarle
el caso de uso **"Create & manage ads with ads MCP server"**, pasar el **app id como OAuth
Client ID** (la doc muestra `--client-id <META_APP_ID>`; **no** pide client secret) y configurar
el redirect URL "según el cliente MCP elegido". No menciona revisión de app ni acceso avanzado
para esos scopes.

**Conclusión en una línea: theagentcy se conecta con DCR y sin que Gabriel registre nada; Meta
necesita app propia, con su app id como `client_id` y el redirect de Latte anotado a mano en esa
app.** Para el gateway el cambio es chico y ya está contemplado: la Conexión guarda un
`clientId` opcional y, cuando existe, el módulo OAuth se saltea el registro dinámico. Queda por
ver si el campo de redirect de su app acepta `http://127.0.0.1:<puerto>/callback`; si exige
https, el plan B es un redirect hosteado en ohmylatte.app que rebote al loopback (5, pregunta
abierta).

## 4. Arquitectura propuesta

### 4.1 Las cuatro opciones, comparadas con lo que medí

Antes de recomendar hay que descartar en serio. Probé la (b) en vez de suponerla.

**(a) Latte implementa OAuth y le inyecta el token del proveedor a cada miembro.** Resuelve el
login (descubrimiento, DCR, PKCE y loopback: verificado contra theagentcy y contra mi AS de
juguete) y el alcance (nombres namespaceados, 1.6). Rompe en dos lugares: **el token del
proveedor sale del proceso principal** (archivo 0600 o env de Codex) y **el vencimiento a mitad
de run es invisible** — `failed`, no `needs-auth` (1.6), y el `--mcp-config` se lee al spawnear,
así que renovar exige reiniciar al miembro.

**(b) Reutilizar el almacén de cada CLI, logueando una vez desde Latte.** Esta era la candidata
seria y **la probé: funciona.** `claude mcp login` dentro de un PTY, manejado enteramente por un
programa —capturar la URL, resolver el `authorize`, escribir el redirect de vuelta— termina el
OAuth sin que nadie escriba nada: `Authenticated with "toy_oauth". Its tools are now available
in Claude Code.`, exit 0.

El CLI hizo el registro dinámico solo (pegó en mi `/register`), usó PKCE `S256` y guardó
`accessToken` + `refreshToken` + `expiresAt` en el perfil. Latte **ya tiene** el PTY que esto
necesita (`terminalManager`, node-pty); sin PTY no anda: `--no-browser` con pipes muere con
*"stdin isn't a terminal"*.

Y sin embargo **la descarto, por la pregunta de Gabriel.** Un servidor distinto por marca exige
un `CLAUDE_CONFIG_DIR` por marca, y el perfil aislado conecta el MCP perfecto
(`{"name":"toy_oauth","status":"connected","source":"user"}`) pero el run termina en `"Not
logged in · Please run /login"`. **Un perfil por marca es un login de Claude por marca**: una
suscripción por marca, o copiar el blob de sesión de Anthropic entre perfiles, frágil y de
legitimidad dudosa. Suman tres almacenes, tres comandos de login, la caché de 1.4 mordiendo por
nombre y el refresh en manos del CLI. La variante sin perfiles —nombres distintos en el registro
global— vuelve a poner las credenciales de todas las marcas en un pozo común y deja a OpenCode
afuera.

**(c) Un gateway MCP local de Latte.** Un proceso en el main que se loguea contra los servidores
externos, guarda los tokens y le expone a cada miembro un endpoint http local con **su propio
bearer emitido por Latte**. Los runtimes no ven OAuth nunca: ven un servidor http con un header,
exactamente lo que los tres ya aceptan (sección 2) y lo que Latte **ya corre hoy** para
`latte_coordination`. El alcance es el bearer; el vencimiento se resuelve adentro y el miembro
nunca ve un 401.

**(d) Lo nativo de cada runtime.** La (b) multiplicada por tres, más `opencode mcp auth`: mismo
problema de alcance, triple superficie. Ninguno de los tres tiene siquiera el concepto.

| | (a) inyectar token | (b) almacén del CLI | (c) gateway |
|---|---|---|---|
| Login sin terminal para la persona | sí | sí (con PTY, probado) | sí |
| Una cuenta por marca | sí (nombres) | **no** (pide un login de Claude por marca) | sí (un bearer por marca) |
| Codex y OpenCode | sí | sí, un store aparte cada uno | sí, iguales a Claude |
| Token vencido a mitad de run | **`failed` mudo, hay que reiniciar al miembro** | idem, y lo maneja el CLI | **invisible: refresca y reintenta** |
| Token del proveedor fuera del main | sí (archivo/env) | sí (store del CLI) | **no, nunca sale** |
| Trabajo | cliente OAuth | driver de PTY por runtime | cliente OAuth + proxy MCP |

### 4.2 Recomendación: el gateway (c)

**La hipótesis "Latte es el cliente OAuth" se confirma en la mitad que importa y se corrige en
la otra.** Latte tiene que ser el cliente OAuth, sí, pero no repartir el token del proveedor
entre los miembros: tiene que quedárselo y repartir bearers propios. Tres razones, todas
medidas. **Una**: el vencimiento a mitad de run es el único fallo que arruina un trabajo y sólo
(c) lo arregla — el runtime reporta `failed`, no `needs-auth` (1.6), así que con (a) o (b) nadie
se entera, y el `--mcp-config` se lee al spawnear, o sea que el token nuevo no entra sin
reiniciar al miembro. **Dos**: el alcance por marca sale gratis — con (b) está probado que
cuesta un login de Claude por marca; con el gateway es qué bearer le tocó al miembro. **Tres**:
no es una seam nueva —`latte_coordination` ya es un servidor MCP http local con bearer que los
tres runtimes consumen— y de paso **le da MCP a OpenCode**, que hoy no recibe nada. Bonus: el
token del proveedor nunca sale del main. Lo que cuesta es un hop de latencia y un proxy MCP
escrito con cuidado (passthrough de `initialize`, `tools/list`, `tools/call`, session id y
notificaciones; SSE si el upstream lo usa): ese proxy es el trabajo real, y los dos riesgos que
trae están en la sección 5.

### 4.3 Diseño

**Conexión** = `id`, `nombre` (slug estable), `url` + `transporte`, `authKind`
(oauth|header|ninguna), `clientId` opcional (para los que no dan DCR, como Meta), `identidad`
(lo que devuelve el servidor: mail, cuenta publicitaria), `tokens` (cifrados con `safeStorage`,
fuera del backup), `estado` (conectada|vencida|error|sin_conectar), `memberOverride` opcional, y
el **alcance**: `scope: 'global' | 'brand'` elegido al conectar, con `brandId` obligatorio si es
`brand` y null si es global.

**El alcance se elige, no se deduce** (decisión A). El caso de Gabriel lo explica solo: Meta Ads
es **global** porque todas las marcas cuelgan de su mismo portfolio; theagentcy es **por marca**
porque es una conexión por cliente y no se puede asociar a uno solo; Gmail será por marca y
Canva global (una cuenta pro). Latte sugiere un default por servidor cuando lo conoce —Meta
global, theagentcy por marca— editable siempre. **Resolución**: al armar el payload, para cada
servidor Latte busca primero una conexión de la marca del trabajo y, si no hay, la global; **la
de marca gana**, así que una marca con su propia cuenta de Canva pisa la pro compartida sin
tocar a las demás. Si no hay ninguna, ese servidor no se inyecta.

**Módulo OAuth** en el main, genérico, sin nada de theagentcy ni Meta hardcodeado:
descubrimiento (401 → `WWW-Authenticate` → `/.well-known/oauth-protected-resource` **path-aware
primero** y genérico después → `/.well-known/oauth-authorization-server` con inserción de path;
Meta obliga a soportar las dos formas); registro dinámico RFC 7591 si hay
`registration_endpoint` **y responde**, si no el `clientId` de la conexión; **PKCE S256
siempre**; redirect a loopback `127.0.0.1` con puerto fijo por conexión y `state` verificado;
login en `BrowserWindow` propia, no el navegador del sistema; refresh con margen de 5 minutos;
revocación al desconectar.

**Gateway**: un servidor http en `127.0.0.1` que Latte levanta con la app. Una ruta por conexión
(`/c/<connectionId>`), un bearer por miembro emitido al armar el payload y revocado al cerrar el
chat, y proxy transparente hacia el upstream con el token del proveedor puesto por el gateway.
Ante un 401 refresca, reintenta una vez, y si no, devuelve un error de tool legible y marca la
conexión **vencida**. El alcance vive en el bearer, no en la ruta: al emitirlo Latte ya resolvió
marca→conexión. Dos miembros de marcas distintas sobre la misma conexión global de Meta reciben
**bearers distintos en la misma ruta** (se revocan por separado y se audita quién llamó qué);
con theagentcy reciben rutas distintas, porque son conexiones distintas. Un bearer contra una
ruta que no le toca es 403.

**Inyección por miembro**, reutilizando lo que ya existe: Claude en el mismo
`<chatId>.mcp.json`; Codex por `-c mcp_servers.<n>.url` + `bearer_token_env_var`; OpenCode por
`OPENCODE_CONFIG_CONTENT`. Todos apuntan al gateway, no al proveedor. **Nunca en argv.**

**Conexión vencida**: el gateway lo sabe antes que nadie, y el equipo interrumpe con una
pregunta en el chat —"no puedo entrar a theagentcy, se venció la sesión"— con botón **Volver a
entrar**. Al volver, el gateway sigue sirviendo sin reiniciar a nadie. Nada de toasts.

**Datos y contratos**: tablas `connections` (con `scope` y `brandId`, e índice único por
`(scope, brandId, nombre)`) y `connection_tokens`, separada para que el backup excluya una tabla
entera y no filtre por olvido. Esquema 12 → **13**. Blob cifrado con `safeStorage`; si
`isEncryptionAvailable()` es false, la conexión no se guarda y se explica por qué. Lockstep de
los cinco lugares: `shared/contracts.ts` (`Connection`, `ConnectionInput`, `ConnectionScope`,
`ConnectionState`; `listConnections(brandId | null)`, que devuelve las de la marca y las
globales marcadas como heredadas, más `startConnectionLogin`, `disconnectConnection`,
`deleteConnection`, `testConnection`), `electron/ipc/channels.ts`, `electron/preload.cjs`,
`electron/services/latteService.ts` y `src/browser-api.ts` (fake: `listConnections` → `[]`, el
resto `unavailable`). `McpCatalog` sobrevive de sólo lectura y **deja de poder agregar**
(decisión C).

**Pantallas**, dos, porque hay dos alcances. **Ajustes → Conexiones** lista las globales (Meta,
Canva) y es donde se agregan. **Marca → Conexiones** lista las de esa marca (theagentcy, Gmail)
y muestra las globales **como heredadas**, en gris, etiquetadas "global" y sin botón de quitar;
desde ahí se puede "usar una cuenta propia para esta marca", que crea una de marca y pasa a
ganar. "Agregar conexión" pide nombre, URL y **alcance** (con el default sugerido ya elegido);
el descubrimiento decide si hace falta OAuth o un header, y si el servidor no da DCR pide el
`client_id`.

**Migración**: Latte lee `claude mcp list` / `codex mcp list --json` y ofrece importar cada
servidor http como conexión, preguntando el alcance de cada una. Los tokens del CLI no se
importan (son de otro cliente OAuth): la importada pide un login que ahora dura en Latte. Es
**una sola vez**: después manda Latte (decisión C). Y antes de cualquier intento con un nombre
que Gabriel ya probó, Latte borra su entrada de `mcp-needs-auth-cache.json`, o la caché de 1.4
lo bloquea de nuevo.

**Tests**, fakes herméticos como el resto del repo: el servidor MCP + AS de juguete del
apéndice, portado a `tests/fakes/`. Cubre descubrimiento path-aware primero y genérico después;
`registration_endpoint` que responde *"not available for this client"* → cae al `clientId` y, si
no hay, lo pide (el caso Meta, medido); loopback con `state` inválido, puerto ocupado y ventana
cerrada; upstream 401 → refresca y reintenta una sola vez; **resolución de alcance**: sólo
global → la usa, sólo de marca → la usa, las dos → gana la de marca, ninguna → no se inyecta;
bearer contra otra ruta → 403; bearer revocado al cerrar el chat; el token del proveedor no
aparece en ningún archivo ni env de los runtimes; `safeStorage` no disponible → no se guarda.

## 5. Riesgos y decisiones abiertas para el dueño

**Riesgos**

1. **Tokens en disco.** `safeStorage` los cifra contra la sesión del SO; si le roban el perfil
   de Windows desbloqueado, caen. Tabla separada, excluida del backup y de export.
2. **El gateway es un punto único**: si se cae, todos los miembros pierden las tools a la vez.
   Arranca con la app, se reinicia solo, y su caída se ve en el chat. Los **bearers** son
   aleatorios por miembro, sólo en `127.0.0.1` y revocados al cerrar el chat (el modelo de
   `latte_coordination`); los **puertos de redirect** son fijos por conexión y pueden estar
   ocupados.
3. **Una conexión global mal elegida toca a todas las marcas.** Es el riesgo nuevo que trae el
   alcance seleccionable: la pantalla tiene que decir "todas las marcas" con todas las letras al
   conectar una global.
4. **El proxy tiene que ser fiel.** Si se come notificaciones, progreso o el session id, las
   tools van a fallar de maneras raras. Es el riesgo técnico real de la opción elegida.

**Decidido por Gabriel el 2026-09-23**

- **A · Alcance seleccionable.** Cada conexión se conecta eligiendo `global` o `brand`, con
  default sugerido por servidor y editable; la de marca gana sobre la global. Global = todas las
  marcas (Meta Ads, Canva pro); marca = una sola (theagentcy, Gmail). Diseño en 4.3.
- **B · Meta sale por app propia.** DCR descartado con evidencia (sección 3): Latte usa el app
  id de Gabriel como `client_id`, sin secreto.
- **C · Latte es dueña de las credenciales.** El registro del CLI se importa una vez y queda de
  sólo lectura. **D · Se da de baja el botón "Autenticar"** con terminal embebida, apenas esté
  el flujo nuevo.

**Sigue abierto de verdad, una sola cosa: el redirect de la app de Meta.** Cuando Gabriel cree
la app con el caso de uso "Create &
   manage ads with ads MCP server", hay que ver si el campo de redirect URL acepta
   `http://127.0.0.1:<puerto>/callback`. Si lo acepta, no hay nada más que hacer; si exige
   https, el plan B es un redirect hosteado en ohmylatte.app que rebote al loopback, que suma
   trabajo y una dependencia del sitio. **No lo puedo averiguar yo**: es la config de una app
   suya, no un endpoint público.

## 6. Cómo ejecutarlo

**No propongo un spike, y el motivo es que ya lo hicimos.** Un spike compra información cuando
no se sabe si algo es posible, y las cinco incógnitas que lo justificaban están medidas acá:
headers por miembro en los tres runtimes (1.1, sección 2), theagentcy con DCR y PKCE sin
registrar nada (3), el flujo completo contra un AS real (4.1), dos conexiones al mismo servidor
en un proceso (1.6) y el vencimiento que no avisa (1.6). Meta tampoco es incógnita: está medido
en la sección 3. Entonces: **un camino delgado de punta a punta, construido de una, con
theagentcy como primer usuario real.** En este orden, porque cada paso deja algo que probar:

1. **Módulo OAuth + gateway, sin UI y sin base.** Una conexión hardcodeada a theagentcy, tokens
   en memoria, un miembro Claude llamando una tool real. Es el corazón y el mayor riesgo (el
   proxy fiel); va primero, con los fakes herméticos desde el día uno.
2. **Persistencia**: tablas con `scope`, esquema 13, `safeStorage`, exclusión del backup,
   refresh y la resolución marca→global.
3. **Contratos y las dos pantallas**: el lockstep, Ajustes → Conexiones, Marca → Conexiones con
   las heredadas, `McpCatalog` a sólo lectura.
4. **Los otros dos runtimes**: Codex y OpenCode contra el mismo gateway. Es config, no
   arquitectura, porque el gateway los iguala — por eso va acá y no antes.
5. **Vencida y aviso en el chat**, más los arreglos de 1.4 (caché por nombre) y 1.5 (el
   `accountId` de `list`/`add`), chicos y hoy mentirosos.
6. **Meta**: `client_id` de su app, y el redirect que salga de la pregunta abierta.

Orden de magnitud sin Meta: **una semana y media concentrada**, con el paso 1 cargando más de la
mitad. Meta baja a **medio día si su app acepta el loopback** y sube a dos o tres si hay que
hostear el redirect. Si el paso 1 se complica —el proxy es traicionero— conviene frenar y
reevaluar la (a): el resto del plan es idéntico para las dos, la única diferencia es si el
miembro recibe el token del proveedor o un bearer nuestro.

## 7. Apéndice: comandos y pruebas corridas

Todo en
`C:/Users/gabog/AppData/Local/Temp/claude/C--Users-gabog-orca-projects-MarketIA/2ca85f73-9fa5-42d1-ab88-57834e2fd39a/scratchpad/mcp-research/`

- `toy-mcp.js` — servidor MCP streamable-http + AS OAuth completo (`/register`, `/authorize` con
  302, `/token`), sin dependencias, `MODE=bearer|oauth|open`. `cfg-*.json` — los `--mcp-config`.
- `run-ok.jsonl` — headers → `connected` + tool ejecutada. `run-bad.jsonl` — 401 sin
  `WWW-Authenticate` → `needs-auth`. `run-oauth.jsonl` + `log-oauth.txt` — 401 con
  `WWW-Authenticate` → descubre metadatos, **cero** `/register` y `/authorize`.
  `run-reuse2.jsonl` — token válido en `mcpOAuth` → `connected`, 6 requests `BEARER-OK`.
  `run-dos.jsonl` — dos nombres, misma URL → `connected` + `failed`.
- `drive-login.js` — `claude mcp login --no-browser` con pipes: **falla**, *"stdin isn't a
  terminal"*. `drive-login-pty.js` — el mismo login en node-pty, manejado por el programa:
  **completa el OAuth, exit 0**. `perfil-ambar/` — `CLAUDE_CONFIG_DIR` aislado: registro y token
  propios, pero `claude -p` ahí responde `"Not logged in · Please run /login"`.
- `probes/` — theagentcy y `mcp.facebook.com`: 401, well-knowns, metadata del AS.
  `probes/meta-dcr/` — los cuatro intentos de registro dinámico contra Meta: **ninguno devolvió
  un `client_id`**, así que no hay identificador de cliente que guardar ni que pegar acá.

```
claude -p "..." --mcp-config cfg-ok.json --output-format stream-json --verbose
claude mcp login <n> [--no-browser]     # exige TTY; con PTY lo maneja un programa
codex mcp add <n> --url <u> --bearer-token-env-var <VAR>
```

Archivos del usuario inspeccionados sin volcar un secreto: `~/.claude/.credentials.json` (clave
`mcpOAuth`, forma `"<nombre>|<hash url>"`), `~/.claude/mcp-needs-auth-cache.json`,
`~/.claude.json` y `~/.codex/secrets/mcp_oauth.age` más `~/.codex/mcp-oauth-locks/`, de los que
sólo se listaron nombres. Los dos que se tocaron para la prueba de reuso se restauraron desde
backup. Todos los logins OAuth se hicieron contra el servidor de juguete: **ninguno con cuentas
reales de Gabriel.** Ninguna prueba tocó código de producto.
