import { describe, expect, it } from 'vitest';
import { NON_DERIVED_RESULTADOS, RESULTADO_TYPE_KEYS, resultadosSummary, type ResultadosInput } from './resultados-summary';
import type { Decision, Work } from '../shared/contracts';

/**
 * The pure core of the Resultados view.
 *
 * Only two classes are derivable here: `documento` (the linked `resultPath`)
 * and `decisión aprobada` (approved decisions of this work). `entregable` is
 * the self-fetching `Deliverables` panel. The other four — diagnóstico,
 * experimento, cambio ejecutado, medición — are declared but have NO producer
 * in this slice, so they are never invented. No DOM, no window: this module
 * only decides, `ResultadosView` only renders.
 */

const work = (patch: Partial<Pick<Work, 'id' | 'expectedOutput' | 'resultPath'>> = {}): Pick<Work, 'id' | 'expectedOutput' | 'resultPath'> => ({
  id: 'w1', expectedOutput: 'Un PDF de dos páginas', resultPath: 'propuesta.pdf', ...patch,
});

const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', workId: 'w1', text: 'Elegimos un tono cercano', rationale: '', alternativesRejected: [],
  evidenceRefs: [], status: 'pending',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '', decidedAt: null, ...patch,
});

const input = (patch: Partial<ResultadosInput> = {}): ResultadosInput => ({
  work: work(), decisions: [], ...patch,
});

describe('the resultado taxonomy', () => {
  it('names every class with a catalog key of its own', () => {
    expect(RESULTADO_TYPE_KEYS).toEqual({
      documento: 'resultados.documento',
      entregable: 'resultados.entregable',
      decision: 'resultados.decision',
      diagnostico: 'resultados.diagnostico',
      experimento: 'resultados.experimento',
      cambio: 'resultados.cambio',
      medicion: 'resultados.medicion',
    });
  });

  it('declares the four non-produced classes, never invents them', () => {
    expect(NON_DERIVED_RESULTADOS).toEqual(['diagnostico', 'experimento', 'cambio', 'medicion']);
  });
});

describe('the derived groups', () => {
  it('derives documento only when a resultPath is linked', () => {
    expect(resultadosSummary(input({ work: work({ resultPath: 'propuesta.pdf' }) })).documento).toEqual({
      expectedOutput: 'Un PDF de dos páginas',
      resultPath: 'propuesta.pdf',
    });
    expect(resultadosSummary(input({ work: work({ resultPath: null }) })).documento).toBeNull();
    expect(resultadosSummary(input({ work: work({ resultPath: '   ' }) })).documento).toBeNull();
  });

  it('trims the expectedOutput and keeps it null when absent', () => {
    expect(resultadosSummary(input({ work: work({ expectedOutput: '  Un PDF  ' }) })).documento?.expectedOutput).toBe('Un PDF');
    expect(resultadosSummary(input({ work: work({ expectedOutput: '', resultPath: 'propuesta.pdf' }) })).documento?.expectedOutput).toBeNull();
  });

  it('keeps only the approved decisions of this work', () => {
    const summary = resultadosSummary(input({
      decisions: [
        decision({ id: 'a1', status: 'approved', text: 'Aprobada' }),
        decision({ id: 'p1', status: 'pending', text: 'Pendiente' }),
        decision({ id: 'r1', status: 'rejected', text: 'Rechazada' }),
        decision({ id: 'x1', status: 'archived', text: 'Archivada' }),
        decision({ id: 'a2', workId: 'w2', status: 'approved', text: 'De otro trabajo' }),
      ],
    }));
    expect(summary.decisionesAprobadas.map((d) => d.id)).toEqual(['a1']);
  });

  it('carries the decidedAt so the view can date each approved decision', () => {
    const summary = resultadosSummary(input({
      decisions: [decision({ id: 'a1', status: 'approved', text: 'Aprobada', decidedAt: '2026-09-01T00:00:00.000Z' })],
    }));
    expect(summary.decisionesAprobadas).toEqual([{ id: 'a1', text: 'Aprobada', decidedAt: '2026-09-01T00:00:00.000Z' }]);
  });

  it('is pure: the same facts produce the same summary', () => {
    const facts = input({ decisions: [decision({ status: 'approved' })] });
    expect(resultadosSummary(facts)).toEqual(resultadosSummary(facts));
  });
});
