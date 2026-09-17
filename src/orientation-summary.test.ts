import { describe, expect, it } from 'vitest';
import { ORIENTATION_STEP_KEYS, orientationStep, orientationSummary, type OrientationInput } from './orientation-summary';

/**
 * The pure core of the orientation strip: which of the four loaded facts wins,
 * and how each absent one is told honestly. No DOM, no window: this module only
 * decides, the strip only renders.
 */

const input = (patch: Partial<OrientationInput> = {}): OrientationInput => ({
  brandContextDefined: true,
  pendingDecisions: 0,
  reviewDocuments: 0,
  expectedOutput: '',
  checking: false,
  ...patch,
});

describe('the next-step ladder', () => {
  it('starts with the brand: an empty context outranks every other pending thing', () => {
    expect(orientationStep({ brandContextDefined: false, pendingDecisions: 3, reviewDocuments: 2, checking: false })).toBe('brand');
  });

  it('puts pending decisions above documents to review', () => {
    expect(orientationStep({ brandContextDefined: true, pendingDecisions: 1, reviewDocuments: 5, checking: false })).toBe('decisions');
  });

  it('asks for a review only when nothing else is pending', () => {
    expect(orientationStep({ brandContextDefined: true, pendingDecisions: 0, reviewDocuments: 2, checking: false })).toBe('review');
  });

  it('says it is checking instead of claiming there is nothing pending', () => {
    expect(orientationStep({ brandContextDefined: true, pendingDecisions: 0, reviewDocuments: 0, checking: true })).toBe('checking');
  });

  it('never lets a running sweep mask a review that is already known', () => {
    expect(orientationStep({ brandContextDefined: true, pendingDecisions: 0, reviewDocuments: 3, checking: true })).toBe('review');
  });

  it('never lets a running sweep outrank the brand or the decisions', () => {
    expect(orientationStep({ brandContextDefined: false, pendingDecisions: 0, reviewDocuments: 0, checking: true })).toBe('brand');
    expect(orientationStep({ brandContextDefined: true, pendingDecisions: 2, reviewDocuments: 0, checking: true })).toBe('decisions');
  });

  it('is none only when the three facts are known and clear', () => {
    expect(orientationStep({ brandContextDefined: true, pendingDecisions: 0, reviewDocuments: 0, checking: false })).toBe('none');
  });

  it('names every rung with a catalog key of its own', () => {
    expect(ORIENTATION_STEP_KEYS).toEqual({
      brand: 'orientation.next.brand',
      decisions: 'orientation.next.decisions',
      review: 'orientation.next.review',
      checking: 'orientation.next.checking',
      none: 'orientation.next.none',
    });
  });
});

describe('the summary the strip renders', () => {
  it('states the brand status, never the brand name', () => {
    expect(orientationSummary(input({ brandContextDefined: false })).brandStateKey).toBe('context.state.empty');
    expect(orientationSummary(input({ brandContextDefined: true })).brandStateKey).toBe('context.state.defined');
  });

  it('turns an absent expected output into null, and trims the one there is', () => {
    expect(orientationSummary(input({ expectedOutput: '' })).expectedOutput).toBeNull();
    expect(orientationSummary(input({ expectedOutput: '   ' })).expectedOutput).toBeNull();
    expect(orientationSummary(input({ expectedOutput: '  Un PDF  ' })).expectedOutput).toBe('Un PDF');
  });

  it('reports a review count of null only while the first sweep has not answered', () => {
    expect(orientationSummary(input({ checking: true, reviewDocuments: 0 })).reviewDocuments).toBeNull();
    expect(orientationSummary(input({ checking: false, reviewDocuments: 0 })).reviewDocuments).toBe(0);
    expect(orientationSummary(input({ checking: true, reviewDocuments: 4 })).reviewDocuments).toBe(4);
    expect(orientationSummary(input({ checking: false, reviewDocuments: 4 })).reviewDocuments).toBe(4);
  });

  it('passes the pending decisions through unchanged', () => {
    expect(orientationSummary(input({ pendingDecisions: 3 })).pendingDecisions).toBe(3);
  });

  it('carries the step, its key and its params, with numbers the plural branch can read', () => {
    const decisions = orientationSummary(input({ pendingDecisions: 2 }));
    expect(decisions.step).toBe('decisions');
    expect(decisions.stepKey).toBe('orientation.next.decisions');
    expect(decisions.stepParams).toEqual({ count: 2 });

    const review = orientationSummary(input({ reviewDocuments: 1 }));
    expect(review.step).toBe('review');
    expect(review.stepKey).toBe('orientation.next.review');
    expect(review.stepParams).toEqual({ count: 1 });
  });

  it('asks for no params in the steps that take none', () => {
    expect(orientationSummary(input({ brandContextDefined: false })).stepParams).toEqual({});
    expect(orientationSummary(input({ checking: true })).stepParams).toEqual({});
    expect(orientationSummary(input()).stepParams).toEqual({});
  });

  it('is pure: the same facts produce the same summary', () => {
    const facts = input({ brandContextDefined: false, pendingDecisions: 1, reviewDocuments: 2, expectedOutput: 'Un PDF' });
    expect(orientationSummary(facts)).toEqual(orientationSummary(facts));
  });
});
