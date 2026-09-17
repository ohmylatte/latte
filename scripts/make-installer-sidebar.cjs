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
/** Resolución de impresión de la lámina respecto de su tamaño final. */
const IMPRESION = 4;
app.commandLine.appendSwitch('disable-gpu');
// Escala 1 exacta: sin esto la captura sale al 125% en una pantalla al 125%.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const { pathToFileURL } = require('node:url');
const fuente = (archivo) => pathToFileURL(path.join(raiz, 'src', 'fonts', archivo)).href;
const kit = pathToFileURL(path.join(raiz, 'assets', 'brand', 'print-kit.js')).href;
// La lámina impresa de la marca: papel con fibras, tintas planas con grano y un leve
// corrimiento entre tintas, la misma estética de las animaciones de ohmylatte.app.
// El canvas pinta el papel y la taza con el kit de impresión; el texto va en HTML para que quede nítido.
const html = `<!doctype html><meta charset="utf-8"><style>
  @font-face { font-family: 'Serif'; src: url('${fuente('instrument-serif.ttf')}'); }
  @font-face { font-family: 'Serif'; src: url('${fuente('instrument-serif-italic.ttf')}'); font-style: italic; }
  @font-face { font-family: 'Sans'; src: url('${fuente('inter-tight.ttf')}'); }
  html, body { margin: 0; width: ${ANCHO}px; height: ${ALTO}px; overflow: hidden; }
  body { position: relative; background: #f6f3ed; color: #292a24; font-family: 'Sans', sans-serif; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .texto { position: absolute; inset: 0; padding: 20px 20px 0; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 12px; }
  h1 { font-family: 'Serif', serif; font-weight: 400; font-size: 25px; line-height: 1.02; letter-spacing: -.5px; margin: 0; }
  h1 em { display: block; font-style: italic; color: #aa4e31; }
  .pie { font-size: 9.5px; line-height: 1.65; color: #4b4a42; letter-spacing: .2px; }
  .pie strong { display: block; color: #292a24; font-weight: 500; letter-spacing: 1.6px; font-size: 8px; margin-bottom: 4px; }
  .linea { width: 30px; height: 2px; background: #aa4e31; margin-bottom: 9px; }
</style>
<body>
  <canvas id="lamina" width="${ANCHO * IMPRESION}" height="${ALTO * IMPRESION}"></canvas>
  <div class="texto">
    <h1>Tu marketing,<em>en su lugar.</em></h1>
    <div class="pie"><div class="linea"></div><strong>OH MY LATTE · ALPHA</strong>Marcas, trabajos y agentes.<br>Todo en tu máquina.</div>
  </div>
  <script src="${kit}"></script>
  <script>
    // La taza es la marca canónica de assets/brand/print-kit.js, la misma de la web y del
    // splash: acá sólo se encuadra, asomando por el borde inferior. El ícono ya está en la
    // barra de título del instalador, así que la lámina no lo repite.
    const K = window.LattePrint;
    const c = document.getElementById('lamina').getContext('2d');
    // Se imprime a IMPRESION× y el navegador lo reduce, como en la web: el grano y la trama
    // quedan finos. Dibujado a 164 px, cada grano ocupa un píxel entero y tapa la trama.
    const P = K.makePress(${ANCHO * IMPRESION}, ${ALTO * IMPRESION}, 20260916, ${ANCHO});
    c.drawImage(P.paper, 0, 0);
    K.cupFromAbove(c, P, 84, ${ALTO} - 22, 58);
    window.lista = true;
  </script>
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
