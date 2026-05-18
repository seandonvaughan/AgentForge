import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@agentforge/shared': resolve('./packages/shared/src/index.ts'),
      '@agentforge/core': resolve('./packages/core/src/index.ts'),
      '@agentforge/db': resolve('./packages/db/src/index.ts'),
      '@agentforge/embeddings': resolve('./packages/embeddings/src/index.ts'),
      '@agentforge/plugins-sdk': resolve('./packages/plugins-sdk/src/index.ts'),
      '@agentforge/executor': resolve('./packages/executor/src/index.ts'),
      '@agentforge/skills-catalog': resolve('./packages/skills-catalog/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/__tests__/*.test.ts'],
    exclude: ['tests/e2e/**/*.test.ts', '**/node_modules/**'],
    testTimeout: 15000,
    coverage: { provider: 'v8', reporter: ['text', 'json-summary'] },
    // Suppress root CLI deprecation warnings during unit tests so [compat]
    // notices don't pollute test output.  Set AGENTFORGE_SUPPRESS_DEPRECATION=1
    // explicitly in any process that invokes the root CLI directly (e.g. E2E
    // spawn helpers) to achieve the same effect there.
    env: { AGENTFORGE_SUPPRESS_DEPRECATION: '1' },
  }
});
