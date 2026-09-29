import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 2.0 · ventana mínima — el contrato de la hoja.
 *
 * jsdom no aplica `styles.css`, así que lo que se VE se prueba donde vive: en
 * el texto del bloque final, el que se abre con el marcador
 * `2.0 · ventana mínima`. Cada bloqueante del encargo con la regla exacta que
 * lo cumple, cortado por su marcador: nada de lo que está arriba, de otras
 * entregas, puede hacer pasar estas aserciones.
 *
 * Los umbrales no son capricho: son medidas de la ventana mínima (1024 x 700).
 * El shell de tres columnas deja al contenido central 479 px de ancho y 670 px
 * de alto a la barra lateral; a 1440 x 900 son 853 px y 870 px. Cada
 * `@container`/`@media` de abajo se elige para que las dos medidas caigan a
 * lados opuestos del umbral.
 */

const MARKER = '/* 2.0 \u00b7 ventana m\u00ednima */';
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const start = css.indexOf(MARKER);
const block = start >= 0 ? css.slice(start) : '';

const has = (fragment: string) => expect(block, fragment).toContain(fragment);

/** El cuerpo de la primera regla de `selector{` dentro del bloque nuevo. */
const rule = (selector: string): string => {
  const at = block.indexOf(selector);
  expect(at, `falta la regla \`${selector}\` en el bloque 2.0`).toBeGreaterThan(-1);
  const open = block.indexOf('{', at);
  return block.slice(open + 1, block.indexOf('}', open));
};

/** El cuerpo de un `@media`/`@container`, con las llaves balanceadas. */
const atBody = (prelude: string): string => {
  const at = block.indexOf(prelude);
  expect(at, `falta \`${prelude}\``).toBeGreaterThan(-1);
  const open = block.indexOf('{', at + prelude.length);
  let depth = 0;
  for (let j = open; j < block.length; j++) {
    if (block[j] === '{') depth++;
    else if (block[j] === '}') { depth--; if (depth === 0) return block.slice(open + 1, j); }
  }
  return '';
};

