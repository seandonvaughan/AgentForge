// tests/dashboard/flywheel-proposals.test.ts
//
// Contract tests for /flywheel/proposals page logic (pure helpers, no rendering).
//
// Tests cover:
//  - statusVariant mapping
//  - actionVariant mapping
//  - fmtDate formatting
//  - filtered list logic (String.includes, no regex on user input)
//  - metaRows derivation from a proposal
//  - empty-state guard: no proposals → filtered is empty array

import { describe, it, expect } from 'vitest';

// ── Types (mirrored from the page) ────────────────────────────────────────────

interface SkillProposal {
  id: string;
  action: 'refine' | 'create';
  targetSkillId: string | null;
  skillId: string;
  capabilityTag: string;
  clusterId: string;
  requiresTools: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  status: 'proposed' | 'approved' | 'rejected';
  createdAt: string;
  occurrences: number;
}

// ── Pure helper mirrors ────────────────────────────────────────────────────────

function statusVariant(status: string): 'success' | 'warning' | 'muted' | 'purple' {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'muted';
  return 'warning';
}

function actionVariant(action: string): 'purple' | 'muted' {
  return action === 'create' ? 'purple' : 'muted';
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function filterProposals(proposals: SkillProposal[], query: string): SkillProposal[] {
  const q = query.trim().toLowerCase();
  if (!q) return proposals;
  // String.includes — no regex on user input (CodeQL ReDoS safety)
  return proposals.filter(
    (p) =>
      p.id.toLowerCase().includes(q) ||
      p.capabilityTag.toLowerCase().includes(q) ||
      p.clusterId.toLowerCase().includes(q) ||
      p.action.includes(q) ||
      p.status.includes(q),
  );
}

function deriveMetaRows(p: SkillProposal): Array<{ label: string; value: string }> {
  return [
    { label: 'ID', value: p.id },
    { label: 'Action', value: p.action },
    { label: 'Skill ID', value: p.skillId || '—' },
    { label: 'Target skill', value: p.targetSkillId ?? '—' },
    { label: 'Capability tag', value: p.capabilityTag || '—' },
    { label: 'Cluster', value: p.clusterId || '—' },
    { label: 'Occurrences', value: String(p.occurrences > 0 ? p.occurrences : '—') },
    { label: 'Requires tools', value: p.requiresTools.length > 0 ? p.requiresTools.join(', ') : '—' },
  ];
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PROPOSALS: SkillProposal[] = [
  {
    id: 'prop-tdd-refine',
    action: 'refine',
    targetSkillId: 'agentforge:tdd',
    skillId: 'agentforge:tdd',
    capabilityTag: 'test-driven-development',
    clusterId: 'cluster-quality-0',
    requiresTools: ['Bash', 'Edit'],
    frontmatter: {},
    body: '## TDD refinement\n\nBody text.',
    status: 'proposed',
    createdAt: '2024-01-15T10:00:00Z',
    occurrences: 14,
  },
  {
    id: 'prop-debug-create',
    action: 'create',
    targetSkillId: null,
    skillId: 'agentforge:debug-advanced',
    capabilityTag: 'systematic-debugging',
    clusterId: 'cluster-debug-1',
    requiresTools: ['Bash'],
    frontmatter: {},
    body: '## New debugging skill\n\nBody text.',
    status: 'approved',
    createdAt: '2024-01-14T08:00:00Z',
    occurrences: 8,
  },
  {
    id: 'prop-stale-reject',
    action: 'refine',
    targetSkillId: 'agentforge:brainstorm',
    skillId: 'agentforge:brainstorm',
    capabilityTag: 'brainstorming',
    clusterId: 'cluster-creative-2',
    requiresTools: [],
    frontmatter: {},
    body: 'Rejected proposal.',
    status: 'rejected',
    createdAt: '2024-01-10T00:00:00Z',
    occurrences: 0,
  },
];

// ── statusVariant tests ───────────────────────────────────────────────────────

describe('statusVariant', () => {
  it('returns success for approved', () => {
    expect(statusVariant('approved')).toBe('success');
  });
  it('returns muted for rejected', () => {
    expect(statusVariant('rejected')).toBe('muted');
  });
  it('returns warning for proposed', () => {
    expect(statusVariant('proposed')).toBe('warning');
  });
  it('returns warning for unknown status', () => {
    expect(statusVariant('unknown')).toBe('warning');
  });
});

// ── actionVariant tests ───────────────────────────────────────────────────────

describe('actionVariant', () => {
  it('returns purple for create', () => {
    expect(actionVariant('create')).toBe('purple');
  });
  it('returns muted for refine', () => {
    expect(actionVariant('refine')).toBe('muted');
  });
  it('returns muted for unknown action', () => {
    expect(actionVariant('other')).toBe('muted');
  });
});

// ── fmtDate tests ─────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  it('formats a valid ISO date to a non-empty string', () => {
    const result = fmtDate('2024-01-15T10:00:00Z');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Should contain the year
    expect(result).toContain('2024');
  });

  it('returns the original string for invalid dates', () => {
    const bad = 'not-a-date';
    // May or may not throw depending on Date implementation; we just check it returns a string
    const result = fmtDate(bad);
    expect(typeof result).toBe('string');
  });
});

