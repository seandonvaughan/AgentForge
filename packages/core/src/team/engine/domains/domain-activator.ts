/**
 * Domain Activator for AgentForge.
 *
 * Given scan results and a set of available domain packs, determines which
 * domains should be activated based on their activation rules.
 *
 * The "core" domain always activates regardless of scan results.
 * Other domains activate when ANY of their `activates_when` rules match
 * against the scan output.
 */

import type { FullScanResult } from "../scanner/index.js";
import type {
  DomainPack,
  DomainId,
  ActivationRule,
} from "../types/domain.js";
import type { FileScanResult } from "../scanner/file-scanner.js";

/**
 * Check whether a single activation rule matches the scan results.
 *
 * A rule matches if ANY of its conditions are satisfied:
 * - file_patterns: at least one scanned file's path matches a pattern
 * - directories: at least one listed directory appears in directory_structure
 * - files: at least one listed file appears in the scanned file paths
 */
function ruleMatches(
  rule: ActivationRule,
  fileScan: FileScanResult,
): boolean {
  // Check file patterns — match against scanned file extensions
  if (rule.file_patterns && rule.file_patterns.length > 0) {
    const matched = rule.file_patterns.some((pattern) => {
      // Convert a glob like "*.ts" to a check against file extensions
      if (pattern.startsWith("*.")) {
        const ext = pattern.slice(1); // ".ts"
        return fileScan.files.some((f) => f.file_path.endsWith(ext));
      }
      // Direct substring match for other patterns
      return fileScan.files.some((f) => f.file_path.includes(pattern));
    });
    if (matched) return true;
  }

  // Check directories — match against directory_structure
  if (rule.directories && rule.directories.length > 0) {
    const matched = rule.directories.some((dir) => {
      // Normalize: strip trailing slashes for comparison
      const normalized = dir.replace(/\/+$/, "");
      return fileScan.directory_structure.some(
        (d) => d === normalized || d === dir,
      );
    });
    if (matched) return true;
  }

  // Check specific files — match against scanned file paths
  if (rule.files && rule.files.length > 0) {
    const matched = rule.files.some((file) =>
      fileScan.files.some(
        (f) => f.file_path === file || f.file_path.endsWith(`/${file}`),
      ),
    );
    if (matched) return true;
  }

  return false;
}

/**
 * Determine which domains should be activated based on scan results.
 *
 * - The "core" domain is always included if present in the map.
 * - Other domains activate when at least one of their `activates_when`
 *   rules matches the scan results (OR logic across rules).
 *
 * @param scanResult - The full scan result from running all scanners.
 * @param domains - Map of all available domain packs.
 * @returns A sorted array of DomainIds for domains that should be active.
 */
export function activateDomains(
  scanResult: FullScanResult,
  domains: Map<DomainId, DomainPack>,
): DomainId[] {
  const active: DomainId[] = [];

  for (const [id, pack] of domains) {
    // Core always activates
    if (id === "core") {
      active.push(id);
      continue;
    }

    // Domains with no activation rules never auto-activate (unless core)
    const rules = pack.scanner.activates_when;
    if (!rules || rules.length === 0) {
      continue;
    }

    // OR logic: activate if ANY rule matches
    const shouldActivate = rules.some((rule) =>
      ruleMatches(rule, scanResult.files),
    );

    if (shouldActivate) {
      active.push(id);
    }
  }

  return active.sort();
}
