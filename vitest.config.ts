import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@contracts': resolve('contracts'),
      '@shared': resolve('src/shared'),
      '@mocks': resolve('mocks'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'contracts/**/*.test.ts',
      'scripts/**/*.test.ts',
      'mocks/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    // `test/e2e/` was excluded through phases 1-4, which did not own it
    // (IMPLEMENTATION-PLAN.md §2). Phase 5 does, and its §5b audit lives there,
    // so it now runs as part of `npm test`.
    exclude: ['node_modules/**', 'out/**'],
  },
});
