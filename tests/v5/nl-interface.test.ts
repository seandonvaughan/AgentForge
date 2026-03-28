import { describe, it, expect } from 'vitest';
import { IntentClassifier } from '../../packages/core/src/nl-interface/intent-classifier.js';
import { NLEntityExtractor } from '../../packages/core/src/nl-interface/entity-extractor.js';
import { NLCommander } from '../../packages/core/src/nl-interface/nl-commander.js';

// ── IntentClassifier ──────────────────────────────────────────────────────────

describe('IntentClassifier', () => {
  const classifier = new IntentClassifier();

  it('classifies run_agent intent', () => {
    const result = classifier.classify('run the architect agent');
    expect(result.intent).toBe('run_agent');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('classifies list_agents intent', () => {
    const result = classifier.classify('list all agents');
    expect(result.intent).toBe('list_agents');
  });

  it('classifies get_status intent', () => {
    const result = classifier.classify('get status');
    expect(result.intent).toBe('get_status');
  });

  it('classifies show_cost intent', () => {
    const result = classifier.classify('show cost');
    expect(result.intent).toBe('show_cost');
  });

  it('classifies create_workflow intent', () => {
    const result = classifier.classify('create a new workflow');
    expect(result.intent).toBe('create_workflow');
  });

  it('classifies query_knowledge intent', () => {
    const result = classifier.classify('search the knowledge graph');
    expect(result.intent).toBe('query_knowledge');
  });

  it('classifies get_sprint intent', () => {
    const result = classifier.classify('show sprint status');
    expect(result.intent).toBe('get_sprint');
  });

  it('returns unknown for nonsense input', () => {
    const result = classifier.classify('xyzzy plugh frobozzle');
    expect(result.intent).toBe('unknown');
  });

  it('includes rawInput in result', () => {
    const input = 'list all agents available';
    const result = classifier.classify(input);
    expect(result.rawInput).toBe(input);
  });

  it('confidence is between 0 and 1', () => {
    const inputs = ['run coder', 'list agents', 'show costs', 'foobar'];
    for (const input of inputs) {
      const result = classifier.classify(input);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('listIntents returns all 8 intent types', () => {
    const intents = classifier.listIntents();
    expect(intents).toHaveLength(8);
    expect(intents).toContain('run_agent');
    expect(intents).toContain('unknown');
  });

  it('show budget keywords → show_cost', () => {
    const result = classifier.classify('what is my budget');
    expect(result.intent).toBe('show_cost');
  });

  it('check health → get_status', () => {
    const result = classifier.classify('check health');
    expect(result.intent).toBe('get_status');
  });
});

// ── NLEntityExtractor ─────────────────────────────────────────────────────────

describe('NLEntityExtractor', () => {
  const extractor = new NLEntityExtractor();

  it('extracts agent names', () => {
    const entities = extractor.extract('run the architect agent');
    const agentEntities = entities.filter(e => e.type === 'agent_name');
    expect(agentEntities.some(e => e.value === 'architect')).toBe(true);
  });

  it('extracts version numbers', () => {
    const entities = extractor.extract('show me version 5.7');
    const versionEntities = entities.filter(e => e.type === 'version');
    expect(versionEntities.some(e => e.value === '5.7')).toBe(true);
  });

  it('extracts v-prefixed versions', () => {
    const entities = extractor.extract('sprint v5.7.0 status');
    const versions = entities.filter(e => e.type === 'version' || e.type === 'sprint_version');
    expect(versions.length).toBeGreaterThan(0);
  });

  it('extracts cost amounts with $ prefix', () => {
    const entities = extractor.extract('the cost was $12.50');
    const costEntities = entities.filter(e => e.type === 'cost_amount');
    expect(costEntities.some(e => e.value === '12.50')).toBe(true);
  });

  it('extracts cost amounts with dollars suffix', () => {
    const entities = extractor.extract('spent 5 dollars');
    const costEntities = entities.filter(e => e.type === 'cost_amount');
    expect(costEntities.length).toBeGreaterThan(0);
  });

  it('extracts sprint version', () => {
    const entities = extractor.extract('show sprint 5.6 results');
    const sprintEntities = entities.filter(e => e.type === 'sprint_version');
    expect(sprintEntities.length).toBeGreaterThan(0);
  });

  it('extracts workflow names', () => {
    const entities = extractor.extract('create deploy workflow');
    const workflowEntities = entities.filter(e => e.type === 'workflow_name');
    expect(workflowEntities.length).toBeGreaterThan(0);
  });

  it('returns empty array for plain text with no entities', () => {
    const entities = extractor.extract('hello world');
    expect(entities).toBeInstanceOf(Array);
  });

  it('entities are sorted by startIndex', () => {
    const entities = extractor.extract('run architect at v5.7');
    for (let i = 0; i < entities.length - 1; i++) {
      expect(entities[i].startIndex).toBeLessThanOrEqual(entities[i + 1].startIndex);
    }
  });

  it('extracts multiple agents', () => {
    const entities = extractor.extract('run coder and researcher');
    const agents = entities.filter(e => e.type === 'agent_name');
    expect(agents.length).toBeGreaterThanOrEqual(2);
  });
});

// ── NLCommander ───────────────────────────────────────────────────────────────

describe('NLCommander', () => {
  const commander = new NLCommander();

  it('parses run_agent intent into action', () => {
    const result = commander.parse('run the architect agent');
    expect(result.parsed.intent).toBe('run_agent');
    expect(result.action).not.toBeNull();
    expect(result.action!.method).toBe('POST');
    expect(result.action!.path).toContain('/agents');
  });

  it('parses list_agents intent', () => {
    const result = commander.parse('list all agents');
    expect(result.parsed.intent).toBe('list_agents');
    expect(result.action!.method).toBe('GET');
    expect(result.action!.path).toContain('/agents');
  });

  it('parses get_status intent', () => {
    const result = commander.parse('get status');
    expect(result.action!.path).toContain('/health');
  });

  it('parses show_cost intent', () => {
    const result = commander.parse('show cost');
    expect(result.action!.path).toContain('/costs');
  });

  it('parses get_sprint intent', () => {
    const result = commander.parse('show sprint status');
    expect(result.action!.path).toContain('/sprints');
  });

  it('returns action=null for unknown intent', () => {
    const result = commander.parse('xyzzy frobozzle plugh');
    expect(result.action).toBeNull();
  });

  it('includes entities in parsed result', () => {
    const result = commander.parse('run the architect agent');
    expect(result.parsed.entities).toBeInstanceOf(Array);
  });

  it('maps agent entity into run_agent action params', () => {
    const result = commander.parse('run the coder agent');
    expect(result.action!.params.agentId).toBe('coder');
  });

  it('includes sprint version in action path', () => {
    const result = commander.parse('show sprint 5.6');
    expect(result.action!.path).toContain('5.6');
  });

  it('create workflow action uses POST method', () => {
    const result = commander.parse('create a new workflow');
    expect(result.action!.method).toBe('POST');
  });

  it('action has description field', () => {
    const result = commander.parse('list all agents');
    expect(result.action!.description).toBeTruthy();
  });

  it('NLResponse has parsed and action fields', () => {
    const result = commander.parse('show cost');
    expect(result).toHaveProperty('parsed');
    expect(result).toHaveProperty('action');
  });
});
