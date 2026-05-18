// tests/core/skills/flywheel/propose-skill.test.ts
//
// Uses a mock runtime — no real LLM calls. Tests the deterministic
// proposeSkill() and approveProposal() functions.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

import {
  proposeSkill,
  approveProposal,
  listProposals,
} from '../../../../packages/core/src/skills/flywheel/propose-skill.js';
import type { LowQualityCluster } from '../../../../packages/core/src/skills/flywheel/cluster-low-quality.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCluster(overrides: Partial<LowQualityCluster> = {}): LowQualityCluster {
  return {
    id: 'cluster-test',
    capabilityTag: 'test',
    memberIds: ['e1', 'e2', 'e3'],
    meanStepScore: 0.3,
    occurrences: 3,
    exemplarPrompt: 'Write a unit test for the login flow',
    ...overrides,
  };
}

let projectRoot: string;
let outputDir: string;

beforeEach(() => {
  projectRoot = join(tmpdir(), `af-test-propose-${randomUUID()}`);
  outputDir = join(projectRoot, '_proposed');
  mkdirSync(outputDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// proposeSkill tests
// ---------------------------------------------------------------------------

describe('proposeSkill', () => {
  it('returns a SkillProposal with required fields', () => {
    const cluster = makeCluster();
    const proposal = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });

    expect(proposal.id).toMatch(/^proposal-test-/);
    expect(proposal.action).toBe('create');
    expect(proposal.targetSkillId).toBeNull();
    expect(proposal.skillId).toBe('af-test');
    expect(proposal.capabilityTag).toBe('test');
    expect(proposal.clusterId).toBe('cluster-test'); // maps from cluster.id
    expect(proposal.status).toBe('proposed');
    expect(Array.isArray(proposal.requiresTools)).toBe(true);
    expect(proposal.frontmatter).toBeDefined();
    expect(typeof proposal.body).toBe('string');
    expect(proposal.body.length).toBeGreaterThan(0);
    expect(typeof proposal.createdAt).toBe('string');
  });

  it('emits action=refine when an existing skill covers the tag', () => {
    const cluster = makeCluster({ capabilityTag: 'bash' });
    const existingSkills = [
      { id: 'af-bash-safety', tags: ['bash'], requiresTools: ['Bash'] },
    ];
    const proposal = proposeSkill({ cluster, existingSkills, projectRoot, outputDir });

    expect(proposal.action).toBe('refine');
    expect(proposal.targetSkillId).toBe('af-bash-safety');
    expect(proposal.skillId).toBe('af-bash-safety-refined');
  });

  it('derives requires_tools from capability tag', () => {
    const cluster = makeCluster({ capabilityTag: 'bash' });
    const proposal = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });
    expect(proposal.requiresTools).toContain('Bash');
  });

  it('requires_tools is an array (even if empty for unknown tags)', () => {
    const cluster = makeCluster({ capabilityTag: 'unknown-tag-xyz' });
    const proposal = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });
    expect(Array.isArray(proposal.requiresTools)).toBe(true);
  });

  it('writes a .md file to outputDir', () => {
    const cluster = makeCluster();
    const proposal = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });

    const expectedPath = join(outputDir, `${proposal.id}.md`);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('written .md file has valid YAML frontmatter', () => {
    const cluster = makeCluster();
    const proposal = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });

    const filePath = join(outputDir, `${proposal.id}.md`);
    const content = readFileSync(filePath, 'utf-8');

    // Parse YAML frontmatter block between --- delimiters
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    expect(match).not.toBeNull();
    const parsed = yaml.load(match![1]) as Record<string, unknown>;

    expect(parsed['status']).toBe('proposed');
    expect(parsed['id']).toBe(proposal.skillId);
    expect(parsed['cluster_id']).toBe(cluster.id);
    expect(Array.isArray(parsed['requires_tools'])).toBe(true);
  });

  it('frontmatter does NOT use template strings (uses js-yaml.dump)', () => {
    // Ensure no raw YAML injection possible via exotic tag names
    const cluster = makeCluster({ capabilityTag: 'test-with-colon:value' });
    const proposal = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });
    const filePath = join(outputDir, `${proposal.id}.md`);
    const content = readFileSync(filePath, 'utf-8');
    // js-yaml.dump will quote strings with colons — should not produce broken YAML
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    expect(match).not.toBeNull();
    const parsed = yaml.load(match![1]) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(typeof parsed['id']).toBe('string');
  });

  it('includes exemplar prompt in the body when present', () => {
    const cluster = makeCluster({ exemplarPrompt: 'Test the login flow' });
    const proposal = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });
    expect(proposal.body).toContain('Test the login flow');
  });

  it('handles null exemplarPrompt gracefully', () => {
    const cluster = makeCluster({ exemplarPrompt: null });
    const proposal = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });
    expect(proposal.body).not.toContain('Exemplar Prompt');
  });

  it('generates unique proposal ids for same tag (idempotency check)', () => {
    const cluster = makeCluster();
    const p1 = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });
    const p2 = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });
    expect(p1.id).not.toBe(p2.id);
  });
});

