import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ResearchFindings } from "../../src/types/analysis.js";

describe("web-researcher", () => {
  describe("researchProject", () => {
    it("returns a ResearchFindings object", async () => {
      // Import fresh each time so env changes take effect
      const { researchProject } = await import("../../src/scanner/web-researcher.js");
      const result = await researchProject("TestApp", ["saas", "B2B"]);

      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    });

    it("returns properly structured ResearchFindings with known optional fields", async () => {
      const { researchProject } = await import("../../src/scanner/web-researcher.js");
      const result: ResearchFindings = await researchProject("MyStartup", ["fintech"]);

      // ResearchFindings allows any keys — check the known optional ones are
      // either absent or of the right type when present.
      if (result.market_size !== undefined) {
        expect(typeof result.market_size).toBe("string");
      }
      if (result.competitors !== undefined) {
        expect(Array.isArray(result.competitors)).toBe(true);
      }
      if (result.industry_trends !== undefined) {
        expect(Array.isArray(result.industry_trends)).toBe(true);
      }
    });

    it("when no API key, returns empty findings with a note", async () => {
      // Ensure the API key env var is absent for this test
      const originalKey = process.env["ANTHROPIC_API_KEY"];
      delete process.env["ANTHROPIC_API_KEY"];

      try {
        // Re-import to pick up the env state (vitest module cache reset not
        // needed here because the function checks env at call time)
        const { researchProject } = await import("../../src/scanner/web-researcher.js");
        const result = await researchProject("NoKeyApp", ["healthcare"]);

        // Should return a valid ResearchFindings object
        expect(result).toBeDefined();

        // Must include a human-readable note explaining why results are empty
        expect(result["note"]).toBeDefined();
        expect(typeof result["note"]).toBe("string");
        expect((result["note"] as string).length).toBeGreaterThan(0);
      } finally {
        if (originalKey !== undefined) {
          process.env["ANTHROPIC_API_KEY"] = originalKey;
        }
      }
    });

    it("note explains missing API key when no key is set", async () => {
      const originalKey = process.env["ANTHROPIC_API_KEY"];
      delete process.env["ANTHROPIC_API_KEY"];

      try {
        const { researchProject } = await import("../../src/scanner/web-researcher.js");
        const result = await researchProject("AnotherApp", ["ecommerce"]);

        const note = result["note"] as string;
        // The note should mention either the API key or that research is unavailable
        expect(
          note.toLowerCase().includes("api key") ||
          note.toLowerCase().includes("unavailable") ||
          note.toLowerCase().includes("not configured") ||
          note.toLowerCase().includes("stub")
        ).toBe(true);
      } finally {
        if (originalKey !== undefined) {
          process.env["ANTHROPIC_API_KEY"] = originalKey;
        }
      }
    });

    it("accepts project name and keywords parameters", async () => {
      const { researchProject } = await import("../../src/scanner/web-researcher.js");
      // Should not throw regardless of parameters
      await expect(
        researchProject("ProjectName", ["keyword1", "keyword2", "keyword3"])
      ).resolves.toBeDefined();
    });

    it("returns empty findings with a note even with empty keywords", async () => {
      const originalKey = process.env["ANTHROPIC_API_KEY"];
      delete process.env["ANTHROPIC_API_KEY"];

      try {
        const { researchProject } = await import("../../src/scanner/web-researcher.js");
        const result = await researchProject("App", []);

        expect(result).toBeDefined();
        expect(result["note"]).toBeDefined();
      } finally {
        if (originalKey !== undefined) {
          process.env["ANTHROPIC_API_KEY"] = originalKey;
        }
      }
    });
  });
});
