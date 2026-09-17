# Latte · An Agent Marketing Platform

Espacio de trabajo de escritorio, local, para marketers que dirigen agentes de IA.
Marcas, trabajos, varios entregables Markdown por trabajo, versiones inmutables,
registro de decisiones, memoria de marca compartida entre trabajos y conversaciones reales con agentes.
Todo en tu máquina.

![Latte: documentos de un trabajo, equipo de roles y aviso de cambio externo](assets/latte-documents-1440x1000.png)

> **Windows x64 está soportado. El empaquetado para Linux x64 está en alpha.**
> Fue verificado en Linux Mint 22.3 con X11; Wayland y otras distribuciones no fueron verificadas.
> Latte no trae los agentes ni una cuenta de IA. Usás la tuya y la inferencia
> la paga tu proveedor. Lo que un agente escribe es una propuesta hasta que la
> revisás.
>
> En Linux x64 podés usar AppImage o `.deb`. La mayoría de los sistemas ejecuta
> el AppImage sin preparación; si aparece un error de FUSE, seguí la solución de
> [`docs/RUN-linux.md`](docs/RUN-linux.md). El `.deb` no necesita FUSE.

## Instalar

Descargá **[Latte-Setup.exe](https://github.com/ohmylatte/latte/releases/latest/download/Latte-Setup.exe)** y ejecutalo.

El instalador todavía no está firmado, así que Windows va a mostrar «Windows
protegió tu PC»: **Más información → Ejecutar de todas formas**. Si preferís no
hacerlo, corré Latte desde el código, más abajo.

En Linux x64, descargá el AppImage o el `.deb` desde la
[última release](https://github.com/ohmylatte/latte/releases/latest). macOS no
tiene un artefacto soportado en esta alpha.

Necesitás además al menos un agente instalado y autenticado por tu cuenta:
[Claude Code](https://claude.com/claude-code),
[Codex](https://developers.openai.com/codex/cli) u
[OpenCode](https://opencode.ai). Latte los detecta solos.

El instalador de Windows y el AppImage avisan cuando hay una versión nueva; la
descarga empieza cuando la aceptás y Latte se reinicia solo cuando vos lo
decidís. Nunca lo hace sobre un documento sin guardar. El `.deb` no se
auto-actualiza: descargá e instalá el nuevo paquete desde cada release.

## Desde el código

```bash
git clone https://github.com/ohmylatte/latte.git
cd latte
npm ci
npm run dev
```

`npm run dev` levanta Vite y Electron sin compilar nada. Es el camino de
desarrollo y el más ejercitado.

### Opcional: renderer compilado

```bash
npm run build   # compila SOLO la interfaz (Vite) a dist/
npm start       # abre Latte usando dist/, sin servidor de desarrollo
```

`npm run build` compila **solo el renderer**: el proceso principal sigue
ejecutando TypeScript por tsx, igual que en desarrollo. Es el camino corto para
mirar la interfaz sin servidor, no el que produce el instalador.

Para eso está `npm run pack:win`, que empaqueta el proceso principal con esbuild
y arma `release/Latte-Setup.exe`. En un release de verdad no lo corras a mano:
lo hace [el workflow de CI](.github/workflows/release-windows.yml) desde un clon
limpio del tag. El detalle está en [`docs/RELEASING.md`](docs/RELEASING.md).

### Si `npm run dev` levanta el servidor pero no abre la ventana

Latte permite **una sola instancia**: las dos compartirían la misma carpeta de
datos. Si ya hay una ventana abierta, la nueva se cierra y te lo dice en la
consola. Cerrá la que está abierta y volvé a intentar. Si no la encontrás,
terminá `electron.exe` desde el Administrador de tareas. En Linux, tanto para
la app empaquetada como desde el código fuente, ejecutá
`pgrep -af 'Latte|latte'`, inspeccioná el resultado para identificar el PID
exacto de Latte y recién entonces ejecutá `kill <PID>`.

### Herramientas de los agentes (MCP)

Sin MCP, un agente solo ve los archivos del trabajo. En **Ajustes → Herramientas
(MCP)** se ve qué servidores tiene configurado cada runtime, con el estado real
que ese runtime reporta, y se pueden conectar o quitar en Claude Code y Codex.

Latte **no implementa MCP y no guarda credenciales**: ejecuta el comando `mcp`
de cada CLI, así que lo que agregues también va a estar cuando uses ese CLI por
fuera de Latte. OpenCode queda en solo lectura porque su `opencode mcp add` es
interactivo y no se puede automatizar sin inventar respuestas.

Una herramienta MCP puede leer y escribir fuera de la carpeta del trabajo, según
lo que ese servidor permita. Los permisos los aplica el runtime, no Latte.

### Usar una carpeta que ya tenés

Si ya venís trabajando en una carpeta del cliente, un trabajo puede apuntar a
esa carpeta en vez de guardar una copia dentro de Latte. **No se copia ni se
mueve nada**: Latte trabaja ahí.

A cambio, Latte crea dentro de esa carpeta `CLAUDE.md`, `AGENTS.md`,
`README.md` y `.latte/` (versiones), y los agentes que abras van a tener esa
carpeta como espacio de trabajo. La app lo dice antes de vincular. Los `.md`
del primer nivel pasan a ser documentos con versiones; el resto queda como está
y el agente puede leerlo.

### Requisitos

| Requisito | Detalle |
| --- | --- |
| Sistema | Windows x64 está soportado. El empaquetado para Linux x64 está en alpha: verificado en Linux Mint 22.3 con X11; Wayland y otras distribuciones no fueron verificadas. macOS no está soportado ni prometido para esta alpha |
| Node.js | Solo para correrlo desde el código: 24 LTS (el proyecto usa `node:sqlite`, incorporado en Node 24) |
| Agentes | Al menos uno instalado y con sesión iniciada: [Claude Code](https://claude.com/claude-code), [Codex](https://developers.openai.com/codex/cli/) u [OpenCode](https://opencode.ai) |
| Facturación | La inferencia la paga tu cuenta con tu proveedor. Latte no factura ni intermedia nada |
| Engram | Opcional, para memoria persistente adicional. La continuidad local entre trabajos de una misma marca no depende de Engram |

La vista web (`npm run dev:web`) es solo previsualización de interfaz: guarda en
el navegador y **no ejecuta ningún agente**.

## Qué hace

- **Conversar y revisar, separados.** Un trabajo abre en su conversación, a ancho completo. «Revisar» trae los documentos al lado. Las dos vistas son los mismos paneles montados, así que un borrador a medio escribir sobrevive al cambio.
- **Conversaciones por rol.** Cada trabajo tiene un equipo: el Asistente neutral más roles opcionales (Estrategia, Investigación, Análisis, Paid Media, Revisión). Cada miembro es una conversación propia con su runtime y su cuenta.
- **Instrucciones de marketing por defecto.** Toda conversación, incluida la neutral, recibe el comportamiento de marketing del pack `marketing-core`: objetivo, audiencia, oferta, etapa del recorrido, baseline y restricciones antes de recomendar; hecho contra hipótesis; marca aprobada contra propuesta; experimentos con guardrail y cadencia de revisión.
- **Memoria de marca entre trabajos.** Una entrega nueva hereda automáticamente el contexto de marca, las decisiones aprobadas y copias locales acotadas de documentos Markdown relevantes de entregas anteriores. Cada dato conserva su trabajo de origen; no se mezcla otra marca ni se confunde ese conocimiento con el delta actual.
- **Varios entregables por trabajo.** Encargo, estrategia, calendario, investigación y piezas, cada uno con su archivo Markdown, sus versiones y su exportación.
- **La lista al costado, el documento a pantalla completa.** Buscar, filtrar y la cola de revisión viven en una columna angosta; el documento se queda con el alto entero. Arriba: Resumen, Trabajo, Evidencia, Documentos, Embudo, Decisiones y Resultados.
- **Etapas del recorrido.** Cada documento puede estar en varias etapas a la vez —descubrimiento, consideración, conversión, retención— o en ninguna. La clasificación es virtual: no mueve ni renombra un solo archivo. Una etapa vacía se muestra como hallazgo y propone acciones —analizar, preparar, asociar, experimentar o marcar fuera de alcance—, porque es la parte del recorrido que nadie está atendiendo.
- **El agente propone la etapa, vos la aplicás.** Un agente no puede llamar a Latte, solo escribir archivos. Así que propone con un bloque `funnel: conversion, retention` al principio del markdown. Latte lo saca del archivo apenas lo ve —no llega al editor, ni a una versión, ni a una exportación— y lo deja pendiente hasta que aprietes Aplicar o Descartar.
- **Ves toda la carpeta, no solo lo que Latte sigue.** Los `.docx`, los PDF y las subcarpetas del cliente aparecen listados. Tu agente los lee; pedirte que confíes en una carpeta que no podés inspeccionar sería otra cosa.
- **Entregables para personas, en `entregables/`.** Lo que recibe el cliente —PDF, DOCX, XLSX, presentaciones, imágenes, HTML— lo deja tu agente en esa carpeta del trabajo y Latte lo lista con formato, tamaño y fecha, con tres acciones explícitas: abrir, mostrar en la carpeta y guardar una copia. Latte no los versiona, no los edita y no convierte un formato en otro: renombrar un Markdown a `.pdf` no es una conversión. El HTML pregunta antes de abrirse, afuera de Latte, porque puede ejecutar scripts.
- **Cola de revisión.** Todo lo que pide atención junto: por estado, o porque cambió el documento que toma como base. Marcar la base revisada no aprueba el documento.
- **Perfiles de agente con archivos.** Cada perfil propio vive en `agents/<id>/` con `profile.json`, `SOUL.md` y `SKILL.md`. Se crean, se duplican y se editan desde Ajustes. Los incluidos son de solo lectura y clonables; un perfil roto se muestra como diagnóstico sin tumbar el resto del catálogo.
- **Skills que vienen puestas.** Un rol es quién hace el trabajo; una skill es el oficio que comparten todos. La primera, «Escritura sin relleno», corta muletillas, frases vacías y cierres de efecto, y pide concreto. Viene activada y se apaga desde Ajustes.
- **Conversación nueva sin miembro nuevo.** Empezar de cero con un rol ya no obliga a sumar un segundo miembro con el mismo rol: se descarta la conversación y el rol se queda en el equipo.
- **Guardado con verificación.** Un guardado hecho desde Latte se rechaza si el archivo cambió por fuera desde la última vez que Latte lo leyó, y se conservan las dos variantes.
- **Permisos por trabajo, en tres niveles.** *Piden permiso por cada cosa* (por defecto), *Escriben en esta carpeta sin preguntar* —acotado a esa carpeta; comandos, web y MCP siguen preguntando— y *Automático*, donde Latte responde por vos a cada pedido. El automático contesta **una vez por pedido, nunca «siempre»**: ningún runtime se queda con permisos guardados, y apagarlo vuelve a preguntar en el pedido siguiente. La advertencia que muestra antes de activarlo es literal: con Claude Code no hay sandbox.
- **El archivo que dejó el agente no se duplica.** Cuando un agente escribe un archivo en la carpeta, Latte lo ve al terminar el turno y ofrece agregarlo, en vez de que guardes la respuesta del chat y termines con dos copias de lo mismo.
- **Tres runtimes.** Claude Code y Codex con tu suscripción (login por navegador desde Ajustes), y proveedores por API key a través de OpenCode.

### Límites que conviene conocer

- Latte 1.0.0 es la primera versión estable del producto. El empaquetado de plataformas sigue su propio ciclo: Windows x64 está soportado, Linux x64 sigue en empaquetado *alpha* y macOS no está soportado. La base se copia antes de cada migración, y una base escrita por una versión más nueva no se abre en una vieja.
- **Plataformas de la alpha.** Windows x64 está soportado. El empaquetado para Linux x64 está en alpha: fue verificado en Linux Mint 22.3 con X11; Wayland y otras distribuciones no fueron verificadas. macOS no está soportado ni prometido; arm64 todavía no está verificado.
- El instalador **no está firmado**, así que SmartScreen advierte hasta que el binario acumule reputación.
- **No todo lo que hace un agente está aislado.** Latte le da al agente la carpeta del trabajo como contexto y las instrucciones lo dicen, pero un runtime puede escribir cualquier archivo al que tenga permiso. Las instrucciones no son un sandbox. Los permisos reales los aplica cada runtime, y Latte te muestra sus pedidos para que decidas.
- Un guardado hecho **fuera** de Latte no se intercepta: reemplaza el archivo y Latte lo detecta después.
- El comportamiento de los modelos frente a las instrucciones de marketing está **medido una sola vez**, no evaluado a fondo: un A/B de la skill de escritura contra Claude Code 2.1.263, mismo brief y mismo modelo, cambiando solo si la skill está en el `CLAUDE.md`. Hay fixtures en `docs/marketing-eval/` para hacerlo en serio.
- Las skills y los perfiles se aplican **al iniciar o reanudar** una conversación, nunca a una que ya está abierta.
- Sin publicación en redes, sin scheduling, sin integraciones y sin colaboración entre personas.

---

# English

# Latte · An Agent Marketing Platform

Latte is a local-first desktop workspace for marketers who direct AI agents.
Brands, works, several tracked Markdown deliverables per work, immutable
snapshots, a decision log, brand memory shared across works, optional Engram-backed persistent memory, and real agent sessions, all on
your machine.

> **Windows x64 is supported. Linux x64 packaging is alpha.** It has been
> verified on Linux Mint 22.3 with X11; Wayland and other distributions are not yet verified.
> Latte does not include an agent or an AI account; you bring your own, and your
> provider bills inference. macOS is not supported or promised for this alpha.

## Install

On Windows x64, download and run
**[Latte-Setup.exe](https://github.com/ohmylatte/latte/releases/latest/download/Latte-Setup.exe)**.
It is not signed yet, so Windows SmartScreen may require **More info → Run
anyway**.

On Linux x64, download the AppImage or `.deb` from the
[latest release](https://github.com/ohmylatte/latte/releases/latest). Most
systems run the AppImage without extra setup; only if it reports a FUSE error,
follow [`docs/RUN-linux.md`](docs/RUN-linux.md). The `.deb` does not require
FUSE.

The Windows installer and AppImage notify you about new versions, download only
after you accept, and restart only when you choose. The `.deb` does not
self-update; download and reinstall it from each release.

- **Chat (default):** a native Latte chat on top of whichever runtime you picked as primary — Claude Code and Codex with your own subscription, or any API-key provider through [OpenCode](https://opencode.ai). One conversation per team member, inside that work's folder, streaming messages, tool calls, permission requests and questions into the UI. No fake replies: when a runtime, a provider or a balance is missing you see the real reason.
- **Terminal (advanced):** a real PTY running your CLI (`claude`, `codex`, `opencode`) inside the work folder, with Latte-managed `CLAUDE.md` / `AGENTS.md` context files. Global tool configuration is never touched.
- **Open source, no proprietary agent runtime.** Electron 44 · React 19 · TypeScript · Vite 7 · SQLite (Node builtin) · node-pty · xterm.

## Run it

```bash
npm ci               # one lockfile; node-pty ships an N-API prebuild, no rebuild
npm run dev          # Vite dev server in-process + Electron (main runs from TypeScript through tsx)
```

Optional, renderer only:

```bash
npm run build        # compiles the RENDERER to dist/ (Vite). The main process still runs TypeScript through tsx
npm start            # opens Latte against dist/, no dev server. Refuses with instructions if dist/ is missing
```

`build` and `start` are the source-checkout path; release packages use
`build:desktop` and electron-builder. `pack:win` creates the Windows installer,
and `pack:linux` creates the x64 AppImage and `.deb`.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Compiles the renderer to `dist/` (renderer only; validated by the current CI workflow) |
| `npm start` | Runs Latte against `dist/`; refuses with instructions when it is missing |
| `npm run dev:web` | Vite only (browser preview with a localStorage backend, agents disabled) |
| `npm run dev:electron` | Electron only, expects Vite on `http://127.0.0.1:5173` |
| `npm run pack:win` | Builds the packaged main process and Windows x64 installer |
| `npm run pack:linux` | Builds the packaged main process, Linux x64 AppImage and `.deb` |
| `npm test` | Vitest: backend + frontend unit tests |
| `npm run typecheck` / `typecheck:web` / `typecheck:all` | `tsc --noEmit` for `electron/**` and `src/**` |
| `npm run probe:electron` | Prints what the Electron runtime supports (`node:sqlite`, node-pty, sql.js) |
| `npm run smoke:desktop` | Runs the real app for 15 s, reports renderer console errors, exits |
| `npm run smoke:opencode` | Bounded live check of the chat path against the installed OpenCode (one tiny prompt; `LATTE_SMOKE_NO_INFERENCE=1` for protocol only) |

In development, `electron/main.cjs` registers `tsx/cjs` and requires
`electron/main.ts`. Release packaging instead bundles the main process with
esbuild into `dist-electron/main.cjs`. The preload is plain CommonJS
(`electron/preload.cjs`). The renderer is served by Vite in dev and read from
`dist/` after `npm run build`.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `LATTE_DATA_DIR` | Data directory override (default `%APPDATA%/Latte/data` on Windows, Electron `userData/data` elsewhere) |
| `VITE_DEV_SERVER_URL` | Renderer URL for `dev:electron` |
| `LATTE_SMOKE_EXIT_MS` | Run the app for N ms, print renderer errors, exit 0/1 |

## Layout

```
electron/                 main process (TypeScript, run through tsx)
  main.cjs / main.ts      bootstrap, window, CSP, permissions, IPC wiring
  preload.cjs             contextBridge: exactly the LatteAPI surface
  bootstrap.ts            createBackend(): wires storage, files, runtimes, chat, memory
  core/                   ids, safe paths, atomic files, optional require
  storage/                SqlDriver adapter: node:sqlite primary, sql.js WASM fallback; repository + schema
  workspace/              work folders, brief.md, snapshots, generated instruction files, packs
  runtime/                CLI detection (allowlist), PTY sessions (node-pty, optional), env hygiene
  opencode/               structured chat: server process, HTTP+SSE client, event translation, ChatManager
  memory/                 Engram CLI adapter (bounded timeouts, graceful unavailable)
  services/               LatteService (validation + orchestration), demo seed
  ipc/                    channel list, arity checks, trusted-sender check, error envelopes
shared/contracts.ts       the API contract between renderer and main
src/                      React UI (ivory / espresso / terracotta), browser preview fallback
packs/marketing-core/     discipline pack prepended to every generated instruction file
tests/backend/            Vitest: persistence, validation, isolation, terminal, detection, IPC, chat protocol
scripts/                  dev.mjs, probe-electron.cjs, smoke-opencode.ts
```

## Data model

Everything lives under the data directory:

```
latte.db                                  SQLite: brands, works, revisions, decisions, chat_sessions, meta
brands/<brandId>/works/<workId>/
  brief.md                                the editable deliverable (single authority, see below)
  CLAUDE.md, AGENTS.md                    managed context: pack + brand context + brief + decisions
  README.md                               explains the folder to humans and agents
  entregables/                            human-facing output written by the agent (see below)
  .latte/snapshots/<timestamp>-<rev>.md   immutable snapshots (read-only files + DB triggers)
```

- **`Work.brief` is the deliverable.** The UI edits it, agents edit `brief.md`
  in the work folder. The file is the source of truth: `listWorks`,
  `snapshot`, `exportWork` and `startAgent`/`startChat` sync the database copy
  from disk, so agent edits appear on refresh. An intentionally blank brief
  exports blank.
- **Snapshots are immutable** twice: SQLite triggers reject `UPDATE`/`DELETE`
  on `revisions`, and the snapshot files are written once and marked read-only.
- **Instruction files are regenerated only when a new session starts**
  (`startAgent` / `startChat`) and when a work is created. Editing the brand
  context or adding a decision never rewrites files a running agent is reading.
  A user-owned `AGENTS.md` (without the `<!-- latte:managed -->` marker) is left alone.
- Ids are app-generated (`brd_…`, `wrk_…`, `rev_…`, `dec_…`, `ses_…`) and are
  the only path segments ever used on disk; `safeJoin` rejects anything else.

### Storage strategy

`node:sqlite` (Node 22.13+/24, shipped by Electron 44) is the primary engine: a
real file database, durable per statement, zero dependencies. If the builtin is
missing in a given runtime, the same schema runs on `sql.js` (WebAssembly) with
atomic write-back of the whole file. Both engines are tested against the same
repository suite and can open each other's files. Nothing native has to be
compiled. `npm run probe:electron` tells you which one your Electron will use.

## Agents

### Structured chat (OpenCode)

1. `chatStatus()` finds `opencode` on PATH and lazily starts
   `opencode serve --pure --port 0 --hostname 127.0.0.1` (real binary, not the
   npm cmd shim, so it can be stopped cleanly) with `OPENCODE_SERVER_USERNAME` /
   `OPENCODE_SERVER_PASSWORD` set to random values in the child environment.
   Credentials never appear on the command line or in logs.
2. `startChat(workId, model?)` regenerates `AGENTS.md`, creates (or resumes) an
   OpenCode session scoped to the work directory (`?directory=`), and persists
   the session id so the conversation survives app restarts.
3. One `GET /global/event` SSE subscription feeds every chat. Events are
   translated into `ChatEvent`s: message/part upserts, text deltas, status,
   permission and question requests, provider errors.
4. Permissions are answered with `once` / `always` / `reject`; questions with
   selected labels or a custom answer, or rejected.

The model picker lists what OpenCode reports as configured
(`/config/providers`). Latte never adds providers, keys or subscriptions.

### Primary agent and subscription runtimes

A new chat never asks which model to use. The **Proveedores de IA** screen
marks one agent as primary: a Claude Code account (your own subscription,
via `claude auth login`), a Codex account (ChatGPT login started from the
screen and finished in the browser) or one OpenCode provider/model. Claude
Code and Codex run as headless processes speaking their native protocols
(stream-json and app-server JSON-RPC); managed accounts are profile folders
under the data directory passed as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, exactly
the way Orca does it, and Latte never reads their credentials.

### Documents of a work

A work holds several tracked Markdown deliverables, not one file. `brief.md`
is the default one (the ask); a strategy, a calendar, research or copy pieces
each live in their own file next to it, with their own title, status, versions
and export. Latte generates every file name; user text never reaches a path.

**Saving never overwrites blindly.** Reading a document hands out a content
fingerprint (sha1 of the text). A save presents the fingerprint it started
from; if the file on disk moved to something Latte has not seen, the save is
refused as a conflict, the disk version is stored as an immutable revision with
source `external` (an outside write does not identify its author), and the UI
asks which variant stays. The other one is always kept as a version. External
changes are noticed by polling that fingerprint for the open document, which
survives atomic write-and-rename, unlike an inode watcher. This protects
against blind overwriting; it is not mutual exclusion between processes, and
instructions to an agent are not filesystem isolation.

A derived document (a calendar built on a strategy) pins the exact base
revision it used. When that base changes, the derived document says it needs a
look; nothing is regenerated and nothing is declared wrong.

### Deliverables for people (`entregables/`)

Markdown is how the work is thought and reviewed; it is not what a client
receives. The instruction file tells every agent to leave human-facing output —
PDF, DOCX, XLSX, decks, images, self-contained HTML — in `./entregables/`
inside the work folder, and to produce real formats only with tools it actually
has: renaming a Markdown file to `.pdf` is not a conversion, and saying so is
part of the pack.

Latte treats that folder as a **catalog, not a database**. It lists the files
with their format, size and date, and offers three explicit actions: open with
the system application, show in the file manager, and save a copy elsewhere.
It does not version them, does not edit them, does not convert them and never
claims a binary was reviewed.

The safety rules are the boring kind, and they are tested:

- Names are validated before touching the disk (no separators, no traversal, no
  hidden files, no Windows reserved names, no trailing space or dot) and only a
  closed list of deliverable extensions is served.
- The folder must be a real directory and each file a real file: symlinks,
  junctions and hard links are refused, `realpath` is compared, and a work that
  points at a linked client folder is treated exactly the same.
- **HTML asks first.** It opens in the external application, never inside a
  Latte window, and only after a native confirmation that says why.
- A copy never replaces: it must keep the original extension and is written
  with exclusive creation, so an existing file at the destination is an error
  with a name, not a silent overwrite.

### Team: roles with their own conversation

The agent panel is the work's **team** (the "Equipo de trabajo" of the
reference mockup). A member is a role opened inside the work: it has its own
conversation, runtime and account, and a live status (working, idle, needs
you, paused, finished). Roles ship with the discipline pack
(`packs/marketing-core/roles/*.md`: Strategist, Researcher, Analyst,
Paid Media, Reviewer) plus the neutral Asistente; each one is a small front matter (name,
initial, summary) followed by the instructions. Adding a member uses the
primary agent unless you pick another logged-in account or OpenCode.

The role personality is appended to the runtime's own system prompt for that
member only, so the shared `CLAUDE.md` / `AGENTS.md` context stays identical
for the whole team: Claude Code gets `--append-system-prompt-file` (a file
under the data directory, never the command line), Codex gets
`developerInstructions` on `thread/start` / `thread/resume`, OpenCode gets
the `system` field of each prompt. The Asistente sends nothing extra. A
member's id is its chat id, so pausing and resuming keep the same identity;
members are persisted in `team_members` (schema v3) and older
`chat_sessions` rows migrate into Asistente members.

### Journey stages, and what an agent may propose

A document can sit in several journey stages at once (`discovery`,
`consideration`, `conversion`, `retention`) or in none. The stages are
virtual: `funnel_stages` is an additive column, and no file is moved or
renamed. The instruction file lists each deliverable's stages plus a coverage
block, so an empty stage is visible as the finding it is rather than buried in
a list.

An agent cannot register or classify a document itself — that barrier is
deliberate. What it can do is **propose**: it opens a Markdown file with a
front matter block (`---` / `funnel: conversion, retention` / `---`). Latte
reads it, takes the block out of the file before the first fingerprint, and
keeps the stages as a pending proposal until a human applies or dismisses it.
The block never reaches the editor, a stored revision or an export: it was a
message to Latte, not part of the deliverable. Anything unrecognised — a
client file that merely opens with a rule, or a stage name Latte does not know
— leaves the file byte-identical.

### Agent profiles

A profile is a role you own: `agents/<id>/profile.json`, `SOUL.md` (what it is
responsible for) and `SKILL.md` (how it works). Saving writes the three files
atomically behind a `.writing` marker and a directory lock, rolls back ordinary
I/O failures, refuses to follow symlinks or Windows reserved names, and rejects
a save when the files changed on disk since you opened them. Shipped profiles
are read-only and clonable. One manually broken folder shows up as a
non-editable diagnostic card instead of taking the whole catalog down.

### Shipped skills

A role is who does the job; a skill is the craft everyone shares, in every
work. Skills live in `packs/marketing-core/skills/*.md` with the same front
matter shape as roles, are declared in the manifest, and render into each
work's `CLAUDE.md` / `AGENTS.md` under a `<!-- latte:skill <id> -->` marker.

They ride the instruction file, written once per conversation — **not** the
base prompt, which is charged on every message and stays under a 6 000-character
budget enforced by a test.

The first one, "Escritura sin relleno", is adapted from
[no-ai-slop](https://github.com/petergyang/no-ai-slop) by Peter Yang (MIT).
Half of the original is an editing service (paste a draft, get a "What changed"
report); Latte's agents write deliverables rather than correct pasted drafts, so
only the writing rules were kept and rewritten in Spanish, with attribution in
the file. Skills ship **on**: quality that each person has to discover and
switch on is quality almost nobody gets, so the switch exists to turn one off.

The shipped **Sales Copywriter** profile is adapted from
[sales-copywriter](https://github.com/treblahq/amplifiers/tree/main/skills/sales-copywriter)
by Trebla (MIT). The procedural skill became a bounded Latte role that writes
in the selected content language and adds evidence, authorization, UTF-8 and
production-readiness gates.

### Providers (no terminal required)

The **Proveedores de IA** screen (sidebar, or the gear icon in the agent
panel) manages the runtime's credential store through its protocol:
`GET /provider` and `GET /provider/auth` for the catalog and login methods,
`PUT /auth/{provider}` for API keys, `POST /provider/{id}/oauth/authorize`
and `.../oauth/callback` for browser logins (ChatGPT Pro/Plus, SuperGrok,
GitHub Copilot in the installed version), `DELETE /auth/{provider}` to
disconnect. Latte opens the OAuth URL in the system browser and passes keys
and codes straight to OpenCode over loopback; nothing is persisted by Latte.
Anthropic is API-key only in this OpenCode version (no subscription OAuth is
exposed); using a Claude subscription means the Claude Code CLI path.

### Terminal (CLI)

Allowlisted executables only (`claude`, `codex`, `opencode`), resolved to
absolute paths with `where`/`which`, spawned with an argument array (never a
shell string) inside the work folder. Child environments are scrubbed of
`ORCA_*`, `CLAUDECODE` and `CLAUDE_CODE_*` so agents never bind to whatever
launched Latte, and `ENGRAM_PROJECT` is set per brand. node-pty is an optional
dependency loaded at runtime: if it cannot load, the UI shows the reason and
nothing pretends to be a terminal.

### Memory (Engram)

`readMemory` runs `engram context latte-<brandId>`, `saveMemory` runs
`engram save <title> <text> --project latte-<brandId>`. Both use `execFile`
with an 8 s timeout and return `{ available: false, text: reason }` when the
CLI is missing, slow or failing. One Engram project per brand, keyed by the
immutable brand id.

## Security posture (renderer)

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The
preload exposes exactly the `LatteAPI` methods over fixed `latte:*` channels;
there is no generic `invoke`. Handlers check the sender, the argument count and
every argument's shape, and return an envelope (`{ok, value}` / `{ok, code,
message}`) so internal errors never leak stack traces or paths. Navigation and
`window.open` are blocked (external http(s) links open in the system browser),
webviews are refused, all permission requests are denied except
`clipboard-sanitized-write`, and a CSP is injected (strict for `file://`,
relaxed only for the Vite dev origin).

## Verification (this checkout)

| Check | Result |
| --- | --- |
| `npm run typecheck:all` | clean |
| `npm test` | Runs the current backend and frontend unit test suite; use this command for the current result rather than a fixed test count |
| `npx vitest run --config docs/qa-vitest.config.ts` (integration QA harness) | 9/9 pass |
| `node_modules/electron/dist/electron.exe docs/qa-desktop.cjs` (real sandboxed preload + IPC) | exit 0: bridge, snapshot, export, decisions, invalid ids rejected, no renderer errors |
| `node docs/qa-stale-save.cjs` | `agentChangesRetained: true` — the reproduced data loss is fixed |
| `node_modules/electron/dist/electron.exe scripts/visual-settings.cjs` | exit 0: Settings has no document controls, the unsaved draft survives the round trip, disk untouched |
| `node_modules/electron/dist/electron.exe scripts/visual-documents.cjs` | exit 0: external change noticed, explicit conflict, both variants kept, base-changed notice |
| `node_modules/electron/dist/electron.exe scripts/qa-marketing-workspace.cjs` (its own Vite server, sandboxed preload, synthetic data, no inference) | exit 0, 10/10 steps, 0 console errors: funnel classified and narrowing, draft preserved across selection, review queue, proposal adopted and applied, folder contents listed without Latte's own files, shipped skill listed and switchable, file-backed profile created and cloned |
| `node_modules/electron/dist/electron.exe scripts/visual-team.cjs` (team roster through the real preload; opens members on OpenCode without sending messages) | exit 0: Strategist and Researcher opened, statuses Activo / En pausa, resume card, no renderer errors |
| `npm run probe:electron` | Electron 44.2.0 · Node 24.20.0 · `node:sqlite` (SQLite 3.53.4) OK · node-pty loads · sql.js loads |
| `npm run smoke:desktop` | renderer loaded, 0 console errors, demo seeded, node-pty ready, OpenCode runtime started and stopped with no orphan process |
| `npm run smoke:opencode` | installed OpenCode 1.18.26: server up in ~2 s, health OK, 152 configured models, session created, prompt sent, events streamed. The reply itself failed with the provider's `Insufficient balance` error on the default model, which the UI surfaces verbatim; pick another configured model or top up the account |

## Known limitations

- Windows x64 is supported. Linux x64 packaging is alpha: it has been verified on Linux Mint 22.3 with X11; Wayland and other distributions are not yet verified. macOS is not supported or promised, and arm64 is not verified yet.
- The chat shows text, reasoning and tool calls; file attachments, subtasks
  and OpenCode's revert/fork features are not exposed.
- Chat history lives in OpenCode's storage; Latte only keeps the session id.
  Deleting OpenCode data means the next start creates a fresh session.
- Windows and AppImage builds can update through the in-app updater after the
  user accepts the download; `.deb` installs must be replaced manually from a
  release.
- Demo brand "Casa Oliva (demo)" is seeded once on an empty database; it is
  fictional and clearly labelled.
