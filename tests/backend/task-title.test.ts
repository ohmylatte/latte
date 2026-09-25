import { describe, expect, it } from 'vitest';
import { taskTitle, TASK_TITLE_LONG } from '../../shared/taskTitle';

/**
 * N2: el título de una tarea no es el bloque de contexto con el que el
 * coordinador arranca el pedido. El spec real de la captura del dueño.
 */
const AYULEM = [
  'CONTEXTO. Ayulem Pastelería, cliente nuevo (arranque 2026-09-14). Hoy es 2026-09-24. Mes 1 prioriza el canal mayorista y la segmentación en Meta.',
  '',
  'Tarea: Estrategia de captación mayorista para Meta Ads, con segmentos y presupuesto del mes 1.',
  'Entregable: estrategia-mayorista.md',
].join('\n');

describe('taskTitle', () => {
  it('el spec real: salta el CONTEXTO y toma la línea "Tarea:"', () => {
    expect(taskTitle(AYULEM)).toBe('Estrategia de captación mayorista para Meta Ads, con segment…');
    expect(taskTitle(AYULEM, null, TASK_TITLE_LONG)).toBe('Estrategia de captación mayorista para Meta Ads, con segmentos y presupuesto del mes 1.');
  });

  it('sin línea "Tarea:": la primera que no es preámbulo', () => {
    const spec = 'CONTEXTO. Ayulem, cliente nuevo.\nContexto: seguimos con lo de ayer.\n# Calendario\n**De:** Asistente\nArmá el calendario de octubre.\nDetalle.';
    expect(taskTitle(spec)).toBe('Armá el calendario de octubre.');
    expect(taskTitle('Context: brand launch.\r\nTask: Write three posts')).toBe('Write three posts');
    expect(taskTitle('CONTEXT. New client.\nDraft the media plan')).toBe('Draft the media plan');
  });

  it('el título que trajo la propuesta gana', () => {
    expect(taskTitle(AYULEM, 'Estrategia mayorista')).toBe('Estrategia mayorista');
    expect(taskTitle(AYULEM, '   ')).toBe('Estrategia de captación mayorista para Meta Ads, con segment…');
  });

  it('todo preámbulo: cae en la primera línea, sin el numeral', () => {
    expect(taskTitle('# Producir 14 piezas Feed y Story')).toBe('Producir 14 piezas Feed y Story');
    expect(taskTitle('CONTEXTO. Sólo contexto.')).toBe('CONTEXTO. Sólo contexto.');
  });

  it('una línea común no se toca, y vacío es vacío', () => {
    expect(taskTitle('Piezas publicitarias Meta')).toBe('Piezas publicitarias Meta');
    expect(taskTitle('')).toBe('');
    expect(taskTitle(null)).toBe('');
  });
});
