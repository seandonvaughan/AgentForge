import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadDomainPack,
  loadAllDomains,
  getDefaultDomainsDir,
} from "../../src/domains/domain-loader.js";

/** Minimal valid domain.yaml content for a "software" domain. */
const VALID_DOMAIN_YAML = `
name: software
version: "1.0"
description: Software engineering domain
scanner:
  type: codebase
  activates_when:
    - file_patterns:
        - "*.ts"
        - "*.js"
      directories:
        - src
      files:
        - package.json
  scanners:
    - file-scanner
    - dependency-mapper
agents:
  strategic:
    - architect
  implementation:
    - coder
  quality:
    - reviewer
  utility:
    - file-reader
default_collaboration: dev-team
signals:
  - source-code-detected
  - node-project
`;

/** A core domain that always activates (no activation rules). */
const CORE_DOMAIN_YAML = `
name: core
version: "1.0"
description: Core agents available to every project
scanner:
  type: codebase
  activates_when: []
  scanners: []
agents:
  strategic:
    - architect
  implementation: []
  quality: []
  utility:
    - file-reader
    - task-manager
default_collaboration: flat
signals: []
`;

describe("domain-loader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentforge-domain-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("loadDomainPack", () => {
    it("should parse a valid domain.yaml file", async () => {
      const domainDir = join(tempDir, "software");
      await mkdir(domainDir, { recursive: true });
      await writeFile(join(domainDir, "domain.yaml"), VALID_DOMAIN_YAML);

      const pack = await loadDomainPack(domainDir);

      expect(pack.name).toBe("software");
      expect(pack.version).toBe("1.0");
      expect(pack.description).toBe("Software engineering domain");
      expect(pack.scanner.type).toBe("codebase");
      expect(pack.scanner.activates_when).toHaveLength(1);
      expect(pack.scanner.activates_when[0].file_patterns).toContain("*.ts");
      expect(pack.scanner.activates_when[0].directories).toContain("src");
      expect(pack.scanner.activates_when[0].files).toContain("package.json");
      expect(pack.scanner.scanners).toContain("file-scanner");
      expect(pack.agents.strategic).toContain("architect");
      expect(pack.agents.implementation).toContain("coder");
      expect(pack.agents.quality).toContain("reviewer");
      expect(pack.agents.utility).toContain("file-reader");
      expect(pack.default_collaboration).toBe("dev-team");
      expect(pack.signals).toContain("source-code-detected");
    });

    it("should parse a core domain with empty activation rules", async () => {
      const domainDir = join(tempDir, "core");
      await mkdir(domainDir, { recursive: true });
      await writeFile(join(domainDir, "domain.yaml"), CORE_DOMAIN_YAML);

      const pack = await loadDomainPack(domainDir);

      expect(pack.name).toBe("core");
      expect(pack.scanner.activates_when).toEqual([]);
      expect(pack.scanner.scanners).toEqual([]);
      expect(pack.agents.strategic).toContain("architect");
      expect(pack.agents.implementation).toEqual([]);
      expect(pack.signals).toEqual([]);
    });

    it("should also load domain.yml files", async () => {
      const domainDir = join(tempDir, "alt");
      await mkdir(domainDir, { recursive: true });
      await writeFile(join(domainDir, "domain.yml"), CORE_DOMAIN_YAML);

      const pack = await loadDomainPack(domainDir);

      expect(pack.name).toBe("core");
    });

    it("should throw when domain.yaml is missing", async () => {
      const domainDir = join(tempDir, "empty");
      await mkdir(domainDir, { recursive: true });

      await expect(loadDomainPack(domainDir)).rejects.toThrow(
        /domain\.ya?ml not found/i
      );
    });

    it("should throw when name field is missing", async () => {
      const domainDir = join(tempDir, "no-name");
      await mkdir(domainDir, { recursive: true });
      await writeFile(
        join(domainDir, "domain.yaml"),
        "version: '1.0'\ndescription: no name\n"
      );

      await expect(loadDomainPack(domainDir)).rejects.toThrow(/name/i);
    });

    it("should throw on malformed YAML", async () => {
      const domainDir = join(tempDir, "malformed");
      await mkdir(domainDir, { recursive: true });
      await writeFile(
        join(domainDir, "domain.yaml"),
        "name: [unclosed bracket\n  invalid: yaml: content:\n"
      );

      await expect(loadDomainPack(domainDir)).rejects.toThrow();
    });

    it("should throw on invalid scanner type", async () => {
      const domainDir = join(tempDir, "bad-scanner");
      await mkdir(domainDir, { recursive: true });
      await writeFile(
        join(domainDir, "domain.yaml"),
        `
name: bad
version: "1.0"
description: bad scanner type
scanner:
  type: invalid
  activates_when: []
  scanners: []
agents:
  strategic: []
  implementation: []
  quality: []
  utility: []
default_collaboration: flat
signals: []
`
      );

      await expect(loadDomainPack(domainDir)).rejects.toThrow(
        /invalid scanner type/i
      );
    });
  });

  describe("loadAllDomains", () => {
    it("should load multiple domain packs from subdirectories", async () => {
      const softwareDir = join(tempDir, "software");
      const coreDir = join(tempDir, "core");
      await mkdir(softwareDir, { recursive: true });
      await mkdir(coreDir, { recursive: true });
      await writeFile(join(softwareDir, "domain.yaml"), VALID_DOMAIN_YAML);
      await writeFile(join(coreDir, "domain.yaml"), CORE_DOMAIN_YAML);

      const domains = await loadAllDomains(tempDir);

      expect(domains.size).toBe(2);
      expect(domains.has("software")).toBe(true);
      expect(domains.has("core")).toBe(true);
      expect(domains.get("software")!.description).toBe(
        "Software engineering domain"
      );
      expect(domains.get("core")!.description).toBe(
        "Core agents available to every project"
      );
    });

    it("should skip non-directory entries", async () => {
      const coreDir = join(tempDir, "core");
      await mkdir(coreDir, { recursive: true });
      await writeFile(join(coreDir, "domain.yaml"), CORE_DOMAIN_YAML);
      await writeFile(join(tempDir, "README.md"), "# Domains\n");

      const domains = await loadAllDomains(tempDir);

      expect(domains.size).toBe(1);
      expect(domains.has("core")).toBe(true);
    });

    it("should skip subdirectories without domain.yaml", async () => {
      const coreDir = join(tempDir, "core");
      const emptyDir = join(tempDir, "empty");
      await mkdir(coreDir, { recursive: true });
      await mkdir(emptyDir, { recursive: true });
      await writeFile(join(coreDir, "domain.yaml"), CORE_DOMAIN_YAML);

      const domains = await loadAllDomains(tempDir);

      expect(domains.size).toBe(1);
      expect(domains.has("core")).toBe(true);
    });

    it("should return empty map for empty directory", async () => {
      const domains = await loadAllDomains(tempDir);

      expect(domains.size).toBe(0);
    });
  });

  describe("getDefaultDomainsDir", () => {
    it("should return a path ending with templates/domains", () => {
      const dir = getDefaultDomainsDir();

      expect(dir).toMatch(/templates[/\\]domains$/);
    });
  });
});
