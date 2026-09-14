# Publicar Latte

> La versión de trabajo actual es **0.2.0**. Windows 0.1.0 sigue siendo la
> última versión cuya instalación fue comprobada; macOS todavía depende de su
> primera ejecución real en CI y no debe presentarse como verificado.

Cómo se arma el instalador de Windows, cómo se publica y cómo llega la
actualización a quien ya tiene Latte instalado.

> **Estado: 0.1.0 publicada. El instalador se descarga desde el enlace público
> y el actualizador lo encuentra.**
> `npm run pack:win` produce `release/Latte-Setup.exe` y `release/latest.yml`,
> la aplicación empaquetada abre con base de datos, packs y terminal
> funcionando, y la release normal en GitHub sirve el archivo por
> `/releases/latest/download/`. Lo que **no** está verificado: instalar con ese
> `.exe` (accesos directos, desinstalador, datos que sobreviven), una
> actualización real entre dos versiones publicadas, y la firma de código.
> El detalle está en la sección 10.

---

## 1. Qué se instala y qué no

El instalador trae Latte: la interfaz, el proceso principal, los packs de
instrucciones y los íconos.

**No trae los agentes.** Claude Code, Codex y OpenCode son herramientas
externas que el usuario instala y autentica por su cuenta. Latte las detecta,
no las incluye ni las actualiza.

**No toca tus datos.** Marcas, trabajos, documentos, versiones y decisiones
viven en `%APPDATA%/Latte/data`, fuera de la carpeta de instalación. Actualizar
o desinstalar Latte no los borra (`deleteAppDataOnUninstall: false`).

---

## 2. Antes de la primera vez

Las dependencias de empaquetado son nuevas. Instalalas:

```bash
npm install
```

Agrega `electron-updater` (dependencia de la aplicación), y `electron-builder`
más `esbuild` (solo de desarrollo).

---

## 3. Versionado

La versión es la de `package.json`. El actualizador compara esa versión con la
publicada: si no la subís, nadie recibe nada.

```
0.1.0  ->  0.2.0   cambios visibles en la alpha
0.2.0  ->  0.2.1   correcciones
```

Subí la versión, commiteá, y recién después construí. El instalador, la release
y `latest.yml` tienen que hablar de la misma versión.

### Schema 8 (marca, generación, learning)

La próxima versión que publique este código migra la base de **7 a 8** al
arrancar. `prepareForMigration` copia el archivo a
`<dataDir>/backups/latte-v7-<timestamp>.db` (y el WAL si existe) **antes** de
aplicar las tablas nuevas. El esquema es aditivo: no se reescriben filas de
`brands`/`works`.

Un instalador **0.3.x** que todavía habla schema 7 **no abre** una base ya
migrada a 8 (`isNewerSchema`). Quien actualice y después intente volver atrás
tiene que restaurar el backup `latte-v7-*`, no el `latte.db` nuevo.

Las features (`feature:generation`, `feature:brand-kits`, `feature:learning`)
siguen apagadas por defecto. La migración corre igual, con o sin flags: no
queremos instalaciones con esquemas distintos.

---

## 4. Construir

### En CI, que es de donde debería salir

`.github/workflows/release-windows.yml` compila en un runner limpio de Windows.
Se dispara solo al pushear un tag `v*`, y a mano desde la pestaña Actions
(«Run workflow») cuando solo querés el instalador para probar.

Hace lo mismo que el camino local, más lo que una máquina de trabajo no
garantiza: que el tag y `package.json` digan la misma versión, que los tests y
los typechecks pasen antes de empaquetar, y que `latest.yml` declare la versión
que corresponde. Con un tag deja la release **en borrador** con los dos
archivos adjuntos; nunca la publica.

Existe por un susto concreto: el `Latte-Setup.exe` que había en el disco tenía
dos días y le faltaban cuatro cambios ya mergeados. Un build que sale de un
clon limpio del tag no puede tener esa clase de sorpresa. Y es el requisito de
entrada para firmar gratis con SignPath Foundation, que firma artefactos
salidos de un CI público y no de un disco ajeno.

### A mano, en tu máquina

```bash
npm run pack:win
```

Hace tres cosas:

1. `vite build` compila la interfaz en `dist/`.
2. `scripts/build-electron.mjs` empaqueta el proceso principal con esbuild en
   `dist-electron/main.cjs` y copia el preload al lado.
