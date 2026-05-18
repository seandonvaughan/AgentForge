// packages/core/src/skills/flywheel/propose-skill.ts
//
// Given a LowQualityCluster and the list of existing skills for its tag,
// emits a SkillProposal and writes the corresponding .md file under
// packages/skills-catalog/skills/agentforge/_proposed/<id>.md.
//
// Uses js-yaml.dump() for all YAML serialization (never template strings).

import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import type { LowQualityCluster } from './cluster-low-quality.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkillProposal {
  id: string;
  action: 'refine' | 'create';
  /** Existing skill id being refined, or null for new-skill proposals. */
  targetSkillId: string | null;
  /** Proposed new skill id (kebab-case). */
  skillId: string;
  capabilityTag: string;
  clusterId: string;
  requiresTools: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  status: 'proposed' | 'approved' | 'rejected';
  createdAt: string;
}

export interface ExistingSkillSummary {
  id: string;
  tags: string[];
  requiresTools?: string[];
}

export interface ProposeSkillOptions {
  cluster: LowQualityCluster;
  existingSkills: ExistingSkillSummary[];
  /** Absolute path to the project root containing packages/. */
  projectRoot: string;
  /** Override the _proposed output directory (for tests). */
  outputDir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDefaultOutputDir(projectRoot: string): string {
  // Resolve relative to this file's location so it works in both src/ and dist/
  const selfDir = dirname(fileURLToPath(import.meta.url));
  // selfDir: packages/core/src/skills/flywheel  OR  packages/core/dist/skills/flywheel
  // Navigate up to repo root, then into the skills-catalog package.
  const repoRoot = join(selfDir, '..', '..', '..', '..', '..', '..');
  const catalogPath = join(repoRoot, 'packages', 'skills-catalog', 'skills', 'agentforge', '_proposed');

  // Fallback: if the catalog doesn't exist relative to file, use projectRoot
  if (!existsSync(join(repoRoot, 'packages', 'skills-catalog'))) {
    return join(projectRoot, 'packages', 'skills-catalog', 'skills', 'agentforge', '_proposed');
  }
  return catalogPath;
}

function deriveRequiresTools(tag: string): string[] {
  const toolMap: Record<string, string[]> = {
    'file-read': ['Read'],
    'file-write': ['Write', 'Edit'],
    'bash': ['Bash'],
    'git': ['Bash'],
    'web-search': ['WebSearch'],
    'web-fetch': ['WebFetch'],
    'code-review': ['Bash', 'Read'],
    'test': ['Bash'],
    'deploy': ['Bash'],
  };

  const lower = tag.toLowerCase();
  for (const [key, tools] of Object.entries(toolMap)) {
    if (lower.includes(key)) return tools;
  }
  // Default: no specific tools required
  return [];
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a SkillProposal from a low-quality cluster and write the .md file
 * to the _proposed directory.
 *
 * If an existing skill already covers the cluster's capability_tag, the
 * proposal action is 'refine'; otherwise it is 'create'.
 */
export function proposeSkill(options: ProposeSkillOptions): SkillProposal {
  const { cluster, existingSkills, projectRoot } = options;

  const outputDir = options.outputDir ?? resolveDefaultOutputDir(projectRoot);

  // Determine action: refine if an existing skill matches the tag
  const matchingSkill = existingSkills.find(
    (s) =>
      s.tags.some((t) => t.toLowerCase() === cluster.capabilityTag.toLowerCase()) ||
      s.id.toLowerCase().includes(slugify(cluster.capabilityTag)),
  );

  const action: 'refine' | 'create' = matchingSkill ? 'refine' : 'create';
  const targetSkillId = matchingSkill?.id ?? null;

  const shortSlug = slugify(cluster.capabilityTag);
  const uniqueSuffix = randomUUID().slice(0, 8);
  const proposalId = `proposal-${shortSlug}-${uniqueSuffix}`;
  const skillId = action === 'refine' ? `${targetSkillId}-refined` : `af-${shortSlug}`;

  const requiresTools = deriveRequiresTools(cluster.capabilityTag);

  const frontmatter: Record<string, unknown> = {
    id: skillId,
    version: '0.1.0',
    tags: [cluster.capabilityTag],
    applies_to: ['*'],
    max_tokens: 1500,
    requires_tools: requiresTools,
    status: 'proposed',
    proposal_id: proposalId,
    cluster_id: cluster.id,
    mean_step_score: cluster.meanStepScore,
    occurrences: cluster.occurrences,
  };

  const exemplarSection =
    cluster.exemplarPrompt
      ? `\n## Exemplar Prompt\n\n> ${cluster.exemplarPrompt.replace(/\n/g, '\n> ')}\n`
      : '';

  const body = [
    `## Overview`,
    ``,
    `This skill was ${action === 'refine' ? `proposed to refine \`${targetSkillId}\`` : 'proposed as a new skill'} based on a low-quality cluster for capability tag \`${cluster.capabilityTag}\`.`,
    ``,
    `- **Cluster ID:** \`${cluster.id}\``,
    `- **Occurrences:** ${cluster.occurrences}`,
    `- **Mean Step Score:** ${cluster.meanStepScore}`,
    `- **Action:** ${action}`,
    ...(targetSkillId ? [`- **Target Skill:** \`${targetSkillId}\``] : []),
    ``,
    `## Guidance`,
    ``,
    `When handling tasks tagged \`${cluster.capabilityTag}\`:`,
    ``,
    `1. Review the exemplar prompt below to understand where agents struggled.`,
    `2. Ensure outputs satisfy the quality criteria for this capability.`,
    `3. Prefer concrete, verifiable steps over vague instructions.`,
    exemplarSection,
    `## Acceptance Criteria`,
    ``,
    `- Step score ≥ 0.70 on new evaluations in this capability cluster.`,
    `- No regression on existing \`${cluster.capabilityTag}\`-tagged evaluations.`,
  ].join('\n');

  const proposal: SkillProposal = {
    id: proposalId,
    action,
    targetSkillId,
    skillId,
    capabilityTag: cluster.capabilityTag,
    clusterId: cluster.id,
    requiresTools,
    frontmatter,
    body,
    status: 'proposed',
    createdAt: new Date().toISOString(),
  };

  // Write .md file with YAML frontmatter using js-yaml.dump() — never template strings
  mkdirSync(outputDir, { recursive: true });

  const frontmatterYaml = yaml.dump(frontmatter, { lineWidth: 120, quotingType: '"' });
  const fileContent = `---\n${frontmatterYaml}---\n\n${body}\n`;

  const outPath = join(outputDir, `${proposalId}.md`);
  writeFileSync(outPath, fileContent, 'utf-8');

  return proposal;
}

/**
 * Approve a proposal: move the .md file out of `_proposed/` into
 * `_approved/` (sibling dir), then validate TypeScript compiles cleanly.
 *
 * Returns the new file path on success.
 * Throws if the file doesn't exist, is already approved, or tsc fails.
 */
export async function approveProposal(
  proposalId: string,
  projectRoot: string,
  opts: { revert?: boolean; outputDir?: string } = {},
): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const outputDir = opts.outputDir ?? resolveDefaultOutputDir(projectRoot);
  const approvedDir = join(dirname(outputDir), '_approved');

