import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

// Parameterized so a second dashboard instance can monitor another project's
// API server (e.g. `AGENTFORGE_DASHBOARD_PORT=4761 AGENTFORGE_API_TARGET=http://127.0.0.1:4760
// pnpm --filter @agentforge/dashboard dev` against an external-repo server
// started with `agentforge start --port 4760 --project-root <path>`).
// Defaults preserve the canonical 4751 → 4750 wiring.
const API_TARGET = process.env['AGENTFORGE_API_TARGET'] ?? 'http://127.0.0.1:4750';
const DASHBOARD_PORT = Number(process.env['AGENTFORGE_DASHBOARD_PORT'] ?? 4751);

export default defineConfig({
  plugins: [sveltekit(), svelteTesting()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.js'],
  },
  server: {
    port: DASHBOARD_PORT,
    proxy: {
      // SSE stream — must not buffer
      '/api/v5/stream': {
        target: API_TARGET,
        changeOrigin: true,
      },
      // WebSocket upgrade
      '/api/v5/ws': {
        target: API_TARGET,
        changeOrigin: true,
        ws: true,
      },
      // All other API calls
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
