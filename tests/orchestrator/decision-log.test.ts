import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DecisionLog } from "../../src/orchestrator/decision-log.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("DecisionLog", () => {
  let tmpDir: string;
  let log: DecisionLog;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentforge-decisions-test-"));
    log = new DecisionLog(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Recording ───────────────────────────────────────────────────────────

  it("records a decision and returns an ID", async () => {
    const id = await log.record({
      type: "routing",
      agent: "cost-tracker-dev",
      description: "Routed task to haiku",
      alternatives: ["sonnet", "opus"],
      rationale: "Low complexity score",
      artifacts: [],
      confidence: 0.9,
    });

    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("persists decisions to disk as JSON files", async () => {
    await log.record({
      type: "routing",
      agent: "test-agent",
      description: "test",
      alternatives: [],
      rationale: "test",
      artifacts: [],
      confidence: 1.0,
    });

    const dir = path.join(tmpDir, ".agentforge", "decisions");
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });

  it("auto-generates timestamp and id", async () => {
    await log.record({
      type: "delegation",
      agent: "cto",
      description: "Delegated to core-platform-lead",
      alternatives: ["runtime-platform-lead"],
      rationale: "Type system task",
      artifacts: [],
      confidence: 0.85,
    });

    const all = await log.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBeTruthy();
    expect(all[0].timestamp).toBeTruthy();
    expect(new Date(all[0].timestamp).getTime()).toBeGreaterThan(0);
  });

  // ── Querying ────────────────────────────────────────────────────────────

  it("loads all decisions", async () => {
    await log.record({ type: "routing", agent: "a", description: "d1", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });
    await log.record({ type: "reforge", agent: "b", description: "d2", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });
    await log.record({ type: "budget", agent: "c", description: "d3", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });

    const all = await log.loadAll();
    expect(all).toHaveLength(3);
  });

  it("getRecent returns most recent N decisions", async () => {
    for (let i = 0; i < 5; i++) {
      await log.record({ type: "routing", agent: `agent-${i}`, description: `d${i}`, alternatives: [], rationale: "r", artifacts: [], confidence: 1 });
    }

    const recent = await log.getRecent(3);
    expect(recent).toHaveLength(3);
    // Most recent first
    expect(recent[0].timestamp >= recent[1].timestamp).toBe(true);
  });

  it("queryByType filters correctly", async () => {
    await log.record({ type: "routing", agent: "a", description: "d1", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });
    await log.record({ type: "reforge", agent: "b", description: "d2", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });
    await log.record({ type: "routing", agent: "c", description: "d3", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });

    const routing = await log.queryByType("routing");
    expect(routing).toHaveLength(2);
    expect(routing.every((d) => d.type === "routing")).toBe(true);
  });

  it("queryByAgent filters correctly", async () => {
    await log.record({ type: "routing", agent: "cto", description: "d1", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });
    await log.record({ type: "reforge", agent: "cto", description: "d2", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });
    await log.record({ type: "routing", agent: "other", description: "d3", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });

    const ctoDecisions = await log.queryByAgent("cto");
    expect(ctoDecisions).toHaveLength(2);
  });

  it("queryBySession filters correctly", async () => {
    await log.record({ type: "routing", agent: "a", description: "d1", alternatives: [], rationale: "r", artifacts: [], confidence: 1, sessionId: "s1" });
    await log.record({ type: "reforge", agent: "b", description: "d2", alternatives: [], rationale: "r", artifacts: [], confidence: 1, sessionId: "s2" });

    const s1 = await log.queryBySession("s1");
    expect(s1).toHaveLength(1);
    expect(s1[0].description).toBe("d1");
  });

  it("returns empty arrays when no decisions exist", async () => {
    expect(await log.loadAll()).toEqual([]);
    expect(await log.getRecent()).toEqual([]);
    expect(await log.queryByType("routing")).toEqual([]);
    expect(await log.queryByAgent("cto")).toEqual([]);
  });

  // ── Artifacts ───────────────────────────────────────────────────────────

  it("preserves artifact links in recorded decisions", async () => {
    await log.record({
      type: "reforge",
      agent: "reforge-engine",
      description: "Applied system prompt preamble",
      alternatives: ["model tier override"],
      rationale: "Feedback theme: cost-awareness",
      artifacts: [
        { type: "override", location: ".agentforge/agent-overrides/cost-tracker-dev.json" },
      ],
      confidence: 0.8,
    });

    const all = await log.loadAll();
    expect(all[0].artifacts).toHaveLength(1);
    expect(all[0].artifacts[0].type).toBe("override");
  });

  // ── Metrics ─────────────────────────────────────────────────────────────

  it("tracks decisions recorded count", async () => {
    expect(log.getDecisionsRecordedCount()).toBe(0);
    await log.record({ type: "routing", agent: "a", description: "d", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });
    expect(log.getDecisionsRecordedCount()).toBe(1);
    await log.record({ type: "routing", agent: "b", description: "d", alternatives: [], rationale: "r", artifacts: [], confidence: 1 });
    expect(log.getDecisionsRecordedCount()).toBe(2);
  });
});
