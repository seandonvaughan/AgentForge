import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditCI } from "../../src/scanner/ci-auditor.js";

describe("ci-auditor", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentforge-ci-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("GitHub Actions detection", () => {
    it("should detect GitHub Actions CI provider", async () => {
      await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });
      await writeFile(
        join(tempDir, ".github", "workflows", "ci.yml"),
        `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        run: npm install
      - name: Run tests
        run: npm test
      - name: Build
        run: npm run build
`
      );

      const result = await auditCI(tempDir);

      expect(result.ci_provider).toBe("github-actions");
      expect(result.config_files).toContain(".github/workflows/ci.yml");
    });

    it("should extract pipeline name and triggers", async () => {
      await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });
      await writeFile(
        join(tempDir, ".github", "workflows", "ci.yml"),
        `name: Build and Test
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`
      );

      const result = await auditCI(tempDir);

      expect(result.pipelines).toHaveLength(1);
      expect(result.pipelines[0].name).toBe("Build and Test");
      expect(result.pipelines[0].triggers).toContain("push");
      expect(result.pipelines[0].triggers).toContain("pull_request");
    });

    it("should detect test commands", async () => {
      await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });
      await writeFile(
        join(tempDir, ".github", "workflows", "ci.yml"),
        `name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
      - run: npx vitest
`
      );

      const result = await auditCI(tempDir);

      expect(result.test_commands.length).toBeGreaterThan(0);
      expect(result.test_commands).toContain("npm test");
    });

    it("should detect build commands", async () => {
      await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });
      await writeFile(
        join(tempDir, ".github", "workflows", "ci.yml"),
        `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
      - run: tsc
`
      );

      const result = await auditCI(tempDir);

      expect(result.build_commands.length).toBeGreaterThan(0);
    });

    it("should detect deploy targets", async () => {
      await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });
      await writeFile(
        join(tempDir, ".github", "workflows", "deploy.yml"),
        `name: Deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: vercel deploy --prod
`
      );

      const result = await auditCI(tempDir);

      expect(result.deploy_targets.length).toBeGreaterThan(0);
    });

    it("should detect linting steps", async () => {
      await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });
      await writeFile(
        join(tempDir, ".github", "workflows", "ci.yml"),
        `name: CI
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
      - run: eslint src/
`
      );

      const result = await auditCI(tempDir);

      expect(result.has_linting).toBe(true);
    });

    it("should detect security scanning", async () => {
      await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });
      await writeFile(
        join(tempDir, ".github", "workflows", "security.yml"),
        `name: Security
on: push
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - run: npm audit
      - uses: github/codeql-action/analyze@v2
`
      );

      const result = await auditCI(tempDir);

      expect(result.has_security_scanning).toBe(true);
    });
  });

  describe("Docker detection", () => {
    it("should detect Docker when Dockerfile exists", async () => {
      await writeFile(join(tempDir, "Dockerfile"), "FROM node:18\nCOPY . .\n");

      const result = await auditCI(tempDir);

      expect(result.has_docker).toBe(true);
      expect(result.dockerfile_count).toBe(1);
    });

    it("should detect docker-compose.yml", async () => {
      await writeFile(
        join(tempDir, "docker-compose.yml"),
        "version: '3'\nservices:\n  app:\n    build: .\n"
      );

      const result = await auditCI(tempDir);

      expect(result.has_docker).toBe(true);
    });

    it("should count multiple Dockerfiles", async () => {
      await writeFile(join(tempDir, "Dockerfile"), "FROM node:18\n");
      await writeFile(join(tempDir, "Dockerfile.dev"), "FROM node:18\n");
      await mkdir(join(tempDir, "services"), { recursive: true });
      await writeFile(
        join(tempDir, "services", "Dockerfile"),
        "FROM python:3.11\n"
      );

      const result = await auditCI(tempDir);

      expect(result.has_docker).toBe(true);
      expect(result.dockerfile_count).toBeGreaterThanOrEqual(3);
    });

    it("should report no Docker when none exists", async () => {
      await writeFile(join(tempDir, "app.ts"), "const x = 1;\n");

      const result = await auditCI(tempDir);

      expect(result.has_docker).toBe(false);
      expect(result.dockerfile_count).toBe(0);
    });
  });

  describe("no CI scenario", () => {
    it("should return ci_provider 'none' when no CI config found", async () => {
      await writeFile(join(tempDir, "index.ts"), "console.log('hello');\n");

      const result = await auditCI(tempDir);

      expect(result.ci_provider).toBe("none");
      expect(result.config_files).toEqual([]);
      expect(result.pipelines).toEqual([]);
      expect(result.test_commands).toEqual([]);
      expect(result.build_commands).toEqual([]);
      expect(result.deploy_targets).toEqual([]);
      expect(result.has_linting).toBe(false);
      expect(result.has_type_checking).toBe(false);
      expect(result.has_security_scanning).toBe(false);
    });
  });

  describe("type checking detection", () => {
    it("should detect type checking steps", async () => {
      await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });
      await writeFile(
        join(tempDir, ".github", "workflows", "ci.yml"),
        `name: CI
on: push
jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - run: tsc --noEmit
`
      );

      const result = await auditCI(tempDir);

      expect(result.has_type_checking).toBe(true);
    });
  });

  describe("multiple workflow files", () => {
    it("should parse multiple workflow files", async () => {
      await mkdir(join(tempDir, ".github", "workflows"), { recursive: true });
      await writeFile(
        join(tempDir, ".github", "workflows", "ci.yml"),
        `name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`
      );
      await writeFile(
        join(tempDir, ".github", "workflows", "release.yml"),
        `name: Release\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run build\n`
      );

      const result = await auditCI(tempDir);

      expect(result.config_files).toHaveLength(2);
      expect(result.pipelines).toHaveLength(2);
    });
  });
});
