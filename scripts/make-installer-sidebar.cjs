// Genera la imagen lateral del instalador (164x314, lo que pide NSIS).
//
// Se dibuja en HTML con la misma L y las mismas fuentes de la marca, se captura
// a escala 1 para que salga exactamente de ese tamaño, y se escribe como BMP de
// 24 bits sin comprimir, que es lo que NSIS lee sin discutir. Sin dependencias
// nuevas: Electron ya está en el proyecto y el encabezado BMP son 54 bytes.
//
// Uso: node_modules/electron/dist/electron scripts/make-installer-sidebar.cjs (.exe en Windows)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const raiz = path.resolve(__dirname, '..');
const ANCHO = 164, ALTO = 314;
app.commandLine.appendSwitch('disable-gpu');
// Escala 1 exacta: sin esto la captura sale al 125% en una pantalla al 125%.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const { pathToFileURL } = require('node:url');
const fuente = (archivo) => pathToFileURL(path.join(raiz, 'src', 'fonts', archivo)).href;
// La marca es el SVG maestro, embebido como data URI: este HTML se escribe en un
// archivo temporal, así que una ruta relativa no resolvería.
const marcaUrl = 'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(fs.readFileSync(path.join(raiz, 'assets', 'latte-mark.svg'), 'utf8'));
const html = `<!doctype html><meta charset="utf-8"><style>
  @font-face { font-family: 'Serif'; src: url('${fuente('dm-serif-display.ttf')}'); }
  @font-face { font-family: 'Sans'; src: url('${fuente('dm-sans.ttf')}'); }
  html, body { margin: 0; width: ${ANCHO}px; height: ${ALTO}px; overflow: hidden; }
  body {
    background: linear-gradient(168deg, #2f2921 0%, #241f19 62%, #1d1915 100%);
    color: #f4efe6; font-family: 'Sans', sans-serif;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 26px 22px; box-sizing: border-box;
  }
  /* Todo esto vive sobre el carbon, asi que usa el tinte claro del acento. */
  .marca { width: 34px; height: 43px; background: #d27d60;
    -webkit-mask: url("${marcaUrl}") center/contain no-repeat;
    mask: url("${marcaUrl}") center/contain no-repeat; }
  h1 { font-family: 'Serif', serif; font-weight: 400; font-size: 27px;
    line-height: 1.1; letter-spacing: -.7px; margin: 16px 0 0; }
  h1 em { display: block; font-style: italic; color: #d27d60; }
  .pie { font-size: 9.5px; line-height: 1.7; color: #9c9184; letter-spacing: .3px; }
  .pie strong { display: block; color: #cfc6b8; font-weight: 500; letter-spacing: 1.6px; font-size: 8.5px; margin-bottom: 3px; }
  .linea { width: 34px; height: 2px; background: #d27d60; margin-bottom: 10px; }
</style>
<body>
  <div><div class="marca"></div><h1>Tu marketing,<em>en su lugar.</em></h1></div>
  <div class="pie"><div class="linea"></div><strong>OH MY LATTE · ALPHA</strong>Marcas, trabajos y agentes.<br>Todo en tu máquina.</div>
</body>`;

/** BMP de 24 bits: filas de abajo hacia arriba y padeadas a múltiplo de 4. */
function aBmp(bgra, ancho, alto) {
  const filaBytes = ancho * 3;
  const relleno = (4 - (filaBytes % 4)) % 4;
  const datos = Buffer.alloc((filaBytes + relleno) * alto);
  for (let y = 0; y < alto; y++) {
    const origen = (alto - 1 - y) * ancho * 4;
    let destino = y * (filaBytes + relleno);
    for (let x = 0; x < ancho; x++) {
      datos[destino++] = bgra[origen + x * 4];
      datos[destino++] = bgra[origen + x * 4 + 1];
      datos[destino++] = bgra[origen + x * 4 + 2];
    }
  }
  const cabecera = Buffer.alloc(54);
  cabecera.write('BM', 0);
  cabecera.writeUInt32LE(54 + datos.length, 2);
  cabecera.writeUInt32LE(54, 10);
  cabecera.writeUInt32LE(40, 14);
  cabecera.writeInt32LE(ancho, 18);
  cabecera.writeInt32LE(alto, 22);
  cabecera.writeUInt16LE(1, 26);
  cabecera.writeUInt16LE(24, 28);
  cabecera.writeUInt32LE(datos.length, 34);
  cabecera.writeInt32LE(2835, 38);
  cabecera.writeInt32LE(2835, 42);
  return Buffer.concat([cabecera, datos]);
}

app.whenReady().then(async () => {
  const temporal = path.join(os.tmpdir(), `latte-sidebar-${process.pid}.html`);
  fs.writeFileSync(temporal, html, 'utf8');
  try {
    const win = new BrowserWindow({ width: ANCHO, height: ALTO, useContentSize: true, show: false, webPreferences: { offscreen: true } });
    await win.loadFile(temporal);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    await new Promise((r) => setTimeout(r, 600));
    const imagen = await win.webContents.capturePage();
    const { width, height } = imagen.getSize();
    if (width !== ANCHO || height !== ALTO) throw new Error(`la captura salió ${width}x${height} y NSIS necesita ${ANCHO}x${ALTO}`);
    const destino = path.join(raiz, 'build');
    fs.mkdirSync(destino, { recursive: true });
    const bmp = aBmp(imagen.toBitmap(), width, height);
    fs.writeFileSync(path.join(destino, 'installerSidebar.bmp'), bmp);
    fs.writeFileSync(path.join(destino, 'uninstallerSidebar.bmp'), bmp);
    fs.writeFileSync(path.join(destino, 'vista-previa.png'), imagen.toPNG());
    console.log(`[sidebar] ${width}x${height}, ${bmp.length} bytes -> build/installerSidebar.bmp`);
  } catch (error) {
    console.error('[sidebar]', error && error.message ? error.message : error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(temporal, { force: true });
  }
  app.exit(process.exitCode || 0);
});
