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
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/__tests__/*.test.ts'],
    testTimeout: 15000,
    coverage: { provider: 'v8', reporter: ['text', 'json-summary'] }
  }
});
