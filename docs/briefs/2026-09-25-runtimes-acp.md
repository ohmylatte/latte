# Grok y Hermes como runtimes de Latte: un adaptador ACP

Fecha: 2026-09-25 · Estado: propuesta para decidir · Autor: arquitectura

Gabriel quiere sumar **Grok Build** (`grok` 1.0.30, xAI) y **Hermes Agent** (v0.21.0) como runtimes, a
la par de Claude Code y Codex. La hipótesis era que los dos hablan ACP (Agent Client Protocol) y que
con un solo adaptador Latte se lleva los dos. La medí contra los binarios instalados en esta máquina,
con las cuentas ya logueadas del dueño. Comandos y salidas, en el apéndice (sección 7).

## 1. Veredicto

1. **Hipótesis confirmada.** `grok agent stdio` y `hermes acp` responden `initialize` con ACP
   `protocolVersion: 1`, y los dos aceptan `mcpServers` http con `headers` en `session/new`: el
   servidor de juguete recibió `Authorization: Bearer secreto` de los dos.
2. Conviene **un módulo `electron/agents/acp/*` más una tabla de quirks por agente**. Los quirks no
   son cosméticos: prompt de sistema, modelo, usage y permisos se resuelven distinto en cada uno.
3. Grok hizo la prueba completa: llamó `ping` por MCP con bearer, escribió el archivo, respetó las
   reglas de Latte y reportó tokens **y costo** por ACP.
4. En Hermes encontré un **bug**: `session/set_model` reconstruye el agente y pierde los MCP
   inyectados por ACP. Hay un workaround verificado: un `session/load` después.
5. Los dos arrastran por defecto la config global de la máquina (hooks, reglas, MCP, memoria). Aislar
   el proceso es obligatorio, no una mejora opcional.

## 2. Qué habla cada uno

"Medido" = lo vi en el cable. "Fuente" = lo leí en el código de Hermes
(`%LOCALAPPDATA%\hermes\hermes-agent\acp_adapter`) o en la documentación que Grok trae en
`~/.grok/docs` y dentro del binario. "Sin probar" = no hay evidencia todavía.

