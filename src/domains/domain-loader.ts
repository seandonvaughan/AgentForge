/**
 * Domain Pack Loader for AgentForge.
 *
 * Reads domain.yaml files from domain pack directories, validates them
 * against the DomainPack interface, and returns typed domain objects.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { DomainPack, DomainId } from "../types/domain.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Valid scanner types for a domain pack. */
const VALID_SCANNER_TYPES = new Set(["codebase", "document", "hybrid"]);

/**
 * Attempt to read domain.yaml or domain.yml from a directory.
 * Returns the file contents as a string, or throws if neither exists.
 */
async function readDomainFile(domainDir: string): Promise<string> {
  for (const filename of ["domain.yaml", "domain.yml"]) {
    try {
      const content = await readFile(join(domainDir, filename), "utf-8");
      return content;
    } catch {
      // Try next filename
    }
  }
  throw new Error(
    `domain.yaml not found in ${domainDir} (also tried domain.yml)`
  );
}

/**
 * Validate raw parsed YAML data and return a typed DomainPack.
 */
function validateDomainPack(raw: unknown, domainDir: string): DomainPack {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Invalid domain pack in ${domainDir}: expected an object`);
  }

  const data = raw as Record<string, unknown>;

  if (!data.name || typeof data.name !== "string") {
    throw new Error(
      `Invalid domain pack in ${domainDir}: missing or invalid "name" field`
    );
  }

  if (data.scanner && typeof data.scanner === "object") {
    const scanner = data.scanner as Record<string, unknown>;
    if (scanner.type && !VALID_SCANNER_TYPES.has(scanner.type as string)) {
      throw new Error(
        `Invalid scanner type "${scanner.type}" in ${domainDir}. ` +
          `Must be one of: ${[...VALID_SCANNER_TYPES].join(", ")}`
      );
    }
  }

  const scanner = data.scanner as Record<string, unknown> | undefined;

  return {
    name: data.name as DomainId,
    version: String(data.version ?? "1.0"),
    description: String(data.description ?? ""),
    scanner: {
      type: (scanner?.type as DomainPack["scanner"]["type"]) ?? "codebase",
      activates_when: Array.isArray(scanner?.activates_when)
        ? (scanner.activates_when as DomainPack["scanner"]["activates_when"])
        : [],
      scanners: Array.isArray(scanner?.scanners)
        ? (scanner.scanners as string[])
        : [],
    },
    agents: {
      strategic: Array.isArray(
        (data.agents as Record<string, unknown>)?.strategic
      )
        ? ((data.agents as Record<string, unknown>).strategic as string[])
        : [],
      implementation: Array.isArray(
        (data.agents as Record<string, unknown>)?.implementation
      )
        ? ((data.agents as Record<string, unknown>).implementation as string[])
        : [],
      quality: Array.isArray(
        (data.agents as Record<string, unknown>)?.quality
      )
        ? ((data.agents as Record<string, unknown>).quality as string[])
        : [],
      utility: Array.isArray(
        (data.agents as Record<string, unknown>)?.utility
      )
        ? ((data.agents as Record<string, unknown>).utility as string[])
        : [],
    },
    default_collaboration: String(data.default_collaboration ?? "flat"),
    signals: Array.isArray(data.signals) ? (data.signals as string[]) : [],
  };
}

/**
 * Load a single domain pack from a directory containing a domain.yaml file.
 *
 * @param domainDir - Absolute path to the domain pack directory.
 * @returns The parsed and validated DomainPack.
 * @throws If domain.yaml is missing, malformed, or fails validation.
 */
export async function loadDomainPack(domainDir: string): Promise<DomainPack> {
  const content = await readDomainFile(domainDir);
  const raw = yaml.load(content);
  return validateDomainPack(raw, domainDir);
}

/**
 * Load all domain packs from a parent directory.
 *
 * Scans each subdirectory for a domain.yaml file and loads it.
 * Subdirectories without a domain.yaml are silently skipped.
 *
 * @param domainsDir - Absolute path to the directory containing domain pack subdirectories.
 * @returns A Map from DomainId to DomainPack for each successfully loaded domain.
 */
export async function loadAllDomains(
  domainsDir: string,
): Promise<Map<DomainId, DomainPack>> {
  const domains = new Map<DomainId, DomainPack>();

  let entries: string[];
  try {
    entries = await readdir(domainsDir);
  } catch {
    return domains;
  }

  for (const entry of entries) {
    const entryPath = join(domainsDir, entry);
    const entryStat = await stat(entryPath);
    if (!entryStat.isDirectory()) {
      continue;
    }

    try {
      const pack = await loadDomainPack(entryPath);
      domains.set(pack.name, pack);
    } catch {
      // Skip directories without valid domain.yaml
    }
  }

  return domains;
}

/**
 * Returns the default domains directory path.
 *
 * This resolves to `templates/domains/` relative to the project root.
 */
export function getDefaultDomainsDir(): string {
  return resolve(__dirname, "..", "..", "templates", "domains");
}