describe('2.0 · ventana mínima — la hoja respeta el encargo', () => {
  it('el bloque existe una sola vez y es el que cierra la hoja', () => {
    expect(start, 'falta el bloque `/* 2.0 · ventana mínima */`').toBeGreaterThan(-1);
    expect(css.lastIndexOf(MARKER)).toBe(start);
    expect(css.length - start, 'el bloque no cierra la hoja').toBeLessThan(16_000);
  });

  it('todo sale de tokens: ni un color literal ni un tamaño de tipografía escrito a mano', () => {
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const values = [...rules.matchAll(/:([^;}]+)[;}]/g)].map((match) => match[1].trim());
    expect(values.length).toBeGreaterThan(15);
    for (const value of values) expect(value, value).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    for (const value of values) expect(value, value).not.toMatch(/font-size:\s*\d/);
  });

  it('1 · Inicio: por ANCHO DE CONTENIDO, la caja primero y las ideas de a una', () => {
    // El contenedor es la columna central, no la ventana: el ancho del contenido
    // no sigue al de la ventana (1024 -> 479 px, 1440 -> 853 px).
    has('.workspace{container-type:inline-size}');
    const narrow = atBody('@container (max-width:840px)');
    expect(narrow, 'la caja no recupera ancho').toContain('.home-view{padding-left:var(--space-5);padding-right:var(--space-5)}');
    expect(narrow, 'Primeros pasos no pasa debajo').toContain('.home-start{grid-template-columns:minmax(0,1fr)}');
    // Dos tarjetas de 220 px + el gap de 12 = 452 de contenido, + 40 de padding.
    const ideas = atBody('@container (max-width:492px)');
    expect(ideas, 'las ideas no pasan a una columna').toContain('.home-suggests{grid-template-columns:minmax(0,1fr)}');
  });

  it('2 · Pestañas: la tira scrollea en horizontal y sus botones no se encogen', () => {
    const tabs = rule('.tabs{');
    expect(tabs, '.tabs no scrollea').toContain('overflow-x:auto');
    expect(tabs, '.tabs no puede crecer en vertical').toContain('overflow-y:hidden');
    expect(tabs, 'sin scrollbar visible no se ve que hay más pestañas').toContain('scrollbar-width:thin');
    expect(tabs).toContain('scrollbar-color:var(--rust-soft)');
    const buttons = rule('.tabs>button:not(.icon-button){');
    // Sin esto los botones se comprimen y el texto se parte en vez de scrollear.
    expect(buttons, 'los botones se encogen y el rótulo se corta').toContain('flex-shrink:0');
    // La tira vive de 42 px: con scrollbar, el botón cede su piso.
    expect(buttons, 'los botones desbordan la tira cuando hay scrollbar').toContain('min-height:0');
    has('.tabs::-webkit-scrollbar{height:6px}');
    has('.tabs::-webkit-scrollbar-thumb{background:var(--rust-soft)');
    // La sombra del borde: el scroll tiene que verse aunque el scrollbar
    // nativo no se dibuje, y sólo se prende cuando hay más de ese lado.
    has('.tabs::after{top:0;right:0;margin-left:-22px;background:linear-gradient(to left,var(--paper),transparent)}');
    has('.tabs::before{top:0;left:0;order:-1;margin-right:-22px;background:linear-gradient(to right,var(--paper),transparent)}');
    has('.tabs[data-edge-start]::before,.tabs[data-edge-end]::after{opacity:1}');
  });

  it('3 · Barra lateral: lo de abajo siempre a la vista, sólo la lista achica', () => {
    const short = atBody('@media (max-height:760px)');
    expect(short, 'el pie sigue pegado al borde').toContain('.sidebar-bottom{padding-top:var(--space-2);padding-bottom:var(--space-2)}');
    expect(short, 'la regla de adentro del pie sigue con su margen de 20 px').toContain('.sidebar-bottom .sidebar-rule{margin:var(--space-2) 0}');
    expect(short, 'la lista de trabajos no puede encogerse').toContain('.sidebar .work-nav{min-height:48px}');
    expect(short, 'los labels siguen con su margen alto').toContain('.sidebar .nav-label{margin:var(--space-3) 10px var(--space-1)}');
    expect(short, 'las marcas archivadas abiertas no scrollean').toContain('.sidebar>.archived-brands{flex-shrink:1;min-height:0;overflow-y:auto}');
    // Sólo el alto cambia: la barra no se mueve de columna ni se hace scrolleable.
    expect(short, 'la barra entera no debería scrollear').not.toContain('.sidebar{');
    expect(short, 'la barra no debería crecer ni moverse de columna').not.toContain('grid-row');
  });

  it('4 · Ficha del ADN y documento: una columna cuando la ventana no da', () => {
    has('.dna-view{container-type:inline-size}');
    // 240 de pasos + 24 de gap + 444 para el `.dna-grid` de 2 columnas.
    const narrow = atBody('@container (max-width:707px)');
    expect(narrow, 'la ficha sigue en dos columnas y se corta').toContain('.dna-build{grid-template-columns:minmax(0,1fr)}');
    // La lista de documentos reparte su alto en vez de desbordar y cortar el pie.
    has('.documents{grid-template-rows:minmax(0,1fr)}');
    has('.doc-list>header{flex-wrap:wrap}');
  });

  it('5 · "Traé tu marca": los dos caminos son enlaces discretos, no botones grandes', () => {
    const links = rule('.dna-source-links .subtle{');
    expect(links, 'sigue siendo un botón con borde').toMatch(/border(?:-color)?:\s*(?:0|transparent)/);
    expect(links, 'sigue con el cuerpo de botón').toContain('font-size:var(--text-sm)');
    expect(links, 'sigue con la altura de botón').toContain('min-height:var(--control-h-sm)');
    expect(links, 'sigue con el color de acento').toContain('color:var(--muted)');
    expect(rule('.dna-source-links{')).toContain('flex-wrap:wrap');
  });

  it('ningún archivo de interfaz sigue usando window.confirm', () => {
    const offenders = readdirSync(join(process.cwd(), 'src'))
      .filter((name) => name.endsWith('.tsx'))
      .filter((name) => {
        const source = readFileSync(join(process.cwd(), 'src', name), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*)/.test(line))
          .join('\n');
        return source.includes('window.confirm(');
      });
    expect(offenders, 'quedó un window.confirm en uso').toEqual([]);
  });
});