| Capacidad | Grok Build 1.0.30 (`grok agent --no-leader stdio`) | Hermes 0.21.0 (`hermes acp`) |
|---|---|---|
| `initialize` | Medido. ACP v1, `loadSession`, `promptCapabilities{embeddedContext}`, sin imagen, `mcpCapabilities{http,sse}`, `sessionCapabilities{list,resume,close}`. Además manda muchas notificaciones `_x.ai/*` (modelos, anuncios, settings). | Medido. ACP v1, `agentInfo hermes-agent 0.21.0`, `loadSession`, `promptCapabilities{image}`, `sessionCapabilities{fork,list,resume}`. **No declara `mcpCapabilities`**, pero igual acepta http (ver abajo). |
| `session/new` + `mcpServers` http | Medido. Conecta cuando arranca el prompt, no durante `session/new`. Hizo `initialize`, `tools/list` y `tools/call` con el bearer. | Medido. Conecta durante `session/new` y registra `mcp__latte__ping` (queda con 18 tools). El primer `session/new` en frío tardó **41,6 s**; el siguiente, 8 s. |
| Nombre de la tool MCP | `latte__ping` (`server__tool`), invocado vía `use_tool` | `mcp__latte__ping`, igual que Claude |
| Descubrimiento de tools MCP | **Diferido**: el modelo llama `search_tool` y después `use_tool`, dos llamadas extra | **Diferido**: `tool_search` → `tool_describe` → `tool_call` |
| `session/prompt` | Medido. `stopReason: end_turn` | Medido. `stopReason: end_turn` |
| Updates | Medido. `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` (con `diff`), `session_info_update`, `available_commands_update`. Por fuera del estándar: `_x.ai/session_notification` (`response_completed` con usage, `turn_completed`, `hook_execution`, `pending_interaction`). | Medido. `tool_call`, `tool_call_update`, `agent_message_chunk`, `agent_thought_chunk`, `session_info_update`, `usage_update{size,used}` |
| Permisos | Estándar `session/request_permission`. Opciones según la fuente: `allow_once`, `allow_command_always`, `always_allow_all_sessions`, `reject`. **No se vio en el cable**: la config global del dueño (`permission_mode = "always-approve"`) dejó la sesión en `yolo:true`. | Fuente (`permissions.py`): `allow_once`, `allow_session` (kind `allow_always`), `allow_always`, `deny` (`reject_once`), `deny_always`. Modos ACP: `default`, `accept_edits`, `dont_ask`. **No se vio**: el turno no llegó a escribir. |
| Preguntas | Extensión propia `x.ai/ask_user_question`, fuera del estándar. Sin probar. | **No hay.** El toolset `hermes-acp` excluye `clarify` (fuente: `toolsets.py`). |
| Usage por ACP | Medido. El `_meta` del `PromptResponse` trae el contexto de la última llamada (`inputTokens: 27500` = 108 + 27392 de caché) y el acumulado del turno (`usage{inputTokens, outputTokens, cachedReadTokens, cacheCreationTokens, reasoningTokens, modelCalls, costUsdTicks}`). Cada llamada emite además su `response_completed`. | Medido. `PromptResponse.usage{inputTokens, outputTokens, cachedReadTokens, thoughtTokens, totalTokens}` y `usage_update{size, used}` = contexto actual. **Sin costo.** |
| Consumo fuera de ACP | Medido. `grok usage <sid>`: JSON con `session` y `turns[]`, los mismos campos, `costUsdTicks` en 1e10 por USD. | Fuente (`hermes_cli/oneshot.py:171-184`): `--usage-file` sólo en modo `-z` (una pasada). Trae `estimated_cost_usd`, `cost_status`, `cost_source`, `input/output/cache_read/cache_write/reasoning/total_tokens`, `api_calls`, `model`, `provider`, `session_id`. |
| Resume | Medido. `session/load` reproduce el historial (1 user, 4 thought, 2 message, 3 tool_call) y responde en 959 ms. También `session/resume`. | Fuente y medido. `session/load` reproduce el historial antes de responder y **vuelve a registrar los `mcpServers`**. También `session/resume` y `session/fork`. |
| Cancel | Estándar `session/cancel`. El init anuncia `cancelRewind: true`: puede deshacer cambios. Sin probar. | Fuente: `session/cancel` corta el agente de golpe y el prompt devuelve `stopReason: cancelled` |
| Modelo | Medido. `configOptions` trae `model` (hoy sólo **grok-4.7** en esta cuenta) y `reasoning_effort` (`low`, `medium`, `high`, `xhigh`); se cambian con `session/set_config_option` (docs). | Medido. `session/set_model` con `proveedor:modelo` (hay 169 modelos en 7 proveedores). **Bug: pierde los MCP de ACP.** |
| Prompt de sistema | Medido. `session/new._meta.rules` agrega texto al prompt (el modelo terminó con `LATTE-OK`). Según los docs, `_meta.systemPromptOverride` lo reemplaza. | **Ningún campo ACP.** Medido: `AGENTS.md` en el cwd se respeta (`LATTE-OK`). Fuente: también `SOUL.md` de `HERMES_HOME` y `.hermes.md`. |
| `headers` en MCP http | Medido: sí | Medido: sí (`server.py:1147-1151` los pasa tal cual) |
| Auth | `authMethods: cached_token` (`~/.grok/auth.json`) y `grok.com`. `GROK_HOME` o `XAI_API_KEY` por proceso. La cuenta está en tier **Free**, con Grok 4.7 "gratis por tiempo limitado". | `authMethods: custom`, `hermes-setup` (terminal). Las credenciales son de cada proveedor y viven en `HERMES_HOME` (`auth.json`, `.env`, `config.yaml`). |

Lo que se cuela desde la config global, medido en esta máquina:

