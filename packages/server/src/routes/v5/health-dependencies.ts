import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DependencyStatus = 'up' | 'degraded' | 'down';

export interface DependencyCheck {
  name: string;
  url: string;
  status: DependencyStatus;
  lastCheckTs: string;
  latencyMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// In-memory cache — results are cached for 30 seconds
// ---------------------------------------------------------------------------

interface CacheEntry {
  ts: number;
  results: DependencyCheck[];
}

const CACHE_TTL_MS = 30_000;

/** Exported for test reset. */
export let _dependencyCache: CacheEntry | null = null;

export function _resetDependencyCache(): void {
  _dependencyCache = null;
}

// ---------------------------------------------------------------------------
// Fetch wrapper type — injectable for testing
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Dependency probe definitions
// ---------------------------------------------------------------------------

export interface DependencyDefinition {
  name: string;
  url: string;
  /** HTTP method to use for the probe. Default: HEAD */
  method?: string;
  /**
   * Accepted status codes that indicate "up" — any status code in this set
   * means the service is reachable. Default: [200, 401, 403, 405, 301, 302].
   *
   * For Anthropic API: a 401 means "server is up, credentials missing" → UP.
   */
  upStatusCodes?: Set<number>;
}

const DEFAULT_UP_STATUS_CODES = new Set([200, 401, 403, 405, 301, 302]);

const DEPENDENCIES: DependencyDefinition[] = [
  {
    name: 'Anthropic API',
    url: 'https://api.anthropic.com/v1/messages',
    method: 'HEAD',
    // 401 = server reachable (no auth), 405 = method not allowed (HEAD not supported)
    upStatusCodes: new Set([200, 401, 403, 405]),
  },
  {
    name: 'GitHub API',
    url: 'https://api.github.com',
    method: 'HEAD',
    upStatusCodes: DEFAULT_UP_STATUS_CODES,
  },
  {
    name: 'npm Registry',
    url: 'https://registry.npmjs.org',
    method: 'HEAD',
    upStatusCodes: DEFAULT_UP_STATUS_CODES,
  },
  {
    name: 'Anthropic Files API',
    url: 'https://api.anthropic.com/v1/files',
    method: 'HEAD',
    upStatusCodes: new Set([200, 401, 403, 405]),
  },
];

// ---------------------------------------------------------------------------
// Check function
// ---------------------------------------------------------------------------

/** Probe a single dependency. Uses a 5-second timeout. */
export async function probeDependency(
  def: DependencyDefinition,
  fetchFn: FetchFn,
): Promise<DependencyCheck> {
  const startMs = Date.now();
  const upCodes = def.upStatusCodes ?? DEFAULT_UP_STATUS_CODES;
  const method = def.method ?? 'HEAD';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);

    let status: number;
    try {
      const response = await fetchFn(def.url, {
        method,
        signal: controller.signal,
        // Don't follow redirects — just check connectivity
        redirect: 'manual',
      });
      status = response.status;
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - startMs;
    const isUp = upCodes.has(status);

    const result: DependencyCheck = {
      name: def.name,
      url: def.url,
      status: isUp ? 'up' : 'degraded',
      lastCheckTs: new Date().toISOString(),
      latencyMs,
    };

    if (!isUp) {
      result.error = `Unexpected HTTP status: ${status}`;
    }

    return result;
  } catch (err: unknown) {
    const latencyMs = Date.now() - startMs;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const errorMsg = isAbort
      ? 'Connection timed out after 5s'
      : err instanceof Error
        ? err.message
        : String(err);

    return {
      name: def.name,
      url: def.url,
      status: 'down',
      lastCheckTs: new Date().toISOString(),
      latencyMs,
      error: errorMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerHealthDependenciesRoutes(
  app: FastifyInstance,
  opts: { fetchFn?: FetchFn } = {},
): void {
  const fetchFn: FetchFn = opts.fetchFn ?? globalThis.fetch;

  /**
   * GET /api/v5/health/dependencies
   *
   * Returns status of external dependencies: Anthropic API, GitHub API,
   * npm registry, and Anthropic Files API. Results are cached for 30 seconds.
   *
   * Each item: { name, url, status ("up"|"degraded"|"down"), lastCheckTs, latencyMs, error? }
   */
  app.get('/api/v5/health/dependencies', async (_req, reply) => {
    const now = Date.now();

    // Return cached result if fresh
    if (_dependencyCache !== null && now - _dependencyCache.ts < CACHE_TTL_MS) {
      return reply.send({
        data: _dependencyCache.results,
        meta: {
          cached: true,
          cacheAgeMs: now - _dependencyCache.ts,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Run all probes in parallel
    const results = await Promise.all(
      DEPENDENCIES.map(def => probeDependency(def, fetchFn)),
    );

    // Update cache
    _dependencyCache = { ts: now, results };

    return reply.send({
      data: results,
      meta: {
        cached: false,
        cacheAgeMs: 0,
        timestamp: new Date().toISOString(),
      },
    });
  });
}
