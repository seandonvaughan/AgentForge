/**
 * OAuth2 authentication hook factory for the AgentForge Fastify server.
 *
 * Design note on encapsulation:
 *   Fastify plugins registered via app.register() create an encapsulated scope.
 *   Hooks inside that scope apply ONLY to routes also registered in that scope.
 *   Since our 404 handler and health route live in the ROOT scope, they would
 *   not be covered by a plugin-scoped hook.
 *
 *   We therefore export a hook factory (registerOAuth2Hook) rather than a
 *   Fastify plugin, and the caller registers it directly on the root app instance.
 *   This guarantees the hook runs for every request — matched routes, 404s, and
 *   the SPA catch-all alike.
 *
 * Usage in server.ts:
 *   registerOAuth2Hook(app, { mode: "jwt", jwtSecret: "..." });
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { OAuth2Config } from "./types.js";
import { extractBearerToken, validateToken } from "./oauth2-validator.js";

export interface OAuth2PluginOptions {
  config: OAuth2Config;
}

/** Default paths that bypass authentication. */
const DEFAULT_EXCLUDE_PATHS = ["/api/v1/health"];

/**
 * Returns true if the given URL path should bypass authentication.
 * Matching is prefix-based, so "/api/v1/health" also covers "/api/v1/health/live".
 */
export function isExcluded(path: string, excludePaths: string[]): boolean {
  return excludePaths.some((prefix) => path.startsWith(prefix));
}

/**
 * Registers the OAuth2 onRequest hook directly on the given Fastify instance.
 *
 * Must be called on the ROOT app instance (not inside app.register()) to ensure
 * the hook applies to all routes including 404 handlers.
 *
 * When config.mode is "disabled", no hook is registered.
 */
export function registerOAuth2Hook(
  app: FastifyInstance,
  config: OAuth2Config,
): void {
  if (config.mode === "disabled") {
    return;
  }

  const excludePaths = config.excludePaths ?? DEFAULT_EXCLUDE_PATHS;

  // onRequest is the first lifecycle stage — it runs before route matching,
  // body parsing, and any handler. This ensures auth is checked even for
  // requests that would result in 404.
  app.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const path = request.url.split("?")[0] ?? request.url;

      // Only protect /api/ paths; SPA and static assets are public
      if (!path.startsWith("/api/")) return;

      // Skip configured exclusions (health check, public endpoints, etc.)
      if (isExcluded(path, excludePaths)) return;

      const token = extractBearerToken(request.headers["authorization"]);

      if (!token) {
        await reply.status(401).send({
          error: "Unauthorized",
          message: "Missing or invalid Authorization header. Expected: Bearer <token>",
        });
        return;
      }

      const result = await validateToken(token, config);

      if (!result.valid) {
        await reply.status(401).send({
          error: "Unauthorized",
          message: result.error ?? "Invalid token",
        });
        return;
      }

      // Attach auth context so downstream handlers can read the authenticated identity
      request.authContext = {
        subject: result.subject,
        scope: result.scope,
      };
    },
  );
}

/**
 * @deprecated Use registerOAuth2Hook instead.
 *
 * Kept as a Fastify plugin shim for backward compatibility.
 * Note: this plugin shim does NOT cover routes outside its encapsulated scope.
 */
export async function oauth2Plugin(
  app: FastifyInstance,
  opts: OAuth2PluginOptions,
): Promise<void> {
  registerOAuth2Hook(app, opts.config);
}

// ---------------------------------------------------------------------------
// Type augmentation — extend FastifyRequest with authContext
// ---------------------------------------------------------------------------

/** Auth context attached to authenticated requests. */
export interface AuthContext {
  /** The authenticated subject (sub claim or equivalent). */
  subject?: string;
  /** Space-separated OAuth2 scope string. */
  scope?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the OAuth2 hook on successfully authenticated requests. */
    authContext?: AuthContext;
  }
}
