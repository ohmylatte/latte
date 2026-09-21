import { describe, expect, it } from 'vitest';
import { generatedEn, generatedEs } from './i18n-generated';

/**
 * B2.3: LAS TRADUCCIONES INGLESAS QUE NO DECIAN LO QUE DICE EL ESPANOL.
 *
 * `i18n-generated` sale de una pasada automatica sobre el copy que estaba
 * escrito a mano en los componentes, y esa pasada dejo calcos que en ingles
 * significan otra cosa: "Descartar" salio "Rule out", "Activo" salio "Asset",
 * "pedido" salio "order" (el de comprar, no el de pedir), "equipo" salio
 * "computer", "proveedor" salio "supplier", "estudio" salio "study" y cada
 * imperativo del voseo ("Elegi") salio en primera persona del pasado ("I
 * chose"). "Trabajo", que es el nombre del objeto central del producto, salio
 * "job" en la mitad del diccionario y "work" en la otra mitad.
 *
 * Este test fija las correcciones contra el diccionario, no contra la
 * pantalla: si alguien vuelve a generar el archivo y la pasada las pisa, esto
 * se pone en rojo en vez de dejar que se publiquen de nuevo en silencio.
 */

/** Cada par es [clave, lo que el ingles TIENE que decir]. */
const CORRECTED: ReadonlyArray<readonly [string, string]> = [
  ["ui.auto.005", "Context saved"],
  ["ui.auto.010", "Automatic mode on for this work. Latte approves every request without asking you."],
  ["ui.auto.011", "Automatic mode off. The next request asks you again."],
  ["ui.auto.012", "New conversation. The agent reads the work context again."],
  ["ui.auto.015", "Pick a work before opening a terminal: it opens in that work's folder."],
  ["ui.auto.029", "Expand the menu"],
  ["ui.auto.038", "New work"],
  ["ui.auto.040", "Work view"],
  ["ui.auto.065", "A space for your judgment"],
  ["ui.auto.071", "No work selected"],
  ["ui.auto.074", "Preview · localStorage"],
  ["ui.auto.076", "YOUR STUDIO, IN ORDER"],
  ["ui.auto.078", "A new work."],
  ["ui.auto.080", "WORK TITLE"],
  ["ui.auto.085", "work"],
  ["ui.auto.111", "of the work."],
  ["ui.auto.122", "Review"],
  ["ui.auto.138", "Changes saved"],
  ["ui.auto.145", "Create a brand and a work. The documents, versions and decisions stay with you."],
  ["ui.auto.146", "New work"],
  ["ui.auto.150", "Save"],
  ["ui.auto.153", "Document exported"],
  ["ui.auto.156", "We save the version of the file so that it is not lost. Pick which one stays as the current text; the other is still available in Versions."],
  ["ui.auto.159", "Save mine"],
  ["ui.auto.177", "ONE WORK, SEVERAL DELIVERABLES"],
  ["ui.auto.181", "TITLE"],
  ["ui.auto.182", "DOES IT BUILD ON ANOTHER DOCUMENT?"],
  ["ui.auto.187", "Bring files to this work"],
  ["ui.auto.213", "Pick a profile to see it."],
  ["ui.auto.224", "MAIN AGENT"],
  ["ui.auto.244", "A profile is a folder of its own for"],
  ["ui.auto.252", "CONNECT A PROVIDER"],
  ["ui.auto.253", "Provider"],
  ["ui.auto.254", "No providers available"],
  ["ui.auto.263", "How the team writes, across every work. A role is who does the work; a skill is the craft everyone shares."],
  ["ui.auto.267", "Open with the request"],
  ["ui.auto.274", "Remove from the team"],
  ["ui.auto.278", "Choose or create a work to build its team."],
  ["ui.auto.279", "Pick a team member to see their conversation."],
  ["ui.auto.280", "Permissions for this work"],
  ["ui.auto.283", "Latte says yes to everything the agent for this work asks, without asking you. It answers once per request: it leaves no saved permissions in any runtime, and turning it off asks again on the next request."],
  ["ui.auto.285", "Finished"],
  ["ui.auto.287", "The conversation is paused. When you resume it, the agent rereads the work's current context."],
  ["ui.auto.305", "Without this, an agent only sees the files of this work. With MCP it can also consult and operate external tools. Latte does not implement MCP or store credentials: it reads and writes each runtime's configuration, so what you add here will also be there when you use that CLI outside Latte."],
  ["ui.auto.339", "{p0} was left with the empty structure. I left the request prepared for {p1}: review it and send it."],
  ["ui.auto.343", "{p0} opened with the request loaded. Review it before sending it."],
  ["ui.auto.356", "You"],
  ["ui.auto.359", "INPUT"],
  ["ui.auto.371", "Search"],
  ["ui.auto.379", "Discard"],
  ["ui.auto.382", "MAIN"],
  ["ui.auto.398", "Off"],
  ["ui.auto.404", "Active"],
];

describe('el diccionario ingles generado', () => {
  it('dice en ingles lo mismo que dice el espanol, sin calcos', () => {
    for (const [key, expected] of CORRECTED) {
      expect(generatedEn[key as keyof typeof generatedEs], key).toBe(expected);
    }
  });

  it('no deja suelta ninguna de las palabras que delataban el calco', () => {
    // `order` (el de comprar) por `pedido`, `supplier` por `proveedor`,
    // `asset` por `activo`, `job` por `trabajo`, `rule out` por `descartar`.
    const offenders = /\b(orders?|suppliers?|asset|jobs?|rule out)\b/i;
    for (const [key, value] of Object.entries(generatedEn)) {
      // "IN ORDER" (el orden de un estudio ordenado) no es el `order` de comprar.
      if (/\bIN ORDER\b/i.test(value)) continue;
      expect(value, key).not.toMatch(offenders);
    }
  });

  it('tiene exactamente las mismas claves que el espanol: ninguna traduccion se perdio', () => {
    expect(Object.keys(generatedEn).sort()).toEqual(Object.keys(generatedEs).sort());
  });
});