- **Grok**: corrió los hooks de `~/.claude/settings.json` (`orca-status`, `settings`) antes y después
  de cada tool, a unos 1,3 s por hook. También cargó las reglas de `~/.claude` (contestó en castellano
  a un prompt en inglés). Sin aislar, importó los MCP de Claude/Cursor (`efecto`, `acdp` con un token
  en el env, `context7`, `engram`) y aplicó el `always-approve` global. Además `agent stdio` se
  cuelga de un *leader* compartido (`~/.grok/leader.sock`) salvo que le pases `--no-leader`.
- **Hermes**: suma a cada sesión los `mcp_servers` de su `config.yaml`, 51 plugins (entre ellos
  `orca-status`), `SOUL.md` y las memorias (también contestó en castellano). Su modelo por defecto
  (`custom:qwen3-4b` en `100.115.169.80`) **no responde**: una sesión sin `set_model` falla.

## 3. El adaptador ACP de Latte

### 3.1 Forma

```
electron/agents/acp/
  connection.ts     JSON-RPC 2.0 por stdio: framing NDJSON, ids, requests del agente, notificaciones
  acpAdapter.ts     RuntimeAdapter genérico: start/send/abort/permisos/preguntas/usage/stop
  profiles.ts       AcpProfile: la tabla de quirks (3.2); un perfil por agente
  profiles/grok.ts  spawn, env de aislamiento, rules, effort, usage x.ai
  profiles/hermes.ts spawn, set_model + load, preámbulo de rol, usage_update
tests/backend/fakeAcpAgent.ts  un agente ACP falso y configurable, como fakeOpenCode
```

`connection.ts` tiene que **ignorar lo que no pidió**. Grok manda decenas de notificaciones `_x.ai/*`
y, en modo leader, respuestas con `id: "skills-reload"` que nadie pidió. Todo request del agente que
el perfil no maneje se contesta con `-32601`. Nunca se deja colgado.

### 3.2 Tabla de capacidades por agente

| Campo de `AcpProfile` | Grok | Hermes |
|---|---|---|
| `command` / `args` | `grok.exe agent --no-leader stdio` | `hermes-agent\venv\Scripts\hermes.exe acp` (directo, **sin** `hermes.cmd` ni shell) |
| `isolationEnv` | `GROK_DISABLE_AUTOUPDATER=1`, `GROK_{CLAUDE,CURSOR,CODEX}_{MCPS,HOOKS,RULES,AGENTS,SKILLS,SESSIONS}_ENABLED=0`, `GROK_HOME` de la cuenta | `HERMES_HOME` de la cuenta (el perfil del sistema arrastra todo, ver 2) |
| `clientCapabilities` | `fs:false`, `terminal:false` (con `fs:true` Grok escribe **a través del cliente**: medido, pidió `fs/read_text_file` y `fs/write_text_file`) | `fs:false`, `terminal:false` |
| `systemPrompt` | `_meta.rules` = pack + rol + marca | preámbulo en el primer `session/prompt` (decisión abierta 3) |
| `permissionSetup` | forzar modo "ask" por sesión: candidato `_meta.yoloMode:false` o `GROK_HOME` limpio (**B0**) | `session/set_mode default` |
| `modelSetup` | `set_config_option reasoning_effort` según el tier | `set_model` + `session/load` con los mismos `mcpServers` (workaround del bug) |
| `usage` | `_meta.inputTokens` → `contextTokens`; `_meta.usage` → turno; `costUsdTicks / 1e10` → `costUsd` | `PromptResponse.usage` → turno; `usage_update.used` → `contextTokens`; `costUsd: null` |
| `questions` | `x.ai/ask_user_question` → `question` (**B0**) | ninguna: las preguntas van por `latte_ask` de coordinación |
| `mcpToolPrefix` | `<server>__` | `mcp__<server>__` |
| `confirmsMcpInjection` | `false` hasta verificar `x.ai/mcp/list` | `false`: sólo lo dice en stderr |

### 3.3 Cómo encaja cada pieza del contrato

