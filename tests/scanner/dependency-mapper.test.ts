import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mapDependencies,
  categorizeDependency,
} from "../../src/scanner/dependency-mapper.js";

describe("dependency-mapper", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentforge-dep-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("categorizeDependency", () => {
    it("should categorize react as framework", () => {
      expect(categorizeDependency("react")).toBe("framework");
    });

    it("should categorize jest as testing", () => {
      expect(categorizeDependency("jest")).toBe("testing");
    });

    it("should categorize vitest as testing", () => {
      expect(categorizeDependency("vitest")).toBe("testing");
    });

    it("should categorize eslint as linting", () => {
      expect(categorizeDependency("eslint")).toBe("linting");
    });

    it("should categorize webpack as bundler", () => {
      expect(categorizeDependency("webpack")).toBe("bundler");
    });

    it("should categorize prisma as database", () => {
      expect(categorizeDependency("prisma")).toBe("database");
    });

    it("should categorize passport as auth", () => {
      expect(categorizeDependency("passport")).toBe("auth");
    });

    it("should categorize tailwindcss as ui", () => {
      expect(categorizeDependency("tailwindcss")).toBe("ui");
    });

    it("should categorize lodash as utility", () => {
      expect(categorizeDependency("lodash")).toBe("utility");
    });

    it("should categorize unknown packages as utility", () => {
      expect(categorizeDependency("some-random-package")).toBe("utility");
    });

    it("should handle scoped Angular packages as framework", () => {
      expect(categorizeDependency("@angular/router")).toBe("framework");
    });

    it("should handle @testing-library packages as testing", () => {
      expect(categorizeDependency("@testing-library/vue")).toBe("testing");
    });

    it("should handle eslint-plugin packages as linting", () => {
      expect(categorizeDependency("eslint-plugin-import")).toBe("linting");
    });

    it("should handle keyword heuristic for test packages", () => {
      expect(categorizeDependency("my-test-utils")).toBe("testing");
    });

    it("should be case-insensitive", () => {
      expect(categorizeDependency("React")).toBe("framework");
      expect(categorizeDependency("JEST")).toBe("testing");
    });
  });

  describe("mapDependencies with package.json", () => {
    it("should parse dependencies from package.json", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          dependencies: { react: "^18.0.0", express: "^4.18.0" },
          devDependencies: { jest: "^29.0.0", eslint: "^8.0.0" },
        })
      );

      const result = await mapDependencies(tempDir);

      expect(result.dependencies).toHaveLength(4);
      expect(result.total_production).toBe(2);
      expect(result.total_development).toBe(2);
      expect(result.framework_dependencies).toContain("react");
      expect(result.framework_dependencies).toContain("express");
      expect(result.test_frameworks).toContain("jest");
      expect(result.linters).toContain("eslint");
    });

    it("should detect npm as package manager by default", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { lodash: "^4.0.0" } })
      );

      const result = await mapDependencies(tempDir);

      expect(result.package_manager).toBe("npm");
    });

    it("should detect yarn from yarn.lock", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { lodash: "^4.0.0" } })
      );
      await writeFile(join(tempDir, "yarn.lock"), "# yarn lockfile\n");

      const result = await mapDependencies(tempDir);

      expect(result.package_manager).toBe("yarn");
    });

    it("should detect pnpm from pnpm-lock.yaml", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { lodash: "^4.0.0" } })
      );
      await writeFile(join(tempDir, "pnpm-lock.yaml"), "lockfileVersion: 5\n");

      const result = await mapDependencies(tempDir);

      expect(result.package_manager).toBe("pnpm");
    });

    it("should handle peer and optional dependencies", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          dependencies: { react: "^18.0.0" },
          peerDependencies: { "react-dom": "^18.0.0" },
          optionalDependencies: { fsevents: "^2.0.0" },
        })
      );

      const result = await mapDependencies(tempDir);

      // peer counts as production
      expect(result.total_production).toBe(2);
      const peerDep = result.dependencies.find((d) => d.name === "react-dom");
      expect(peerDep?.type).toBe("peer");
      const optDep = result.dependencies.find((d) => d.name === "fsevents");
      expect(optDep?.type).toBe("optional");
    });
  });

  describe("mapDependencies with requirements.txt", () => {
    it("should parse Python requirements", async () => {
      await writeFile(
        join(tempDir, "requirements.txt"),
        "django==4.2\nflask>=2.0.0\nrequests~=2.28\n# comment\n\npytest==7.0\n"
      );

      const result = await mapDependencies(tempDir);

      expect(result.package_manager).toBe("pip");
      expect(result.dependencies).toHaveLength(4);
      expect(result.framework_dependencies).toContain("django");
      expect(result.framework_dependencies).toContain("flask");
      expect(result.test_frameworks).toContain("pytest");
    });

    it("should skip comments and blank lines", async () => {
      await writeFile(
        join(tempDir, "requirements.txt"),
        "# This is a comment\n\n-r other-requirements.txt\nflask>=2.0\n"
      );

      const result = await mapDependencies(tempDir);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].name).toBe("flask");
    });
  });

  describe("mapDependencies with Cargo.toml", () => {
    it("should parse Rust dependencies", async () => {
      await writeFile(
        join(tempDir, "Cargo.toml"),
        '[package]\nname = "myapp"\nversion = "0.1.0"\n\n[dependencies]\ntokio = "1.28"\nserde = { version = "1.0", features = ["derive"] }\n\n[dev-dependencies]\ncriterion = "0.5"\n'
      );

      const result = await mapDependencies(tempDir);

      expect(result.package_manager).toBe("cargo");
      expect(result.dependencies).toHaveLength(3);
      expect(result.framework_dependencies).toContain("tokio");
      const serde = result.dependencies.find((d) => d.name === "serde");
      expect(serde?.version).toBe("1.0");
      expect(serde?.type).toBe("production");
      const criterion = result.dependencies.find((d) => d.name === "criterion");
      expect(criterion?.type).toBe("development");
    });
  });

  describe("mapDependencies with go.mod", () => {
    it("should parse Go dependencies", async () => {
      await writeFile(
        join(tempDir, "go.mod"),
        'module example.com/myapp\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgithub.com/stretchr/testify v1.8.0 // indirect\n)\n'
      );

      const result = await mapDependencies(tempDir);

      expect(result.package_manager).toBe("go");
      expect(result.dependencies.length).toBeGreaterThanOrEqual(2);
      const gin = result.dependencies.find((d) =>
        d.name.includes("gin-gonic/gin")
      );
      expect(gin?.type).toBe("production");
      const testify = result.dependencies.find((d) =>
        d.name.includes("testify")
      );
      expect(testify?.type).toBe("optional"); // indirect
    });
  });

  describe("mapDependencies with missing files", () => {
    it("should return unknown package manager for empty directory", async () => {
      const result = await mapDependencies(tempDir);

      expect(result.package_manager).toBe("unknown");
      expect(result.dependencies).toEqual([]);
      expect(result.total_production).toBe(0);
      expect(result.total_development).toBe(0);
    });

    it("should handle malformed package.json gracefully", async () => {
      await writeFile(join(tempDir, "package.json"), "{ invalid json }}}");

      const result = await mapDependencies(tempDir);

      expect(result.package_manager).toBe("unknown");
      expect(result.dependencies).toEqual([]);
    });
  });

  describe("build tools detection", () => {
    it("should detect build tools from dependencies", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          devDependencies: { vite: "^5.0.0", typescript: "^5.0.0" },
        })
      );

      const result = await mapDependencies(tempDir);

      expect(result.build_tools).toContain("vite");
      expect(result.build_tools).toContain("typescript");
    });
  });
});