3. `electron-builder --win --publish never` arma el instalador en `release/`.

El paso 2 existe por una razón concreta: en desarrollo `electron/main.cjs`
registra `tsx` y ejecuta TypeScript directo, y `tsx` es una dependencia de
desarrollo. Un instalador que dependiera de ella no arrancaría. La aplicación
empaquetada apunta a `dist-electron/main.cjs` mediante `extraMetadata.main`, así
que el modo desarrollo sigue igual que siempre.

Salida esperada en `release/`:

| Archivo | Para qué |
| --- | --- |
| `Latte-Setup.exe` | El instalador. Es el archivo público. |
| `latest.yml` | Metadatos del actualizador: versión, nombre y sha512. |

### Por qué `npmRebuild: false`

electron-builder recompila las dependencias nativas por defecto, y ahí el build
se cae:

```
"GetCommitHash.bat" no se reconoce como un comando…
gyp: Call to 'cmd /c "cd shared && GetCommitHash.bat"' returned exit status 1
```

`node-pty` es la única dependencia nativa y **ya trae binarios N-API
precompilados** en `prebuilds/win32-x64/`, que cargan igual en Node y en
Electron sin recompilar. Su propio loader (`lib/utils.js`) busca
`build/Release`, después `build/Debug`, y recién ahí `prebuilds/<plataforma>-<arch>`.
Recompilarlo desde el código fuente no solo es innecesario: es imposible, porque
el submódulo `winpty` dentro del tarball de npm viene sin metadatos de git.

`sql.js` es WebAssembly y nunca necesitó rebuild.

Verificado en la aplicación empaquetada: `[latte] terminal backend: node-pty ready`.

### Verificado en la primera corrida

- `Latte-Setup.exe` sale con ese nombre exacto. electron-builder acepta un
  `artifactName` fijo sin `${version}`.
- `latest.yml` apunta a `Latte-Setup.exe` con su sha512.
- El `package.json` empaquetado tiene `main: dist-electron/main.cjs`.
- Dentro del `.asar` viajan `dist`, `dist-electron`, `assets`, `packs` y
  `node_modules` de producción — incluido `electron-updater`. **Cero
  devDependencies**: ni `tsx`, ni `vite`, ni `electron`, ni `esbuild`.
- `node-pty` y `sql.js` quedan en `app.asar.unpacked`.
- La app empaquetada arranca: `node:sqlite`, siembra la marca demo (o sea que
  leyó el pack desde el `.asar`), y la terminal está lista.
- El actualizador consulta GitHub de verdad y falla con honestidad mientras no
  haya releases: `[latte:update] No published versions on GitHub`. Como no hay
  versión ofrecida, el usuario no ve ningún aviso — que es lo correcto.

---

## 5. Publicar

```bash
npm run release:win
```

Sube el instalador y `latest.yml` a GitHub Releases de `ohmylatte/latte`, como
**borrador**. Nada llega a nadie hasta que un humano lo publica desde la
interfaz de GitHub.

Necesita un token con permiso sobre el repositorio:

```bash
# PowerShell, solo en tu sesión
$env:GH_TOKEN = "..."
```

El token nunca va en el repositorio, ni en `electron-builder.yml`, ni en el
cliente. En CI va como secreto del repositorio.

### La release tiene que ser normal, no prerelease

`/releases/latest` de GitHub ignora las prereleases, y el actualizador también
las ignora salvo que se lo pida explícitamente. Una alpha marcada como
prerelease deja el botón de descarga apuntando a la versión anterior y a nadie
le llega la actualización.

**Regla: las alphas se publican como release normal.** El estado alpha se
comunica en la landing y dentro de la app, no con la casilla de GitHub.

Existe una salida de emergencia para probar: arrancar Latte con
`LATTE_UPDATE_PRERELEASE=1` hace que el actualizador acepte prereleases. Es para
probar, no para publicar.

---

## 6. El enlace público

La landing descarga directo, sin pasar por GitHub:

```
https://github.com/ohmylatte/latte/releases/latest/download/Latte-Setup.exe
```

Funciona porque el nombre del instalador es fijo en todas las versiones. Si
alguna vez cambia, cambia también la landing, y en el mismo commit.

