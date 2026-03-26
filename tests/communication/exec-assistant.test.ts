import { describe, it, expect, beforeEach } from "vitest";
import { ExecAssistant } from "../../src/communication/exec-assistant.js";
import type { ChannelMessage } from "../../src/communication/channel-manager.js";

function makeMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    messageId: "m1",
    channelId: "inbox",
    from: "cto",
    subject: "Update",
    body: "Here is an update",
    category: "status",
    priority: "normal",
    timestamp: new Date().toISOString(),
    consumed: false,
    ...overrides,
  };
}

describe("ExecAssistant", () => {
  let assistant: ExecAssistant;
  beforeEach(() => { assistant = new ExecAssistant("ceo"); });

  describe("classify", () => {
    it("classifies urgent priority as urgent", () => {
      const c = assistant.classify(makeMsg({ priority: "urgent" }));
      expect(c.classification).toBe("urgent");
    });
    it("classifies escalation category as urgent", () => {
      const c = assistant.classify(makeMsg({ category: "escalation" }));
      expect(c.classification).toBe("urgent");
    });
    it("classifies decision as action", () => {
      const c = assistant.classify(makeMsg({ category: "decision" }));
      expect(c.classification).toBe("action");
    });
    it("classifies task as action", () => {
      const c = assistant.classify(makeMsg({ category: "task" }));
      expect(c.classification).toBe("action");
    });
    it("classifies high priority as action", () => {
      const c = assistant.classify(makeMsg({ priority: "high" }));
      expect(c.classification).toBe("action");
    });
    it("classifies review as fyi", () => {
      const c = assistant.classify(makeMsg({ category: "review" }));
      expect(c.classification).toBe("fyi");
    });
    it("classifies status as fyi", () => {
      const c = assistant.classify(makeMsg({ category: "status", priority: "normal" }));
      expect(c.classification).toBe("fyi");
    });
    it("classifies low priority as noise", () => {
      const c = assistant.classify(makeMsg({ priority: "low" }));
      expect(c.classification).toBe("noise");
    });
  });

  describe("generateBriefing", () => {
    it("produces correct counts", () => {
      const msgs = [
        makeMsg({ priority: "urgent", messageId: "1" }),
        makeMsg({ category: "decision", messageId: "2" }),
        makeMsg({ category: "review", messageId: "3" }),
        makeMsg({ priority: "low", messageId: "4" }),
      ];
      const briefing = assistant.generateBriefing(msgs);
      expect(briefing.urgentItems).toHaveLength(1);
      expect(briefing.actionItems).toHaveLength(1);
      expect(briefing.fyiCount).toBe(1);
      expect(briefing.noiseCount).toBe(1);
      expect(briefing.totalProcessed).toBe(4);
    });
    it("fyiSummary lists FYI subjects", () => {
      const msgs = [makeMsg({ category: "review", subject: "PR #42", messageId: "1" })];
      const briefing = assistant.generateBriefing(msgs);
      expect(briefing.fyiSummary).toContain("PR #42");
    });
    it("fyiSummary is 'No FYI items.' when empty", () => {
      const briefing = assistant.generateBriefing([makeMsg({ priority: "urgent" })]);
      expect(briefing.fyiSummary).toBe("No FYI items.");
    });
  });

  describe("requiresAttention", () => {
    it("returns true when urgent items present", () => {
      const b = assistant.generateBriefing([makeMsg({ priority: "urgent" })]);
      expect(assistant.requiresAttention(b)).toBe(true);
    });
    it("returns true when action items present", () => {
      const b = assistant.generateBriefing([makeMsg({ category: "decision" })]);
      expect(assistant.requiresAttention(b)).toBe(true);
    });
    it("returns false for FYI-only briefing", () => {
      const b = assistant.generateBriefing([makeMsg({ category: "status" })]);
      expect(assistant.requiresAttention(b)).toBe(false);
    });
    it("returns false for empty briefing", () => {
      const b = assistant.generateBriefing([]);
      expect(assistant.requiresAttention(b)).toBe(false);
    });
  });

  describe("formatForPrompt", () => {
    it("returns minimal summary when no attention required", () => {
      const b = assistant.generateBriefing([makeMsg({ priority: "low" })]);
      const prompt = assistant.formatForPrompt(b);
      expect(prompt).toMatch(/no action required/i);
    });
    it("includes urgent and action sections", () => {
      const msgs = [
        makeMsg({ priority: "urgent", subject: "FIRE", messageId: "1" }),
        makeMsg({ category: "decision", subject: "Approve PR", messageId: "2" }),
      ];
      const prompt = assistant.formatForPrompt(assistant.generateBriefing(msgs));
      expect(prompt).toContain("URGENT");
      expect(prompt).toContain("FIRE");
      expect(prompt).toContain("ACTION REQUIRED");
      expect(prompt).toContain("Approve PR");
    });
  });

  describe("custom rules", () => {
    it("applies custom classification rules", () => {
      const customAssistant = new ExecAssistant("ceo", [
        { matches: (m) => m.subject.startsWith("[SKIP]"), classification: "noise", reason: "Filtered" },
      ]);
      const c = customAssistant.classify(makeMsg({ subject: "[SKIP] boring", priority: "urgent" }));
      expect(c.classification).toBe("noise");
    });
  });
});
