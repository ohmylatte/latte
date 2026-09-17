// Genera los íconos impresos grandes (512 y 256) con el ícono canónico de
// assets/brand/print-kit.js, el mismo que imprime la web: tinta, L en óxido con trama,
// tres hilos de vapor, grano y corrimiento de tintas. Los tamaños chicos y el .ico los arma
// después scripts/make-icon.mjs, que lee el 256 de acá.
//
// Se dibuja en un canvas dentro de Electron y se exporta como PNG con transparencia fuera
// del cuadrado redondeado.
//
// Uso: node_modules/electron/dist/electron scripts/make-print-icons.cjs (.exe en Windows)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const raiz = path.resolve(__dirname, '..');
const kit = pathToFileURL(path.join(raiz, 'assets', 'brand', 'print-kit.js')).href;
const TAMAÑOS = [512, 256];
app.commandLine.appendSwitch('disable-gpu');

const html = `<!doctype html><meta charset="utf-8"><body>
<script src="${kit}"></script>
<script>
  // Mismo radio y misma geometría que el ícono del kit: 96/520 del lado.
  // Se imprime a 4× y se reduce, como la web: dibujado al tamaño final, cada grano ocupa un
  // píxel entero y la trama se pierde.
  const IMPRESION = 4;
  window.imprimir = (N) => {
    const K = window.LattePrint;
    const M = N * IMPRESION;
    const grande = document.createElement('canvas'); grande.width = grande.height = M;
    const g = grande.getContext('2d');
    const P = K.makePress(M, M, 20260916, N);
    // Papel debajo: donde la tinta no agarra se ve papel, no un agujero.
    g.drawImage(P.paper, 0, 0);
    // Un poco más grande que el lienzo, para que el borde a mano quede fuera de la máscara.
    K.printedIcon(g, P, N / 2, N / 2, N * 1.012, { time: 0.8 });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = N;
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(grande, 0, 0, N, N);
    c.globalCompositeOperation = 'destination-in';
    c.beginPath(); c.roundRect(0, 0, N, N, N * 96 / 520); c.fill();
    return canvas.toDataURL('image/png');
  };
</script></body>`;

app.whenReady().then(async () => {
  const temporal = path.join(os.tmpdir(), `latte-print-icons-${process.pid}.html`);
  fs.writeFileSync(temporal, html, 'utf8');
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadFile(temporal);
    for (const tamaño of TAMAÑOS) {
      const datos = await win.webContents.executeJavaScript(`window.imprimir(${tamaño})`);
      const destino = path.join(raiz, 'assets', `icon-${tamaño}.png`);
      fs.writeFileSync(destino, Buffer.from(datos.split(',')[1], 'base64'));
      console.log(`[iconos] assets/icon-${tamaño}.png ${tamaño}x${tamaño} impreso`);
    }
  } catch (error) {
    console.error('[iconos]', error && error.message ? error.message : error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(temporal, { force: true });
  }
  app.exit(process.exitCode || 0);
});
