import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoleCatalog } from '../../electron/agents/roles';
import { reviewSpec } from '../../electron/coordination/engine';
import { loadInstructionPack } from '../../electron/workspace/packs';

/**
 * E3: REGLAS POR AUDIENCIA, NO MOLDES POR TIPO DE DOCUMENTO.
 *
 * El dueño, sobre la propuesta que le llegó a Vane: "es un documento
 * analítico, no para una cliente que me contrató para que yo tome decisiones
 * analíticas. Quiere saber qué voy a hacer, cuánto voy a gastar y qué esperar.
 * Punto." Un copy, un post y una propuesta no comparten estructura; lo que sí
 * comparten es para quién son. Las reglas viven en `skills/writing.md`
 * (castellano, para todos los roles) y la lista de verificación del revisor
 * en `roles/reviewer.md` (inglés). `base.md` no se toca: está en su techo.
 *
 * Chequeos léxicos: prueban que las reglas LLEGAN al texto que Latte compone,
 * no que un modelo las obedezca.
 */

const PACKS_DIR = path.resolve(__dirname, '..', '..', 'packs');
const pack = loadInstructionPack(PACKS_DIR, 'marketing-core');
const catalog = new RoleCatalog(pack);
const writing = pack?.skills.find((skill) => skill.id === 'writing')?.body ?? '';

/** El techo propio de la skill de escritura: la leen todos los roles antes de cada entregable. */
const WRITING_CEILING = 6_500;

describe('E3: writing.md dice cómo se escribe para el cliente y para el equipo', () => {
  const CLIENT_RULES: Array<[string, RegExp]> = [
    ['abre con qué, cuánto y qué esperar', /abrí con qué vamos a hacer, cuánto cuesta y qué esperar/i],
    ['sin rótulos internos', /sin rótulos internos/i],
    ['sin notas de la agencia', /notas para la agencia/i],
    ['el largo lo dicta el pedido', /el largo lo dicta el pedido/i],
    ['el análisis va aparte o se queda interno', /el análisis va aparte o se queda interno/i],
    ['una sola versión vigente', /una sola versión vigente/i],
    ['PDF al final, con fuentes incrustadas', /fuentes incrustadas/i],
    ['borradores, no entregables', /borradores\//],
  ];

  it('tiene la sección para el cliente, con cada regla', () => {
    expect(writing).toMatch(/^## Para el cliente/m);
    for (const [name, pattern] of CLIENT_RULES) expect(pattern.test(writing), `falta: ${name}`).toBe(true);
  });

  it('y la sección para el equipo, donde los rótulos son obligatorios', () => {
    expect(writing).toMatch(/^## Para el equipo/m);
    expect(writing).toMatch(/los rótulos son obligatorios/i);
    expect(writing).toMatch(/Hecho, Hipótesis, Decisión/);
  });

  it('no pone moldes por tipo de documento', () => {
    expect(writing).not.toMatch(/plantilla de propuesta|estructura obligatoria/i);
  });

  it('respeta su techo', () => {
    expect(writing.length).toBeLessThan(WRITING_CEILING);
  });

  it('y base.md sigue bajo el suyo', () => {
    expect((pack?.base ?? '').trim().length).toBeLessThan(7_500);
  });
});

describe('E3: el revisor tiene la lista de verificación de un entregable para el cliente', () => {
  const reviewer = catalog.promptFor('reviewer');
  const CHECKLIST: Array<[string, RegExp]> = [
    ['el encabezado de la lista', /## Client-deliverable checklist/],
    ['audiencia y registro', /audience and register/i],
    ['largo', /\*\*Length\*\*/],
    ['contradicciones internas', /contradictions/i],
    ['un tope que las estimaciones violan', /a cap that the estimates break/i],
    ['tablas partidas', /split across pages/i],
    ['notas internas filtradas', /internal notes/i],
    ['identidad aplicada', /logo, palette and type of the approved kit/i],
    ['o portada sin identidad', /no approved identity/i],
    ['extraer el texto del PDF', /pdftotext|pypdf/],
    ['acentos', /accents/i],
    ['veredicto', /verdict "pass" or "fail"/],
  ];

  it('cada punto de la lista está en el rol', () => {
    for (const [name, pattern] of CHECKLIST) expect(pattern.test(reviewer), `falta: ${name}`).toBe(true);
  });

  it('el pedido de revisión que arma el motor nombra la misma lista', () => {
    const spec = reviewSpec({ title: 'Propuesta para Vane', locale: 'es-AR', originalSpec: 'x', files: ['borradores/p.pdf'], summary: 'ok' });
    expect(spec).toContain('client-deliverable checklist of your role');
    expect(spec).toContain('El cliente lo lee para decidir: Propuesta para Vane');
  });
});
