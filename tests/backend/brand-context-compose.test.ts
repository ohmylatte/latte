import { describe, expect, it } from 'vitest';
import { composeBrandContext } from '../../shared/brandContext';

describe('composeBrandContext', () => {
  it('replaces and appends the same way the UI preview and the service persist', () => {
    expect(composeBrandContext('Actual.', 'Nuevo.', 'replace')).toBe('Nuevo.');
    expect(composeBrandContext('Actual.  \n', 'Más.', 'append')).toBe('Actual.\n\nMás.');
    expect(composeBrandContext('   ', 'Primero.', 'append')).toBe('Primero.');
  });
});
