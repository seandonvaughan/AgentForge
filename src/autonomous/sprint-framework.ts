/**
 * AutonomousSprintFramework — v4.2 P0-3
 *
 * Codifies the sprint planning → execution → review cycle so the team
 * can autonomously plan and execute v4.3+ without human direction.
 *
 * Cycle: audit → plan → assign → execute → test → review → gate → release → learn
 */

import { randomUUID } from "node:crypto";
import type { SessionMemoryEntry } from "../memory/session-memory-manager.js";
import { writeMemoryEntry } from "../../packages/core/src/memory/types.js";

/**
 * Minimal interface for writing gate-verdict memory entries.
 * Satisfied by SessionMemoryManager.addEntry() — accepts any object with that method.
 */
export interface GateVerdictMemoryWriter {
  addEntry(entry: SessionMemoryEntry): void;
}

export interface SprintFrameworkOptions {
  /** When provided, every call to recordResult() writes a gate-verdict memory entry. */
  memoryWriter?: GateVerdictMemoryWriter;
  /**
   * Absolute path to the project root. When provided, recordResult() also
   * appends a gate-verdict entry to `.agentforge/memory/gate-verdict.jsonl`
   * via writeMemoryEntry so the verdict is visible to the /api/v5/memory
   * endpoint and flywheel dashboard between sessions.
   */
  projectRoot?: string;
}

export type SprintPhase =
  | "audit"      // R&D lead scans codebase, metrics, feedback
  | "plan"       // Sprint planner produces roadmap
  | "assign"     // CTO assigns tasks to agents
  | "execute"    // Agents work in parallel
  | "test"       // QA runs full suite
  | "review"     // Team reviewer + meta-architect audit
  | "gate"       // CEO approves/rejects
  | "release"    // DevOps tags and builds
  | "learn";     // Flywheel records outcomes

export interface SprintItem {
  id: string;
  title: string;
  description: string;
  priority: "P0" | "P1" | "P2";
  assignee: string;
  status: "planned" | "in_progress" | "completed" | "blocked" | "deferred";
  completedAt?: string;
}

export interface SprintPlan {
  sprintId: string;
  version: string;         // e.g. "4.3"
  title: string;
  createdAt: string;
  phase: SprintPhase;
  items: SprintItem[];
  budget: number;
  teamSize: number;
  successCriteria: string[];
  auditFindings: string[];
}

export interface SprintResult {
  sprintId: string;
  version: string;
  phase: SprintPhase;
  completedAt: string;
  itemsCompleted: number;
  itemsTotal: number;
  testsPassing: number;
  testsTotal: number;
  budgetUsed: number;
  gateVerdict: "approved" | "rejected" | "pending";
  learnings: string[];
}

const PHASE_ORDER: SprintPhase[] = [
  "audit", "plan", "assign", "execute", "test", "review", "gate", "release", "learn",
];

export class AutonomousSprintFramework {
  private sprints = new Map<string, SprintPlan>();
  private results = new Map<string, SprintResult>();
  private readonly memoryWriter?: GateVerdictMemoryWriter;
  private readonly projectRoot?: string;

  constructor(options?: SprintFrameworkOptions) {
    this.memoryWriter = options?.memoryWriter;
    this.projectRoot = options?.projectRoot;
  }

  // ---------------------------------------------------------------------------
  // Sprint lifecycle
  // ---------------------------------------------------------------------------

  createSprint(version: string, title: string, budget: number, teamSize: number): SprintPlan {
    const sprint: SprintPlan = {
      sprintId: randomUUID(),
      version,
      title,
      createdAt: new Date().toISOString(),
      phase: "audit",
      items: [],
      budget,
      teamSize,
      successCriteria: [],
      auditFindings: [],
    };
    this.sprints.set(sprint.sprintId, sprint);
    return this.cloneSprint(sprint);
  }

  advancePhase(sprintId: string): SprintPlan {
    const sprint = this.requireSprint(sprintId);
    const currentIdx = PHASE_ORDER.indexOf(sprint.phase);
    if (currentIdx >= PHASE_ORDER.length - 1) {
      throw new Error(`Sprint "${sprintId}" is already in final phase "${sprint.phase}"`);
    }
    sprint.phase = PHASE_ORDER[currentIdx + 1];
    return this.cloneSprint(sprint);
  }

