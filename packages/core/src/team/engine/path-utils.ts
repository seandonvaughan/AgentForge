import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// AgentForge package-internal paths (templates, prompts, etc.)
// These ALWAYS point inside the AgentForge package installation, regardless
// of which external project is being forged.
// ---------------------------------------------------------------------------

function getRepositoryRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), '..', '..', '..', '..', '..');
}

export function getRepositoryTemplatesDir(): string {
  return join(getRepositoryRoot(), 'templates');
}

export function getRepositoryDomainsDir(): string {
  return join(getRepositoryTemplatesDir(), 'domains');
}

// ---------------------------------------------------------------------------
// Project-root resolution — resolves the EXTERNAL project that AgentForge is
// being run against.  This is distinct from the AgentForge installation root.
//
// Resolution order (first match wins):
//   1. `opts.explicit`       — `--project <path>` CLI flag
//   2. `AGENTFORGE_PROJECT_ROOT` env var  (or `opts.env.AGENTFORGE_PROJECT_ROOT`)
//   3. `opts.cwd` (or process.cwd())  if it contains a `.agentforge/` directory
//   4. Traverse upward from cwd to find an ancestor with `.agentforge/`
//   5. Error: "no project root found — run `agentforge init` first"
// ---------------------------------------------------------------------------

export class NoProjectRootError extends Error {
  constructor(searchRoot: string) {
    super(
      `No AgentForge project found at or above "${searchRoot}". ` +
        `Run \`agentforge init\` in your project directory first, or pass ` +
        `--project <path> / set AGENTFORGE_PROJECT_ROOT.`,
    );
    this.name = 'NoProjectRootError';
  }
}

export interface ResolveProjectRootOptions {
  /** An explicit path provided by the caller (e.g. from `--project` flag). */
  explicit?: string;
  /** Process environment to read `AGENTFORGE_PROJECT_ROOT` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Starting directory for cwd-based resolution. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Resolve the project root for an external project that AgentForge is being
 * run against.  See module-level comment for resolution order.
 *
 * @throws {NoProjectRootError} when no project can be found via any strategy.
 */
export function resolveProjectRoot(opts?: ResolveProjectRootOptions): string {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();

  // 1. Explicit flag
  if (typeof opts?.explicit === 'string' && opts.explicit.length > 0) {
    return resolve(opts.explicit);
  }

  // 2. Env var
  const envRoot = env['AGENTFORGE_PROJECT_ROOT'];
  if (typeof envRoot === 'string' && envRoot.length > 0) {
    return resolve(envRoot);
  }

  // 3. cwd itself has .agentforge/
  const resolvedCwd = resolve(cwd);
  if (existsSync(join(resolvedCwd, '.agentforge'))) {
    return resolvedCwd;
  }

  // 4. Traverse upward
  const candidate = traverseUpForAgentForge(resolvedCwd);
  if (candidate !== null) {
    return candidate;
  }

  // 5. Not found
  throw new NoProjectRootError(resolvedCwd);
}

/**
 * Walk up from `startDir` until we find a directory containing `.agentforge/`,
 * or we reach the filesystem root.  Returns `null` when nothing is found.
 */
function traverseUpForAgentForge(startDir: string): string | null {
  let current = startDir;
  const homeRoot = comparablePath(homedir());
  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding a match
      return null;
    }
    current = parent;
    if (comparablePath(current) === homeRoot) {
      return null;
    }
    if (existsSync(join(current, '.agentforge'))) {
      return current;
    }
  }
}

function comparablePath(path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(path);
  } catch {
    resolved = resolve(path);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
