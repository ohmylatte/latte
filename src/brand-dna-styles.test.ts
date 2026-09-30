import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Pulido visual del ADN (ronda 2) — el contrato de estilo en la hoja.
 *
 * jsdom no aplica `styles.css`, así que lo que se VE se prueba donde vive: en
 * el texto del bloque final de la hoja, el que se abre con el marcador del ADN.
 * Son las correcciones que vio el coordinador en la vista previa, cada una con
 * la regla exacta que la cumple — si alguien la toca, esto se pone rojo en vez
 * de dejarlo pasar como "un detalle de estilo".
 *
 * El bloque se corta por su marcador: nada de lo que está arriba, de otras
 * entregas, puede hacer pasar estas aserciones.
 */
const MARKER = "/* ADN \u00b7 interfaz */";
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const start = css.indexOf(MARKER);
const block = start >= 0 ? css.slice(start) : '';

const has = (fragment: string) => expect(block, fragment).toContain(fragment);

describe('pulido del ADN · la hoja respeta las correcciones', () => {
  it('1 · los chips de la ficha son texto: sans, 13 px, fondo paper-deep', () => {
    has('.dna-chips .chip,.dna-word-group .chip,.dna-colors .chip{font-family:var(--sans);font-size:var(--text-base);font-weight:var(--weight-medium);text-transform:none;letter-spacing:0}');
    has('.chip[data-tone="plain"]{background:var(--paper-deep);color:var(--ink);border-color:transparent}');
    // Los de "la marca NO usa" siguen en rojo tachado.
    has('.chip[data-tone="avoid"]{background:transparent;color:var(--danger);border-color:var(--danger);text-decoration:line-through}');
    // Y las etiquetas de sección siguen en mono chiquita.
    has('.dna-block-head h3{margin:0;font-family:var(--mono)');
    has('.dna-word-label{font-family:var(--mono)');
  });

  it('2 · el chip "Supuesto" no ocupa la celda: chico y a la izquierda', () => {
    has('.dna-block .chip[data-tone="assumption"]{align-self:flex-start;width:fit-content}');
  });

  it('4 · sugerencias en grilla de 2, a la izquierda, título 14/500 y detalle en una línea', () => {
    has('.home-suggests{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3)}');
    has('.home-suggest{display:flex;align-items:center;justify-content:flex-start;');
    has('.home-suggest-text strong{font-size:var(--text-md);font-weight:var(--weight-medium);');
    has('.home-suggest-text small{display:block;font-size:var(--text-sm);line-height:1.5;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}');
    // y una sola columna cuando la pantalla no da para dos.
    has('  .home-suggests{grid-template-columns:minmax(0,1fr)}');
  });

  it('5 · Primeros pasos: 300 px, texto en una línea, Probalo de 32 px y la X sin borde', () => {
    has('grid-template-columns:minmax(0,1fr) 300px');
    has('.first-step-label{flex:1;min-width:0;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}');
    has('.first-step-try{margin-top:0;height:var(--control-h-sm);min-height:var(--control-h-sm);');
    has('.first-steps-head .icon-button{border:0;background:transparent;color:var(--muted);padding:0;');
    has('width:var(--control-icon);height:var(--control-icon);min-width:var(--control-icon);min-height:var(--control-icon)}');
  });

  it('6 · los títulos de pantalla del ADN salen en serif', () => {
    has('.dna-sources h1,.dna-sources h2,.onboarding-dna h1,.dna-view h1{font-family:var(--serif);font-weight:400}');
    has('.dna-sources h2{font-size:var(--text-3xl);line-height:1.25;');
    // El título de Inicio y el de la ficha ya eran de la serif de marca.
    has('.home-ask-title{font-family:var(--serif)');
    has('.dna-card-brand{font-family:var(--serif)');
  });

  it('todo sigue saliendo de tokens: ni un color literal en el bloque', () => {
    expect(start, 'falta el bloque final del ADN').toBeGreaterThan(-1);
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const values = [...rules.matchAll(/:([^;}]+)[;}]/g)].map((match) => match[1].trim());
    expect(values.length).toBeGreaterThan(60);
    for (const value of values) expect(value, value).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });
});
