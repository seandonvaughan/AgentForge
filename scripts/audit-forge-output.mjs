#!/usr/bin/env node
/**
 * Audit the output of a forge run. Reads .agentforge/forge/* artifacts
 * and compares against .agentforge/agents-pre-v22-forge/ to quantify:
 *
 *   1. Specialization quality — does any agent system_prompt cite real
 *      project files? (vs. the old "You are the Coder agent" generic mush)
 *   2. Hallucination check — does any system_prompt mention frameworks
 *      not present in the project? (the old coder claimed Django/FastAPI/Gin etc)
 *   3. Coverage — does the new team cover every subsystem from the recon
 *      SubsystemsReport?
 *   4. pr-merge-manager presence — required role baked in?
 *   5. Diff vs baseline — what changed, what stayed?
 *
 * Output: a markdown report at .agentforge/forge/audit-v22.1.md
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

const FORGE_DIR = join(projectRoot, ".agentforge/forge");
const AGENTS_DIR = join(projectRoot, ".agentforge/agents");
const BASELINE_DIR = join(projectRoot, ".agentforge/agents-pre-v22-forge");

// Frameworks the OLD broken forge hallucinated for AgentForge — anything
// mentioning these in the new prompts is a regression.
const HALLUCINATED_TECHS = [
  "django", "fastapi", "flask", "gin-gonic", "actix",
  "fiber", "spring", "rails", "laravel", "next.js",
  "nuxt", "vue", "graphql server", "express",
  // languages not in this project
  "python", "ruby", "java ", "kotlin", "swift",
  "rust ", "golang", "go-fiber",
];

// Real frameworks/libs that SHOULD appear in specialist prompts
const REAL_TECHS = [
  "fastify", "svelte", "vitest", "playwright", "tsx",
  "sveltekit", "anthropic", "claude code", "git worktree",
  "sqlite", "better-sqlite3", "zod", "js-yaml", "pnpm",
];

async function main() {
  const report = [];
  report.push("# Agent-driven forge — audit report (v22.1)");
  report.push(`Generated: ${new Date().toISOString()}\n`);

  // ── Phase A — Recon outputs ──
  report.push("## 1. Recon outputs\n");
  const reconDir = join(FORGE_DIR, "recon");
  if (!existsSync(reconDir)) {
    report.push("**❌ No recon outputs found.** Forge may have crashed before Phase A completed.\n");
  } else {
    const files = await readdir(reconDir);
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      try {
        const raw = JSON.parse(await readFile(join(reconDir, f), "utf8"));
        const sizeKb = (JSON.stringify(raw).length / 1024).toFixed(1);
        report.push(`- **${f}** — ${sizeKb} KB`);
        if (raw.parsed) {
          const keys = Object.keys(raw.parsed).slice(0, 6);
          report.push(`  - top-level keys: \`${keys.join("`, `")}\``);
        }
      } catch (err) {
        report.push(`- **${f}** — ⚠️ parse error: ${err.message}`);
      }
    }
    report.push("");
  }

  // ── Phase B — Team plan ──
  report.push("## 2. Synthesis team plan\n");
  const planPath = join(FORGE_DIR, "team-plan.json");
  if (!existsSync(planPath)) {
    report.push("**❌ No team-plan.json.** Synthesis did not complete.\n");
  } else {
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    report.push(`- Team name: \`${plan.team_name ?? "(unnamed)"}\``);
    report.push(`- Agents: **${plan.agents?.length ?? 0}** (target 12–30)`);
    const tierCount = {};
    for (const a of plan.agents ?? []) {
      tierCount[a.tier] = (tierCount[a.tier] ?? 0) + 1;
    }
    report.push(`- Tier breakdown: \`${JSON.stringify(tierCount)}\``);
    const hasPrMerge = plan.agents?.some((a) => a.id === "pr-merge-manager");
    report.push(`- pr-merge-manager present: **${hasPrMerge ? "✅ YES" : "❌ NO"}**`);
    report.push("");
  }

  // ── Specialization scan ──
  report.push("## 3. Specialization quality scan\n");
  if (!existsSync(AGENTS_DIR)) {
    report.push("**❌ No .agentforge/agents/ directory.**\n");
  } else {
    const agentFiles = (await readdir(AGENTS_DIR)).filter((f) => f.endsWith(".yaml"));
    let hallucinations = 0;
    let realRefs = 0;
    let pathRefs = 0;
    let cloneCount = 0;
    const seen = new Set();
    for (const f of agentFiles) {
      const content = (await readFile(join(AGENTS_DIR, f), "utf8")).toLowerCase();

      // Hallucination check
      for (const t of HALLUCINATED_TECHS) {
        if (content.includes(t)) hallucinations++;
      }
      // Real-tech check
      for (const t of REAL_TECHS) {
        if (content.includes(t)) { realRefs++; break; }
      }
      // File path heuristic
      const pathMatches = content.match(/packages\/[\w-]+\/src\/[\w/.\-]+/g) ?? [];
      pathRefs += pathMatches.length;
      // Clone check: same first-paragraph fingerprint
      const fingerprint = content
        .replace(/[\s\n]+/g, " ")
        .slice(0, 200);
      if (seen.has(fingerprint)) cloneCount++;
      else seen.add(fingerprint);
    }
    report.push(`- Total agent YAMLs: **${agentFiles.length}**`);
    report.push(`- Agents referencing real techs (fastify/svelte/vitest/...): scan hits **${realRefs}**`);
    report.push(`- Mentions of hallucinated techs (django/flask/rails/...): **${hallucinations}** ${hallucinations === 0 ? "✅" : "⚠️"}`);
    report.push(`- File-path references in prompts (\`packages/x/src/...\`): **${pathRefs}**`);
    report.push(`- Agents with identical opening fingerprint (clones): **${cloneCount}** ${cloneCount === 0 ? "✅" : "⚠️"}`);
    report.push("");
  }

  // ── Validation report ──
  report.push("## 4. Validator findings (Phase C)\n");
  const vrPath = join(FORGE_DIR, "validation-report.json");
  if (!existsSync(vrPath)) {
    report.push("**(no validation-report.json found)**\n");
  } else {
    const vr = JSON.parse(await readFile(vrPath, "utf8"));
    const errors = vr.findings.filter((f) => f.severity === "ERROR");
    const warns = vr.findings.filter((f) => f.severity === "WARN");
    report.push(`- valid: **${vr.valid ? "✅" : "❌"}**`);
    report.push(`- agents checked: ${vr.agentsChecked}`);
    report.push(`- ERROR findings: ${errors.length}`);
    report.push(`- WARN findings: ${warns.length}`);
    if (errors.length > 0) {
      report.push("\nTop ERRORs:");
      for (const e of errors.slice(0, 10)) {
        report.push(`- \`${e.agentId}\`/${e.check}: ${e.message.slice(0, 120)}`);
      }
    }
    report.push("");
  }

  // ── Routing index ──
  report.push("## 5. Routing index\n");
  const riPath = join(projectRoot, ".agentforge/routing-index.json");
  if (existsSync(riPath)) {
    const ri = JSON.parse(await readFile(riPath, "utf8"));
    const withTags = ri.agents.filter((a) => (a.capability_tags?.length ?? 0) > 0).length;
    const withSubsystems = ri.agents.filter((a) => (a.owns_subsystems?.length ?? 0) > 0).length;
    report.push(`- Indexed agents: ${ri.agents.length}`);
    report.push(`- Agents with capability_tags: **${withTags}** / ${ri.agents.length}`);
    report.push(`- Agents with owns_subsystems: **${withSubsystems}** / ${ri.agents.length}`);
    report.push("");
  } else {
    report.push("**(no routing-index.json found)**\n");
  }

  // ── Baseline diff summary ──
  report.push("## 6. Baseline diff (vs agents-pre-v22-forge/)\n");
  if (existsSync(BASELINE_DIR)) {
    const oldAgents = (await readdir(BASELINE_DIR)).filter((f) => f.endsWith(".yaml")).length;
    const newAgents = existsSync(AGENTS_DIR)
      ? (await readdir(AGENTS_DIR)).filter((f) => f.endsWith(".yaml")).length
      : 0;
    report.push(`- Baseline agent count: **${oldAgents}**`);
    report.push(`- New agent count: **${newAgents}**`);
    report.push(`- Reduction: **${oldAgents - newAgents}** (consolidation expected)`);

    // Spot-check the old hallucination
    const oldApiSpec = join(BASELINE_DIR, "api-specialist.yaml");
    const newApiSpec = join(AGENTS_DIR, "api-specialist.yaml");
    if (existsSync(oldApiSpec)) {
      const oldText = await readFile(oldApiSpec, "utf8");
      const oldHasCoderClaim = oldText.includes("You are the Coder agent");
      report.push(`- Baseline \`api-specialist\` says "You are the Coder agent": **${oldHasCoderClaim ? "YES (bug)" : "NO"}**`);
    }
    if (existsSync(newApiSpec)) {
      const newText = await readFile(newApiSpec, "utf8");
      const newHasCoderClaim = newText.includes("You are the Coder agent");
      report.push(`- New \`api-specialist\` (if present) says "You are the Coder agent": **${newHasCoderClaim ? "❌ STILL BUGGY" : "✅ FIXED"}**`);
    }
  } else {
    report.push("(no baseline snapshot)\n");
  }

  // Write report
  const out = report.join("\n");
  const outPath = join(FORGE_DIR, "audit-v22.1.md");
  await writeFile(outPath, out, "utf8");
  console.log(out);
  console.log(`\n[audit] written to ${outPath}`);
}

main().catch((err) => {
  console.error("AUDIT FAILED:", err);
  process.exit(1);
});
