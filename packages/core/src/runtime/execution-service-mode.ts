import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import type { RuntimeMode } from './types.js';
import {
  buildCodexSpawnCommand,
  type CodexSpawnCommandOptions,
} from './transports/codex-cli-transport.js';

/**
 * Runtime mode settings accepted from env/config.
 *
 * Compatibility aliases:
 * - `'sdk'` means `'anthropic-sdk'`.
 * - `'cli'` means `'claude-cli'`.
 * - `'claude-code-compat'` is retained for older config/tests.
 */
export type ExecutionServiceMode = RuntimeMode;

/** All valid string values accepted in the env var or config file. */
const VALID_MODES = new Set<ExecutionServiceMode>([
  'auto',
  'sdk',
  'cli',
  'anthropic-sdk',
  'claude-cli',
  'claude-code-compat',
  'codex-cli',
  'openai-sdk',
]);

/**
 * Probe whether the `claude` CLI binary is available on PATH.
 * Uses `spawnSync` (never `exec`) to avoid shell injection.
 */
function isCliAvailable(): boolean {
  const probe =
    process.platform === 'win32'
      ? spawnSync('where', ['claude'], { stdio: 'ignore', windowsHide: true })
      : spawnSync('which', ['claude'], { stdio: 'ignore', windowsHide: true });
  return probe.status === 0;
}

function isCodexCliAvailable(options: CodexSpawnCommandOptions = {}): boolean {
  const command = buildCodexSpawnCommand(['--version'], options);
  const probe = spawnSync(command.command, command.args, {
    stdio: 'ignore',
    windowsHide: true,
    ...(command.env ? { env: command.env } : {}),
  });
  return probe.status === 0;
}

interface AutonomousYaml {
  runtime?: string;
  [key: string]: unknown;
}

/**
 * Read the `runtime:` field from `.agentforge/autonomous.yaml` relative to
 * `projectRoot` (defaults to `process.cwd()`).  Returns `undefined` when the
 * file is absent, the field is missing, the value is unrecognised, or the file
 * cannot be parsed.
 */
export function readConfigMode(projectRoot: string = process.cwd()): ExecutionServiceMode | undefined {
  const configPath = resolve(projectRoot, '.agentforge', 'autonomous.yaml');
  if (!existsSync(configPath)) return undefined;

  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as AutonomousYaml | null | undefined;
    if (!parsed || typeof parsed !== 'object') return undefined;

    const field = parsed.runtime;
    if (!field || typeof field !== 'string') return undefined;

    const trimmed = field.trim().toLowerCase();
    if (!isExecutionServiceMode(trimmed)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agentforge] autonomous.yaml has unrecognised runtime value: "${field}". ` +
          `Ignoring; valid values are: ${Array.from(VALID_MODES).join(', ')}.`,
      );
      return undefined;
    }
    return trimmed;
  } catch {
    // File unreadable or YAML parse error — treat as absent
    return undefined;
  }
}

/**
 * Determine the effective `ExecutionServiceMode`.
 *
 * Resolution order (highest → lowest precedence):
 * 1. `AGENTFORGE_RUNTIME` environment variable — per-process, always wins.
 * 2. `runtime:` field in `.agentforge/autonomous.yaml` relative to `projectRoot`.
 * 3. Hard fallback: `'auto'`.
 *
 * When the env var and config file disagree a warning is logged once to stderr
 * so operators can spot misconfiguration without it being a hard error.
 *
 * Invalid env var values also emit a warning and fall back to `'auto'`.
 *
 * @param env         Defaults to `process.env`. Pass a plain object in tests.
 * @param projectRoot Project root for resolving `autonomous.yaml`.
 *                    Defaults to `process.cwd()`.
 */
export function resolveMode(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = process.cwd(),
): ExecutionServiceMode {
  const raw = env['AGENTFORGE_RUNTIME']?.trim().toLowerCase();

  if (raw !== undefined && raw !== '') {
    if (!isExecutionServiceMode(raw)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agentforge] AGENTFORGE_RUNTIME="${env['AGENTFORGE_RUNTIME']}" is not a valid value. ` +
          `Falling back to "auto". Valid values: ${Array.from(VALID_MODES).join(', ')}.`,
      );
      return 'auto';
    }

    const envMode = raw;

    // Check if the config file disagrees and warn for operator visibility
    const configMode = readConfigMode(projectRoot);
    if (configMode !== undefined && configMode !== envMode) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agentforge] AGENTFORGE_RUNTIME="${raw}" overrides autonomous.yaml runtime="${configMode}". ` +
          `Env var takes precedence (see docs/runtime-modes.md).`,
      );
    }

    return envMode;
  }

  // No env var — fall through to config file
  const configMode = readConfigMode(projectRoot);
  if (configMode !== undefined) return configMode;

  return 'auto';
}

/**
 * Resolve `'auto'` to a concrete `'cli' | 'sdk'` selection by probing PATH.
 *
 * - Returns `'cli'` when `claude` is present on PATH.
 * - Returns `'sdk'` otherwise (e.g. in Cloud / CI environments with no CLI).
 *
 * @param env         Defaults to `process.env`. Pass a plain object in tests.
 * @param projectRoot Project root for resolving `autonomous.yaml`.
 */
export function resolveAutoMode(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = process.cwd(),
): Exclude<ExecutionServiceMode, 'auto'> {
  const mode = resolveMode(env, projectRoot);
  if (mode === 'sdk') return 'sdk';
  if (mode === 'anthropic-sdk') return 'anthropic-sdk';
  if (mode === 'cli') return 'cli';
  if (mode === 'claude-cli' || mode === 'claude-code-compat') return mode;
  if (mode === 'codex-cli' || mode === 'openai-sdk') return mode;
  // 'auto': preserve the historical Claude preference, then fall back to Codex/OpenAI.
  return isCliAvailable() ? 'cli' : 'sdk';
}

export function isCodexRuntimeAvailable(options: CodexSpawnCommandOptions = {}): boolean {
  return isCodexCliAvailable(options);
}

function isExecutionServiceMode(value: string): value is ExecutionServiceMode {
  return VALID_MODES.has(value as ExecutionServiceMode);
}
