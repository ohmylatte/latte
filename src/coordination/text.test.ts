import { describe, expect, it } from 'vitest';
import { bodyOf, fileNames, initialsOf, stripMarkdown, titleOf } from './text';
import { stripLeadingHeading, stripMarkdownPrefix } from '../../shared/markdown';

/**
 * C3: LOS DOS BUGS DE LA CAPTURA, CERRADOS DONDE SE PUEDEN PROBAR SIN DOM.
 *
 * (a) "despachó: # Piezas exactas…": el numeral de Markdown del traspaso
 *     puenteado a tarea se filtraba al título.
 * (b) "reportó" pelado: el renderer fabricaba un reporte para todo despacho
 *     con `settled_at`, incluidos los que se cerraron sin reportar nunca.
 */

describe('C3 (a): la sintaxis de Markdown no llega a la pantalla', () => {
  it('saca el encabezado y deja el texto', () => {
    expect(stripMarkdownPrefix('# Piezas exactas para producción')).toBe('Piezas exactas para producción');
    expect(stripMarkdownPrefix('### Calendario')).toBe('Calendario');
    expect(stripMarkdownPrefix('#Titulo')).toBe('Titulo');
  });

  it('saca viñetas, numeración y cita, también anidadas', () => {
    expect(stripMarkdownPrefix('- Producir 14 piezas')).toBe('Producir 14 piezas');
    expect(stripMarkdownPrefix('1. Producir 14 piezas')).toBe('Producir 14 piezas');
    expect(stripMarkdownPrefix('> - # Producir 14 piezas')).toBe('Producir 14 piezas');
  });

  /** Sólo del PRINCIPIO: un `#` en el medio de una frase lo escribió alguien. */
  it('no toca un numeral en el medio de una frase', () => {
    expect(stripMarkdownPrefix('Campaña #3 de Meta')).toBe('Campaña #3 de Meta');
    expect(titleOf('Campaña #3 de Meta')).toBe('Campaña #3 de Meta');
  });

  it('el cuerpo del pedido no se pierde: sólo su primera línea cambia', () => {
    const handoff = '# Piezas exactas\nCon las piezas que reportó Paid Media.\nTexto por debajo del 20%.';
    expect(stripLeadingHeading(handoff)).toBe('Piezas exactas\nCon las piezas que reportó Paid Media.\nTexto por debajo del 20%.');
  });

  it('un texto sin sintaxis vuelve idéntico', () => {
    const plain = 'Piezas publicitarias Meta\nCopy por ángulo.';
    expect(stripLeadingHeading(plain)).toBe(plain);
  });

  it('el énfasis envuelve y también se saca', () => {
    expect(stripMarkdown('**Producir 14 piezas** en Feed')).toBe('Producir 14 piezas en Feed');
    expect(stripMarkdown('`angulo1.png` listo')).toBe('angulo1.png listo');
    expect(stripMarkdown('[el brief](brief.md) aprobado')).toBe('el brief aprobado');
  });

  it('el título es la primera línea con contenido, ya limpia', () => {
    expect(titleOf('\n\n## Producir 14 piezas\nCon el brief')).toBe('Producir 14 piezas');
    expect(titleOf('')).toBe('');
    expect(titleOf(null)).toBe('');
  });

  it('el cuerpo es lo que sigue, y vacío cuando no sigue nada', () => {
    expect(bodyOf('Producir 14 piezas\nCon el brief\ny las imágenes')).toBe('Con el brief y las imágenes');
    expect(bodyOf('Producir 14 piezas')).toBe('');
  });

  it('un texto largo se recorta y lo dice con puntos suspensivos', () => {
    expect(titleOf('x'.repeat(200), 20)).toBe('x'.repeat(20) + '…');
  });
});

describe('C3: las fichas de archivo salen del texto, no de una lista inventada', () => {
  it('nombra los archivos que el resumen nombra, sin repetir y en orden', () => {
    const summary = '14 piezas en piezas-para-produccion-cm.md y angulo1-feed-v1.png; ver piezas-para-produccion-cm.md';
    expect(fileNames(summary)).toEqual(['piezas-para-produccion-cm.md', 'angulo1-feed-v1.png']);
  });

  it('sin un nombre de archivo no inventa ninguno', () => {
    expect(fileNames('Quedaron las 14 piezas listas para producir.')).toEqual([]);
    expect(fileNames('La versión 1.2 quedó aprobada')).toEqual([]);
    expect(fileNames(null)).toEqual([]);
  });
});

describe('C2: las iniciales del avatar salen del NOMBRE, nunca de un id', () => {
  it('una palabra da una letra, dos o más dan dos', () => {
    expect(initialsOf('Asistente')).toBe('A');
    expect(initialsOf('Community Manager')).toBe('CM');
    expect(initialsOf('Paid Media')).toBe('PM');
  });

  it('un nombre vacío no rompe la fila', () => {
    expect(initialsOf('')).toBe('·');
    expect(initialsOf('   ')).toBe('·');
  });
});
