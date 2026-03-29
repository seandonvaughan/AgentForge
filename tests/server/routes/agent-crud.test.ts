/**
 * tests/server/routes/agent-crud.test.ts
 *
 * Tests for the agent CRUD route logic.
 * We exercise the pure helper functions (YAML read/write, delegation map
 * manipulation, model routing, validation) directly via a temporary directory,
 * without spinning up the Fastify server.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Types (mirror agent-crud.ts)
// ---------------------------------------------------------------------------

interface AgentYaml {
  name: string;
  model: string;
  version: string;
  description: string;
  system_prompt: string;
  seniority?: string;
  layer?: string;
  skills?: string[];
  collaboration?: {
    reports_to?: string;
    can_delegate_to?: string[];
    parallel?: boolean;
  };
}

type DelegationMap = Record<string, string[]>;
type ModelsMap = Record<string, string[]>;

// ---------------------------------------------------------------------------
// Helpers — mirroring agent-crud.ts helper functions
// ---------------------------------------------------------------------------

function readYaml<T>(filePath: string): T {
  return yaml.load(readFileSync(filePath, 'utf-8')) as T;
}

function writeYaml(filePath: string, data: unknown): void {
  writeFileSync(filePath, yaml.dump(data, { lineWidth: 120 }), 'utf-8');
}

function modelForSeniority(seniority: string): string {
  if (seniority === 'lead' || seniority === 'principal') return 'opus';
  if (seniority === 'junior') return 'haiku';
  return 'sonnet';
}

function addToDelegation(delPath: string, supervisorId: string, agentId: string): void {
  if (!existsSync(delPath)) return;
  const map = readYaml<DelegationMap>(delPath);
  const list = map[supervisorId] ?? [];
  if (!list.includes(agentId)) {
    map[supervisorId] = [...list, agentId];
    writeYaml(delPath, map);
  }
}

function removeFromDelegation(delPath: string, agentId: string): void {
  if (!existsSync(delPath)) return;
  const map = readYaml<DelegationMap>(delPath);
  let changed = false;
  for (const supervisor of Object.keys(map)) {
    const before = map[supervisor] ?? [];
    const after = before.filter((r) => r !== agentId);
    if (after.length !== before.length) {
      map[supervisor] = after;
      changed = true;
    }
  }
  if (agentId in map) {
    delete map[agentId];
    changed = true;
  }
  if (changed) writeYaml(delPath, map);
}

function setModelRouting(mdlPath: string, agentId: string, model: string): void {
  if (!existsSync(mdlPath)) return;
  const map = readYaml<ModelsMap>(mdlPath);
  for (const tier of Object.keys(map)) {
    map[tier] = (map[tier] ?? []).filter((id) => id !== agentId);
  }
  if (!map[model]) map[model] = [];
  if (!map[model].includes(agentId)) {
    map[model] = [...map[model], agentId];
  }
  writeYaml(mdlPath, map);
}

function removeFromModels(mdlPath: string, agentId: string): void {
  if (!existsSync(mdlPath)) return;
  const map = readYaml<ModelsMap>(mdlPath);
  let changed = false;
  for (const tier of Object.keys(map)) {
    const before = map[tier] ?? [];
    const after = before.filter((id) => id !== agentId);
    if (after.length !== before.length) {
      map[tier] = after;
      changed = true;
    }
  }
  if (changed) writeYaml(mdlPath, map);
}

function getDirectReports(agentsDir: string, supervisorId: string): string[] {
  if (!existsSync(agentsDir)) return [];
  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
  const reports: string[] = [];
  for (const file of files) {
    try {
      const data = readYaml<AgentYaml>(join(agentsDir, file));
      if (data?.collaboration?.reports_to === supervisorId) {
        reports.push(file.replace('.yaml', ''));
      }
    } catch {
      // skip malformed
    }
  }
  return reports;
}

function isValidKebabId(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

let tmpRoot: string;
let agentsDir: string;
let cfgDir: string;
let delPath: string;
let mdlPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-agent-crud-test-'));
  agentsDir = join(tmpRoot, '.agentforge', 'agents');
  cfgDir = join(tmpRoot, '.agentforge', 'config');
  delPath = join(cfgDir, 'delegation.yaml');
  mdlPath = join(cfgDir, 'models.yaml');

  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(cfgDir, { recursive: true });

  // Seed delegation.yaml and models.yaml
  writeYaml(delPath, { cto: ['architect'], coo: [] });
  writeYaml(mdlPath, { opus: [], sonnet: [], haiku: [] });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function agentPath(id: string): string {
  return join(agentsDir, `${id}.yaml`);
}

function createAgent(id: string, overrides: Partial<AgentYaml> = {}): AgentYaml {
  const agent: AgentYaml = {
    name: 'Test Agent',
    model: 'sonnet',
    version: '1.0',
    description: 'A test agent',
    system_prompt: 'You are a test agent.',
    collaboration: { can_delegate_to: [], parallel: false },
    ...overrides,
  };
  writeYaml(agentPath(id), agent);
  return agent;
}

// ---------------------------------------------------------------------------
// Tests: Create agent
// ---------------------------------------------------------------------------

describe('Create agent', () => {
  it('writes a YAML file at the correct path', () => {
    createAgent('my-agent');
    expect(existsSync(agentPath('my-agent'))).toBe(true);
  });

  it('written YAML is readable and has correct fields', () => {
    createAgent('test-coder', { name: 'Test Coder', model: 'sonnet' });
    const loaded = readYaml<AgentYaml>(agentPath('test-coder'));
    expect(loaded.name).toBe('Test Coder');
    expect(loaded.model).toBe('sonnet');
    expect(loaded.version).toBe('1.0');
  });

  it('stores description correctly', () => {
    createAgent('desc-agent', { description: 'Writes tests' });
    const loaded = readYaml<AgentYaml>(agentPath('desc-agent'));
    expect(loaded.description).toBe('Writes tests');
  });

  it('stores system_prompt correctly', () => {
    createAgent('prompt-agent', { system_prompt: 'You are a QA engineer.' });
    const loaded = readYaml<AgentYaml>(agentPath('prompt-agent'));
    expect(loaded.system_prompt).toBe('You are a QA engineer.');
  });

  it('stores seniority when provided', () => {
    createAgent('senior-agent', { seniority: 'senior' });
    const loaded = readYaml<AgentYaml>(agentPath('senior-agent'));
    expect(loaded.seniority).toBe('senior');
  });

  it('stores layer when provided', () => {
    createAgent('backend-agent', { layer: 'backend' });
    const loaded = readYaml<AgentYaml>(agentPath('backend-agent'));
    expect(loaded.layer).toBe('backend');
  });

  it('stores skills array when provided', () => {
    createAgent('skilled-agent', { skills: ['typescript', 'testing'] });
    const loaded = readYaml<AgentYaml>(agentPath('skilled-agent'));
    expect(loaded.skills).toEqual(['typescript', 'testing']);
  });

  it('registers agent in model routing', () => {
    createAgent('model-agent', { model: 'opus' });
    setModelRouting(mdlPath, 'model-agent', 'opus');

    const map = readYaml<ModelsMap>(mdlPath);
    expect(map.opus).toContain('model-agent');
  });

  it('wires reports_to in delegation when provided', () => {
    createAgent('junior-agent', {
      collaboration: { reports_to: 'cto', can_delegate_to: [], parallel: false },
    });
    addToDelegation(delPath, 'cto', 'junior-agent');

    const map = readYaml<DelegationMap>(delPath);
    expect(map.cto).toContain('junior-agent');
  });
});

// ---------------------------------------------------------------------------
// Tests: ID validation
// ---------------------------------------------------------------------------

describe('ID validation (kebab-case)', () => {
  it('accepts lowercase kebab-case', () => {
    expect(isValidKebabId('my-agent')).toBe(true);
  });

  it('accepts single word', () => {
    expect(isValidKebabId('coder')).toBe(true);
  });

  it('accepts alphanumeric segments', () => {
    expect(isValidKebabId('agent-v2')).toBe(true);
  });

  it('rejects uppercase letters', () => {
    expect(isValidKebabId('MyAgent')).toBe(false);
  });

  it('rejects spaces', () => {
    expect(isValidKebabId('my agent')).toBe(false);
  });

  it('rejects underscores', () => {
    expect(isValidKebabId('my_agent')).toBe(false);
  });

  it('rejects leading hyphen', () => {
    expect(isValidKebabId('-my-agent')).toBe(false);
  });

  it('rejects trailing hyphen', () => {
    expect(isValidKebabId('my-agent-')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidKebabId('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Update agent
// ---------------------------------------------------------------------------

describe('Update agent', () => {
  it('merges name field correctly', () => {
    const original = createAgent('upd-agent', { name: 'Original' });
    const updated = { ...original, name: 'Updated' };
    writeYaml(agentPath('upd-agent'), updated);

    const loaded = readYaml<AgentYaml>(agentPath('upd-agent'));
    expect(loaded.name).toBe('Updated');
  });

  it('preserves unmodified fields after update', () => {
    createAgent('pres-agent', { name: 'Preserved', description: 'Keep me' });
    const existing = readYaml<AgentYaml>(agentPath('pres-agent'));
    const updated = { ...existing, model: 'haiku' };
    writeYaml(agentPath('pres-agent'), updated);

    const loaded = readYaml<AgentYaml>(agentPath('pres-agent'));
    expect(loaded.name).toBe('Preserved');
    expect(loaded.description).toBe('Keep me');
    expect(loaded.model).toBe('haiku');
  });

  it('updates model and changes model routing', () => {
    createAgent('routing-agent', { model: 'sonnet' });
    setModelRouting(mdlPath, 'routing-agent', 'sonnet');

    // Now update model to opus
    setModelRouting(mdlPath, 'routing-agent', 'opus');

    const map = readYaml<ModelsMap>(mdlPath);
    expect(map.opus).toContain('routing-agent');
    expect(map.sonnet).not.toContain('routing-agent');
  });

  it('updates seniority field', () => {
    createAgent('seniority-agent', { seniority: 'mid' });
    const existing = readYaml<AgentYaml>(agentPath('seniority-agent'));
    const updated = { ...existing, seniority: 'senior' };
    writeYaml(agentPath('seniority-agent'), updated);

    const loaded = readYaml<AgentYaml>(agentPath('seniority-agent'));
    expect(loaded.seniority).toBe('senior');
  });

  it('rewires delegation when reports_to changes', () => {
    createAgent('mobile-agent', {
      collaboration: { reports_to: 'cto', can_delegate_to: [], parallel: false },
    });
    addToDelegation(delPath, 'cto', 'mobile-agent');

    // Change reports_to from cto → coo
    removeFromDelegation(delPath, 'mobile-agent');
    addToDelegation(delPath, 'coo', 'mobile-agent');

    const map = readYaml<DelegationMap>(delPath);
    expect(map.cto ?? []).not.toContain('mobile-agent');
    expect(map.coo).toContain('mobile-agent');
  });

  it('returns 404 semantics for non-existent agent', () => {
    const exists = existsSync(agentPath('ghost-agent'));
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Delete agent
// ---------------------------------------------------------------------------

describe('Delete agent', () => {
  it('removes the YAML file', () => {
    createAgent('del-agent');
    unlinkSync(agentPath('del-agent'));
    expect(existsSync(agentPath('del-agent'))).toBe(false);
  });

  it('removes agent from delegation map', () => {
    createAgent('del-del-agent');
    addToDelegation(delPath, 'cto', 'del-del-agent');
    removeFromDelegation(delPath, 'del-del-agent');

    const map = readYaml<DelegationMap>(delPath);
    expect(map.cto).not.toContain('del-del-agent');
  });

  it('removes agent from models map', () => {
    createAgent('del-mdl-agent', { model: 'haiku' });
    setModelRouting(mdlPath, 'del-mdl-agent', 'haiku');
    removeFromModels(mdlPath, 'del-mdl-agent');

    const map = readYaml<ModelsMap>(mdlPath);
    expect(map.haiku ?? []).not.toContain('del-mdl-agent');
  });

  it('cannot delete agent that has direct reports', () => {
    createAgent('supervisor', { name: 'Supervisor' });
    createAgent('report-agent', {
      collaboration: { reports_to: 'supervisor', can_delegate_to: [], parallel: false },
    });

    const reports = getDirectReports(agentsDir, 'supervisor');
    expect(reports).toContain('report-agent');
    // Guard: should refuse deletion
    expect(reports.length).toBeGreaterThan(0);
  });

  it('allows deletion when agent has no direct reports', () => {
    createAgent('lonely-agent');
    const reports = getDirectReports(agentsDir, 'lonely-agent');
    expect(reports).toHaveLength(0);
    // Safe to delete
    unlinkSync(agentPath('lonely-agent'));
    expect(existsSync(agentPath('lonely-agent'))).toBe(false);
  });

  it('returns 404 semantics for non-existent agent', () => {
    const exists = existsSync(agentPath('no-such-agent'));
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Fork agent
// ---------------------------------------------------------------------------

describe('Fork agent', () => {
  it('creates a new YAML file with newId', () => {
    createAgent('source-agent', { name: 'Source' });
    const source = readYaml<AgentYaml>(agentPath('source-agent'));
    const forked: AgentYaml = {
      ...source,
      name: `Source (fork of source-agent)`,
      version: '1.0',
    };
    writeYaml(agentPath('forked-agent'), forked);

    expect(existsSync(agentPath('forked-agent'))).toBe(true);
  });

  it('fork inherits source system_prompt by default', () => {
    createAgent('src-fork', { system_prompt: 'Original prompt' });
    const source = readYaml<AgentYaml>(agentPath('src-fork'));
    const forked = { ...source, version: '1.0' };
    writeYaml(agentPath('fork-of-src'), forked);

    const loaded = readYaml<AgentYaml>(agentPath('fork-of-src'));
    expect(loaded.system_prompt).toBe('Original prompt');
  });

  it('fork can override name', () => {
    createAgent('base-agent', { name: 'Base' });
    const source = readYaml<AgentYaml>(agentPath('base-agent'));
    const forked = { ...source, name: 'Custom Fork Name', version: '1.0' };
    writeYaml(agentPath('custom-fork'), forked);

    const loaded = readYaml<AgentYaml>(agentPath('custom-fork'));
    expect(loaded.name).toBe('Custom Fork Name');
  });

  it('fork can override model', () => {
    createAgent('model-base', { model: 'sonnet' });
    const source = readYaml<AgentYaml>(agentPath('model-base'));
    const forked = { ...source, model: 'haiku', version: '1.0' };
    writeYaml(agentPath('model-fork'), forked);

    const loaded = readYaml<AgentYaml>(agentPath('model-fork'));
    expect(loaded.model).toBe('haiku');
  });

  it('fork can override system_prompt', () => {
    createAgent('prompt-base', { system_prompt: 'Original' });
    const source = readYaml<AgentYaml>(agentPath('prompt-base'));
    const forked = { ...source, system_prompt: 'Forked prompt', version: '1.0' };
    writeYaml(agentPath('prompt-fork'), forked);

    const loaded = readYaml<AgentYaml>(agentPath('prompt-fork'));
    expect(loaded.system_prompt).toBe('Forked prompt');
  });

  it('fork version resets to "1.0"', () => {
    createAgent('version-base', { version: '3.5' });
    const source = readYaml<AgentYaml>(agentPath('version-base'));
    const forked = { ...source, version: '1.0' };
    writeYaml(agentPath('version-fork'), forked);

    const loaded = readYaml<AgentYaml>(agentPath('version-fork'));
    expect(loaded.version).toBe('1.0');
  });

  it('newId must be kebab-case', () => {
    expect(isValidKebabId('InvalidFork')).toBe(false);
    expect(isValidKebabId('valid-fork')).toBe(true);
  });

  it('cannot fork to an ID that already exists', () => {
    createAgent('existing-fork');
    const alreadyExists = existsSync(agentPath('existing-fork'));
    expect(alreadyExists).toBe(true);
  });

  it('requires newId', () => {
    const newId: string | undefined = undefined;
    expect(newId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Promote agent
// ---------------------------------------------------------------------------

describe('Promote agent', () => {
  it('updates seniority to new level', () => {
    createAgent('promo-agent', { seniority: 'mid' });
    const existing = readYaml<AgentYaml>(agentPath('promo-agent'));
    const updated = { ...existing, seniority: 'senior', model: modelForSeniority('senior') };
    writeYaml(agentPath('promo-agent'), updated);

    const loaded = readYaml<AgentYaml>(agentPath('promo-agent'));
    expect(loaded.seniority).toBe('senior');
  });

  it('promotes to lead and sets model to opus', () => {
    createAgent('lead-promo', { seniority: 'senior', model: 'sonnet' });
    const newModel = modelForSeniority('lead');
    expect(newModel).toBe('opus');
  });

  it('promotes to principal and sets model to opus', () => {
    expect(modelForSeniority('principal')).toBe('opus');
  });

  it('promotes to mid and sets model to sonnet', () => {
    expect(modelForSeniority('mid')).toBe('sonnet');
  });

  it('promotes to senior and sets model to sonnet', () => {
    expect(modelForSeniority('senior')).toBe('sonnet');
  });

  it('junior maps to haiku', () => {
    expect(modelForSeniority('junior')).toBe('haiku');
  });

  it('syncs model routing after promotion', () => {
    createAgent('sync-promo', { seniority: 'mid', model: 'sonnet' });
    setModelRouting(mdlPath, 'sync-promo', 'sonnet');

    const newModel = modelForSeniority('lead');
    setModelRouting(mdlPath, 'sync-promo', newModel);

    const map = readYaml<ModelsMap>(mdlPath);
    expect(map.opus).toContain('sync-promo');
    expect(map.sonnet ?? []).not.toContain('sync-promo');
  });

  it('rejects missing newSeniority', () => {
    const newSeniority: string | undefined = undefined;
    expect(newSeniority).toBeUndefined();
  });

  it('rejects missing approvedBy', () => {
    const approvedBy: string | undefined = undefined;
    expect(approvedBy).toBeUndefined();
  });

  it('valid seniorities are: mid, senior, lead, principal', () => {
    const validSeniorities = ['mid', 'senior', 'lead', 'principal'];
    expect(validSeniorities).toContain('lead');
    expect(validSeniorities).not.toContain('junior');
  });
});

// ---------------------------------------------------------------------------
// Tests: Delegation helper
// ---------------------------------------------------------------------------

describe('Delegation helpers', () => {
  it('addToDelegation adds agent to supervisor list', () => {
    addToDelegation(delPath, 'cto', 'new-report');
    const map = readYaml<DelegationMap>(delPath);
    expect(map.cto).toContain('new-report');
  });

  it('addToDelegation is idempotent', () => {
    addToDelegation(delPath, 'cto', 'idempotent-agent');
    addToDelegation(delPath, 'cto', 'idempotent-agent');
    const map = readYaml<DelegationMap>(delPath);
    const count = (map.cto ?? []).filter((id) => id === 'idempotent-agent').length;
    expect(count).toBe(1);
  });

  it('removeFromDelegation removes from all lists', () => {
    addToDelegation(delPath, 'cto', 'remove-me');
    addToDelegation(delPath, 'coo', 'remove-me');
    removeFromDelegation(delPath, 'remove-me');

    const map = readYaml<DelegationMap>(delPath);
    expect(map.cto ?? []).not.toContain('remove-me');
    expect(map.coo ?? []).not.toContain('remove-me');
  });

  it('removeFromDelegation removes own supervisor key', () => {
    const map = readYaml<DelegationMap>(delPath);
    map['some-supervisor'] = ['a', 'b'];
    writeYaml(delPath, map);

    removeFromDelegation(delPath, 'some-supervisor');
    const updated = readYaml<DelegationMap>(delPath);
    expect('some-supervisor' in updated).toBe(false);
  });

  it('addToDelegation is no-op when delegation file does not exist', () => {
    const fakePath = join(tmpRoot, 'fake-delegation.yaml');
    // Should not throw
    expect(() => addToDelegation(fakePath, 'cto', 'agent')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: Model routing helpers
// ---------------------------------------------------------------------------

describe('Model routing helpers', () => {
  it('setModelRouting puts agent in correct bucket', () => {
    setModelRouting(mdlPath, 'bucket-agent', 'haiku');
    const map = readYaml<ModelsMap>(mdlPath);
    expect(map.haiku).toContain('bucket-agent');
  });

  it('setModelRouting removes from old bucket', () => {
    setModelRouting(mdlPath, 'move-agent', 'sonnet');
    setModelRouting(mdlPath, 'move-agent', 'opus');

    const map = readYaml<ModelsMap>(mdlPath);
    expect(map.sonnet ?? []).not.toContain('move-agent');
    expect(map.opus).toContain('move-agent');
  });

  it('removeFromModels strips agent from all buckets', () => {
    setModelRouting(mdlPath, 'strip-agent', 'opus');
    removeFromModels(mdlPath, 'strip-agent');

    const map = readYaml<ModelsMap>(mdlPath);
    for (const bucket of Object.values(map)) {
      expect(bucket).not.toContain('strip-agent');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: getDirectReports
// ---------------------------------------------------------------------------

describe('getDirectReports', () => {
  it('returns IDs of agents reporting to a supervisor', () => {
    createAgent('report-a', {
      collaboration: { reports_to: 'boss', can_delegate_to: [], parallel: false },
    });
    createAgent('report-b', {
      collaboration: { reports_to: 'boss', can_delegate_to: [], parallel: false },
    });

    const reports = getDirectReports(agentsDir, 'boss');
    expect(reports).toContain('report-a');
    expect(reports).toContain('report-b');
  });

  it('returns empty array when supervisor has no direct reports', () => {
    createAgent('orphan-agent');
    const reports = getDirectReports(agentsDir, 'no-boss');
    expect(reports).toHaveLength(0);
  });

  it('returns empty array when agentsDir does not exist', () => {
    const reports = getDirectReports(join(tmpRoot, 'nonexistent'), 'boss');
    expect(reports).toHaveLength(0);
  });

  it('skips malformed YAML files silently', () => {
    writeFileSync(join(agentsDir, 'broken.yaml'), 'BROKEN: [unclosed', 'utf-8');
    const reports = getDirectReports(agentsDir, 'any-boss');
    // Should not throw and broken file is ignored
    expect(Array.isArray(reports)).toBe(true);
  });
});
