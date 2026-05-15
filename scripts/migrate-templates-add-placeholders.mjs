#!/usr/bin/env node
/**
 * One-shot migration: inject {project_purpose}, {key_subsystems}, and
 * {baked_learnings} placeholder sections into every agent template under
 * templates/domains/{domain}/agents/*.yaml.
 *
 * Idempotent — re-running skips templates that already contain the new
 * placeholders. Run from repo root: `node scripts/migrate-templates-add-placeholders.mjs`
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const domainsRoot = join(repoRoot, 'templates', 'domains');

// The injected sections — splice them in after the project-name opening line
const PROJECT_CONTEXT_BLOCK = `
## What {project_name} Is
{project_purpose}

## Key Subsystems
{key_subsystems}
`;

const LEARNINGS_BLOCK = `
## Recent Learnings (auto-curated from prior cycles)
The lessons below are picked from this project's memory store (gate verdicts,
review findings, cycle outcomes) on each forge/reforge. Treat them as
current-state context — they capture what has actually gone wrong or right.

{baked_learnings}
`;

function listAgentTemplates() {
  const files = [];
  for (const domain of readdirSync(domainsRoot)) {
    const agentsDir = join(domainsRoot, domain, 'agents');
    let entries;
    try {
      entries = readdirSync(agentsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.yaml')) continue;
      const path = join(agentsDir, entry);
      if (!statSync(path).isFile()) continue;
      files.push(path);
    }
  }
  return files;
}

function processTemplate(path) {
  const raw = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return { path, status: 'parse-error', reason: String(err) };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { path, status: 'skipped', reason: 'not an object' };
  }
  if (typeof parsed.system_prompt !== 'string') {
    return { path, status: 'skipped', reason: 'no system_prompt' };
  }

  const prompt = parsed.system_prompt;

  // Idempotency guard
  if (prompt.includes('{baked_learnings}') || prompt.includes('{project_purpose}')) {
    return { path, status: 'already-migrated' };
  }

  // Insert AFTER the "You are X for the project ..." opening line, BEFORE the
  // first ## section.
  const lines = prompt.split('\n');
  let insertIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      insertIdx = i;
      break;
    }
  }
  // No ## section? Append at end.
  if (insertIdx === -1) insertIdx = lines.length;

  const before = lines.slice(0, insertIdx).join('\n').trimEnd();
  const after = lines.slice(insertIdx).join('\n').trimStart();

  // Two new sections: project context (early, before role) and learnings
  // (later, after role/responsibilities so the agent reads them in context).
  // We splice project context right before the first ## section. For learnings,
  // we append at the end so they appear after Constraints/Style — most templates
  // close with those.

  const withProjectContext = `${before}\n${PROJECT_CONTEXT_BLOCK.trim()}\n\n${after}`;
  const final = `${withProjectContext.trimEnd()}\n\n${LEARNINGS_BLOCK.trim()}\n`;

  parsed.system_prompt = final;

  // Preserve formatting as best js-yaml can. lineWidth=-1 disables wrapping
  // so we don't reflow long lines into garbled YAML.
  const out = yaml.dump(parsed, { lineWidth: -1, noRefs: true, quotingType: '"' });
  writeFileSync(path, out, 'utf8');
  return { path, status: 'migrated' };
}

const templates = listAgentTemplates();
const counts = { migrated: 0, 'already-migrated': 0, skipped: 0, 'parse-error': 0 };
const issues = [];

for (const path of templates) {
  const result = processTemplate(path);
  counts[result.status] = (counts[result.status] ?? 0) + 1;
  if (result.status === 'parse-error' || result.status === 'skipped') {
    issues.push(result);
  }
}

console.log(`\nProcessed ${templates.length} template(s)`);
console.log(`  migrated:         ${counts.migrated}`);
console.log(`  already-migrated: ${counts['already-migrated']}`);
console.log(`  skipped:          ${counts.skipped}`);
console.log(`  parse-error:      ${counts['parse-error']}`);
if (issues.length > 0) {
  console.log(`\nIssues:`);
  for (const i of issues) console.log(`  [${i.status}] ${i.path}${i.reason ? ` — ${i.reason}` : ''}`);
}
