import { spawnSync } from 'node:child_process';
import { isCodexAuthenticated } from './codex-auth.js';
import { verifyCodexBinaryIdentity } from './transports/codex-cli-transport.js';
import type { ExecutionProviderKind } from './types.js';

/**
 * Whether a single provider is usable right now, plus a human-readable reason.
 * The reason is surfaced to operators and recorded so a fallback can explain
 * *why* a provider was skipped.
 */
export interface ProviderAvailability {
  available: boolean;
  reason: string;
}

export type ProviderAvailabilityMap = Record<ExecutionProviderKind, ProviderAvailability>;

/**
 * Injectable boolean probes for the signals that cannot be read from `env`
 * alone (CLI presence on PATH, Codex auth state). Defaults spawn real
 * subprocesses; tests inject pure functions so the probe never shells out.
 */
export interface ProviderProbeDeps {
  isClaudeCliAvailable: (env: NodeJS.ProcessEnv) => boolean;
  isCodexCliAvailable: (env: NodeJS.ProcessEnv) => boolean;
  isCodexAuthenticated: (env: NodeJS.ProcessEnv) => boolean;
}

export interface ProviderAvailabilityOptions {
  /** Cache lifetime in milliseconds. Defaults to 30s. */
  ttlMs?: number;
  /** Injectable clock for deterministic TTL tests. Defaults to Date.now. */
  now?: () => number;
  /** Override any subset of the real subprocess-backed probes. */
  probes?: Partial<ProviderProbeDeps>;
}

export interface ProviderAvailabilityProbe {
  get(env?: NodeJS.ProcessEnv): ProviderAvailabilityMap;
}

const DEFAULT_TTL_MS = 30_000;

function defaultIsClaudeCliAvailable(): boolean {
  const probe =
    process.platform === 'win32'
      ? spawnSync('where', ['claude'], { stdio: 'ignore', windowsHide: true })
      : spawnSync('which', ['claude'], { stdio: 'ignore', windowsHide: true });
  return probe.status === 0;
}

/**
 * Codex presence + identity probe: resolves the binary (AGENTFORGE_CODEX_BIN →
 * ~/.agentforge/bin/codex → PATH), runs `--version`, and requires the output
 * to look like the real Codex CLI. A wrong binary answering on PATH (incident:
 * macOS purged a /tmp shim and an unrelated homebrew `codex` took over)
 * reports unavailable — runs degrade to Claude instead of dying mid-cycle.
 * Identity verdicts are cached per-process inside the transport module.
 */
function defaultIsCodexCliAvailable(env: NodeJS.ProcessEnv): boolean {
  return verifyCodexBinaryIdentity({ env }).ok;
}

/**
 * File-based Codex auth detection (item 4): reads CODEX_HOME/auth.json contents
 * via resolveCodexAuth — no subprocess. Authenticated only when a usable, non-
 * expired credential is present.
 */
function defaultIsCodexAuthenticated(env: NodeJS.ProcessEnv): boolean {
  return isCodexAuthenticated(env);
}

function computeAvailability(
  env: NodeJS.ProcessEnv,
  deps: ProviderProbeDeps,
): ProviderAvailabilityMap {
  const hasAnthropicKey = Boolean(env['ANTHROPIC_API_KEY']);
  const hasOpenAiKey = Boolean(env['OPENAI_API_KEY']);
  const claudeCli = deps.isClaudeCliAvailable(env);
  const codexCli = deps.isCodexCliAvailable(env);

  return {
    'anthropic-sdk': hasAnthropicKey
      ? { available: true, reason: 'ANTHROPIC_API_KEY is set' }
      : { available: false, reason: 'ANTHROPIC_API_KEY is not set' },
    'openai-sdk': hasOpenAiKey
      ? { available: true, reason: 'OPENAI_API_KEY is set' }
      : { available: false, reason: 'OPENAI_API_KEY is not set' },
    'claude-code-compat': claudeCli
      ? { available: true, reason: 'claude CLI found on PATH' }
      : { available: false, reason: 'claude CLI not found on PATH' },
    'codex-cli': resolveCodexAvailability(env, deps, codexCli),
  };
}

function resolveCodexAvailability(
  env: NodeJS.ProcessEnv,
  deps: ProviderProbeDeps,
  codexCli: boolean,
): ProviderAvailability {
  if (!codexCli) {
    return {
      available: false,
      reason: 'codex CLI not found on PATH (or the resolved binary failed identity validation)',
    };
  }
  if (!deps.isCodexAuthenticated(env)) {
    return { available: false, reason: 'codex CLI is not authenticated (run: codex login)' };
  }
  return { available: true, reason: 'codex CLI authenticated' };
}

/**
 * Build a TTL-cached provider availability probe. The cache holds the last
 * computed map and re-evaluates only once the injected clock advances past the
 * TTL, so routing/auto-switch can ask "is this provider usable now?" per job
 * without re-probing (and re-spawning) every time.
 */
export function createProviderAvailabilityProbe(
  options: ProviderAvailabilityOptions = {},
): ProviderAvailabilityProbe {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const deps: ProviderProbeDeps = {
    isClaudeCliAvailable: options.probes?.isClaudeCliAvailable ?? defaultIsClaudeCliAvailable,
    isCodexCliAvailable: options.probes?.isCodexCliAvailable ?? defaultIsCodexCliAvailable,
    isCodexAuthenticated: options.probes?.isCodexAuthenticated ?? defaultIsCodexAuthenticated,
  };

  let cache: { value: ProviderAvailabilityMap; computedAt: number } | undefined;

  return {
    get(env: NodeJS.ProcessEnv = process.env): ProviderAvailabilityMap {
      const current = now();
      if (cache && current - cache.computedAt < ttlMs) {
        return cache.value;
      }
      const value = computeAvailability(env, deps);
      cache = { value, computedAt: current };
      return value;
    },
  };
}

let defaultProbe: ProviderAvailabilityProbe | undefined;

/**
 * Convenience entry point over a process-wide default probe (real subprocess
 * probes, real clock, default TTL). Pass `options` to get a transient,
 * isolated probe — used by tests and by callers that need their own cache.
 */
export function getProviderAvailability(
  env: NodeJS.ProcessEnv = process.env,
  options?: ProviderAvailabilityOptions,
): ProviderAvailabilityMap {
  if (options) {
    return createProviderAvailabilityProbe(options).get(env);
  }
  if (!defaultProbe) {
    defaultProbe = createProviderAvailabilityProbe();
  }
  return defaultProbe.get(env);
}
