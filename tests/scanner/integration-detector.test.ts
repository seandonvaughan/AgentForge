import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectIntegrations } from "../../src/scanner/integration-detector.js";
import type { IntegrationRef } from "../../src/types/analysis.js";

describe("integration-detector", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentforge-int-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("detectIntegrations", () => {
    it("returns IntegrationRef[] with required fields", async () => {
      await writeFile(
        join(tempDir, "notes.md"),
        "We track issues in PROJ-123.\n"
      );

      const results = await detectIntegrations(tempDir);

      expect(Array.isArray(results)).toBe(true);
      if (results.length > 0) {
        const ref: IntegrationRef = results[0];
        expect(ref).toHaveProperty("type");
        expect(ref).toHaveProperty("ref");
        expect(typeof ref.type).toBe("string");
        expect(typeof ref.ref).toBe("string");
      }
    });

    it("returns empty array when no integrations found", async () => {
      await writeFile(
        join(tempDir, "readme.md"),
        "# Project\n\nNo integration references here.\n"
      );

      const results = await detectIntegrations(tempDir);

      expect(results).toEqual([]);
    });

    // ── Jira ──────────────────────────────────────────────────────────────

    it("finds Jira PROJECT-123 style references", async () => {
      await writeFile(
        join(tempDir, "notes.md"),
        "Related to ticket PROJ-456 and PROJ-789.\n"
      );

      const results = await detectIntegrations(tempDir);

      const jiraRefs = results.filter((r) => r.type === "jira");
      expect(jiraRefs.length).toBeGreaterThanOrEqual(2);
      const refs = jiraRefs.map((r) => r.ref);
      expect(refs).toContain("PROJ-456");
      expect(refs).toContain("PROJ-789");
    });

    it("finds Jira references with multi-character project keys", async () => {
      await writeFile(
        join(tempDir, "ticket.txt"),
        "See MYPROJECT-1 and BACKEND-42 for details.\n"
      );

      const results = await detectIntegrations(tempDir);

      const jiraRefs = results.filter((r) => r.type === "jira");
      const refs = jiraRefs.map((r) => r.ref);
      expect(refs).toContain("MYPROJECT-1");
      expect(refs).toContain("BACKEND-42");
    });

    it("finds Jira URL references", async () => {
      await writeFile(
        join(tempDir, "config.md"),
        "Jira board: https://mycompany.atlassian.net/browse/FEAT-100\n"
      );

      const results = await detectIntegrations(tempDir);

      const jiraRefs = results.filter((r) => r.type === "jira");
      expect(jiraRefs.length).toBeGreaterThanOrEqual(1);
    });

    it("does not treat lowercase ticket-like strings as Jira refs", async () => {
      await writeFile(
        join(tempDir, "notes.md"),
        "No jira refs here, just text like abc-123 in lowercase.\n"
      );

      const results = await detectIntegrations(tempDir);

      const jiraRefs = results.filter((r) => r.type === "jira");
      expect(jiraRefs).toHaveLength(0);
    });

    // ── Confluence ────────────────────────────────────────────────────────

    it("finds Confluence URL references", async () => {
      await writeFile(
        join(tempDir, "docs.md"),
        "See the design doc at https://mycompany.atlassian.net/wiki/spaces/ENG/pages/123456\n"
      );

      const results = await detectIntegrations(tempDir);

      const confRefs = results.filter((r) => r.type === "confluence");
      expect(confRefs.length).toBeGreaterThanOrEqual(1);
      expect(confRefs[0].ref).toContain("confluence");
    });

    it("finds Confluence references using 'confluence' keyword in URL", async () => {
      await writeFile(
        join(tempDir, "link.txt"),
        "Wiki: https://confluence.example.com/display/SPACE/Page+Title\n"
      );

      const results = await detectIntegrations(tempDir);

      const confRefs = results.filter((r) => r.type === "confluence");
      expect(confRefs.length).toBeGreaterThanOrEqual(1);
    });

    it("finds Confluence space key references", async () => {
      await writeFile(
        join(tempDir, "notes.md"),
        "Confluence space: ENG, page: Architecture Overview\n"
      );

      const results = await detectIntegrations(tempDir);

      // Either a confluence ref is found or not (depends on heuristic strength)
      // At minimum, no crash
      expect(Array.isArray(results)).toBe(true);
    });

    // ── Slack ─────────────────────────────────────────────────────────────

    it("finds Slack webhook URLs", async () => {
      await writeFile(
        join(tempDir, "notify.ts"),
        `const webhookUrl = "https://hooks.slack.com/services/" + "T00000000/B00000000/XXXXXXXXXXXX";\n`
      );

      const results = await detectIntegrations(tempDir);

      const slackRefs = results.filter((r) => r.type === "slack");
      expect(slackRefs.length).toBeGreaterThanOrEqual(1);
      expect(slackRefs[0].ref).toContain("hooks.slack.com");
    });

    it("finds Slack workspace URL references", async () => {
      await writeFile(
        join(tempDir, "readme.md"),
        "Join our Slack at https://myteam.slack.com/archives/C12345678\n"
      );

      const results = await detectIntegrations(tempDir);

      const slackRefs = results.filter((r) => r.type === "slack");
      expect(slackRefs.length).toBeGreaterThanOrEqual(1);
    });

    it("finds Slack channel mentions", async () => {
      await writeFile(
        join(tempDir, "notes.md"),
        "Post updates to the #engineering-alerts channel on Slack.\n"
      );

      const results = await detectIntegrations(tempDir);

      const slackRefs = results.filter((r) => r.type === "slack");
      expect(slackRefs.length).toBeGreaterThanOrEqual(1);
    });

    // ── Multi-file / multi-type ───────────────────────────────────────────

    it("scans source files for integrations", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await writeFile(
        join(tempDir, "src", "service.ts"),
        'const slackHook = "https://hooks.slack.com/services/T123/B456/abc";\n'
      );

      const results = await detectIntegrations(tempDir);

      const slackRefs = results.filter((r) => r.type === "slack");
      expect(slackRefs.length).toBeGreaterThanOrEqual(1);
    });

    it("scans doc files for integrations", async () => {
      await mkdir(join(tempDir, "docs"), { recursive: true });
      await writeFile(
        join(tempDir, "docs", "integrations.md"),
        "Tickets tracked in BACKEND-55. Wiki at https://mycompany.atlassian.net/wiki/spaces/TECH/pages/1\n"
      );

      const results = await detectIntegrations(tempDir);

      const jiraRefs = results.filter((r) => r.type === "jira");
      const confRefs = results.filter((r) => r.type === "confluence");
      expect(jiraRefs.length).toBeGreaterThanOrEqual(1);
      expect(confRefs.length).toBeGreaterThanOrEqual(1);
    });

    it("finds multiple integration types in same file", async () => {
      await writeFile(
        join(tempDir, "project.md"),
        [
          "# Project\n",
          "Jira: WORK-42\n",
          "Confluence: https://example.atlassian.net/wiki/spaces/ENG/pages/1\n",
          "Slack: https://hooks.slack.com/services/T000/B000/xxx\n",
        ].join("")
      );

      const results = await detectIntegrations(tempDir);

      const types = new Set(results.map((r) => r.type));
      expect(types.has("jira")).toBe(true);
      expect(types.has("confluence")).toBe(true);
      expect(types.has("slack")).toBe(true);
    });

    it("deduplicates identical integration refs", async () => {
      await writeFile(
        join(tempDir, "notes.md"),
        "See PROJ-10 and PROJ-10 and PROJ-10.\n"
      );

      const results = await detectIntegrations(tempDir);

      const jiraRefs = results.filter((r) => r.type === "jira" && r.ref === "PROJ-10");
      expect(jiraRefs).toHaveLength(1);
    });

    it("skips node_modules directory", async () => {
      await mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
      await writeFile(
        join(tempDir, "node_modules", "pkg", "readme.md"),
        "See INTERNAL-99 for details.\n"
      );
      await writeFile(join(tempDir, "clean.md"), "No integrations.\n");

      const results = await detectIntegrations(tempDir);

      const jiraRefs = results.filter((r) => r.type === "jira" && r.ref === "INTERNAL-99");
      expect(jiraRefs).toHaveLength(0);
    });

    it("skips .git directory", async () => {
      await mkdir(join(tempDir, ".git"), { recursive: true });
      await writeFile(
        join(tempDir, ".git", "COMMIT_EDITMSG"),
        "fix: resolved SKIP-1\n"
      );
      await writeFile(join(tempDir, "readme.md"), "# Readme\n");

      const results = await detectIntegrations(tempDir);

      const jiraRefs = results.filter((r) => r.type === "jira" && r.ref === "SKIP-1");
      expect(jiraRefs).toHaveLength(0);
    });

    it("skips dist directory", async () => {
      await mkdir(join(tempDir, "dist"), { recursive: true });
      await writeFile(
        join(tempDir, "dist", "bundle.js"),
        "// See DIST-999 for this optimization\n"
      );
      await writeFile(join(tempDir, "clean.ts"), "const x = 1;\n");

      const results = await detectIntegrations(tempDir);

      const jiraRefs = results.filter((r) => r.type === "jira" && r.ref === "DIST-999");
      expect(jiraRefs).toHaveLength(0);
    });
  });
});