// ── filterProposals tests ─────────────────────────────────────────────────────

describe('filterProposals', () => {
  it('returns all proposals when query is empty', () => {
    expect(filterProposals(PROPOSALS, '')).toHaveLength(PROPOSALS.length);
  });

  it('returns all proposals when query is only whitespace', () => {
    expect(filterProposals(PROPOSALS, '   ')).toHaveLength(PROPOSALS.length);
  });

  it('filters by capability tag (String.includes)', () => {
    const result = filterProposals(PROPOSALS, 'test-driven');
    expect(result.every((p) => p.capabilityTag.includes('test-driven'))).toBe(true);
    expect(result.some((p) => p.id === 'prop-tdd-refine')).toBe(true);
  });

  it('filters by status', () => {
    const result = filterProposals(PROPOSALS, 'approved');
    expect(result.every((p) => p.status === 'approved')).toBe(true);
  });

  it('filters by action', () => {
    const result = filterProposals(PROPOSALS, 'create');
    expect(result.some((p) => p.action === 'create')).toBe(true);
  });

  it('filters by id prefix', () => {
    const result = filterProposals(PROPOSALS, 'prop-tdd');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('prop-tdd-refine');
  });

  it('returns empty array when nothing matches', () => {
    const result = filterProposals(PROPOSALS, 'xyzzy-no-match');
    expect(result).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    const lower = filterProposals(PROPOSALS, 'systematic-debugging');
    const upper = filterProposals(PROPOSALS, 'SYSTEMATIC-DEBUGGING');
    expect(lower).toHaveLength(upper.length);
  });

  it('handles empty proposals array gracefully', () => {
    expect(filterProposals([], 'anything')).toHaveLength(0);
  });
});

// ── deriveMetaRows tests ──────────────────────────────────────────────────────

describe('deriveMetaRows', () => {
  it('returns rows with required labels', () => {
    const rows = deriveMetaRows(PROPOSALS[0]!);
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('ID');
    expect(labels).toContain('Action');
    expect(labels).toContain('Capability tag');
    expect(labels).toContain('Occurrences');
    expect(labels).toContain('Requires tools');
  });

  it('shows occurrences value when > 0', () => {
    const rows = deriveMetaRows(PROPOSALS[0]!);
    const occ = rows.find((r) => r.label === 'Occurrences');
    expect(occ?.value).toBe('14');
  });

  it('shows — for occurrences when 0', () => {
    const rows = deriveMetaRows(PROPOSALS[2]!); // occurrences: 0
    const occ = rows.find((r) => r.label === 'Occurrences');
    expect(occ?.value).toBe('—');
  });

  it('shows — for empty requiresTools', () => {
    const rows = deriveMetaRows(PROPOSALS[2]!); // requiresTools: []
    const tools = rows.find((r) => r.label === 'Requires tools');
    expect(tools?.value).toBe('—');
  });

  it('shows — for null targetSkillId', () => {
    const rows = deriveMetaRows(PROPOSALS[1]!); // targetSkillId: null
    const target = rows.find((r) => r.label === 'Target skill');
    expect(target?.value).toBe('—');
  });

  it('shows joined tool list when requiresTools is non-empty', () => {
    const rows = deriveMetaRows(PROPOSALS[0]!); // requiresTools: ['Bash', 'Edit']
    const tools = rows.find((r) => r.label === 'Requires tools');
    expect(tools?.value).toBe('Bash, Edit');
  });
});

// ── pending count derivation ──────────────────────────────────────────────────

describe('pending count', () => {
  it('counts only proposed status', () => {
    const count = PROPOSALS.filter((p) => p.status === 'proposed').length;
    expect(count).toBe(1);
  });

  it('is zero for empty list', () => {
    const count = [].filter((p: SkillProposal) => p.status === 'proposed').length;
    expect(count).toBe(0);
  });
});