- **Un proceso por miembro.** `start()` spawnea, hace `initialize` y abre la sesión con `session/new`
  (o `session/load` si hay `previousSessionId`), usando `cwd = input.directory`. No se comparte
  proceso como en Codex: el bearer de coordinación es por miembro y el costo de arranque es bajo en
  Grok (≈1 s). En Hermes son 3-8 s, y 41 s en frío.
- **Inyección.** `mcpInjection = 'per-member'`. `AdapterMcpServer` http pasa a
  `{type:'http', name, url, headers:[{name:'Authorization', value:'Bearer …'}]}`. El bearer viaja por
  stdin, nunca por argv, que es lo que exige `types.ts`. El `stdio` de `latte_memory` pasa a
  `{name, command, args, env:[{name,value}]}`, forma que Hermes lee en `server.py:1141-1146`; en Grok
  todavía no lo probé con stdio. `injectedMcpServers` = los nombres que se mandaron, porque ninguno de
  los dos confirma por ACP. Las conexiones de marca (`connections/injection.ts`) salen gratis: son
  más entradas http.
- **Permisos.** `session/request_permission` → `emit({type:'permission'})` → `PermissionCard`.
  `replyPermission` traduce `once|always|reject` al `optionId` cuyo `kind` sea `allow_once`,
  `allow_always` o `reject_once`. Se elige por `kind` y no por id, porque cada agente usa ids
  distintos. `trustedFolder` → modo "accept edits" (`accept_edits` en Hermes y, en Grok, lo que
  encuentre B0).
- **Preguntas.** Grok: `x.ai/ask_user_question` → `emit({type:'question'})`. Hermes:
  `replyQuestion` tira `NotFoundError`, igual que un runtime sin preguntas nativas.
- **Usage.** Misma regla N3 que `claudeAdapter.ts:750-784`: `contextTokens` es **la última llamada**,
  nunca la suma del turno. Grok la entrega directo. En Hermes sale del último `usage_update.used`.
  Donde el agente no da costo, `costUsd: null`. Latte no estima.
- **Pausa y reanudación.** `stop()` mata el proceso (en Windows, el árbol). Reanudar es spawn +
  `session/load(previousSessionId, mcpServers con bearers nuevos)`. Mientras dura el load, el
  adaptador **ignora** el replay: el pane se reconstruye desde `TranscriptStore`, como en Claude, y
  así no se duplican turnos. `runtimeSessionId` es el `sessionId` de ACP.
- **Abort.** Es `session/cancel`, que es una notificación: se espera el `PromptResponse` con
  `cancelled`. Antes de exponerlo en Grok hay que medir qué rebobina `cancelRewind`.
- **Topes** (`coordination/limits.ts`). Propongo `MAX_ACP_AGENT_PROCESSES_TOTAL = 8` (estructural,
  como `MAX_OPENCODE_SERVERS_TOTAL`) y que cada proceso cuente en `DEFAULT_MAX_CONCURRENT` como
  cualquier miembro. Ojo: `limits.ts` tiene cambios sin commitear del otro agente, así que esto va
  después de su merge.
- **Tier → modelo** (`agents/tiers.ts`). Grok: el modelo queda como está (hoy hay uno solo) y
  `light|balanced|deep` → `reasoning_effort low|medium|high`. Hermes: el tier elige
  `proveedor:modelo` de una tabla que define el dueño (decisión 2). Si el humano eligió un modelo
  explícito, nunca se reemplaza (regla existente).
- **Runtime picker.** Se suman `'grok' | 'hermes'` a `ChatRuntime`/`Provider` (`shared/contracts.ts`),
  a `PROVIDERS` y `PROVIDER_LABEL` (`runtime/providers.ts`: "Grok", "Hermes"), a `detect.ts`, a
  `isChatRuntime` del hub, a `PROFILE_ENV` de `accounts.ts` (`GROK_HOME`, `HERMES_HOME`) y a la lista
  de `runtimeStatus` de `src/browser-api.ts`. `hub.adapterFor` enruta los dos al mismo
  `AcpChatAdapter` instanciado con su perfil.
