import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { MomentoDeValorCard } from './MomentoDeValor';
import type { MomentoDeValorSummary } from './momento-de-valor';

/**
 * ENTREGA 1A: LA TARJETA DE MOMENTO DE VALOR, POR PROPS.
 *
 * Ninguna cifra en esta tarjeta se escribe a mano: todas salen de `summary`,
 * así que un cambio en `momento-de-valor.ts` que deje de contar algo se nota
 * acá, no sólo en el módulo puro.
 */
const summary = (patch: Partial<MomentoDeValorSummary> = {}): MomentoDeValorSummary => ({
  workId: 'w1', documentCount: 3, reviewCount: 1, approvedCount: 1, decisionCount: 2, brandContextDefined: true, ...patch,
});

function mount(patch: Partial<MomentoDeValorSummary> = {}, handlers: Partial<{ onViewResult: () => void; onReviewDecisions: () => void; onContinue: () => void }> = {}) {
  const onViewResult = handlers.onViewResult ?? vi.fn();
  const onReviewDecisions = handlers.onReviewDecisions ?? vi.fn();
  const onContinue = handlers.onContinue ?? vi.fn();
  const view = render(<I18nProvider><MomentoDeValorCard summary={summary(patch)} onViewResult={onViewResult} onReviewDecisions={onReviewDecisions} onContinue={onContinue} /></I18nProvider>);
  return { view, onViewResult, onReviewDecisions, onContinue };
}

describe('MomentoDeValorCard: el cierre del primer resultado, sólo con datos reales', () => {
  it('dice qué usó Latte con las cifras reales, nunca un genérico', () => {
    const { view } = mount();
    expect(view.getByText(/el contexto de tu marca/)).toBeDefined();
    expect(view.getByText(/3 documentos/)).toBeDefined();
    expect(view.getByText(/2 decisiones registradas/)).toBeDefined();
  });

  it('sin contexto de marca, lo dice tal cual: nunca inventa uno', () => {
    const { view } = mount({ brandContextDefined: false });
    expect(view.getByText(/sin contexto de marca todavía/)).toBeDefined();
  });

  it('lo producido sólo aparece cuando hay algo que contar', () => {
    const { view } = mount({ reviewCount: 0, approvedCount: 0 });
    expect(view.queryByText(/Y produjo/)).toBeNull();
  });

  it('las tres acciones llaman a su callback', () => {
    const { view, onViewResult, onReviewDecisions, onContinue } = mount();
    fireEvent.click(view.getByRole('button', { name: 'Ver resultado' }));
    fireEvent.click(view.getByRole('button', { name: 'Revisar decisiones' }));
    fireEvent.click(view.getByRole('button', { name: 'Continuar con el próximo paso' }));
    expect(onViewResult).toHaveBeenCalledTimes(1);
    expect(onReviewDecisions).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