  getPhase(sprintId: string): SprintPhase {
    return this.requireSprint(sprintId).phase;
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  recordAuditFindings(sprintId: string, findings: string[]): void {
    const sprint = this.requireSprint(sprintId);
    sprint.auditFindings.push(...findings);
  }

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------

  addItem(sprintId: string, item: Omit<SprintItem, "id" | "status">): SprintItem {
    const sprint = this.requireSprint(sprintId);
    const full: SprintItem = { ...item, id: randomUUID(), status: "planned" };
    sprint.items.push(full);
    return { ...full };
  }

  setSuccessCriteria(sprintId: string, criteria: string[]): void {
    const sprint = this.requireSprint(sprintId);
    sprint.successCriteria = [...criteria];
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  startItem(sprintId: string, itemId: string): SprintItem {
    const item = this.requireItem(sprintId, itemId);
    item.status = "in_progress";
    return { ...item };
  }

  completeItem(sprintId: string, itemId: string): SprintItem {
    const item = this.requireItem(sprintId, itemId);
    item.status = "completed";
    item.completedAt = new Date().toISOString();
    return { ...item };
  }

  blockItem(sprintId: string, itemId: string): SprintItem {
    const item = this.requireItem(sprintId, itemId);
    item.status = "blocked";
    return { ...item };
  }

  deferItem(sprintId: string, itemId: string): SprintItem {
    const item = this.requireItem(sprintId, itemId);
    item.status = "deferred";
    return { ...item };
  }

  // ---------------------------------------------------------------------------
  // Gate
  // ---------------------------------------------------------------------------

  recordResult(sprintId: string, result: Omit<SprintResult, "sprintId" | "version" | "completedAt">): SprintResult {
    const sprint = this.requireSprint(sprintId);
    const full: SprintResult = {
      ...result,
      sprintId,
      version: sprint.version,
      completedAt: new Date().toISOString(),
    };
    this.results.set(sprintId, full);

    // Write a gate-verdict memory entry so future audit phases can inspect
    // what caused prior approvals or rejections across cycles.
    const verdictSummary = `Sprint ${sprint.version} gate ${full.gateVerdict}: ${full.itemsCompleted}/${full.itemsTotal} items completed, ${full.testsPassing}/${full.testsTotal} tests passing`;
    const verdictEntryId = randomUUID();

    if (this.memoryWriter) {
      const entry: SessionMemoryEntry = {
        id: verdictEntryId,
        sessionId: sprintId,
        category: "gate-verdict",
        agentId: "gate-phase",
        summary: verdictSummary,
        success: full.gateVerdict === "approved",
        timestamp: full.completedAt,
      };
      this.memoryWriter.addEntry(entry);
    }

    // Append to the canonical JSONL store so the verdict persists across
    // sessions and is queryable by the /api/v5/memory endpoint.
    if (this.projectRoot !== undefined) {
      writeMemoryEntry(this.projectRoot, {
        id: verdictEntryId,
        type: "gate-verdict",
        value: verdictSummary,
        createdAt: full.completedAt,
        source: sprintId,
        tags: ["gate", full.gateVerdict, `sprint:${sprint.version}`],
      });
    }

    return { ...full };
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getSprint(sprintId: string): SprintPlan | null {
    const s = this.sprints.get(sprintId);
    return s ? this.cloneSprint(s) : null;
  }

  getResult(sprintId: string): SprintResult | null {
    const r = this.results.get(sprintId);
    return r ? { ...r, learnings: [...r.learnings] } : null;
  }

  listSprints(): SprintPlan[] {
    return Array.from(this.sprints.values()).map((s) => this.cloneSprint(s));
  }

  getProgress(sprintId: string): { completed: number; total: number; pct: number } {
    const sprint = this.requireSprint(sprintId);
    const completed = sprint.items.filter((i) => i.status === "completed").length;
    const total = sprint.items.length;
    return { completed, total, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
  }

  getPhaseOrder(): SprintPhase[] {
    return [...PHASE_ORDER];
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJSON(): string {
    return JSON.stringify({
      sprints: Array.from(this.sprints.values()),
      results: Array.from(this.results.values()),
    });
  }

  static fromJSON(json: string): AutonomousSprintFramework {
    const fw = new AutonomousSprintFramework();
    const data = JSON.parse(json);
    for (const s of data.sprints) fw.sprints.set(s.sprintId, s);
    for (const r of data.results) fw.results.set(r.sprintId, r);
    return fw;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private requireSprint(sprintId: string): SprintPlan {
    const s = this.sprints.get(sprintId);
    if (!s) throw new Error(`Sprint "${sprintId}" not found`);
    return s;
  }

  private requireItem(sprintId: string, itemId: string): SprintItem {
    const sprint = this.requireSprint(sprintId);
    const item = sprint.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`Item "${itemId}" not found in sprint "${sprintId}"`);
    return item;
  }

  private cloneSprint(sprint: SprintPlan): SprintPlan {
    return {
      ...sprint,
      items: sprint.items.map((i) => ({ ...i })),
      successCriteria: [...sprint.successCriteria],
      auditFindings: [...sprint.auditFindings],
    };
  }
}
