import type { Handle } from '@sveltejs/kit';

/**
 * Backend API base URL.
 *
 * In Vite dev mode the `vite.config.ts` proxy intercepts all `/api/*` traffic
 * and forwards it to the Fastify server before SvelteKit even sees the
 * request, so this hook is effectively a no-op during development.
 *
 * In production (adapter-node built server) the Vite proxy is absent.
 * This hook fills that gap by forwarding every `/api/*` request to the
 * co-located Fastify backend. Override the target with the `API_BASE_URL`
 * environment variable when backend and dashboard run on different hosts.
 */
const API_BASE_URL = process.env['API_BASE_URL'] ?? 'http://127.0.0.1:4750';

export const handle: Handle = async ({ event, resolve }) => {
  if (event.url.pathname.startsWith('/api/')) {
    const target = `${API_BASE_URL}${event.url.pathname}${event.url.search}`;

    // Buffer the request body so we can re-send it to Fastify.
    // GET and HEAD requests must not include a body per the HTTP spec.
    const isBodyless = event.request.method === 'GET' || event.request.method === 'HEAD';
    const body = isBodyless ? undefined : await event.request.arrayBuffer();

    // Forward request headers as-is (includes Content-Type, Authorization, etc.)
    const headers = new Headers(event.request.headers);
    // Remove the host header so Fastify sees its own host, not the SvelteKit host.
    headers.delete('host');

    try {
      const upstream = await fetch(target, {
        method: event.request.method,
        headers,
        body,
      });
      // Return a clean Response so SvelteKit's response pipeline is not
      // confused by the upstream connection object.
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch {
      return new Response(JSON.stringify({ error: 'Backend unreachable', target }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return resolve(event);
};
