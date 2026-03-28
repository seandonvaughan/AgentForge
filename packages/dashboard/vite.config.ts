import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 4751,
    proxy: {
      // SSE stream — must not buffer
      '/api/v5/stream': {
        target: 'http://127.0.0.1:4750',
        changeOrigin: true,
      },
      // WebSocket upgrade
      '/api/v5/ws': {
        target: 'http://127.0.0.1:4750',
        changeOrigin: true,
        ws: true,
      },
      // All other API calls
      '/api': {
        target: 'http://127.0.0.1:4750',
        changeOrigin: true,
      },
    },
  },
});
