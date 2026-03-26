/**
 * APIStabilityAuditor — Sprint 4.3
 *
 * Semver audit, deprecation policy, and breaking change detection.
 * Classifies all public APIs as stable/beta/experimental.
 */

export type StabilityLevel = "stable" | "beta" | "experimental";
export type ExportType = "class" | "function" | "interface" | "type" | "enum" | "const";

export interface APIEntry {
  name: string;
  module: string;
  exportType: ExportType;
  stability: StabilityLevel;
  version: string;
  deprecated?: boolean;
  deprecationMessage?: string;
}

export interface BreakingChange {
  name: string;
  module: string;
  type: "removed" | "stability_downgrade";
  details: string;
}

export interface StabilityReport {
  totalAPIs: number;
  stable: APIEntry[];
  beta: APIEntry[];
  experimental: APIEntry[];
  deprecated: APIEntry[];
}

export class APIStabilityAuditor {
  private entries = new Map<string, APIEntry>(); // key: `${module}::${name}`

  private key(name: string, module: string): string {
    return `${module}::${name}`;
  }

  register(entry: APIEntry): void {
    const k = this.key(entry.name, entry.module);
    if (this.entries.has(k)) {
      throw new Error(`API "${entry.name}" in module "${entry.module}" is already registered`);
    }
    this.entries.set(k, { ...entry });
  }

  get(name: string, module: string): APIEntry | null {
    const e = this.entries.get(this.key(name, module));
    return e ? { ...e } : null;
  }

  count(): number {
    return this.entries.size;
  }

  // ---------------------------------------------------------------------------
  // Deprecation
  // ---------------------------------------------------------------------------

  deprecate(name: string, module: string, message: string): void {
    const k = this.key(name, module);
    const e = this.entries.get(k);
    if (!e) throw new Error(`API "${name}" in module "${module}" not found`);
    e.deprecated = true;
    e.deprecationMessage = message;
  }

  getDeprecated(): APIEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.deprecated)
      .map((e) => ({ ...e }));
  }

  // ---------------------------------------------------------------------------
  // Breaking change detection
  // ---------------------------------------------------------------------------

  detectBreakingChanges(newAuditor: APIStabilityAuditor): BreakingChange[] {
    const changes: BreakingChange[] = [];
    const STABILITY_ORDER: Record<StabilityLevel, number> = {
      stable: 3,
      beta: 2,
      experimental: 1,
    };

    for (const [k, oldEntry] of this.entries) {
      if (oldEntry.stability === "experimental") continue; // experimental can be removed freely

      const newEntry = newAuditor.entries.get(k);
      if (!newEntry) {
        changes.push({
          name: oldEntry.name,
          module: oldEntry.module,
          type: "removed",
          details: `${oldEntry.stability} API "${oldEntry.name}" was removed`,
        });
        continue;
      }
      if (STABILITY_ORDER[newEntry.stability] < STABILITY_ORDER[oldEntry.stability]) {
        changes.push({
          name: oldEntry.name,
          module: oldEntry.module,
          type: "stability_downgrade",
          details: `"${oldEntry.name}" downgraded from ${oldEntry.stability} to ${newEntry.stability}`,
        });
      }
    }
    return changes;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getByModule(module: string): APIEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.module === module)
      .map((e) => ({ ...e }));
  }

  getByStability(stability: StabilityLevel): APIEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.stability === stability)
      .map((e) => ({ ...e }));
  }

  generateReport(): StabilityReport {
    const all = Array.from(this.entries.values()).map((e) => ({ ...e }));
    return {
      totalAPIs: all.length,
      stable: all.filter((e) => e.stability === "stable"),
      beta: all.filter((e) => e.stability === "beta"),
      experimental: all.filter((e) => e.stability === "experimental"),
      deprecated: all.filter((e) => e.deprecated),
    };
  }
}
