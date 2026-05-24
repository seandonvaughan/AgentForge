import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';
export default defineConfig({
    plugins: [sveltekit(), svelteTesting()],
    test: {
        environment: 'happy-dom',
        globals: true,
        include: ['src/**/*.test.ts', 'src/**/*.test.js'],
    },
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
