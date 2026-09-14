import { describe, expect, it } from 'vitest';
import type { Brand, Work } from '../../shared/contracts';
import { renderInstructions, renderOutcomeContext, showsCurrentOutcome } from '../../electron/workspace/instructions';

const brand: Brand = { id: 'brd_client', name: 'Café', context: 'CONTEXTO_RELEVANTE', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null };
const work: Work = { id: 'wrk_client', brandId: brand.id, title: 'Propuesta', brief: 'BRIEF_UNICO', folder: null, expectedOutput: 'RESULTADO_UNICO PDF y Word', updatedAt: brand.createdAt };

describe('client document working rules', () => {
  it.each(['es-AR', 'en-US'] as const)('keeps relevant context and approval distinct from evidence in %s', (outputLanguage) => {
    const text = renderInstructions({ brand, work, decisions: [], outputLanguage });
    expect(text).toContain('relevant brand context, brief, expected output, source documents and approved decisions');
    expect(text).toContain('Keep evidence, hypotheses and pending choices distinct from approved decisions');
    expect(text).toContain(outputLanguage === 'es-AR' ? 'Spanish (Argentina)' : 'English (United States)');
    expect(text).toContain('Café');
  });

  it('requires real format validation and full visual QA rather than existence alone', () => {
    const text = renderInstructions({ brand, work, decisions: [] });
    expect(text).toContain('tools actually available');
    expect(text).toContain('Existence and size do not validate the format');
    expect(text).toContain('open or parse it with a format-appropriate tool');
    expect(text).toContain('render and visually inspect every page');
    expect(text).toContain('correct defects and repeat the checks before calling it ready');
    expect(text).toContain('report the blocker and exact QA scope');
    expect(text).toContain('never imply an unperformed check passed');
  });

  it('uses the human UI for review/linking without bypassing managed state', () => {
    const text = renderInstructions({ brand, work, decisions: [] });
    expect(text).toContain('Entregables / Deliverables');
    expect(text).toContain('Resultado esperado / Expected output');
    expect(text).toContain('If no agent tool is available for linking');
    expect(text).toContain('never edit SQLite or managed metadata');
    expect(text).toContain('do not claim it is linked until confirmed');
    expect(text).toContain('does not generate, validate, approve or version binary outputs');
  });

  it('keeps document QA in shared rules, without repeating source context or per-conversation instructions', () => {
    const text = renderInstructions({ brand, work, decisions: [] });
    for (const sentinel of ['CONTEXTO_RELEVANTE', 'BRIEF_UNICO', 'RESULTADO_UNICO', 'render and visually inspect every page']) {
      expect(text.split(sentinel)).toHaveLength(2);
    }
    expect(showsCurrentOutcome(text, work, undefined)).toBe(true);
    expect(showsCurrentOutcome(text, { ...work, expectedOutput: 'Nuevo PDF' }, undefined)).toBe(false);
    const conversation = renderOutcomeContext(work, undefined)!;
    expect(conversation).not.toContain('render and visually inspect every page');
    expect(conversation).not.toContain('CONTEXTO_RELEVANTE');
    expect(conversation).not.toContain('BRIEF_UNICO');
  });
});
