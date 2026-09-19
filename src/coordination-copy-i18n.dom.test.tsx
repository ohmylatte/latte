import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatMessage, type MessageKey } from './i18n';

/**
 * U8: en los archivos de coordinación no queda copy escrito a mano.
 *
 * `TeamPanel.tsx` y `DecisionsView.tsx` tenían una docena de frases en
 * castellano incrustadas en el JSX — `'Te necesita'`, `'En pausa'`,
 * `aria-label="Proveedores de IA"`, `placeholder="Elegimos? porque?"`,
 * `"CRITERIO QUE PERMANECE"` —, así que la interfaz en inglés mostraba media
 * pantalla en castellano y nadie podía traducirlas sin tocar el componente.
 *
 * El test escanea el FUENTE, no el render: un literal nuevo lo rompe aunque
 * caiga en una rama que ningún test monta. Se corta por `/\r?\n/` (el repo es
 * CRLF: buscar un `\n` literal no matchea nunca) y cada aserción falla cuando
 * no encuentra su ancla, en vez de pasar por vacío.
 */

const FILES = ['TeamPanel.tsx', 'DecisionsView.tsx'];

/** Las líneas de código, sin comentarios: un comentario en castellano es documentación, no copy. */
function codeLines(file: string): string[] {
  const source = readFileSync(join(process.cwd(), 'src', file), 'utf8');
  const lines = source.split(/\r?\n/);
  expect(lines.length).toBeGreaterThan(50); // el archivo existe y se leyó de verdad
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlock = true; continue; }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    // Un comentario JSX de una línea (`{/* ... */}`) también es documentación.
    if (trimmed.startsWith('{/*') && trimmed.endsWith('*/}')) continue;
    out.push(line);
  }
  return out;
}

describe('U8: el copy de coordinación vive en los diccionarios', () => {
  // Las frases exactas que estaban incrustadas. Una lista literal, no una
  // regex floja: `/empty|vac/` también matchea "vacuum".
  const LITERALS = [
    'Te necesita', 'En pausa', 'Abriendo', 'Buscando agentes', 'Buscando modelos',
    'Volver a comprobar', 'por defecto', 'Modelos configurados', 'Marcar como finalizado',
    'Proveedores de IA', 'Agentes y proveedores', 'ese rol no existe en Latte',
    'CRITERIO QUE PERMANECE', 'No empezar', 'de cero otra vez', 'Elegimos', 'vea esto',
  ];

  for (const file of FILES) {
    it(`${file} no tiene ninguna de las frases que estaban a mano`, () => {
      const lines = codeLines(file);
      const offenders: string[] = [];
      for (const line of lines) {
        for (const literal of LITERALS) {
          if (line.includes(literal)) offenders.push(`${literal} :: ${line.trim()}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${file} no tiene un aria-label, title ni placeholder con una cadena literal`, () => {
      const offenders = codeLines(file).filter((line) => /(?:aria-label|title|placeholder)=["']/.test(line));
      expect(offenders.map((l) => l.trim())).toEqual([]);
    });
  }

  // Y las claves nuevas existen en los DOS diccionarios: una clave que sólo
  // está en castellano deja la interfaz en inglés mostrando la clave cruda.
  const NEW_KEYS: MessageKey[] = [
    'team.status.attention', 'team.status.paused', 'team.opening', 'team.checkingAgents',
    'team.checkingModels', 'team.recheck', 'team.providers.label', 'team.providers.title',
    'team.finish.label', 'team.rolePicker.group', 'team.model.isDefault',
    'team.model.openCodeDetail', 'team.model.openCodeDefault',
    'handoff.unknownRole', 'handoff.wants',
    'decision.kicker', 'decision.headline.first', 'decision.headline.second', 'decision.draftPlaceholder',
    'coordination.run.finished.done', 'coordination.run.finished.cancelled', 'coordination.run.planning',
    'coordination.proposal.unreadable', 'coordination.budget.editLabel', 'coordination.budget.save',
  ];

  /**
   * F11b: las claves cuyo castellano y cuyo inglés coinciden A PROPÓSITO.
   *
   * El test prometía "y no son el mismo texto por olvido" y nunca comparaba
   * uno con el otro: una clave copiada y pegada del diccionario castellano al
   * inglés pasaba sin que nadie se enterara, que es exactamente el olvido que
   * el título nombra. La comparación existe ahora, y lo que legítimamente
   * coincide se declara acá, clave por clave, con su razón — una lista
   * explícita que hay que ampliar a mano, nunca una excepción genérica.
   *
   * Hoy está VACÍA: ninguna de estas claves coincide. En el diccionario entero
   * sí hay coincidencias legítimas (`question.option.instagram`,
   * `trabajo.runtime`: nombres propios y préstamos), que es exactamente el tipo
   * de entrada que va acá cuando alguna caiga en esta lista.
   */
  const SAME_IN_BOTH = new Map<MessageKey, string>([]);

  it('cada clave nueva tiene texto propio en los dos idiomas, y no son el mismo texto por olvido', () => {
    expect(NEW_KEYS.length).toBeGreaterThan(20);
    for (const key of NEW_KEYS) {
      const es = formatMessage('es-AR', key, { done: 1, failed: 2, pending: 3, suffix: '', model: 'x' });
      const en = formatMessage('en-US', key, { done: 1, failed: 2, pending: 3, suffix: '', model: 'x' });
      expect(es, `falta el castellano de ${key}`).not.toBe(key);
      expect(en, `falta el inglés de ${key}`).not.toBe(key);
      expect(es.trim().length, `castellano vacío en ${key}`).toBeGreaterThan(0);
      expect(en.trim().length, `inglés vacío en ${key}`).toBeGreaterThan(0);
      if (SAME_IN_BOTH.has(key)) {
        expect(es, `${key} está en la lista de coincidencias legítimas (${SAME_IN_BOTH.get(key)}) pero YA NO coincide: sacala de la lista`).toBe(en);
      } else {
        expect(es, `${key} tiene el MISMO texto en los dos idiomas: o falta traducirlo, o va declarado en SAME_IN_BOTH con su razón`).not.toBe(en);
      }
    }
  });
});