- **Nombres de tools en prompts.** Si el pack o el rol nombran tools como
  `mcp__latte_coordination__…`, en Grok no existen con ese nombre. El texto tiene que ser neutral
  ("la tool `latte_report`") o armarse con `mcpToolPrefix`.

## 4. Riesgos

| Riesgo | Evidencia | Mitigación |
|---|---|---|
| Versiones que se mueven | Grok avisó `1.0.30 -> 1.0.41` disponible. Sus docs dicen que las extensiones `x.ai/*` "may expand across releases". Hermes se instala desde git upstream y el bug de `set_model` vive en su código. | Piso de versión por perfil, como `claudeSupportsMcpInjection`. `GROK_DISABLE_AUTOUPDATER=1`. Test de contrato contra `fakeAcpAgent`. Reportar el bug upstream. |
| Auth y cuentas | Grok está en tier Free con promo temporal. Hermes guarda claves de proveedores **en texto plano** en `config.yaml` y su modelo por defecto está muerto. | Cuentas gestionadas con `GROK_HOME`/`HERMES_HOME`. No copiar credenciales entre homes: los refresh tokens rotan y dos copias se desincronizan. |
| Costo del prompt de sistema | Grok: la primera llamada ya son ~26,5k tokens de entrada; el `ping` costó 4 llamadas, 107.503 tokens de entrada (81.664 cacheados) y **US$ 0,098**. Hermes arranca con ~7k de contexto y el turno sumó 53.310 de entrada. | `rules` corto. Evaluar `systemPromptOverride` (decisión 4). Topes de `budget.ts` sobre `costUsd` donde exista. |
| Tools nativas vs las de Latte | Los dos esconden los MCP detrás de una búsqueda: más llamadas, y el modelo puede no encontrarlos. Hermes buscó 3 veces y se rindió (por el bug, pero el patrón es real). Traen además sus propias tools de memoria, skills, web, subagentes y terminal. | Describir las tools de coordinación de forma que la búsqueda las encuentre ("latte report task"). Nombrarlas en el `rules`. Apagar lo nativo que compita (memoria de Hermes vs `latte_memory`). |
| Config global filtrada | Ver sección 2: hooks, reglas, MCP ajenos (uno con token), always-approve. | `isolationEnv` obligatorio. Home propio por cuenta. |
| Windows | `hermes.cmd` es un wrapper: spawn con shell (y Node 24 avisa DEP0190). Python tarda 2,6-3,6 s en `initialize`. Hooks de ~1,3 s por tool. Rutas con `\` en `tool_call`. | Spawn directo de `hermes.exe`. Matar el árbol con `taskkill /T`. Timeouts de arranque distintos por perfil. |

## 5. Cómo ejecutarlo

La evidencia pide primero cerrar lo que no se vio (permisos y preguntas de Grok, permisos de Hermes,
aislamiento real) y después construir en capas. Días de agente:

| Bloque | Qué | Días | Mergea solo |
|---|---|---|---|
| B0 | Spike en el scratchpad: modo "ask" de Grok bajo `isolationEnv`/`GROK_HOME` limpio y forma real de `request_permission` y `x.ai/ask_user_question`; permiso de Hermes en modo `default`; `cancel` en los dos. Cuesta 3-4 prompts pagos. | 0,5 | no aplica (no toca código) |
| B1 | `acp/connection.ts` + `acpAdapter.ts` + `fakeAcpAgent.ts` + tests de contrato | 1,5 | **sí**: nada lo instancia todavía |
| B2 | Perfil Grok (aislamiento, `rules`, effort, usage con costo, preguntas) | 1 | sí, detrás de `PROVIDERS` sin exponer |
| B3 | Perfil Hermes (spawn directo, `set_model`+`load`, preámbulo, `usage_update`, sin preguntas) | 1,5 | sí, igual que B2 |
| B4 | Cableado: contracts, providers, detect, accounts, hub, tiers, limits, picker | 1 | no: es lo que lo muestra; va después del merge del otro agente en `limits.ts` |
| B5 | QA con los CLIs reales en la app (dev server) y actualizar este brief | 0,5 | con B4 |

Total: unos 6 días de agente. B1 a B3 pueden correr en paralelo después de B0 (B2 y B3 dependen de la
interfaz de B1, no de su implementación).

## 6. Decisiones abiertas para Gabriel

1. **Cuentas.** ¿Grok y Hermes con cuentas gestionadas por Latte (`GROK_HOME`/`HERMES_HOME` por
   cuenta, como Claude/Codex) o sólo "mi sesión"? Recomiendo gestionadas: el perfil del sistema trae
   hooks, reglas y MCP globales, y en Grok además el always-approve.
2. **Hermes: qué modelo por tier.** Es multiproveedor y hoy su default no responde. Hay que elegir
   proveedor y modelo para `light`, `balanced` y `deep`. En esta prueba usé
   `openai-codex:gpt-6-luna` (tu suscripción).
3. **Hermes: prompt de rol.** ACP no trae el campo. (a) Preámbulo en el primer mensaje: simple, pero
   la compactación de Hermes lo puede resumir. (b) `HERMES_HOME` por miembro con `SOUL.md` = rol:
   robusto, pero duplica el home y las credenciales. (c) `AGENTS.md` en el directorio del trabajo:
   descartada, porque los miembros comparten cwd. Recomiendo (a) y medir.
4. **Grok: `rules` (agrega) o `systemPromptOverride` (reemplaza).** Reemplazar ahorra buena parte de
   los ~26k tokens por llamada, pero pierde la guía nativa de Grok para sus tools. Recomiendo `rules`
   y medir.
5. **Grok: plan de pago.** El tier Free con promo no aguanta un equipo coordinado. ¿SuperGrok o
   `XAI_API_KEY` por cuenta?

## 7. Apéndice: comandos y pruebas corridas

Todo quedó en
`%TEMP%\claude\…\scratchpad\acp-research\` (`init.mjs`, `mcp-toy.mjs`, `run.mjs`, `summarize.mjs`,
`log-*.jsonl`). **Hubo un solo prompt al modelo por agente**, con la cuenta logueada del dueño. Grok usó
`grok-4.7` (el único modelo ofrecido) con effort `medium`. Hermes usó `openai-codex:gpt-6-luna`. Los
`/tools` de Hermes son comandos locales: no llaman al modelo.

1. **Versiones.** `grok --version` → `grok 1.0.30 (04b7ffed98c6)`. `hermes --version` →
   `Hermes Agent v0.21.0 (2026.8.31) · upstream 416a8177`, Python 3.11.15.
2. **`initialize`** (`node init.mjs grok|hermes`, JSON-RPC por stdin con
   `protocolVersion:1, clientCapabilities{fs, terminal}`). Las dos respuestas están resumidas en la
   tabla de la sección 2. Grok, lanzado sin `--no-leader`, publicó además
   `_x.ai/mcp/servers_updated` con los MCP globales de la máquina y 10 respuestas `id:"skills-reload"`.
3. **MCP de juguete.** `mcp-toy.mjs` es streamable-http en `127.0.0.1:7801` y devuelve 401 sin
   `Authorization: Bearer secreto`. Expone una tool `ping` que contesta `pong-7731`.
4. **`session/new` sin prompt** (`run.mjs <agente> new`, `mcpServers: [{type:'http', name:'latte',
   url, headers:[Authorization]}]`). Grok respondió en 897 ms con `configOptions{model,
   reasoning_effort}` y fases `_x.ai/session/setup` (`mcp_merge`, …). Hermes respondió en 41,6 s (en
   frío), con 169 modelos, modos `default|accept_edits|dont_ask`, `usage_update{size:131072,
   used:6993}`, y el log del toy muestra `initialize` + `tools/list` con el bearer.
5. **Prompt de Grok** (`ISOLATE=1 node run.mjs grok prompt`, con `_meta.rules` "terminá con
   LATTE-OK"). Prompt: "Call the ping tool from the latte MCP server. Then create pong.txt … reply with
   the result". Secuencia: `search_tool("latte ping")` → `use_tool(latte__ping)` →
   `rawOutput{type:MCP, output:{OkayOutput:"pong-7731"}}` → `write` con `diff`, hecho vía
   `fs/write_text_file` del cliente. Texto final: `"…pong-7731\nLATTE-OK"`. `stopReason end_turn`,
   26,6 s. `_meta.usage`: 4 llamadas, input 107.503, cached 81.664, output 885, reasoning 739,
   `costUsdTicks 978200000` = US$ 0,0978. La sesión reportó `yolo:true` (config global): hubo
   `pending_interaction`/`interaction_resolved` y ningún `request_permission`. Los hooks
   `global/orca-status` y `global/settings` corrieron en cada tool.
6. **`grok usage 01a0d8f3-…`** devolvió los mismos números, en `session` y `turns[0]`.
7. **`session/load` de Grok** (en un proceso nuevo, sin prompt): 959 ms, replay de 1
   `user_message_chunk`, 4 `agent_thought_chunk`, 2 `agent_message_chunk` y 3 `tool_call`.
8. **Prompt de Hermes** (`node run.mjs hermes prompt "" openai-codex:gpt-6-luna`, con `AGENTS.md`
   "terminá con LATTE-OK" en el cwd). `set_model` → `{}`; el stderr dice `model switched to gpt-6-luna
   via provider openai-codex`. El modelo llamó 3 veces a `tool_search`, que listó sólo `session_search`,
   `terminal` y `todo`: **sin latte**. Contestó que no tenía la tool `ping`, no creó el archivo y cerró
   con `LATTE-OK`. `usage{inputTokens:53310, outputTokens:248, cachedReadTokens:38400,
   thoughtTokens:128}`, `usage_update{size:272000, used:17177}`, 25,4 s.
9. **Aislar el bug de Hermes sin gastar modelo** (`node run.mjs hermes tools "" openai-codex:gpt-6-luna`):
   `session/new` → `/tools` dice "Search **4** additional tools"; `set_model` → `/tools` dice
   "Search **3**"; `session/load` con los mismos `mcpServers` → vuelve a "**4**" y el stderr repite
   `refreshed tool surface after ACP MCP registration (18 tools)`. La causa, en la fuente:
   `set_session_model` hace `state.agent = self.session_manager._make_agent(...)` (`server.py:2570+`),
   que arma `enabled_toolsets` sólo con `hermes-acp` y los MCP del `config.yaml`.
10. **Lectura de fuente y docs.** Hermes: `acp_adapter/server.py` (MCP, usage, `set_session_model`,
    `cancel`, `load_session`), `session.py` (`_make_agent`), `permissions.py`, `toolsets.py`,
    `hermes_cli/oneshot.py`. Grok: `~/.grok/docs/user-guide/15-agent-mode.md` (`_meta` de sesión,
    `--no-leader`, `configOptions`, `grok usage`), `07-mcp-servers.md` (`search_tool`/`use_tool`,
    compatibilidad Claude/Cursor), `10-hooks.md`, `12-project-rules.md`, y strings del binario para
    `GROK_*` y las opciones de permiso.
11. **Latte.** Leí `electron/agents/types.ts`, `claude/claudeAdapter.ts` (usage N3, permisos,
    `AskUserQuestion`, transcripto), `codex/codexAdapter.ts` (proceso por fingerprint, topes),
    `hub.ts` (`isChatRuntime`, `adapterFor`, `liveMemberIds`), `connections/injection.ts`,
    `coordination/limits.ts`, `runtime/providers.ts`, `agents/tiers.ts`, `agents/accounts.ts`
    (`PROFILE_ENV`) y `src/browser-api.ts`. No toqué código del repo ni `electron/opencode/*`.
