# Correr Latte en Linux

## Requisitos

### AppImage o `.deb` publicados

- El empaquetado para Linux x64 está en alpha y fue verificado en Linux Mint
  22.3 con X11. Wayland y otras distribuciones todavía no fueron verificados.
- Al menos un CLI de agente en PATH: `claude`, `codex` u `opencode`
  (Latte antepone `~/.local/bin` y `/usr/local/bin` a PATH al arrancar;
  si tu CLI vive en otro lado, exportalo antes de abrir Latte).

Los paquetes ya traen el runtime de la aplicación: **no necesitás Node.js ni
npm** para instalar o ejecutar Latte. El `.deb` no requiere FUSE. El AppImage
suele abrir sin instalar paquetes adicionales; no instales FUSE
preventivamente.

## Instalar los paquetes publicados

Descargá uno de los archivos de la release y ejecutá estos comandos desde la
carpeta donde lo guardaste. En `<version>`, reemplazá el marcador por la versión
del archivo descargado (por ejemplo, `0.2.0`). Los nombres usan arquitecturas
distintas: `x86_64` para el AppImage y `amd64` para el `.deb`.

Para el AppImage:

```bash
chmod +x ./Latte-<version>-linux-x86_64.AppImage
./Latte-<version>-linux-x86_64.AppImage
```

Para el `.deb`:

```bash
sudo apt install ./Latte-<version>-linux-amd64.deb
```

Después de instalar el `.deb`, abrí Latte desde el menú de aplicaciones o con:

```bash
/opt/Latte/latte
```

### Desde el código fuente

- Linux x64.
- Node 24+ (CI usa 24; probado localmente con `v26.7.0`).
- `npm ci` para instalar las dependencias (baja el binario de Electron; si
  falla el postinstall de node-pty, ver la fila `npm ci` del baseline).
- Al menos uno de los mismos CLI de agente en PATH.

## Correr

`npm run dev` (desarrollo) · `npm run build && npm start` (renderer compilado).
`npm run pack:linux` → `release/` (AppImage + deb).

### Si el AppImage muestra un error de FUSE

FUSE es solo una solución de diagnóstico para ese error, no un requisito
general de Latte ni del `.deb`. En Ubuntu 24.04 y Linux Mint 22, instalá el
paquete compatible:

```bash
sudo apt install libfuse2t64
```

El nombre puede variar en otras distribuciones y versiones; usá el paquete
FUSE 2 de tu sistema.

## Baseline 2026-09-10

Worktree: `~/src/latte-wt-T0`, rama `feat/linux-T0-baseline`, base `6a000d6`.
Máquina: Linux Mint 22.3. Node local sin cambios.

| comando | exit code | resultado |
|---|---|---|
| `node --version` | 0 | `v26.7.0` |
| `npm --version` | 0 | `11.19.0` |
| `npm ci` | 0 | `added 488 packages, audited 489, found 0 vulnerabilities` (11s; avisos: boolean@3.2.0 deprecated; install-scripts pendientes: electron-winstaller, esbuild, node-pty) |
| `npm run probe:electron` | 0 | `OK electron: 44.2.0`, `OK node: 24.20.0`, `OK node:sqlite: 3.53.4`, `OK node-pty: loaded`, `OK sql.js: loaded`, `OK tsx/cjs: resolvable` |
| `npm run typecheck:all` | 0 | `tsc electron + web + web-tests`, sin errores |
| `npm test` | 1 | `6 failed / 31 passed files; 9 failed / 290 passed tests`. Fallos: agents (2, list/installed + login), chat (1, shim Windows), codex (1, binario Windows), detect (1, .exe Windows), mcp (3, CLI runtime), service (1, Engram CLI ausente en PATH). Resto verde. |
| `which opencode` | 0 | `/home/pablo/.local/bin/opencode` |
| `opencode --version` | 0 | `1.18.30` |
| `LATTE_SMOKE_EXIT_MS=15000 npm run smoke:desktop` | 0 | `renderer loaded=true consoleErrors=0`; seed demo brand; opencode server en 4096; avisos GPU no fatales (MESA Haswell Vulkan, libva iHD) |
| `LATTE_SMOKE_NO_INFERENCE=1 npx tsx scripts/smoke-opencode.ts` | 0 | `protocol-only: session created, no prompt sent` (chatId `ses_9cf97d8e45b53d797b25`, defaultModel `opencode-go/gpt-5.6-luna`) |
| `npm run dev` (ventana, kill = Ctrl+C) | 143 (SIGTERM, cierre manual) | ventana abrió (log main+renderer+gpu, cerrada con kill). Sin fallo sandbox → no se añaden flags. Solo avisos GPU no fatales (MESA-INTEL Haswell Vulkan incomplete; `libva iHD_drv_video.so init failed`). |

Salidas completas verificadas en la corrida local (no se versionan logs).

## Artefactos 2026-09-10 (T6)

`npm run pack:linux` en Linux Mint 22.3 produjo en `release/`:

- `Latte-0.2.0-linux-x86_64.AppImage` (ejecutado OK: ventana abre, backend
  sqlite + pty listos, updater responde 404 elegante sin release publicada)
- `Latte-0.2.0-linux-amd64.deb` (construido; NO instalado ni probado)
- `latest-linux.yml` v0.2.0 (electron-updater; apunta al AppImage)

Ojo con los sufijos de arquitectura: AppImage usa `x86_64`, deb usa `amd64`.

## Actualizaciones

- AppImage: electron-updater avisa cuando hay una versión nueva, la descarga
  cuando la aceptás y reinicia para instalarla cuando vos lo decidís.
- `.deb`: no usa electron-updater; descargá e instalá el paquete nuevo desde
  cada release.

## Limitaciones conocidas

- El empaquetado para Linux x64 solo fue verificado en Linux Mint 22.3 con X11;
  Wayland, otras distribuciones y arm64 todavía no fueron verificados.
- Lanzado desde terminal hereda tu PATH completo; desde el menú usa el PATH
  extendido (`~/.local/bin`, `/usr/local/bin`).
- Polish pendiente: `desktopName` / `StartupWMClass` (`app.setName('Latte')`
  vs `StartupWMClass: latte` en `electron-builder.yml`); el icono del dock
  puede no agruparse hasta alinearlos.
