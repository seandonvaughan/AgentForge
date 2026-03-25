import { describe, it, expect } from "vitest";
import { activateDomains } from "../../src/domains/domain-activator.js";
import type { DomainPack, DomainId } from "../../src/types/domain.js";
import type { FullScanResult } from "../../src/scanner/index.js";

// ---------------------------------------------------------------------------
// Helpers — build mock data
// ---------------------------------------------------------------------------

function makeDomainPack(overrides: Partial<DomainPack> & { name: DomainId }): DomainPack {
  return {
    version: "1.0",
    description: "",
    scanner: {
      type: "codebase",
      activates_when: [],
      scanners: [],
    },
    agents: {
      strategic: [],
      implementation: [],
      quality: [],
      utility: [],
    },
    default_collaboration: "flat",
    signals: [],
    ...overrides,
  };
}

/** Minimal FullScanResult with sensible empty defaults. */
function makeScanResult(overrides: Partial<FullScanResult> = {}): FullScanResult {
  return {
    files: {
      files: [],
      languages: {},
      frameworks_detected: [],
      total_files: 0,
      total_loc: 0,
      directory_structure: [],
      ...overrides.files,
    },
    git: {
      total_commits: 0,
      contributors: [],
      active_files: [],
      branch_count: 0,
      branch_strategy: "unknown",
      churn_rate: [],
      commit_frequency: [],
      age_days: 0,
      ...overrides.git,
    },
    dependencies: {
      package_manager: "unknown",
      dependencies: [],
      total_production: 0,
      total_development: 0,
      framework_dependencies: [],
      test_frameworks: [],
      build_tools: [],
      linters: [],
      ...overrides.dependencies,
    },
    ci: {
      ci_provider: "none",
      config_files: [],
      pipelines: [],
      test_commands: [],
      build_commands: [],
      deploy_targets: [],
      has_linting: false,
      has_type_checking: false,
      has_security_scanning: false,
      has_docker: false,
      dockerfile_count: 0,
      ...overrides.ci,
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("domain-activator", () => {
  describe("activateDomains", () => {
    it("should always activate the core domain", () => {
      const domains = new Map<DomainId, DomainPack>([
        ["core", makeDomainPack({ name: "core" })],
      ]);
      const scan = makeScanResult();

      const active = activateDomains(scan, domains);

      expect(active).toContain("core");
    });

    it("should activate software domain when source files match file_patterns", () => {
      const domains = new Map<DomainId, DomainPack>([
        ["core", makeDomainPack({ name: "core" })],
        [
          "software",
          makeDomainPack({
            name: "software",
            scanner: {
              type: "codebase",
              activates_when: [
                {
                  file_patterns: ["*.ts", "*.js"],
                },
              ],
              scanners: ["file-scanner"],
            },
          }),
        ],
      ]);

      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/index.ts",
              language: "typescript",
              loc: 50,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { typescript: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 50,
          directory_structure: ["src"],
        },
      });

      const active = activateDomains(scan, domains);

      expect(active).toContain("core");
      expect(active).toContain("software");
    });

    it("should activate domain when directories match", () => {
      const domains = new Map<DomainId, DomainPack>([
        ["core", makeDomainPack({ name: "core" })],
        [
          "software",
          makeDomainPack({
            name: "software",
            scanner: {
              type: "codebase",
              activates_when: [
                {
                  directories: ["src"],
                },
              ],
              scanners: [],
            },
          }),
        ],
      ]);

      const scan = makeScanResult({
        files: {
          files: [],
          languages: {},
          frameworks_detected: [],
          total_files: 0,
          total_loc: 0,
          directory_structure: ["src", "docs"],
        },
      });

      const active = activateDomains(scan, domains);

      expect(active).toContain("software");
    });

    it("should activate domain when specific files match", () => {
      const domains = new Map<DomainId, DomainPack>([
        ["core", makeDomainPack({ name: "core" })],
        [
          "software",
          makeDomainPack({
            name: "software",
            scanner: {
              type: "codebase",
              activates_when: [
                {
                  files: ["package.json"],
                },
              ],
              scanners: [],
            },
          }),
        ],
      ]);

      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "package.json",
              language: "json",
              loc: 20,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { json: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 20,
          directory_structure: [],
        },
      });

      const active = activateDomains(scan, domains);

      expect(active).toContain("software");
    });

    it("should NOT activate domain when no rules match", () => {
      const domains = new Map<DomainId, DomainPack>([
        ["core", makeDomainPack({ name: "core" })],
        [
          "software",
          makeDomainPack({
            name: "software",
            scanner: {
              type: "codebase",
              activates_when: [
                {
                  file_patterns: ["*.py"],
                  directories: ["lib"],
                  files: ["setup.py"],
                },
              ],
              scanners: [],
            },
          }),
        ],
      ]);

      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "README.md",
              language: "markdown",
              loc: 10,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { markdown: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 10,
          directory_structure: ["docs"],
        },
      });

      const active = activateDomains(scan, domains);

      expect(active).toContain("core");
      expect(active).not.toContain("software");
    });

    it("should activate business domain when document files found", () => {
      const domains = new Map<DomainId, DomainPack>([
        ["core", makeDomainPack({ name: "core" })],
        [
          "business",
          makeDomainPack({
            name: "business",
            scanner: {
              type: "document",
              activates_when: [
                {
                  file_patterns: ["*.md", "*.pdf"],
                  directories: ["docs"],
                },
              ],
              scanners: [],
            },
          }),
        ],
      ]);

      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "docs/strategy.md",
              language: "markdown",
              loc: 100,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { markdown: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 100,
          directory_structure: ["docs"],
        },
      });

      const active = activateDomains(scan, domains);

      expect(active).toContain("core");
      expect(active).toContain("business");
    });

    it("should activate when ANY activation rule matches (OR logic)", () => {
      const domains = new Map<DomainId, DomainPack>([
        ["core", makeDomainPack({ name: "core" })],
        [
          "software",
          makeDomainPack({
            name: "software",
            scanner: {
              type: "codebase",
              activates_when: [
                { file_patterns: ["*.py"] },
                { file_patterns: ["*.ts"] },
              ],
              scanners: [],
            },
          }),
        ],
      ]);

      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "app.py",
              language: "python",
              loc: 30,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { python: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 30,
          directory_structure: [],
        },
      });

      const active = activateDomains(scan, domains);

      expect(active).toContain("software");
    });

    it("should return a sorted list of active domain IDs", () => {
      const domains = new Map<DomainId, DomainPack>([
        ["core", makeDomainPack({ name: "core" })],
        [
          "software",
          makeDomainPack({
            name: "software",
            scanner: {
              type: "codebase",
              activates_when: [{ file_patterns: ["*.ts"] }],
              scanners: [],
            },
          }),
        ],
        [
          "business",
          makeDomainPack({
            name: "business",
            scanner: {
              type: "document",
              activates_when: [{ directories: ["docs"] }],
              scanners: [],
            },
          }),
        ],
      ]);

      const scan = makeScanResult({
        files: {
          files: [
            {
              file_path: "src/index.ts",
              language: "typescript",
              loc: 50,
              imports: [],
              exports: [],
              framework_indicators: [],
              patterns: [],
            },
          ],
          languages: { typescript: 1 },
          frameworks_detected: [],
          total_files: 1,
          total_loc: 50,
          directory_structure: ["src", "docs"],
        },
      });

      const active = activateDomains(scan, domains);

      expect(active).toEqual(["business", "core", "software"]);
    });

    it("should handle empty domains map and still return empty array", () => {
      const domains = new Map<DomainId, DomainPack>();
      const scan = makeScanResult();

      const active = activateDomains(scan, domains);

      expect(active).toEqual([]);
    });
  });
});
