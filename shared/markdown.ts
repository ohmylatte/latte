/**
 * C3 BUG (a): EL NUMERAL DE MARKDOWN NO ES PARTE DEL TÍTULO.
 *
 * Un archivo de traspaso lo escribe un agente, y un agente escribe Markdown:
 * su primera línea es casi siempre `# Piezas exactas para producción`. Ese
 * cuerpo entra tal cual como el `spec` de la tarea que el puente crea, el
 * `spec` se vuelve el prompt del despacho, el prompt se recorta a
 * `promptPreview` y la pantalla terminaba diciendo, literal:
 *
 *     despachó: # Piezas exactas…
 *
 * Vive en `shared/` porque hacen falta los DOS lados: el motor, para que la
 * tarea nazca limpia, y el renderer, para que una tarea vieja —ya guardada con
 * su numeral— se siga leyendo bien. Una sola función, un solo criterio.
 *
 * Saca SINTAXIS, nunca contenido: `# Piezas exactas` queda `Piezas exactas`.
 * Y sólo del principio de la línea — un `#` en el medio de una frase es un
 * carácter que alguien escribió.
 */
export function stripMarkdownPrefix(line: string): string {
  let out = line.trimStart();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = out;
    out = out.replace(/^#{1,6}[ \t]+/, '');
    out = out.replace(/^>[ \t]*/, '');
    out = out.replace(/^[-*+][ \t]+/, '');
    out = out.replace(/^\d+[.)][ \t]+/, '');
    if (out === before) break;
  }
  // Un `#` pegado al texto (`#Titulo`) es igual de sintáctico en este contexto.
  out = out.replace(/^#+/, '');
  return out.trimStart();
}

/**
 * El TEXTO entero con su primera línea limpia. Es lo que el puente guarda: el
 * cuerpo del pedido no se toca —ahí vive lo que el agente realmente pidió—,
 * sólo deja de empezar con un numeral suelto.
 */
export function stripLeadingHeading(text: string): string {
  const match = /^[ \t]*\r?\n*/.exec(text);
  const start = match ? match[0].length : 0;
  const rest = text.slice(start);
  const breakAt = rest.search(/\r?\n/);
  const first = breakAt < 0 ? rest : rest.slice(0, breakAt);
  const cleaned = stripMarkdownPrefix(first);
  if (cleaned === first) return text;
  return cleaned + (breakAt < 0 ? '' : rest.slice(breakAt));
}