// ---------------------------------------------------------------------------
// listProposals tests
// ---------------------------------------------------------------------------

describe('listProposals', () => {
  it('returns empty array when outputDir is absent', () => {
    const missing = join(projectRoot, '_missing');
    expect(listProposals(projectRoot, missing)).toEqual([]);
  });

  it('lists proposal ids after proposals are written', () => {
    const cluster = makeCluster();
    const p1 = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });
    const p2 = proposeSkill({ cluster, existingSkills: [], projectRoot, outputDir });

    const ids = listProposals(projectRoot, outputDir);
    expect(ids).toContain(p1.id);
    expect(ids).toContain(p2.id);
  });
});

// ---------------------------------------------------------------------------
// approveProposal tests
// ---------------------------------------------------------------------------

describe('approveProposal — file movement logic (no real tsc)', () => {
  it('throws when proposal file does not exist', async () => {
    await expect(
      approveProposal('nonexistent-id', projectRoot, { outputDir }),
    ).rejects.toThrow(/not found/);
  });

  it('revert throws when proposal is not in _approved', async () => {
    const proposalId = `proposal-test-${randomUUID().slice(0, 8)}`;
    await expect(
      approveProposal(proposalId, projectRoot, { outputDir, revert: true }),
    ).rejects.toThrow(/not in _approved/);
  });

  it('revert moves file from _approved back to _proposed', async () => {
    const approvedDir = join(projectRoot, '_approved');
    mkdirSync(approvedDir, { recursive: true });
    const proposalId = `proposal-test-${randomUUID().slice(0, 8)}`;
    const approvedPath = join(approvedDir, `${proposalId}.md`);
    const proposedPath = join(outputDir, `${proposalId}.md`);
    writeFileSync(approvedPath, '---\nid: test-revert\n---\nbody', 'utf-8');

    const result = await approveProposal(proposalId, projectRoot, {
      outputDir,
      revert: true,
    });
    expect(result).toBe(proposedPath);
    expect(existsSync(proposedPath)).toBe(true);
    expect(existsSync(approvedPath)).toBe(false);
  });

  it('revert is not re-applicable — second revert throws', async () => {
    const approvedDir = join(projectRoot, '_approved');
    mkdirSync(approvedDir, { recursive: true });
    const proposalId = `proposal-test-${randomUUID().slice(0, 8)}`;
    const approvedPath = join(approvedDir, `${proposalId}.md`);
    writeFileSync(approvedPath, '---\nid: test-revert2\n---\nbody', 'utf-8');

    await approveProposal(proposalId, projectRoot, { outputDir, revert: true });

    // Second revert: file is back in _proposed, not in _approved
    await expect(
      approveProposal(proposalId, projectRoot, { outputDir, revert: true }),
    ).rejects.toThrow(/not in _approved/);
  });

  it('approve is idempotent — returns approved path when already approved', async () => {
    const approvedDir = join(projectRoot, '_approved');
    mkdirSync(approvedDir, { recursive: true });
    const proposalId = `proposal-test-${randomUUID().slice(0, 8)}`;
    // Seed the approved dir (simulate already-approved state, no proposed file)
    const approvedPath = join(approvedDir, `${proposalId}.md`);
    writeFileSync(approvedPath, '---\nid: test-idempotent\n---\nbody', 'utf-8');

    // No file in _proposed → should return approved path (idempotent)
    const result = await approveProposal(proposalId, projectRoot, { outputDir });
    expect(result).toBe(approvedPath);
  });
});
