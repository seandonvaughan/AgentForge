/**
 * tests/lifecycle/agent-lifecycle-manager.test.ts
 *
 * Tests for the AgentLifecycleManager facade.
 * All tests use in-memory mode (no DB) so they are fast and isolated.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentLifecycleManager } from '../../src/lifecycle/agent-lifecycle-manager.js';
import type { AgentIdentity, TeamUnit } from '../../src/types/lifecycle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: 'agent-001',
    name: 'Test Agent',
    role: 'specialist',
    seniority: 'mid',
    layer: 'backend',
    teamId: 'backend-team',
    model: 'sonnet',
    status: 'idle',
    hiredAt: new Date().toISOString(),
    currentTasks: [],
    maxConcurrentTasks: 3,
    ...overrides,
  };
}

function makeTeam(overrides: Partial<TeamUnit> = {}): TeamUnit {
  return {
    id: 'backend-team',
    layer: 'backend',
    manager: 'manager-001',
    techLead: 'lead-001',
    specialists: [],
    maxCapacity: 10,
    currentLoad: 0,
    domain: ['api', 'services'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let manager: AgentLifecycleManager;

beforeEach(() => {
  manager = AgentLifecycleManager.create(); // in-memory, no DB
});

// ---------------------------------------------------------------------------
// Tests: registerAgent + getAgent roundtrip
// ---------------------------------------------------------------------------

describe('registerAgent + getAgent', () => {
  it('registered agent is retrievable by ID', () => {
    const agent = makeAgent({ id: 'test-001' });
    manager.registerAgent(agent);

    const result = manager.getAgent('test-001');
    expect(result).toBeDefined();
    expect(result!.id).toBe('test-001');
  });

  it('returns the correct name', () => {
    manager.registerAgent(makeAgent({ id: 'named-001', name: 'Named Agent' }));
    expect(manager.getAgent('named-001')!.name).toBe('Named Agent');
  });

  it('returns undefined for a non-existent agent', () => {
    expect(manager.getAgent('does-not-exist')).toBeUndefined();
  });

  it('throws when registering a duplicate ID', () => {
    manager.registerAgent(makeAgent({ id: 'dup-001' }));
    expect(() => manager.registerAgent(makeAgent({ id: 'dup-001' }))).toThrow();
  });

  it('multiple distinct agents can be registered', () => {
    manager.registerAgent(makeAgent({ id: 'a1' }));
    manager.registerAgent(makeAgent({ id: 'a2' }));
    manager.registerAgent(makeAgent({ id: 'a3' }));

    expect(manager.listAgents()).toHaveLength(3);
  });

  it('registered agent starts with correct teamId', () => {
    manager.registerAgent(makeAgent({ id: 'team-check', teamId: 'frontend-team' }));
    expect(manager.getAgent('team-check')!.teamId).toBe('frontend-team');
  });

  it('registered agent has correct seniority', () => {
    manager.registerAgent(makeAgent({ id: 'seniority-check', seniority: 'lead' }));
    expect(manager.getAgent('seniority-check')!.seniority).toBe('lead');
  });
});

// ---------------------------------------------------------------------------
// Tests: terminateAgent
// ---------------------------------------------------------------------------

describe('terminateAgent', () => {
  it('sets agent status to "terminated"', () => {
    manager.registerAgent(makeAgent({ id: 'term-001', status: 'active' }));
    manager.terminateAgent('term-001');

    expect(manager.getAgent('term-001')!.status).toBe('terminated');
  });

  it('accepts an optional reason without throwing', () => {
    manager.registerAgent(makeAgent({ id: 'term-reason' }));
    expect(() => manager.terminateAgent('term-reason', 'budget cuts')).not.toThrow();
  });

  it('preserves other fields after termination', () => {
    manager.registerAgent(makeAgent({ id: 'term-preserve', name: 'Keep Name', teamId: 'qa-team' }));
    manager.terminateAgent('term-preserve');

    const result = manager.getAgent('term-preserve')!;
    expect(result.name).toBe('Keep Name');
    expect(result.teamId).toBe('qa-team');
    expect(result.status).toBe('terminated');
  });

  it('throws when terminating a non-existent agent', () => {
    expect(() => manager.terminateAgent('ghost')).toThrow();
  });

  it('terminated agent is still retrievable (not deleted)', () => {
    manager.registerAgent(makeAgent({ id: 'still-there' }));
    manager.terminateAgent('still-there');

    expect(manager.getAgent('still-there')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: createTeam + getTeam roundtrip
// ---------------------------------------------------------------------------

describe('createTeam + getTeam', () => {
  it('created team is retrievable by ID', () => {
    const team = makeTeam({ id: 'test-team' });
    manager.createTeam(team);

    const result = manager.getTeam('test-team');
    expect(result).toBeDefined();
    expect(result!.id).toBe('test-team');
  });

  it('returns the correct layer', () => {
    manager.createTeam(makeTeam({ id: 'fe-team', layer: 'frontend' }));
    expect(manager.getTeam('fe-team')!.layer).toBe('frontend');
  });

  it('returns undefined for non-existent team', () => {
    expect(manager.getTeam('ghost-team')).toBeUndefined();
  });

  it('throws when creating a duplicate team', () => {
    manager.createTeam(makeTeam({ id: 'dup-team' }));
    expect(() => manager.createTeam(makeTeam({ id: 'dup-team' }))).toThrow();
  });

  it('multiple distinct teams can be created', () => {
    manager.createTeam(makeTeam({ id: 'team-a' }));
    manager.createTeam(makeTeam({ id: 'team-b' }));
    manager.createTeam(makeTeam({ id: 'team-c' }));

    expect(manager.listTeams()).toHaveLength(3);
  });

  it('created team has correct manager and techLead', () => {
    manager.createTeam(makeTeam({ id: 'mgr-team', manager: 'the-manager', techLead: 'the-lead' }));
    const t = manager.getTeam('mgr-team')!;
    expect(t.manager).toBe('the-manager');
    expect(t.techLead).toBe('the-lead');
  });
});

// ---------------------------------------------------------------------------
// Tests: reassignAgent
// ---------------------------------------------------------------------------

describe('reassignAgent', () => {
  beforeEach(() => {
    manager.createTeam(makeTeam({ id: 'from-team', maxCapacity: 10 }));
    manager.createTeam(makeTeam({ id: 'to-team', maxCapacity: 10 }));
  });

  it('agent teamId is updated after reassignment', () => {
    manager.registerAgent(makeAgent({ id: 'mover', teamId: 'from-team' }));
    manager.reassignAgent('mover', 'to-team');

    expect(manager.getAgent('mover')!.teamId).toBe('to-team');
  });

  it('agent appears in new team after reassignment', () => {
    manager.registerAgent(makeAgent({ id: 'mover-2', teamId: 'from-team' }));
    manager.reassignAgent('mover-2', 'to-team');

    const members = manager.getAgentsByTeam('to-team');
    expect(members.map((a) => a.id)).toContain('mover-2');
  });

  it('throws when agent does not exist', () => {
    expect(() => manager.reassignAgent('ghost', 'to-team')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: requestHire + approveHire flow (in-memory — DB methods are no-ops)
// ---------------------------------------------------------------------------

describe('requestHire + approveHire (in-memory)', () => {
  it('requestHire returns a string ID', () => {
    const id = manager.requestHire({
      teamId: 'backend-team',
      requestedRole: 'specialist',
      requestedSeniority: 'senior',
      requestedSkills: ['typescript'],
      justification: 'Team is overloaded',
      requestedBy: 'cto',
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('requestHire returns unique IDs for each call', () => {
    const id1 = manager.requestHire({
      teamId: 'backend-team',
      requestedRole: 'specialist',
      requestedSeniority: 'mid',
      requestedSkills: [],
      justification: 'Need more people',
      requestedBy: 'cto',
    });
    const id2 = manager.requestHire({
      teamId: 'backend-team',
      requestedRole: 'specialist',
      requestedSeniority: 'mid',
      requestedSkills: [],
      justification: 'Need more people',
      requestedBy: 'cto',
    });

    expect(id1).not.toBe(id2);
  });

  it('approveHire does not throw in-memory mode (no DB)', () => {
    // In-memory mode: _updateHireStatus is a no-op because db is null
    expect(() => manager.approveHire('any-id', 'ceo')).not.toThrow();
  });

  it('denyHire does not throw in-memory mode (no DB)', () => {
    expect(() => manager.denyHire('any-id', 'ceo', 'not enough budget')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: getAgentsByTeam
// ---------------------------------------------------------------------------

describe('getAgentsByTeam', () => {
  beforeEach(() => {
    manager.createTeam(makeTeam({ id: 'alpha-team', maxCapacity: 10 }));
    manager.createTeam(makeTeam({ id: 'beta-team', maxCapacity: 10 }));
  });

  it('returns agents belonging to the specified team', () => {
    manager.registerAgent(makeAgent({ id: 'alpha-1', teamId: 'alpha-team' }));
    manager.registerAgent(makeAgent({ id: 'alpha-2', teamId: 'alpha-team' }));
    manager.registerAgent(makeAgent({ id: 'beta-1', teamId: 'beta-team' }));

    const result = manager.getAgentsByTeam('alpha-team');
    expect(result).toHaveLength(2);
    expect(result.every((a) => a.teamId === 'alpha-team')).toBe(true);
  });

  it('returns empty array when no agents belong to team', () => {
    const result = manager.getAgentsByTeam('empty-team');
    expect(result).toEqual([]);
  });

  it('returns correct members after reassignment', () => {
    manager.registerAgent(makeAgent({ id: 'moved-agent', teamId: 'alpha-team' }));
    manager.reassignAgent('moved-agent', 'beta-team');

    expect(manager.getAgentsByTeam('alpha-team').map((a) => a.id)).not.toContain('moved-agent');
    expect(manager.getAgentsByTeam('beta-team').map((a) => a.id)).toContain('moved-agent');
  });
});

// ---------------------------------------------------------------------------
// Tests: getTeamUtilization
// ---------------------------------------------------------------------------

describe('getTeamUtilization', () => {
  it('returns 0 for a team with 0 current load', () => {
    manager.createTeam(makeTeam({ id: 'util-team', maxCapacity: 10, currentLoad: 0 }));
    expect(manager.getTeamUtilization('util-team')).toBe(0);
  });

  it('returns 1.0 for a fully loaded team', () => {
    manager.createTeam(makeTeam({ id: 'full-team', maxCapacity: 4, currentLoad: 4 }));
    expect(manager.getTeamUtilization('full-team')).toBe(1.0);
  });

  it('returns correct ratio for partial load', () => {
    manager.createTeam(makeTeam({ id: 'half-team', maxCapacity: 10, currentLoad: 5 }));
    expect(manager.getTeamUtilization('half-team')).toBe(0.5);
  });

  it('throws for a non-existent team', () => {
    expect(() => manager.getTeamUtilization('no-team')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: getAgentsByLayer
// ---------------------------------------------------------------------------

describe('getAgentsByLayer', () => {
  it('returns only agents in the specified layer', () => {
    manager.registerAgent(makeAgent({ id: 'be-1', layer: 'backend' }));
    manager.registerAgent(makeAgent({ id: 'be-2', layer: 'backend' }));
    manager.registerAgent(makeAgent({ id: 'fe-1', layer: 'frontend' }));

    const result = manager.getAgentsByLayer('backend');
    expect(result).toHaveLength(2);
    expect(result.every((a) => a.layer === 'backend')).toBe(true);
  });

  it('returns empty array when no agents in layer', () => {
    const result = manager.getAgentsByLayer('data');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: getTeamsByLayer
// ---------------------------------------------------------------------------

describe('getTeamsByLayer', () => {
  it('returns only teams in the specified layer', () => {
    manager.createTeam(makeTeam({ id: 'be-team-1', layer: 'backend' }));
    manager.createTeam(makeTeam({ id: 'be-team-2', layer: 'backend' }));
    manager.createTeam(makeTeam({ id: 'fe-team-1', layer: 'frontend' }));

    const result = manager.getTeamsByLayer('backend');
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.layer === 'backend')).toBe(true);
  });

  it('returns empty array for layer with no teams', () => {
    const result = manager.getTeamsByLayer('qa');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: listAgents + listTeams
// ---------------------------------------------------------------------------

describe('listAgents', () => {
  it('returns empty array when no agents registered', () => {
    expect(manager.listAgents()).toEqual([]);
  });

  it('returns all registered agents', () => {
    manager.registerAgent(makeAgent({ id: 'list-a' }));
    manager.registerAgent(makeAgent({ id: 'list-b' }));
    expect(manager.listAgents()).toHaveLength(2);
  });

  it('includes terminated agents in list', () => {
    manager.registerAgent(makeAgent({ id: 'term-list' }));
    manager.terminateAgent('term-list');
    expect(manager.listAgents()).toHaveLength(1);
  });
});

describe('listTeams', () => {
  it('returns empty array when no teams exist', () => {
    expect(manager.listTeams()).toEqual([]);
  });

  it('returns all created teams', () => {
    manager.createTeam(makeTeam({ id: 'lt-1' }));
    manager.createTeam(makeTeam({ id: 'lt-2' }));
    expect(manager.listTeams()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Combined scenarios
// ---------------------------------------------------------------------------

describe('Combined scenarios', () => {
  it('full hire and team assignment flow', () => {
    manager.createTeam(makeTeam({ id: 'ops-team', maxCapacity: 10 }));

    const agent = makeAgent({ id: 'new-hire', teamId: 'ops-team', status: 'idle' });
    manager.registerAgent(agent);

    expect(manager.getAgent('new-hire')).toBeDefined();
    expect(manager.getAgentsByTeam('ops-team')).toHaveLength(1);
  });

  it('terminate then check team membership is unchanged', () => {
    manager.createTeam(makeTeam({ id: 'qa-team', maxCapacity: 10 }));
    manager.registerAgent(makeAgent({ id: 'qa-coder', teamId: 'qa-team' }));
    manager.terminateAgent('qa-coder');

    // listByTeam still returns the agent (terminated, not removed)
    const members = manager.getAgentsByTeam('qa-team');
    expect(members.find((a) => a.id === 'qa-coder')!.status).toBe('terminated');
  });

  it('reassign updates both agent identity and team membership', () => {
    manager.createTeam(makeTeam({ id: 'src-team', maxCapacity: 10 }));
    manager.createTeam(makeTeam({ id: 'dst-team', maxCapacity: 10 }));

    manager.registerAgent(makeAgent({ id: 'traveller', teamId: 'src-team' }));
    manager.reassignAgent('traveller', 'dst-team');

    const agent = manager.getAgent('traveller')!;
    expect(agent.teamId).toBe('dst-team');
  });
});
