// packages/cli/src/commands/skills.ts
//
// CLI surface for the skill flywheel curator.
//
// Commands:
//   agentforge skills propose-from-learnings   — cluster + propose
//   agentforge skills approve-proposal <id>   — move out of _proposed, tsc gate
//   agentforge skills approve-proposal <id> --revert  — undo approval

import type { Command } from 'commander';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { clusterLowQuality } from '@agentforge/core';
import { proposeSkill, approveProposal, listProposals } from '@agentforge/core';
import { listSkills } from '@agentforge/skills-catalog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveProjectRoot(
  fallback: string | undefined,
  command?: Command,
): string {
  const envRoot = process.env['AGENTFORGE_PROJECT_ROOT'];
  if (typeof envRoot === 'string' && envRoot.length > 0) return envRoot;

  const localOptions = command?.optsWithGlobals?.() as { projectRoot?: unknown } | undefined;
  if (typeof localOptions?.projectRoot === 'string' && localOptions.projectRoot.length > 0) {
    return localOptions.projectRoot;
  }

  const parentOptions = command?.parent?.opts?.() as { projectRoot?: unknown } | undefined;
  if (typeof parentOptions?.projectRoot === 'string' && parentOptions.projectRoot.length > 0) {
    return parentOptions.projectRoot;
  }

  if (typeof fallback === 'string' && fallback.length > 0) return fallback;
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Action: propose-from-learnings
// ---------------------------------------------------------------------------

async function proposeFromLearningsAction(
  options: { projectRoot: string; dryRun?: boolean },
  command: Command,
): Promise<void> {
  const projectRoot = resolveProjectRoot(options.projectRoot, command);

  console.log(`[skills] Clustering low-quality capability tags in ${projectRoot} …`);

  const clusters = clusterLowQuality({ projectRoot });

  if (clusters.length === 0) {
    console.log(
      '[skills] No qualifying clusters found (need ≥3 occurrences AND mean step-score < 0.55).',
    );
    return;
  }

  console.log(`[skills] Found ${clusters.length} qualifying cluster(s).`);

  // Load existing skills to drive refine vs. create decisions
  let existingSkillsSummary: Array<{ id: string; tags: string[]; requiresTools?: string[] }> = [];
  try {
    existingSkillsSummary = listSkills().map((s) => ({
      id: s.frontmatter.id,
      tags: s.frontmatter.tags,
      requiresTools: s.frontmatter.requires_tools,
    }));
  } catch {
    // If catalog load fails, continue with empty list (create-only proposals)
    console.warn('[skills] Could not load skills catalog — all proposals will use action=create.');
  }

  const proposals = [];

  for (const cluster of clusters) {
    if (options.dryRun) {
      console.log(
        `[skills][dry-run] Would propose for cluster ${cluster.id} (tag=${cluster.capabilityTag}, score=${cluster.meanStepScore}, n=${cluster.occurrences})`,
      );
      continue;
    }

    try {
      const proposal = proposeSkill({
        cluster,
        existingSkills: existingSkillsSummary,
        projectRoot,
      });
      proposals.push(proposal);
      console.log(
        `[skills] Proposal written: ${proposal.id} (action=${proposal.action}, skill=${proposal.skillId})`,
      );
    } catch (err) {
      console.error(
        `[skills] Failed to propose for cluster ${cluster.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!options.dryRun) {
    console.log(`[skills] Done. ${proposals.length} proposal(s) written.`);
    console.log(
      `[skills] Review proposals in packages/skills-catalog/skills/agentforge/_proposed/`,
    );
    console.log('[skills] Approve with: agentforge skills approve-proposal <id>');
  }
}

// ---------------------------------------------------------------------------
// Action: approve-proposal
// ---------------------------------------------------------------------------

async function approveProposalAction(
  proposalId: string,
  options: { projectRoot: string; revert?: boolean },
  command: Command,
): Promise<void> {
  const projectRoot = resolveProjectRoot(options.projectRoot, command);

  const verb = options.revert ? 'Reverting' : 'Approving';
  console.log(`[skills] ${verb} proposal: ${proposalId} …`);

  try {
    const resultPath = await approveProposal(proposalId, projectRoot, {
      revert: options.revert,
    });

    if (options.revert) {
      console.log(`[skills] Reverted — proposal back at: ${resultPath}`);
    } else {
      console.log(`[skills] Approved — skill moved to: ${resultPath}`);
      console.log('[skills] tsc --noEmit gate passed.');

      // Audit log entry (best-effort)
      try {
        const { appendFileSync, mkdirSync } = await import('node:fs');
        const auditDir = join(projectRoot, '.agentforge', 'memory');
        mkdirSync(auditDir, { recursive: true });
        const entry = JSON.stringify({
          type: 'skill-proposal-approved',
          proposalId,
          resultPath,
          approvedAt: new Date().toISOString(),
        });
        appendFileSync(join(auditDir, 'skill-proposals.jsonl'), entry + '\n', 'utf-8');
      } catch {
        // Audit log failure is non-fatal
      }
    }
  } catch (err) {
    console.error(
      `[skills] ${options.revert ? 'Revert' : 'Approve'} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Action: list (bonus — list current proposals)
// ---------------------------------------------------------------------------

async function listProposalsAction(
  options: { projectRoot: string },
  command: Command,
): Promise<void> {
  const projectRoot = resolveProjectRoot(options.projectRoot, command);
  const ids = listProposals(projectRoot);

  if (ids.length === 0) {
    console.log('[skills] No pending proposals.');
    return;
  }

  console.log(`[skills] ${ids.length} pending proposal(s):`);
  for (const id of ids) {
    console.log(`  - ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command('skills')
    .description('Skill flywheel curator — cluster low-quality capability tags and propose improvements')
    .option('--project-root <path>', 'Project root', process.cwd());

  skills
    .command('propose-from-learnings')
    .description('Cluster low-quality capability tags from memory JSONL and emit skill proposals')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--dry-run', 'Show which proposals would be created without writing files')
    .action(async (opts, cmd) => {
      try {
        await proposeFromLearningsAction(opts as { projectRoot: string; dryRun?: boolean }, cmd);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  skills
    .command('approve-proposal <id>')
    .description('Move a proposal from _proposed/ to _approved/ and run tsc --noEmit gate')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--revert', 'Undo a previous approval — move back to _proposed/')
    .action(async (id: string, opts, cmd) => {
      try {
        await approveProposalAction(id, opts as { projectRoot: string; revert?: boolean }, cmd);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  skills
    .command('list')
    .description('List all pending skill proposals')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (opts, cmd) => {
      try {
        await listProposalsAction(opts as { projectRoot: string }, cmd);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
