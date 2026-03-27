/**
 * autonomy-persistence.test.ts
 * Tests for SQLite persistence of AutonomyGovernor (P0-8)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AutonomyGovernor } from "../../src/flywheel/autonomy-governor.js";
import { AgentDatabase } from "../../src/db/database.js";

function makeDb(): AgentDatabase {
  return new AgentDatabase({ path: ":memory:" });
}

function getAutonomyRow(db: AgentDatabase, agentId: string) {
  return db.getDb()
    .prepare("SELECT * FROM agent_autonomy WHERE agent_id = ?")
    .get(agentId) as Record<string, unknown> | undefined;
}

describe("AutonomyGovernor — pure in-memory (no DB)", () => {
  let gov: AutonomyGovernor;

  beforeEach(() => {
    gov = new AutonomyGovernor();
  });

  it("registers an agent in memory", () => {
    gov.register("agent-a", 1);
    expect(gov.getTier("agent-a")).toBe(1);
  });

  it("records successes in memory", () => {
    gov.register("agent-a", 1);
    gov.recordSuccess("agent-a");
    gov.recordSuccess("agent-a");
    expect(gov.getRecord("agent-a")!.totalSuccesses).toBe(2);
  });

  it("records failures in memory", () => {
    gov.register("agent-a", 2);
    gov.recordFailure("agent-a");
    expect(gov.getRecord("agent-a")!.totalFailures).toBe(1);
  });

  it("promotes in memory without DB", () => {
    gov.register("agent-a", 1);
    for (let i = 0; i < 5; i++) gov.recordSuccess("agent-a");
    const result = gov.evaluatePromotion("agent-a");
    expect(result.promoted).toBe(true);
    expect(gov.getTier("agent-a")).toBe(2);
  });

  it("demotes in memory without DB", () => {
    gov.register("agent-a", 3);
    for (let i = 0; i < 3; i++) gov.recordFailure("agent-a");
    const result = gov.evaluateDemotion("agent-a");
    expect(result.demoted).toBe(true);
    expect(gov.getTier("agent-a")).toBe(2);
  });
});

describe("AutonomyGovernor — SQLite persistence", () => {
  let db: AgentDatabase;
  let gov: AutonomyGovernor;

  beforeEach(() => {
    db = makeDb();
    gov = new AutonomyGovernor({ db });
  });

  afterEach(() => {
    db.close();
  });

  it("register() persists a new agent to agent_autonomy table", () => {
    gov.register("cto", 2);
    const row = getAutonomyRow(db, "cto");
    expect(row).toBeDefined();
    expect(row!.agent_id).toBe("cto");
    expect(row!.current_tier).toBe(2);
  });

  it("register() persists default zeroed counters", () => {
    gov.register("eng", 1);
    const row = getAutonomyRow(db, "eng");
    expect(row!.consecutive_successes).toBe(0);
    expect(row!.consecutive_failures).toBe(0);
    expect(row!.total_successes).toBe(0);
    expect(row!.total_failures).toBe(0);
  });

  it("recordSuccess() persists updated counters", () => {
    gov.register("eng", 1);
    gov.recordSuccess("eng");
    gov.recordSuccess("eng");
    const row = getAutonomyRow(db, "eng");
    expect(row!.total_successes).toBe(2);
    expect(row!.consecutive_successes).toBe(2);
  });

  it("recordFailure() persists updated counters", () => {
    gov.register("eng", 2);
    gov.recordFailure("eng");
    const row = getAutonomyRow(db, "eng");
    expect(row!.total_failures).toBe(1);
    expect(row!.consecutive_failures).toBe(1);
  });

  it("recordSuccess() resets consecutive_failures in DB", () => {
    gov.register("eng", 2);
    gov.recordFailure("eng");
    gov.recordFailure("eng");
    gov.recordSuccess("eng");
    const row = getAutonomyRow(db, "eng");
    expect(row!.consecutive_failures).toBe(0);
    expect(row!.total_failures).toBe(2);
    expect(row!.total_successes).toBe(1);
  });

  it("evaluatePromotion() persists promoted_at when promoted", () => {
    gov.register("arch", 1);
    for (let i = 0; i < 5; i++) gov.recordSuccess("arch");
    gov.evaluatePromotion("arch");
    const row = getAutonomyRow(db, "arch");
    expect(row!.current_tier).toBe(2);
    expect(row!.promoted_at).toBeTruthy();
    expect(row!.consecutive_successes).toBe(0);
  });

  it("evaluateDemotion() persists demoted_at when demoted", () => {
    gov.register("agent", 3);
    for (let i = 0; i < 3; i++) gov.recordFailure("agent");
    gov.evaluateDemotion("agent");
    const row = getAutonomyRow(db, "agent");
    expect(row!.current_tier).toBe(2);
    expect(row!.demoted_at).toBeTruthy();
  });

  it("evaluatePromotion() persists record even when NOT promoted", () => {
    gov.register("newbie", 1);
    gov.recordSuccess("newbie");
    gov.evaluatePromotion("newbie"); // only 1 success, not enough
    const row = getAutonomyRow(db, "newbie");
    expect(row!.current_tier).toBe(1);
    expect(row!.promoted_at).toBeNull();
  });

  it("clamps tier to [1..4] on register()", () => {
    gov.register("agent-low", 0);
    gov.register("agent-high", 99);
    expect(getAutonomyRow(db, "agent-low")!.current_tier).toBe(1);
    expect(getAutonomyRow(db, "agent-high")!.current_tier).toBe(4);
  });
});

describe("AutonomyGovernor — loadFromDb()", () => {
  let db: AgentDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it("loadFromDb() restores all agent records from DB", () => {
    const gov1 = new AutonomyGovernor({ db });
    gov1.register("cto", 2);
    gov1.register("eng", 1);
    gov1.recordSuccess("cto");
    gov1.recordSuccess("cto");

    const gov2 = AutonomyGovernor.loadFromDb(db);
    expect(gov2.getTier("cto")).toBe(2);
    expect(gov2.getTier("eng")).toBe(1);
    expect(gov2.getRecord("cto")!.totalSuccesses).toBe(2);
  });

  it("loadFromDb() restores tier after promotion", () => {
    const gov1 = new AutonomyGovernor({ db });
    gov1.register("arch", 1);
    for (let i = 0; i < 5; i++) gov1.recordSuccess("arch");
    gov1.evaluatePromotion("arch");

    const gov2 = AutonomyGovernor.loadFromDb(db);
    expect(gov2.getTier("arch")).toBe(2);
    expect(gov2.getRecord("arch")!.consecutiveSuccesses).toBe(0);
  });

  it("loadFromDb() restores tier after demotion", () => {
    const gov1 = new AutonomyGovernor({ db });
    gov1.register("agent", 3);
    for (let i = 0; i < 3; i++) gov1.recordFailure("agent");
    gov1.evaluateDemotion("agent");

    const gov2 = AutonomyGovernor.loadFromDb(db);
    expect(gov2.getTier("agent")).toBe(2);
    expect(gov2.getRecord("agent")!.consecutiveFailures).toBe(0);
  });

  it("loadFromDb() with empty DB returns governor with no records", () => {
    const gov = AutonomyGovernor.loadFromDb(db);
    expect(gov.getTier("nobody")).toBeNull();
    expect(gov.getRecord("nobody")).toBeNull();
  });

  it("loadFromDb() accepts optional bus parameter", () => {
    const gov1 = new AutonomyGovernor({ db });
    gov1.register("x", 1);

    // Should not throw when bus is omitted
    const gov2 = AutonomyGovernor.loadFromDb(db);
    expect(gov2.getTier("x")).toBe(1);
  });
});

describe("AutonomyGovernor — shared in-memory DB state", () => {
  let db: AgentDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it("two governors sharing same :memory: DB share state via loadFromDb", () => {
    const gov1 = new AutonomyGovernor({ db });
    gov1.register("shared-agent", 2);
    gov1.recordSuccess("shared-agent");
    gov1.recordSuccess("shared-agent");

    const gov2 = AutonomyGovernor.loadFromDb(db);
    expect(gov2.getTier("shared-agent")).toBe(2);
    expect(gov2.getRecord("shared-agent")!.totalSuccesses).toBe(2);
  });

  it("second governor can continue from where first left off", () => {
    const gov1 = new AutonomyGovernor({ db });
    gov1.register("agent", 1);
    for (let i = 0; i < 3; i++) gov1.recordSuccess("agent");

    const gov2 = AutonomyGovernor.loadFromDb(db);
    for (let i = 0; i < 2; i++) gov2.recordSuccess("agent");
    const result = gov2.evaluatePromotion("agent");
    expect(result.promoted).toBe(true);
    expect(gov2.getTier("agent")).toBe(2);
  });
});
