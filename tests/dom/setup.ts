import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// The dom project runs without `globals`, so Testing Library cannot hook its own
// auto-cleanup. Without this, the tree of one test leaks into the next and a
// query for "Contexto" starts matching the previous render.
afterEach(() => cleanup());
