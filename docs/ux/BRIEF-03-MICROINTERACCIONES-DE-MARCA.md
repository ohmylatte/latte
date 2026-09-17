# Brief 03 — Microinteracciones de marca

## Dependencia

Comenzar después de que entre la capa 1 de la estética (tokens, tipografía y formas; ver `AUDIT-TOKENS-ESTETICA.md`). Cada microinteracción usa esos tokens, nunca colores sueltos.

Si la pantalla cambia por el Brief 02, la microinteracción viaja con el objeto (el documento, el rol, la etapa), no con la ubicación actual en la interfaz.

## Propósito

La marca de Latte es una taza de café con la L en la espuma y tres hilos de vapor. No es decoración: cada imagen dice algo del producto.

| Imagen | Qué dice |
|---|---|
| La L en la espuma | La firma humana: vos aprobás |
| El vapor | Un agente trabajando; un hilo por rol |
| La taza que se llena | Tu contexto entrando |
| Los anillos | Versiones |
| La etapa punteada | La parte del recorrido que nadie atiende |

Este brief lleva esas imágenes a la interfaz como microinteracciones **planas y cortas**.

Referencias:

- Maqueta interactiva: https://claude.ai/artifact/4N5GZ4WBZVgq7Z7CFzUnEM (sección "Microinteracciones" y el botón Aprobar de la pantalla principal).
- El splash ya implementado (`electron/splash.ts`, `assets/splash.js`) usa las mismas imágenes en versión impresa.

## Reglas

1. **Sin textura en la interfaz.** Grano, trama y corrimiento de tintas son de las piezas impresas (web, instalador, splash, íconos grandes). Adentro: vector limpio, tokens planos.
2. **Cortas.** Ninguna dura más de 450 ms, salvo los estados continuos (vapor, carga), que se repiten mientras el estado existe.
3. **Verdaderas.** Una microinteracción aparece sólo cuando el estado ocurre. El vapor no se muestra si el rol no está trabajando; la L no aparece si no hubo aprobación.
4. **Movimiento reducido.** Con `prefers-reduced-motion: reduce` todas quedan en su cuadro final, sin animación. El estado se sigue leyendo por la forma y el texto.
5. **El color nunca es la única señal.** Cada estado tiene también texto (BORRADOR, EN REVISIÓN, APROBADO) o forma (hilo, punto, anillo lleno).
6. **SVG o CSS.** Nada de canvas ni librerías de animación para esto.

## Microinteracciones

### 1. Aprobar: la L en la espuma

**Dónde:** al aprobar un documento, en la barra de herramientas del documento y en su fila de la lista.

**Qué pasa:**

1. El chip de estado pasa de EN REVISIÓN (`--rust-soft`) a APROBADO (`--rust`, texto `--on-accent`).
2. Junto al título aparece un sello de 34 px: la taza vista desde arriba (borde `--ink`, café `--rust`) con la L en `--foam`, que escala de 0 a 1 con un rebote corto.
3. El texto *aprobado por vos.* en `--serif` itálica, color `--rust`.
4. Se suma el anillo de la nueva versión (ver 4).

**Duración:** 400 ms, `cubic-bezier(.3, 1.4, .5, 1)` para la L.

**Deshacer:** si la aprobación se revierte, el sello desaparece sin animación.

### 2. Cargando: la taza que se llena

**Dónde:** reemplaza al spinner cuando se abre un trabajo, cuando un agente lee una carpeta y en cualquier espera de más de 400 ms. Esperas más cortas no muestran nada.

**Qué pasa:** taza vista desde arriba (borde `--ink`, platito sin dibujar), el interior en `--paper-deep` se llena de `--rust` desde abajo. Loop de 2,6 s.

**Tamaños:** 16 px en botones, 32 px en paneles, 64 px en estados vacíos.

**Accesibilidad:** `role="status"` con texto oculto que dice qué se está cargando.

### 3. Agentes trabajando: un hilo de vapor por rol

**Dónde:** en las pestañas del equipo (`.team-tab`) y en el trabajo de la barra lateral que tiene un chat activo (hoy `.live-dot`).

**Qué pasa:** mientras el rol trabaja, un hilo de vapor de 10 × 16 px en el color del rol (`--role-*`) sube en loop: trazo con `stroke-dasharray` que se desplaza, 1,6 s. Cuando el rol queda inactivo, el hilo se reemplaza por un punto quieto en `--neutral-mid`. Si el rol necesita atención, punto `--rust` con halo (se mantiene lo de hoy).

**Por qué hilo y no punto:** el punto verde dice "conectado"; el vapor dice "está haciendo algo". Son estados distintos.

### 4. Versiones: anillos

**Dónde:** el control de versiones en la barra de herramientas del documento y el modal de revisiones.

**Qué pasa:** cada versión es un anillo de 14 px con borde `--rust` de 2 px. Las versiones anteriores al 35 % de opacidad; la actual, llena. Al guardar o aprobar una versión nueva, su anillo se dibuja (trazo de 0 a 360°) en 300 ms. Al lado, en `--mono`: `v3 · aprobada`.

**Límite:** hasta 5 anillos visibles; si hay más, `+N` en `--mono` antes del primero.

### 5. Embudo: la etapa vacía

**Dónde:** vista Embudo, en cada etapa sin documentos.

**Qué pasa:** la etapa no se oculta. Su área muestra un recuadro con borde punteado `--rust` (1,5 px, `6px 5px`), el texto *etapa vacía* en `--serif` itálica `--rust` y debajo, en `--mono` `--muted`, *nadie la está atendiendo*. Sin animación.

**Documento en varias etapas:** la segunda aparición va con borde punteado `--ink` y la leyenda *mismo archivo ↔*, para que no se lea como un duplicado.

## Fuera de alcance

- Splash de inicio, íconos e instalador: ya implementados en la rama de marca.
- Tokens, tipografía y formas: capa 1.
- Cambios de navegación o de estructura de pantallas: Brief 02.

## Verificación

- Cada microinteracción probada con movimiento normal y con movimiento reducido.
- Capturas antes y después de: documento en revisión → aprobado, equipo con un rol trabajando y uno inactivo, embudo con una etapa vacía, carga de un trabajo.
- `npm run typecheck:all` y `npm test` en verde; si la microinteracción depende de un estado, un test que verifique que aparece sólo con ese estado.