  const proposedPath = join(outputDir, `${proposalId}.md`);
  const approvedPath = join(approvedDir, `${proposalId}.md`);

  if (opts.revert) {
    // Revert: move from _approved back to _proposed
    if (!existsSync(approvedPath)) {
      throw new Error(`Proposal ${proposalId} is not in _approved/ — cannot revert`);
    }
    mkdirSync(outputDir, { recursive: true });
    // Read and write to move (avoids fs.rename cross-device issues)
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(approvedPath, 'utf-8');
    writeFileSync(proposedPath, content, 'utf-8');
    unlinkSync(approvedPath);
    return proposedPath;
  }

  // Approve: move proposed → approved
  if (!existsSync(proposedPath)) {
    // Idempotent: already approved?
    if (existsSync(approvedPath)) {
      return approvedPath;
    }
    throw new Error(`Proposal file not found: ${proposedPath}`);
  }

  mkdirSync(approvedDir, { recursive: true });

  const { readFileSync } = await import('node:fs');
  const content = readFileSync(proposedPath, 'utf-8');
  writeFileSync(approvedPath, content, 'utf-8');
  unlinkSync(proposedPath);

  // Gate: run tsc --noEmit against the project root
  try {
    await execFileAsync('pnpm', ['exec', 'tsc', '--noEmit'], {
      cwd: projectRoot,
      timeout: 120_000,
    });
  } catch (err) {
    // Rollback on tsc failure
    writeFileSync(proposedPath, content, 'utf-8');
    unlinkSync(approvedPath);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`tsc --noEmit failed — proposal rolled back.\n${message}`);
  }

  return approvedPath;
}

/**
 * List all proposal .md filenames in the _proposed directory.
 */
export function listProposals(projectRoot: string, outputDir?: string): string[] {
  const dir = outputDir ?? resolveDefaultOutputDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}
