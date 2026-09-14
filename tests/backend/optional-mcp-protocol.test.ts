import { describe, expect, it } from 'vitest';
import type { Brand, Work } from '../../shared/contracts';
import { renderInstructions, renderOutcomeContext, showsCurrentOutcome } from '../../electron/workspace/instructions';

const brand: Brand = { id: 'brd_mcp', name: 'Café', context: 'BRAND_ONCE', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null };
const work: Work = { id: 'wrk_mcp', brandId: brand.id, title: 'Trabajo', brief: 'BRIEF_ONCE', folder: null, expectedOutput: 'OUTCOME_ONCE', updatedAt: brand.createdAt };
const render = () => renderInstructions({ brand, work, decisions: [] });

describe('optional MCP working rules', () => {
  it.each(['es-AR', 'en-US'] as const)('keeps MCP optional and human-configured in %s', (outputLanguage) => {
    const text = renderInstructions({ brand, work, decisions: [], outputLanguage });
    expect(text).toContain('MCP is optional');
    expect(text).toContain('actually exposed by the current runtime and configured by the human');
    expect(text).toContain('never assume a provider or preinstalled server');
    expect(text).toContain('blocks only that external action');
    expect(text).toContain('Herramientas (MCP) / Tools (MCP)');
    expect(text).toContain('continue ordinary local work');
    expect(text).toContain(outputLanguage === 'es-AR' ? 'Spanish (Argentina)' : 'English (United States)');
    expect(text).toContain('Café');
  });

  it('separates planning, business authorization and real execution', () => {
    const text = render();
    expect(text).toContain('Distinguish a request to plan from a request to execute');
    expect(text).toContain('confirm scope, target account, budget and business authorization');
    expect(text).toContain('Technical tool permissions are not business authorization');
    expect(text).toContain('wait for the human');
    expect(text).toContain('execute with the real tool rather than substituting Markdown');
    expect(text).toContain('never invent a tool call or success');
  });

  it('requires remote reconciliation and secret-free evidence', () => {
    const text = render();
    expect(text).toContain('query remote state after the action');
    expect(text).toContain('A timeout is not proof of failure');
    expect(text).toContain('do not retry blindly');
    expect(text).toContain('report the outcome as unconfirmed');
    expect(text).toContain('result files in ./entregables/');
    expect(text).toContain('remote IDs, observed status and pending steps');
    expect(text).toContain('never include credentials or secrets');
  });

  it('uses bounded existing context without another prompt framework', () => {
    const text = render();
    expect(text).toContain('Use only the relevant brief, approved decisions, files and expected output');
    for (const marker of ['BRAND_ONCE', 'BRIEF_ONCE', 'OUTCOME_ONCE', 'MCP is optional']) {
      expect(text.split(marker)).toHaveLength(2);
    }
    expect(showsCurrentOutcome(text, work, undefined)).toBe(true);
    expect(renderOutcomeContext(work, undefined)).not.toContain('MCP is optional');
  });
});
