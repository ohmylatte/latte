# Brief — Estética de marca en la interfaz de la app

## Contexto

Latte tiene una marca nueva y ya está publicada en ohmylatte.app: una estética de edición impresa (papel, pocas tintas, trama, grano) donde el café es metáfora del producto, no el rubro.

| Imagen | Qué dice del producto |
|---|---|
| La L que humea (ícono) | La marca. Tres hilos de vapor = agentes trabajando en paralelo |
| La L en la espuma | La firma humana: vos aprobás |
| La taza que se llena | Tu contexto entrando |
| Los anillos | Versiones |
| La etapa punteada | La parte del recorrido que nadie atiende |

**Decisiones de producto ya tomadas (no se reabren):**

- La marca es **la L que humea, en óxido plano `#aa4e31`**. La L caligráfica está descartada.
- **La interfaz es plana.** Grano, trama y corrimiento de tintas son sólo de las piezas *impresas*: web, instalador, splash, íconos grandes. Adentro de la app: vector limpio y tokens.
- Toda imagen impresa sale de **un único kit**, `assets/brand/print-kit.js`. Una variación es de encuadre (posición, tamaño, recorte, tiempo), nunca un dibujo nuevo de la marca.

**Referencias:**

- Web publicada: https://ohmylatte.app (landing y blog con el sistema).
- Maqueta de la app con la dirección visual: https://claude.ai/artifact/4N5GZ4WBZVgq7Z7CFzUnEM
- `docs/ux/AUDIT-TOKENS-ESTETICA.md` — relevamiento de `styles.css` y tokens propuestos.
- `docs/ux/BRIEF-03-MICROINTERACCIONES-DE-MARCA.md` — microinteracciones de marca.

## Qué ya está hecho — PR #41 (`gabogabucho/brand-steaming-mark`)

- Kit de impresión `assets/brand/print-kit.js`.
- Íconos por tamaño (`npm run assets:icons`): impreso en 256/512, vapor en 48–128, L plana abajo de 48; `assets/icon.ico` por tamaño para Windows.
- Lámina lateral del instalador impresa, con la taza asomando.
- Splash impreso (`electron/splash.ts`, `assets/splash.html`, `assets/splash.js`) que informa la etapa real del arranque.
- `.logo-mark` en óxido plano.

Este brief **no rehace nada de eso**. Lo usa.

## Orden de trabajo

### 0. Cerrar lo pendiente

1. Terminar e integrar tus ramas en revisión. La capa 1 toca `src/styles.css` entero: empezarla con ramas abiertas genera conflictos en todos lados.
2. PR #41: `npm install`, `npm run typecheck:all`, `npm test` completo y `npm run dev` (el splash aparece al arrancar y se cierra cuando carga la interfaz). Si pasa, mergear.
3. Cerrar el PR #40 (L caligráfica) sin mergear.

### 1. Capa 1 — Base del sistema (un PR chico, mergeado rápido)

Objetivo: que `styles.css` deje de tener colores sueltos y pase a tokens, con la tipografía y las formas de la marca. **Sin cambios de funcionalidad ni de arquitectura de información.**

1. **Tokens.** Declarar en `:root` los tokens de `AUDIT-TOKENS-ESTETICA.md` (base, marca y estados, etapas del embudo, roles). `--accent: #b75534` pasa a `--rust: #aa4e31`; `#c0392b` pasa a `--danger`.
2. **Reemplazar literales.** Usar la tabla de mapeo de la auditoría (188 colores, 313 usos). Los casos marcados como lejanos y los translúcidos se deciden a mano, mirando la pantalla.
3. **Tipografía.** Empaquetar en `src/fonts/`, con su licencia OFL, igual que DM Sans hoy:
   - Instrument Serif (regular e itálica) → `--serif`: títulos de documento, encabezados de panel, estados vacíos.
   - Inter Tight (400, 500, 600) → `--sans`: interfaz.
   - JetBrains Mono (400, 500) → `--mono`: nombres de archivo, versiones, rutas, etiquetas de estado, terminal. Reemplaza los `Consolas` sueltos.

   No usar Google Fonts: la app es local-first y su CSP sólo admite fuentes propias.
4. **Formas.** `--radius-sm: 3px`, `--radius-md: 6px`, `--radius-pill: 999px`. Menos sombras: una línea de 1 px separa; la sombra queda para modales.
5. **Barra lateral** en `--ink` plano (sale el degradé). Trabajo activo en `--rust`.
6. **Estados como chips:** BORRADOR (contorno), EN REVISIÓN (`--rust-soft`), APROBADO (`--rust`, texto `--on-accent`).
7. **Piezas impresas que usan la fuente:** cuando entre Instrument Serif, cambiar `@font-face` en `assets/splash.html` y en `scripts/make-installer-sidebar.cjs` (hoy DM Serif Display), regenerar con `npm run assets:installer` y agregar el archivo de fuente a `files` en `electron-builder.yml`.

**Verificación de la capa 1:**

- `npm run typecheck:all` y `npm test` en verde.
- Capturas antes y después de: barra lateral, documento en revisión, embudo, equipo con un rol trabajando, un modal, un mensaje de error. Nada se tiene que romper ni desalinear; sólo cambiar de piel.
- Buscar que no queden hex sueltos fuera de `:root` (salvo los decididos a mano, con comentario).

### 2. Capa 2 — Microinteracciones de marca

Seguir `docs/ux/BRIEF-03-MICROINTERACCIONES-DE-MARCA.md`, después de mergeada la capa 1:

1. Aprobar: la L en la espuma (400 ms).
2. Cargando: la taza que se llena (esperas de más de 400 ms).
3. Agentes trabajando: un hilo de vapor por rol (reemplaza el punto verde).
4. Versiones: anillos, el actual lleno.
5. Embudo: la etapa vacía punteada, y *mismo archivo ↔* para documentos en varias etapas.

Se pueden entregar en PRs separados, uno por microinteracción.

## Reglas que no se negocian

- **Sin textura en la interfaz.** Nada de canvas, grano ni trama adentro de la app. Microinteracciones en SVG o CSS.
- **Verdaderas.** Una microinteracción aparece sólo cuando el estado ocurre. El splash ya lo cumple: no inventa progreso.
- **Movimiento reducido.** Con `prefers-reduced-motion: reduce`, todo queda en su cuadro final.
- **El color nunca es la única señal:** siempre también texto o forma.
- **El kit no se redibuja.** Si una pieza impresa necesita algo que el kit no tiene, se agrega al kit, no a la pieza. Cambiar el kit implica copiarlo a la web (`public/print-kit.js` en `ohmylatte/latte-web`, con el nuevo sha256 en la primera línea; su `npm run check` falla si no coinciden).
- **Lo impreso se dibuja a 2–4× y se reduce.** Dibujado al tamaño final, el grano ocupa un píxel entero y tapa la trama (pasó con el instalador).
- **CSP:** producción es `script-src 'self'`. Nada de scripts inline.
- **Copy en español rioplatense y en inglés**, con las claves de i18n existentes.

## Fuera de alcance

- Cambios de navegación o de estructura de pantallas (Brief 02).
- Rediseñar íconos, splash o instalador: ya están hechos.
- La web.

## Definición de terminado

- Capa 1 y capa 2 mergeadas, cada una con su verificación.
- Capturas antes y después adjuntas a cada PR.
- Ningún color suelto nuevo en `styles.css`.
