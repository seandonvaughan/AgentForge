import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeDocuments } from "../../src/scanner/document-analyzer.js";
import type { DocumentAnalysis } from "../../src/types/analysis.js";

describe("document-analyzer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentforge-doc-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("analyzeDocuments", () => {
    it("detects .md files", async () => {
      await writeFile(
        join(tempDir, "README.md"),
        "# My Project\n\nThis is a readme file.\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("README.md");
    });

    it("detects .txt files", async () => {
      await writeFile(
        join(tempDir, "notes.txt"),
        "Some plain text notes about the project.\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("notes.txt");
    });

    it("detects both .md and .txt files", async () => {
      await writeFile(join(tempDir, "doc.md"), "# Doc\n");
      await writeFile(join(tempDir, "notes.txt"), "Notes here.\n");
      await writeFile(join(tempDir, "app.ts"), "const x = 1;\n");

      const results = await analyzeDocuments(tempDir);

      expect(results).toHaveLength(2);
      const paths = results.map((r) => r.path);
      expect(paths).toContain("doc.md");
      expect(paths).toContain("notes.txt");
    });

    it("returns DocumentAnalysis[] with required fields", async () => {
      await writeFile(join(tempDir, "spec.md"), "# Spec\n\nSome spec content.\n");

      const results = await analyzeDocuments(tempDir);

      expect(results).toHaveLength(1);
      const doc: DocumentAnalysis = results[0];
      expect(doc).toHaveProperty("type");
      expect(doc).toHaveProperty("path");
      expect(doc).toHaveProperty("summary");
      expect(typeof doc.type).toBe("string");
      expect(typeof doc.path).toBe("string");
      expect(typeof doc.summary).toBe("string");
    });

    it("classifies readme files as 'readme'", async () => {
      await writeFile(join(tempDir, "README.md"), "# Project Readme\n\nSetup instructions.\n");

      const results = await analyzeDocuments(tempDir);

      expect(results[0].type).toBe("readme");
    });

    it("classifies business plan files as 'business-plan'", async () => {
      await writeFile(
        join(tempDir, "business-plan.md"),
        "# Business Plan\n\nExecutive Summary\n\nMarket opportunity...\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results[0].type).toBe("business-plan");
    });

    it("classifies PRD files as 'prd'", async () => {
      await writeFile(
        join(tempDir, "product-requirements.md"),
        "# Product Requirements Document\n\nUser stories and acceptance criteria.\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results[0].type).toBe("prd");
    });

    it("classifies contract files as 'contract'", async () => {
      await writeFile(
        join(tempDir, "service-contract.md"),
        "# Service Agreement\n\nThis contract is between Party A and Party B...\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results[0].type).toBe("contract");
    });

    it("classifies policy files as 'policy'", async () => {
      await writeFile(
        join(tempDir, "privacy-policy.md"),
        "# Privacy Policy\n\nWe collect and process your data...\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results[0].type).toBe("policy");
    });

    it("classifies handbook files as 'handbook'", async () => {
      await writeFile(
        join(tempDir, "employee-handbook.md"),
        "# Employee Handbook\n\nWelcome to the company. Our values are...\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results[0].type).toBe("handbook");
    });

    it("classifies research paper files as 'research-paper'", async () => {
      await writeFile(
        join(tempDir, "research-paper.md"),
        "# Abstract\n\nThis paper presents findings on...\n\n## Methodology\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results[0].type).toBe("research-paper");
    });

    it("classifies marketing plan files as 'marketing-plan'", async () => {
      await writeFile(
        join(tempDir, "marketing-plan.md"),
        "# Marketing Plan\n\nTarget audience and campaign strategy.\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results[0].type).toBe("marketing-plan");
    });

    it("classifies unrecognized files as 'unknown'", async () => {
      await writeFile(
        join(tempDir, "random-notes.txt"),
        "Just some random notes with no clear type.\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results[0].type).toBe("unknown");
    });

    it("extracts summary as first 500 characters", async () => {
      const longContent = "A".repeat(600);
      await writeFile(join(tempDir, "doc.txt"), longContent);

      const results = await analyzeDocuments(tempDir);

      expect(results[0].summary).toHaveLength(500);
      expect(results[0].summary).toBe("A".repeat(500));
    });

    it("extracts full content when shorter than 500 characters", async () => {
      const shortContent = "Short document content here.";
      await writeFile(join(tempDir, "short.txt"), shortContent);

      const results = await analyzeDocuments(tempDir);

      expect(results[0].summary).toBe(shortContent);
    });

    it("skips node_modules directory", async () => {
      await mkdir(join(tempDir, "node_modules", "some-pkg"), { recursive: true });
      await writeFile(
        join(tempDir, "node_modules", "some-pkg", "README.md"),
        "# Package Readme\n"
      );
      await writeFile(join(tempDir, "my-doc.md"), "# My Doc\n");

      const results = await analyzeDocuments(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("my-doc.md");
    });

    it("skips .git directory", async () => {
      await mkdir(join(tempDir, ".git"), { recursive: true });
      await writeFile(join(tempDir, ".git", "COMMIT_EDITMSG"), "Initial commit\n");
      await writeFile(join(tempDir, "readme.md"), "# Readme\n");

      const results = await analyzeDocuments(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("readme.md");
    });

    it("skips dist directory", async () => {
      await mkdir(join(tempDir, "dist"), { recursive: true });
      await writeFile(join(tempDir, "dist", "CHANGES.md"), "# Changes\n");
      await writeFile(join(tempDir, "docs.md"), "# Docs\n");

      const results = await analyzeDocuments(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("docs.md");
    });

    it("handles nested document files", async () => {
      await mkdir(join(tempDir, "docs"), { recursive: true });
      await writeFile(join(tempDir, "docs", "overview.md"), "# Overview\n");
      await writeFile(join(tempDir, "docs", "spec.md"), "# Spec\n");

      const results = await analyzeDocuments(tempDir);

      expect(results).toHaveLength(2);
      const paths = results.map((r) => r.path);
      expect(paths).toContain(join("docs", "overview.md"));
      expect(paths).toContain(join("docs", "spec.md"));
    });

    it("returns empty array when no document files present", async () => {
      await writeFile(join(tempDir, "app.ts"), "const x = 1;\n");
      await writeFile(join(tempDir, "package.json"), "{}");

      const results = await analyzeDocuments(tempDir);

      expect(results).toEqual([]);
    });

    it("classifies by content keywords when filename is ambiguous", async () => {
      await writeFile(
        join(tempDir, "document.md"),
        "# Q3 Marketing Campaign\n\nBrand awareness strategy, target audience, and messaging.\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results[0].type).toBe("marketing-plan");
    });

    it("path is relative to project root", async () => {
      await mkdir(join(tempDir, "docs", "legal"), { recursive: true });
      await writeFile(
        join(tempDir, "docs", "legal", "contract.md"),
        "# Contract\n\nThis agreement...\n"
      );

      const results = await analyzeDocuments(tempDir);

      expect(results[0].path).toBe(join("docs", "legal", "contract.md"));
    });
  });
});