**Antes de habilitar el botón**, comprobá que el enlace devuelve el archivo.
Mientras no exista una release publicada, ese enlace da 404: la landing debe
mostrar el botón preparado, no un enlace roto.

---

## 7. Cómo se ve la actualización desde adentro

1. Latte consulta a los 25 segundos de abrir, y después cada 6 horas.
2. Si hay algo nuevo, aparece un aviso: **Hay una nueva versión de Latte
   disponible**, con *Descargar actualización* y *Más tarde*. No descarga nada
   por su cuenta (`autoDownload = false`).
3. Durante la descarga seguís trabajando. Se ve el progreso.
4. Cuando termina: **Guardá tus documentos antes de continuar**, con *Reiniciar
   e instalar* y *Más tarde*.
5. Al confirmar aparece un diálogo nativo que dice qué se detiene: las
   conversaciones y terminales activas, con su número. Los documentos guardados,
   las versiones y las decisiones no se tocan.
6. *Cancelar* deja la aplicación funcionando igual que antes, con la
   actualización esperando.

Dos cosas que el sistema **no** hace:

- **No instala al cerrar.** `autoInstallOnAppQuit = false`: cerrar Latte por
  cualquier otro motivo nunca termina en una instalación sorpresa.
- **No instala sobre trabajo sin guardar.** Si hay un documento con cambios, el
  proceso principal rechaza la instalación y la interfaz explica por qué. No es
  una advertencia que se pueda saltear con un clic.

---

## 8. Los datos, al actualizar

Una versión nueva puede traer un esquema nuevo. Antes de la primera migración:

- Se copia `latte.db` (y su `-wal`, donde viven los últimos commits) a
  `data/backups/latte-v<esquema>-<fecha>.db`. Se conservan los 5 más recientes.
- Si la base es de una versión **más nueva** que la instalada, Latte no la
  abre: muestra un diálogo y se cierra sin tocar nada. Migrar hacia atrás es
  peor que no arrancar.

Volver a una versión anterior del ejecutable **no** revierte la base de datos.
Si una migración sale mal, la recuperación es el archivo de `data/backups/`:
cerrá Latte, copiá el backup sobre `latte.db` (y su `-wal` al lado, si existe) y
volvé a abrir.

---

## 9. Firma de código (pendiente)

Sin firmar, Windows SmartScreen muestra "Windows protegió tu PC" y esconde el
botón de instalar detrás de *Más información*. Para una descarga pública eso
cuesta usuarios reales.

Para firmar hace falta un certificado de Code Signing (OV o EV) y estas
variables en el entorno de build:

```
CSC_LINK           ruta o base64 del .pfx
CSC_KEY_PASSWORD   su contraseña
```

Nunca en el repositorio: `.gitignore` ya excluye `*.pfx`, `*.p12`, `*.pem` y
`*.key`. En CI, secretos del repositorio.

