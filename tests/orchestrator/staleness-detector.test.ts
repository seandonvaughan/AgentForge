import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StalenessDetector } from "../../src/orchestrator/staleness-detector.js";

describe("StalenessDetector", () => {
  let detector: StalenessDetector;

  beforeEach(() => {
    detector = new StalenessDetector("/fake/project");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isStaleness", () => {
    it("should return false when commits match", async () => {
      vi.spyOn(detector, "getCurrentCommit").mockResolvedValue("abc1234");
      const result = await detector.isStale("abc1234");
      expect(result).toBe(false);
    });

    it("should return true when commits differ", async () => {
      vi.spyOn(detector, "getCurrentCommit").mockResolvedValue("def5678");
      const result = await detector.isStale("abc1234");
      expect(result).toBe(true);
    });

    it("should return false when savedCommit is empty string", async () => {
      vi.spyOn(detector, "getCurrentCommit").mockResolvedValue("abc1234");
      const result = await detector.isStale("");
      expect(result).toBe(false);
    });
  });

  describe("getCommitDistance", () => {
    it("should return 0 when commits match", async () => {
      vi.spyOn(detector, "getCommitsBetween").mockResolvedValue([]);
      const distance = await detector.getCommitDistance("abc1234", "abc1234");
      expect(distance).toBe(0);
    });

    it("should return the number of commits between", async () => {
      vi.spyOn(detector, "getCommitsBetween").mockResolvedValue(["commit1", "commit2", "commit3"]);
      const distance = await detector.getCommitDistance("old123", "new456");
      expect(distance).toBe(3);
    });
  });

  describe("formatStalenessWarning", () => {
    it("should return null when not stale", () => {
      const result = detector.formatStalenessWarning(false, 0);
      expect(result).toBeNull();
    });

    it("should return a warning message when stale", () => {
      const result = detector.formatStalenessWarning(true, 5);
      expect(result).not.toBeNull();
      expect(result).toContain("5");
    });

    it("should return a basic warning when stale with 0 distance", () => {
      const result = detector.formatStalenessWarning(true, 0);
      expect(result).not.toBeNull();
    });
  });
});
