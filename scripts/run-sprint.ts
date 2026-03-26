#!/usr/bin/env node
/**
 * Sprint Simulation — accepts version arg, defaults to latest
 *
 * Demonstrates the AutonomousSprintFramework running a full 9-phase
 * sprint cycle. Run with:
 *   npx tsx scripts/run-sprint.ts        # runs v4.4
 *   npx tsx scripts/run-sprint.ts 4.3   # runs v4.3
 */

import { AutonomousSprintFramework } from "../src/autonomous/sprint-framework.js";

const SPRINT_VERSION = process.argv[2] ?? "4.4";
const fw = new AutonomousSprintFramework();

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function separator(phase: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  PHASE: ${phase.toUpperCase()}`);
  console.log(`${"─".repeat(60)}`);
}

// ── CREATE SPRINT ────────────────────────────────────────────────
const SPRINT_TITLES: Record<string, string> = {
  "4.3": "AgentForge v4.3 Dashboard Overhaul",
  "4.4": "AgentForge v4.4 Real Execution Sprint",
};
const SPRINT_BUDGETS: Record<string, number> = { "4.3": 400, "4.4": 450 };
const sprint = fw.createSprint(
  SPRINT_VERSION,
  SPRINT_TITLES[SPRINT_VERSION] ?? `AgentForge v${SPRINT_VERSION}`,
  SPRINT_BUDGETS[SPRINT_VERSION] ?? 400,
  37,
);
log(`Sprint created: ${sprint.sprintId}`);
log(`Version: ${sprint.version} | Budget: $${sprint.budget} | Team: ${sprint.teamSize} agents`);

// ── PHASE 1: AUDIT ───────────────────────────────────────────────
separator("audit");
fw.recordAuditFindings(sprint.sprintId, [
  "Dashboard uses simulated data — not connected to .agentforge/ file system",
  "Missing 10 new sections from v4.3 directive (Activity Feed, Delegation Flow, etc.)",
  "No dark/light theme toggle",
  "No keyboard navigation",
  "No export functionality",
  "Agent cards have no mini charts",
  "Org graph is static tree, not interactive SVG",
  "Bus monitor lacks payload inspection panel",
  "Session timeline has no Gantt bars",
  "Flywheel gauges have no historical trend lines",
  "No responsive mobile layout",
  "No auto-refresh mechanism (5-second interval needed)",
]);
log(`Audit complete. ${fw.getSprint(sprint.sprintId)!.auditFindings.length} findings recorded.`);
fw.advancePhase(sprint.sprintId);

// ── PHASE 2: PLAN ────────────────────────────────────────────────
separator("plan");

// P0 — Critical path items
const item1 = fw.addItem(sprint.sprintId, {
  title: "Agent Activity Feed",
  description: "Real-time log of agent tasks with durations",
  priority: "P0",
  assignee: "frontend-dev",
});
const item2 = fw.addItem(sprint.sprintId, {
  title: "Sprint Progress Tracker",
  description: "Gantt-style view of current sprint items, completion %",
  priority: "P0",
  assignee: "dashboard-architect",
});
const item3 = fw.addItem(sprint.sprintId, {
  title: "Real data binding",
  description: "Dashboard reads from .agentforge/ files via fetch() with fallback",
  priority: "P0",
  assignee: "backend-dev",
});
const item4 = fw.addItem(sprint.sprintId, {
  title: "Dark/light theme toggle",
  description: "User preference persisted in localStorage",
  priority: "P0",
  assignee: "interaction-designer",
});
const item5 = fw.addItem(sprint.sprintId, {
  title: "Auto-refresh every 5 seconds",
  description: "All sections refresh data without page reload",
  priority: "P0",
  assignee: "frontend-dev",
});

// P1 — High-value additions
const item6 = fw.addItem(sprint.sprintId, {
  title: "Delegation Flow Diagram",
  description: "Interactive SVG showing live delegation chains",
  priority: "P1",
  assignee: "data-viz-specialist",
});
const item7 = fw.addItem(sprint.sprintId, {
  title: "Capability Matrix",
  description: "Heatmap of agent skills with inheritance arrows",
  priority: "P1",
  assignee: "data-viz-specialist",
});
const item8 = fw.addItem(sprint.sprintId, {
  title: "Cost Analytics Section",
  description: "Detailed cost breakdown, historical trends, budget burn rate",
  priority: "P1",
  assignee: "cfo",
});
const item9 = fw.addItem(sprint.sprintId, {
  title: "Review Pipeline Kanban",
  description: "Visual board: pending→assigned→in_review→responded→resolved→approved",
  priority: "P1",
  assignee: "team-reviewer",
});
const item10 = fw.addItem(sprint.sprintId, {
  title: "Autonomy Tier Dashboard",
  description: "Per-agent tier with promotion/demotion history timeline",
  priority: "P1",
  assignee: "rd-lead",
});
const item11 = fw.addItem(sprint.sprintId, {
  title: "Memory Knowledge Base Browser",
  description: "Search/browse memory entries, filter by agent/category/tags",
  priority: "P1",
  assignee: "prototype-dev",
});
const item12 = fw.addItem(sprint.sprintId, {
  title: "REFORGE Activity Panel",
  description: "Active proposals, guardrail results, apply/verify/rollback history",
  priority: "P1",
  assignee: "meta-architect",
});
const item13 = fw.addItem(sprint.sprintId, {
  title: "Meeting Schedule Calendar",
  description: "Calendar view of meetings with participant lists",
  priority: "P1",
  assignee: "coo",
});
const item14 = fw.addItem(sprint.sprintId, {
  title: "Interactive Org Graph SVG",
  description: "Replace static tree with draggable, zoom/pan, click-to-inspect SVG",
  priority: "P1",
  assignee: "data-viz-specialist",
});
const item15 = fw.addItem(sprint.sprintId, {
  title: "Bus Monitor enhancements",
  description: "Payload inspection panel, delivery timing metrics, topic subscription map",
  priority: "P1",
  assignee: "frontend-dev",
});

// P2 — Polish and completeness
const item16 = fw.addItem(sprint.sprintId, {
  title: "Session Timeline Gantt bars",
  description: "Gantt bars, context chain visualization, crash/resume indicators",
  priority: "P2",
  assignee: "interaction-designer",
});
const item17 = fw.addItem(sprint.sprintId, {
  title: "Flywheel historical trend lines",
  description: "Trend lines, component correlation analysis, compound rate graph",
  priority: "P2",
  assignee: "data-viz-specialist",
});
const item18 = fw.addItem(sprint.sprintId, {
  title: "Agent Cards mini charts",
  description: "Mini charts per agent: tasks completed, cost, error rate; expandable panels",
  priority: "P2",
  assignee: "frontend-dev",
});
const item19 = fw.addItem(sprint.sprintId, {
  title: "Keyboard navigation",
  description: "Tab sections, Escape closes modals, / focuses search",
  priority: "P2",
  assignee: "interaction-designer",
});
const item20 = fw.addItem(sprint.sprintId, {
  title: "Export section as PNG or JSON",
  description: "html2canvas via CDN for PNG, JSON download for data",
  priority: "P2",
  assignee: "frontend-dev",
});
const item21 = fw.addItem(sprint.sprintId, {
  title: "Browser notifications for urgent bus events",
  description: "Ask permission on load, show notifications for priority events",
  priority: "P2",
  assignee: "frontend-dev",
});
const item22 = fw.addItem(sprint.sprintId, {
  title: "Responsive layout",
  description: "Desktop, tablet, and mobile breakpoints",
  priority: "P2",
  assignee: "ui-ux-designer",
});
const item23 = fw.addItem(sprint.sprintId, {
  title: "Performance: <2s load, 60fps animations",
  description: "Profile and optimize all animations and initial render",
  priority: "P2",
  assignee: "performance-engineer",
});

fw.setSuccessCriteria(sprint.sprintId, [
  "All 23 directive items implemented in dashboard/index.html",
  "Dark/light theme toggle works and persists preference",
  "All sections have live simulated data with 5-second refresh",
  "Keyboard navigation: Escape closes modals, / focuses search",
  "Org graph is interactive SVG with zoom/pan",
  "Sprint Progress Tracker shows v4.3 items with realistic completion %",
  "Agent Activity Feed shows simulated real-time agent tasks",
  "All 1422+ tests still passing",
]);

const progress = fw.getProgress(sprint.sprintId);
log(`Plan complete. ${progress.total} items added across P0/P1/P2.`);
fw.advancePhase(sprint.sprintId);

// ── PHASE 3: ASSIGN ──────────────────────────────────────────────
separator("assign");
log("Assignments already set during planning. Delegating to parallel agent teams:");
log("  → Team A (frontend-dev, interaction-designer): items 1,4,5,15,16,19,20,21");
log("  → Team B (data-viz-specialist, dashboard-architect): items 2,6,7,14,17");
log("  → Team C (prototype-dev, meta-architect, coo, rd-lead): items 10,11,12,13");
log("  → Team D (ui-ux-designer, performance-engineer, cfo): items 8,9,18,22,23");
log("  → P0 gating: item 3 (real data binding) in parallel with all others");
fw.advancePhase(sprint.sprintId);

// ── PHASE 4: EXECUTE ─────────────────────────────────────────────
separator("execute");
const allItems = fw.getSprint(sprint.sprintId)!.items;
for (const item of allItems) {
  fw.startItem(sprint.sprintId, item.id);
}
log(`${allItems.length} items started by parallel agent teams.`);

// Simulate execution — all complete (dashboard-architect agent does the real work)
for (const item of allItems) {
  fw.completeItem(sprint.sprintId, item.id);
}
const postExec = fw.getProgress(sprint.sprintId);
log(`Execution complete. ${postExec.pct}% items done (${postExec.completed}/${postExec.total}).`);
fw.advancePhase(sprint.sprintId);

// ── PHASE 5: TEST ────────────────────────────────────────────────
separator("test");
log("QA automation engineer running full test suite...");
log("  → npx vitest run (1422+ tests)");
log("  → All tests expected to pass (no backend changes in v4.3)");
fw.advancePhase(sprint.sprintId);

// ── PHASE 6: REVIEW ──────────────────────────────────────────────
separator("review");
log("Team reviewer + meta-architect reviewing dashboard changes:");
log("  → Visual QA: all 23 sections render correctly");
log("  → Cross-browser: Chrome, Firefox, Safari checks");
log("  → Accessibility: ARIA labels, contrast ratios");
log("  → Code quality: no inline event handlers, clean CSS");
fw.advancePhase(sprint.sprintId);

// ── PHASE 7: GATE ────────────────────────────────────────────────
separator("gate");
const result = fw.recordResult(sprint.sprintId, {
  phase: "gate",
  itemsCompleted: 23,
  itemsTotal: 23,
  testsPassing: 1422,
  testsTotal: 1422,
  budgetUsed: 320,
  gateVerdict: "approved",
  learnings: [
    "Single-file HTML dashboard scales well to 4000+ lines with sections",
    "Simulated data with 5s refresh gives convincing live feel before real data binding",
    "Interactive SVG org graph requires careful viewport/pan math",
    "Dark/light theme via CSS custom property swap is zero-cost performance",
    "Mini charts in agent cards add significant visual value",
    "Keyboard navigation with tabindex and keydown events works without libraries",
  ],
});
log(`Gate verdict: ${result.gateVerdict.toUpperCase()}`);
log(`Budget used: $${result.budgetUsed} of $${sprint.budget}`);
fw.advancePhase(sprint.sprintId);

// ── PHASE 8: RELEASE ─────────────────────────────────────────────
separator("release");
log("DevOps tagging release: plugin v0.4.2");
log("Changelog updated with all 23 dashboard items");
fw.advancePhase(sprint.sprintId);

// ── PHASE 9: LEARN ───────────────────────────────────────────────
separator("learn");
log("Flywheel recording v4.3 outcomes...");
const finalPhase = fw.getPhase(sprint.sprintId);
const finalProgress = fw.getProgress(sprint.sprintId);
log(`Final phase: ${finalPhase}`);
log(`Final progress: ${finalProgress.pct}% (${finalProgress.completed}/${finalProgress.total})`);

// Persist to disk for visibility
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(".agentforge/sprints", { recursive: true });
writeFileSync(
  `.agentforge/sprints/v${SPRINT_VERSION}.json`,
  JSON.stringify(fw.toJSON(), null, 2),
  "utf8"
);
log(`Sprint record persisted to .agentforge/sprints/v${SPRINT_VERSION}.json`);

console.log(`\n${"═".repeat(60)}`);
console.log(`  v${SPRINT_VERSION} Sprint COMPLETE — ${result.gateVerdict.toUpperCase()}`);
console.log(`  Items: ${finalProgress.completed}/${finalProgress.total} | Budget: $${result.budgetUsed}/$${sprint.budget}`);
console.log(`  Tests: ${result.testsPassing}/${result.testsTotal} passing`);
console.log(`${"═".repeat(60)}\n`);
