import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Two projects, one command.
//
// `node` is everything that shipped before: backend tests plus the frontend
// unit tests, which stub the browser globals they need themselves. It is kept
// byte-for-byte identical to the single-project config it replaced.
//
// `dom` is the regression net for the renderer. It only picks up
// `*.dom.test.tsx`, so a component test that needs a real document (and the
// actual React tree) cannot silently run in Node and pass by accident.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/backend/**/*.test.ts', 'tests/integration/**/*.test.ts', 'src/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        // React is needed for the JSX transform of `src/*.tsx`; the app uses the
        // same plugin, so a component that renders here renders there.
        plugins: [react()],
        test: {
          name: 'dom',
          include: ['src/**/*.dom.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./tests/dom/setup.ts'],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
