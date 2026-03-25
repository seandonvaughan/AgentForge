import { describe, it, expect } from "vitest";
import { BudgetEnvelope } from "../../src/budget/budget-envelope.js";

describe("BudgetEnvelope", () => {
  it("creates envelope with maxBudgetUsd", () => {
    const env = new BudgetEnvelope(10);
    const report = env.getSpendReport();
    expect(report.totalSpentUsd).toBe(0);
    expect(report.remainingUsd).toBe(10);
    expect(report.percentUsed).toBe(0);
  });

  it("proceeds when estimate is below 50% of budget", () => {
    const env = new BudgetEnvelope(10);
    const result = env.checkBefore(4, "haiku"); // 40%
    expect(result.action).toBe("proceed");
    expect(result.allowed).toBe(true);
    expect(result.budgetContextSnippet).toBeUndefined();
  });

  it("proceeds silently between 50% and 80%", () => {
    const env = new BudgetEnvelope(10);
    const result = env.checkBefore(6, "sonnet"); // 60%
    expect(result.action).toBe("proceed");
    expect(result.allowed).toBe(true);
  });

  it("warns when estimate pushes spend to 80–95%", () => {
    const env = new BudgetEnvelope(10);
    env.recordActual(7);                         // already at 70%
    const result = env.checkBefore(1.5, "opus"); // 70% + 15% = 85%
    expect(result.action).toBe("warn");
    expect(result.allowed).toBe(true);
    expect(result.budgetContextSnippet).toBeDefined();
  });

  it("requires approval (soft block) when estimate pushes spend to 95–100%", () => {
    const env = new BudgetEnvelope(10);
    env.recordActual(8.5);                       // 85%
    const result = env.checkBefore(1, "opus");   // 85% + 10% = 95%
    expect(result.action).toBe("approve");
    expect(result.allowed).toBe(false);
  });

  it("blocks when estimate would exceed 100% of budget", () => {
    const env = new BudgetEnvelope(10);
    env.recordActual(9);                         // 90%
    const result = env.checkBefore(2, "opus");   // 90% + 20% = 110%
    expect(result.action).toBe("block");
    expect(result.allowed).toBe(false);
  });

  it("recordActual accumulates spend correctly", () => {
    const env = new BudgetEnvelope(10);
    env.recordActual(2);
    env.recordActual(3);
    const report = env.getSpendReport();
    expect(report.totalSpentUsd).toBe(5);
    expect(report.remainingUsd).toBe(5);
    expect(report.percentUsed).toBe(50);
  });

  it("remainingUsd never goes negative in report", () => {
    const env = new BudgetEnvelope(5);
    env.recordActual(7);
    const report = env.getSpendReport();
    expect(report.remainingUsd).toBe(0);
  });

  it("budgetContextSnippet contains remaining info when warning", () => {
    const env = new BudgetEnvelope(10);
    env.recordActual(7);
    const result = env.checkBefore(1.5, "sonnet");
    expect(result.budgetContextSnippet).toContain("remaining");
  });

  it("getSpendReport returns percentUsed > 100 when over budget", () => {
    const env = new BudgetEnvelope(5);
    env.recordActual(6);
    const report = env.getSpendReport();
    expect(report.percentUsed).toBeGreaterThan(100);
  });
});
