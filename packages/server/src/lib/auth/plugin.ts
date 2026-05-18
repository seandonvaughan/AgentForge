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
const DEFAULT_EXCLUDE_PATHS = ["/api/v5/health"];

/**
 * Returns true if the given URL path should bypass authentication.
 *
 * Matching rules (in priority order):
 *   1. Exact match   — "/api/v5/health" matches only "/api/v5/health"
 *   2. Sub-path      — "/api/v5/health" also covers "/api/v5/health/live"
 *   3. Query string  — "/api/v5/health" also covers "/api/v5/health?check=1"
 *
 * A pure `startsWith` would incorrectly exclude "/api/v5/healthdata" when the
 * exclusion list contains "/api/v5/health" — that path-prefix collision is an
 * auth bypass. The checks below require a path separator or query delimiter
 * after the prefix, preventing unintended exclusions.
 */
export function isExcluded(path: string, excludePaths: string[]): boolean {
  return excludePaths.some(
    (prefix) =>
      path === prefix ||
      path.startsWith(prefix + '/') ||
      path.startsWith(prefix + '?'),
  );
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
        // RFC 6750 §3 requires WWW-Authenticate: Bearer on every 401 response.
        // Omitting it causes OAuth2-compliant clients to misclassify the failure.
        reply.header("WWW-Authenticate", 'Bearer realm="AgentForge"');
        await reply.status(401).send({
          error: "Unauthorized",
          message: "Missing or invalid Authorization header. Expected: Bearer <token>",
        });
        return;
      }

      const result = await validateToken(token, config);

      if (!result.valid) {
        // RFC 6750 §3: include error description when rejecting an invalid token.
        // Sanitise the error string (strip quotes) so it can be safely embedded in
        // the header challenge value without breaking the parameter syntax.
        const safeDesc = (result.error ?? "Invalid token").replace(/"/g, "'");
        reply.header(
          "WWW-Authenticate",
          `Bearer realm="AgentForge", error="invalid_token", error_description="${safeDesc}"`,
        );
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
  subject?: string | undefined;
  /** Space-separated OAuth2 scope string. */
  scope?: string | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the OAuth2 hook on successfully authenticated requests. */
    authContext?: AuthContext;
  }
}