Firmar con un certificado OV o EV no garantiza evitar las advertencias de
SmartScreen: un binario nuevo puede mostrarlas hasta acumular reputación positiva.
Los certificados EV ya no otorgan un bypass inmediato. No elegir EV solamente
para evitar ese aviso. Ver [la documentación de Microsoft sobre reputación de
SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

---

## 10. Lo que falta verificar

Verificado, con la salida del build y del arranque a la vista:

- [x] `npm run pack:win` produce el instalador y `latest.yml`.
- [x] El nombre fijo `Latte-Setup.exe` es aceptado.
- [x] `electron-builder` incluye `node_modules` de producción con el `files`
      explícito, y ninguna dependencia de desarrollo.
- [x] La aplicación **empaquetada** abre: base de datos `node:sqlite`, packs,
      terminal `node-pty` lista.
- [x] El actualizador llega a GitHub y reporta el estado real.
- [x] **0.1.0 publicada** como release normal (no prerelease), con
      `Latte-Setup.exe` y `latest.yml` como assets.
- [x] **El enlace público sirve el archivo.**
      `/releases/latest/download/Latte-Setup.exe` responde 200 con los
      108.681.365 bytes exactos del build y los bytes `MZ` de un ejecutable.
- [x] **El actualizador ve la versión publicada**: `Update for version 0.1.0 is
      not available (latest version: 0.1.0)`, en vez del `No published
      versions` de antes.

### Cómo probar la app empaquetada sin cerrar tu Latte

`requestSingleInstanceLock()` es lo primero que corre en `main.ts`, y el lock
vive en el `userData` de Electron. Con una instancia abierta, el `.exe`
empaquetado se cierra solo diciendo que ya hay una ventana. Dale su propio
perfil y conviven:

```bash
LATTE_SMOKE_EXIT_MS=12000 LATTE_DATA_DIR=<datos temporales> \
  ./release/win-unpacked/Latte.exe --user-data-dir=<perfil temporal>
```

Arranca, hace su chequeo de actualización y se cierra solo. La línea que
importa es `[latte:smoke] renderer loaded=true consoleErrors=0`.

Falta, y no lo demos por hecho:

- [ ] **Instalar con `Latte-Setup.exe`.** Lo que se probó es
      `release/win-unpacked/Latte.exe`, no el instalador corriendo: accesos
      directos, desinstalador, y que los datos en `%APPDATA%/Latte` sobrevivan
      a una reinstalación. Instalar software es decisión de quien publica, no
      del build.
- [ ] **Una actualización real entre dos versiones publicadas**, de punta a
      punta: aviso, descarga, reinicio e instalación. Es lo único que prueba de
      verdad el circuito completo, y necesita dos releases en GitHub.
- [ ] **Firma de código.** Comprobado que hoy el instalador sale `NotSigned`:
      los `signing with signtool.exe` del log son intentos sin certificado.
      SmartScreen va a mostrar la advertencia.
- [ ] **Migración de esquema entre dos versiones reales.** El backup y el
      rechazo de esquema futuro tienen tests, pero nunca corrieron sobre una
      base migrada por una versión distinta de la app.
- [ ] **macOS.** El empaquetado y CI están diseñados, pero todavía deben correr
      en un runner macOS real y verificarse en Intel y Apple Silicon.
- [ ] **Linux.** Diseñado y empaquetado desde el PR #14 (AppImage + deb x64,
      `.github/workflows/release-linux.yml`, guía en `docs/RUN-linux.md`).
      Falta instalar el `.deb`, probar Wayland y una actualización real con
      `latest-linux.yml` publicado.

---

## 11. macOS (Intel y Apple Silicon)

El workflow `.github/workflows/release-macos.yml` corre en macOS y ejecuta
`npm ci`, typechecks y tests antes de empaquetar. La matriz de targets declarada
en `electron-builder.yml` produce, en **una sola invocación**, DMG y ZIP para
`x64` y `arm64`:

```text
Latte-0.2.0-mac-x64.dmg
Latte-0.2.0-mac-x64.zip
Latte-0.2.0-mac-arm64.dmg
Latte-0.2.0-mac-arm64.zip
latest-mac.yml
```

El ZIP es obligatorio para `electron-updater` en macOS. Construir ambas
arquitecturas juntas permite que electron-builder genere un único
`latest-mac.yml` con los dos ZIP; el workflow falla si falta alguno o si la
metadata no declara la versión de `package.json`.

Una ejecución manual sin credenciales deja artefactos de QA sin firmar ni
notarizar. **No se publican.** Un tag `v*` exige los cinco secretos siguientes,
o el job falla antes de crear/actualizar la release en borrador:

```text
MAC_CSC_LINK                 # certificado Developer ID Application (.p12), base64 o URL segura
MAC_CSC_KEY_PASSWORD         # contraseña del certificado
APPLE_ID                     # cuenta usada por notarytool
APPLE_APP_SPECIFIC_PASSWORD # contraseña específica de aplicación
APPLE_TEAM_ID                # Team ID de 10 caracteres
```

Nunca los agregues al repositorio. Con el conjunto completo, electron-builder
firma con Hardened Runtime y notariza; después CI valida `codesign`, Gatekeeper
y el ticket adjunto. Con cero secretos desactiva el descubrimiento automático
de identidad para que el resultado sea inequívocamente un build local de QA.

Para generar localmente, solamente desde macOS:

```bash
npm run pack:mac
```

No alcanza con que el comando termine. Antes de publicar la primera release hay
que instalar ambos DMG en hardware real, abrir la app, probar `node-pty`, cerrar
y reabrir, y hacer una actualización real desde una versión anterior. Hasta
entonces, DMG, ZIP, firma, notarización y `latest-mac.yml` están **configurados,
no verificados**.
