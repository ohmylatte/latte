# Auditoría de tokens — estética de marca en la app

## Para qué sirve

Es el relevamiento previo a la **capa 1** de la estética de marca (tokens, tipografía y formas). La capa 1 entra después de que se integren las ramas abiertas de la app, rebasada una sola vez y mergeada rápido, para que el resto del trabajo use variables en lugar de colores sueltos.

Referencias:

- Maqueta de la dirección: https://claude.ai/artifact/4N5GZ4WBZVgq7Z7CFzUnEM
- Landing con la misma estética: rama `feat/premium-landing` de latte-web.
- Decisión de marca: la L que humea, óxido plano. La L caligráfica (PR #40) quedó descartada.

## Estado actual de `src/styles.css`

| Medida | Hoy |
|---|---|
| Tamaño | 79 KB, CSS minificado en pocas líneas |
| Colores literales | **188 distintos, 313 usos**, más 11 `rgba()` |
| Variables | `--paper`, `--line`, `--muted`, `--accent`, `--dark`, `--serif`, `--sidebar` y seis `--role-*` |
| Radios | 14 valores distintos (3, 4, 5, 6, 7, 8, 9, 20 px, 50 %, combinados) |
| Tipografía | DM Sans y DM Serif Display, empaquetadas en `src/fonts/`; monoespaciada del sistema (`Consolas`) |
| Acento | `#b75534` (la marca es `#aa4e31`) |

La mayoría de los 188 colores son variaciones mínimas del mismo papel, línea o crema: se hicieron a mano pantalla por pantalla. Eso es lo que la capa 1 ordena.

## Tokens propuestos

### Base

| Token | Valor | Uso |
|---|---|---|
| `--paper` | `#f6f3ed` | Fondo de la app |
| `--paper-raised` | `#fbf9f4` | Paneles, barra superior, documento |
| `--foam` | `#fffdf8` | Campos, tarjetas, filas seleccionadas |
| `--paper-deep` | `#eee9df` | Hover, pozos, código |
| `--line` | `#e2ddd2` | Divisores |
| `--line-strong` | `#cfc8bb` | Bordes de controles |
| `--neutral-mid` | `#c8c0b2` | Puntos de estado inactivos, scrollbars, iconos apagados |
| `--ink` | `#292a24` | Texto y barra lateral |
| `--ink-raised` | `#34352e` | Superficies elevadas sobre la barra lateral |
| `--ink-soft` | `#4b4a42` | Texto secundario |
| `--muted` | `#7a766b` | Texto terciario, metadatos |
| `--muted-soft` | `#a9a293` | Texto sobre tinta, etiquetas de la barra lateral |
| `--on-dark` | `#e9e3d8` | Texto sobre tinta |
| `--line-on-dark` | `#3d3e36` | Divisores sobre tinta |

### Marca y estados

| Token | Valor | Uso |
|---|---|---|
| `--rust` | `#aa4e31` | Acción principal, trabajo activo, APROBADO (reemplaza a `--accent: #b75534`) |
| `--rust-hover` | `#8f4128` | Hover de la acción principal |
| `--rust-deep` | `#7a3c26` | Texto sobre `--rust-wash` |
| `--rust-soft` | `#e9c4aa` | EN REVISIÓN, vapor, bordes de propuestas |
| `--rust-wash` | `#f4e6da` | Banners de propuesta, selección suave |
| `--on-accent` | `#fff7ee` | Texto sobre óxido |
| `--green` | `#293c32` | Local, marca secundaria |
| `--green-ok` | `#4f6a49` | Éxito, agente trabajando (punto quieto) |
| `--green-wash` | `#e3e9dc` | Mensajes de éxito |
| `--danger` | `#a3362a` | Error (reemplaza `#c0392b`, que no es de la paleta) |
| `--danger-wash` | `#f8e3dc` | Fondo de errores |

### Familias que ya existen y se mantienen como tokens

| Familia | Hoy | Propuesta |
|---|---|---|
| Etapas del embudo | `#c98c5f`, `#bd7a4e`, `#b0663d`, `#a2542e` | `--stage-1` a `--stage-4`, en rampa de crema a óxido: `#d9a57f`, `#c47f57`, `#b0613c`, `#aa4e31` |
| Roles | `--role-strategist` `#5c6b4a`, `--role-researcher` `#4a6272`, `--role-reviewer` `#7a4f6b`, `--role-analyst` `#9a7233`, `--role-assistant` `#b75534`, `--role-default` `#8a7f70` | Se mantienen los tonos (distinguen roles), bajando saturación para que convivan con la tinta. `--role-assistant` pasa a `--rust` |

### Tipografía

| Token | Familia | Uso |
|---|---|---|
| `--serif` | Instrument Serif (regular e itálica) | Títulos de documentos, encabezados de paneles, estados vacíos |
| `--sans` | Inter Tight (400, 500, 600) | Interfaz |
| `--mono` | JetBrains Mono (400, 500) | Nombres de archivo, versiones, rutas, etiquetas de estado, terminal |

Las tres son OFL. Se empaquetan en `src/fonts/` con su licencia, igual que DM Sans hoy: la app es local-first y su CSP sólo admite fuentes propias, así que no se cargan de Google Fonts. El splash y el lateral del instalador siguen con DM Serif Display hasta que entre la capa 1.

### Formas

| Token | Valor | Reemplaza |
|---|---|---|
| `--radius-sm` | `3px` | 3, 4 y 5 px en controles, filas y chips cuadrados |
| `--radius-md` | `6px` | 6, 7, 8 y 9 px en tarjetas, modales y paneles |
| `--radius-pill` | `999px` | Chips de estado |
| `50%` | se mantiene | Avatares y puntos |

Menos sombras: una línea de 1 px separa; la sombra queda sólo para modales.

## Plan de la capa 1

1. Declarar todos los tokens en `:root`.
2. Reemplazar literales por tokens con la tabla de abajo, revisando a mano los marcados como lejanos y los translúcidos.
3. Empaquetar las tres fuentes y cambiar `--serif`, `--sans` y los `Consolas` sueltos por `--mono`.
4. Unificar radios.
5. Barra lateral en `--ink` plano (sale el degradé `#302c25 → #24221d`).
6. Verificación: `npm run typecheck:all`, `npm test`, capturas de las pantallas principales antes y después.

Fuera de alcance de la capa 1: las microinteracciones (ver `BRIEF-03-MICROINTERACCIONES-DE-MARCA.md`) y cualquier cambio de arquitectura de información (Brief 02).

## Mapeo de literales a tokens

Generado por distancia de color, separado por uso (texto, superficie, línea). Es un punto de partida: los casos lejanos y los translúcidos se deciden a mano.

### Texto

| Token propuesto | Literales de hoy (usos) |
|---|---|
| `--muted-soft` | `#a8947a` (5), `#a89880` (5), `#9b8c79` (2), `#8fbf9e` (2), `#d99a6c` (2), `#b7a996` (1), `#bdb09c` (1), `#b8ac9b` (1), `#cabfad` (1), `#a99d8b` (1), `#a29685` (1), `#b4aa9a` (1), `#a19586` (1), `#b9a68a` (1), `#c5b9aa` (1), `#a2988a` (1), `#9d8d75` (1), `#b09a76` (1), `#b09070` (1), `#b0a493` (1), `#d9a066` (1) |
| `--ink` | `#302c26` (15) |
| `--rust-deep` | `#91462e` (9), `#854a34` (1), `#8a4f31` (1), `#7d5a45` (1), `#874228` (1), `#8d4b21` (1) |
| `--green-ok` | `#4c6146` (6), `#5f7a56` (1), `#6b5b45` (1), `#6f5c33` (1) |
| `--muted` | `#8a7a63` (2), `#807564` (1), `#927e65` (1), `#a18564` (1), `#75876c` (1), `#6f675c` (1), `#6b5a80` (1) |
| `--on-accent` | `#fffaf2` (2), `#fff6e9` (2), `#fff5e5` (1), `#f4efe7` (1), `#fff` (1) |
| `--ink-soft` | `#5f5749` (2), `#4f3f63` (1), `#4f483f` (1) |
| `--rust` | `#8a5230` (2), `#8a5a3a` (2) |
| `--on-dark` | `#e8e0d5` (1), `#f3ece0` (1) |
| `--danger` | `#994322` (1) |

### Superficies

| Token propuesto | Literales de hoy (usos) |
|---|---|
| `--rust-wash` | `#f5e3d8` (5), `#f3e7da` (4), `#f6e8db` (2), `#e9d8c4` (2), `#eee0d2` (1), `#f3e3d8` (1), `#f8ece3` (1), `#efe0d3` (1), `#f4e3c9` (1), `#eee3d2` (1), `#eddfca` (1), `#e8d9c0` (1), `#f8e7d9` (1), `#f5e7d7` (1), `#f4e5d6` (1) |
| `--paper-deep` | `#eee8de` (4), `#eee8dd` (4), `#f0ebe2` (3), `#eee9df` (1), `#f0ece4` (1), `#f0e9de` (1), `#eee7db` (1), `#f1ece1` (1), `#f6ece4` (1), `#f2ede4` (1), `#f1ece3` (1), `#f1ebe1` (1), `#efe8dd` (1) |
| `--paper` | `#fbf3ec` (2), `#f6f2ea` (2), `#f8efe4` (2), `#f4f0e8` (1), `#f2eee6` (1), `#f5f1ea` (1), `#f6f2eb` (1), `#f4efe6` (1), `#f1eee7` (1), `#eef1e8` (1), `#efe9f2` (1), `#f7f3eb` (1), `#fbf4ec` (1), `#e6f4ea` (1) |
| `--rust-soft` | `#b5ab9c` (4), `#d9cebf` (3), `#c9a98f` (2), `#a8998a` (1), `#d3c8b8` (1), `#cec2b0` (1), `#b8a894` (1), `#e0d5bd` (1), `#b3a897` (1), `#c3b7a5` (1), `#e3c8b3` (1) |
| `--paper-raised` | `#faf8f3` (3), `#fbf9f5` (2), `#fbf6ee` (2), `#faf7ef` (2), `#faf7f1` (1), `#fff8ed` (1), `#fbf7f0` (1) |
| `--green-wash` | `#e8eddf` (3), `#e6ded1` (3), `#e3ddd3` (1), `#e9e2d6` (1), `#e8e1d5` (1), `#e6dbc6` (1), `#e8e1d6` (1) |
| `--foam` | `#fffdf8` (10), `#fffdf7` (1) |
| `--green-ok` | `#65805c` (3), `#827b70` (1), `#7d8a6f` (1), `#5c6b4a` (1), `#4a6272` (1), `#7a4f6b` (1), `#8a7f70` (1), `#8aa07f` (1) |
| `--rust` | `#b75534` (3), `#c0392b` (2), `#aa4e31` (1), `#a94d2f` (1), `#b55b3b` (1), `#9a7233` (1), `#c99a3b` (1) |
| `(translúcido: revisar a mano)` | `#ffffff0a` (2), `#ffffff55` (2), `#211a146b` (1), `#0000` (1), `#fff8` (1), `#ffffff12` (1), `#ffffff88` (1) |
| `--ink` | `#302c25` (2), `#28251f` (1), `#24221d` (1) |
| `--rust-hover` | `#98492f` (2) |
| `--ink-raised` | `#4b4439` (1) |
| `--danger-wash` | `#fce8e6` (1) |

### Líneas y bordes

| Token propuesto | Literales de hoy (usos) |
|---|---|
| `--rust-soft` | `#e9c7b5` (4), `#d9bda4` (3), `#e0c9b3` (3), `#e6c8b9` (2), `#e0c8b6` (2), `#c9ad93` (1), `#e6c9b6` (1), `#c89475` (1), `#c69269` (1), `#dcc3ac` (1), `#e0c0ae` (1), `#c98d72` (1) |
| `--line-strong` | `#c5b9aa` (3), `#d9cebd` (3), `#d7c9b8` (1), `#d9cdbb` (1), `#daccba` (1), `#cfc3b1` (1), `#d5c8b6` (1), `#cbd8bf` (1) |
| `--rust` | `#b75534` (3), `#98492f` (2), `#c58162` (1), `#b78051` (1), `#a66d40` (1), `#c98c5f` (1), `#bd7a4e` (1), `#b0663d` (1), `#a2542e` (1) |
| `--line` | `#ded5c6` (3), `#ece5da` (3), `#d6dfc9` (2), `#e0d7c9` (1), `#ffffff` (1), `#dcd2e4` (1), `#e8e1d6` (1) |
| `(translúcido: revisar a mano)` | `#0001` (1), `#17130e33` (1), `#b7553418` (1), `#b7553426` (1) |
| `--line-on-dark` | `#4b4439` (2), `#454036` (1) |
| `--green-ok` | `#5a5143` (1), `#7d865a` (1), `#4c6146` (1) |

### Colores lejos de cualquier token (revisar a mano)

- #827b70 (surface, 1×) → --green-ok, distancia 107
- #c58162 (line, 1×) → --rust, distancia 134
- #b5ab9c (surface, 4×) → --rust-soft, distancia 103
- #7d8a6f (surface, 1×) → --green-ok, distancia 114
- #a8998a (surface, 1×) → --rust-soft, distancia 146
- #b8a894 (surface, 1×) → --rust-soft, distancia 105
- #7a4f6b (surface, 1×) → --green-ok, distancia 102
- #8a7f70 (surface, 1×) → --green-ok, distancia 119
- #ffffff (line, 1×) → --line, distancia 106
- #c99a3b (surface, 1×) → --rust, distancia 161
- #c89475 (line, 1×) → --rust-soft, distancia 135
- #c69269 (line, 1×) → --rust-soft, distancia 150
- #b78051 (line, 1×) → --rust, distancia 113
- #7d865a (line, 1×) → --green-ok, distancia 95
- #b3a897 (surface, 1×) → --rust-soft, distancia 110
- #8aa07f (surface, 1×) → --green-ok, distancia 166
- #c98c5f (line, 1×) → --rust, distancia 151
- #bd7a4e (line, 1×) → --rust, distancia 103
- #d9a066 (text, 1×) → --muted-soft, distancia 104
- #d99a6c (text, 2×) → --muted-soft, distancia 100
- #c98d72 (line, 1×) → --rust-soft, distancia 147

