# ADN: colores y tipografía los prepara Latte

Primera actualización después del 2.0. Decidido el 2026-09-29.

## Problema

En la prueba de escritorio del 2.0, el ADN se armó bien:
- tono, audiencia, propuesta y palabras;
- cada dato con su fuente (web y bio de Instagram).

Pero **Colores** y **Tipografía** quedaron en "Todavía sin datos".

Hay dos causas:
- La herramienta de lectura web del agente (WebFetch) le entrega un resumen
  en texto. Las hojas de estilo, que es donde viven colores y fuentes, no llegan.
- Los logos que sube la persona ya están en `borradores/adn/fuentes/`, pero el
  pedido no dice qué hacer con ellos. Además, estimar un hex desde una imagen
  "a ojo" da un valor aproximado.

La regla "sin fuente firme, el campo queda vacío" es correcta y se mantiene.

## Por qué lo hace Latte y no el agente

El plan es pasar a un loop propio por API. Ese modelo no tiene terminal: no
puede correr `curl`, `grep` ni abrir archivos por su cuenta. Todo lo que no sea
texto se lo tiene que preparar Latte.

Por eso este trabajo es el primer ladrillo del módulo **"Latte prepara las
fuentes"**, no un parche. Por la misma razón se descartó cambiar solo el pedido
para que el agente use `curl`: funciona únicamente con IAs que tienen terminal.

## Qué se construye

### A · Estilo de la web

En el proceso principal, antes de despachar el armado:

1. Bajar el HTML de la web. Topes de tiempo y tamaño, redirecciones y
   codificación resueltas.
2. Seguir las hojas de estilo `<link rel="stylesheet">` y los `<style>` en
   línea. Solo del mismo sitio, más Google Fonts, con un tope de cantidad y de
   peso total.
3. Extraer los colores:
   - variables CSS (`--*`) con valor de color;
   - hex, rgb y hsl normalizados a `#rrggbb`;
   - ordenados por frecuencia y por dónde se usan (`body`, títulos, botones, enlaces);
   - filtrar grises neutros y los colores típicos de frameworks.
4. Extraer las fuentes:
   - la primera familia de cada `font-family`, sin las genéricas ni las del sistema;
   - las familias de Google Fonts;
   - los `@font-face`.
   Distinguir entre títulos y texto.

### B · Paleta de los logos

Con `nativeImage` de Electron:

1. Decodificar cada logo PNG o JPG de la identidad a bitmap.
2. Descartar los píxeles transparentes, casi blancos y casi negros. Estos
   últimos se reportan aparte, porque un logo negro es un dato.
3. Agrupar los colores y devolver de 3 a 5 dominantes con su porcentaje.

### Cómo llega al agente

- Latte escribe `borradores/adn/fuentes/web-estilo.md` con los candidatos:
  - colores con su hex, dónde aparecen y su peso;
  - fuentes con su rol;
  - la paleta de cada logo.
- El pedido del ADN suma una línea: los colores y las fuentes salen de ese
  archivo. El agente elige y nombra ("Terracota principal", "Títulos:
  Fraunces").
- Cada valor lleva su fuente, `web · css` o `logo-blue.png`.
  `assumption: false` cuando el valor viene del CSS o de los píxeles.
- Si la web no se puede leer, el paso `web` lo dice con su motivo, igual que
  hoy con los canales.
- La vista previa (`src/browser-api.ts`) simula el archivo.

## Tests

- Sin red real: HTML y CSS de prueba, con redirección, con una hoja de estilo
  grande (tope) y con una hoja de otro dominio (se ignora).
- Logos de prueba: uno de dos colores, uno transparente y uno negro.
- Un armado con web y logos deja `web-estilo.md` y el pedido lo menciona.

## Fuera de alcance

- Leer imágenes de redes o de posts.
- Capturas de pantalla de la web.
- Colores de marcas sin web ni logos: siguen vacíos, y la persona los completa
  con el lápiz.
