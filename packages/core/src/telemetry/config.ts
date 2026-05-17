// packages/core/src/telemetry/config.ts
//
// Telemetry configuration for AgentForge cycle export.
// Opt-in only — disabled by default. Two ways to enable:
//   1. AGENTFORGE_TELEMETRY=1 environment variable
//   2. .agentforge/telemetry.yaml with `enabled: true`
//
// AGENTFORGE_TELEMETRY_ENDPOINT overrides the endpoint URL.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface TelemetryConfig {
  /** Whether telemetry export is enabled. Default: false. */
  enabled: boolean;
  /**
   * Remote endpoint to POST to. If undefined, telemetry is persisted locally
   * only (.agentforge/telemetry/cycle-<id>.json) without any network call.
   */
  endpoint: string | undefined;
}

interface TelemetryYaml {
  enabled?: boolean;
  endpoint?: string;
}

/**
 * Resolve telemetry configuration by merging the environment and the optional
 * .agentforge/telemetry.yaml file. Environment variables win over file config.
 *
 * Precedence (highest → lowest):
 *   1. AGENTFORGE_TELEMETRY env var (must be '1' to enable, anything else to override)
 *   2. AGENTFORGE_TELEMETRY_ENDPOINT env var
 *   3. .agentforge/telemetry.yaml fields
 *   4. Disabled-by-default fallback
 *
 * @param projectRoot - Absolute path to the project root; used to locate telemetry.yaml.
 */
export function resolveTelemetryConfig(projectRoot?: string): TelemetryConfig {
  // Attempt to read .agentforge/telemetry.yaml when a project root is provided.
  let fileConfig: TelemetryYaml = {};
  if (projectRoot) {
    const yamlPath = join(projectRoot, '.agentforge', 'telemetry.yaml');
    if (existsSync(yamlPath)) {
      try {
        const raw = readFileSync(yamlPath, 'utf8');
        const parsed = yaml.load(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          fileConfig = parsed as TelemetryYaml;
        }
      } catch {
        // Malformed YAML — treat as empty config.
      }
    }
  }

  // Environment wins over file config.
  const envEnabled = process.env['AGENTFORGE_TELEMETRY'];
  const envEndpoint = process.env['AGENTFORGE_TELEMETRY_ENDPOINT'];

  const enabled: boolean =
    envEnabled !== undefined
      ? envEnabled === '1'
      : (fileConfig.enabled === true);

  const endpoint: string | undefined =
    envEndpoint !== undefined && envEndpoint.length > 0
      ? envEndpoint
      : (typeof fileConfig.endpoint === 'string' && fileConfig.endpoint.length > 0
          ? fileConfig.endpoint
          : undefined);

  return { enabled, endpoint };
}
