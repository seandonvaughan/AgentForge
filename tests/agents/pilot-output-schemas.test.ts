import { describe, it, expect, beforeAll } from 'vitest';
import { load } from 'js-yaml';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const AGENT_YAMLS = [
  'fastify-v5-engineer',
  'db-workspace-engineer',
  'test-engineer',
  'svelte-cycles-engineer',
];

interface OutputSchemaBlock {
  name: string;
  strict?: boolean;
  schema: {
    type: string;
    required: string[];
    properties: Record<string, any>;
    additionalProperties?: boolean;
  };
}

interface AgentYaml {
  name: string;
  output_schema?: OutputSchemaBlock;
  [key: string]: any;
}

describe('pilot-output-schemas', () => {
  let agents: Map<string, AgentYaml> = new Map();

  beforeAll(() => {
    AGENT_YAMLS.forEach((agentId) => {
      const yamlPath = resolve(
        __dirname,
        '../../.agentforge/agents',
        `${agentId}.yaml`
      );
      const content = readFileSync(yamlPath, 'utf-8');
      const parsed = load(content) as AgentYaml;
      agents.set(agentId, parsed);
    });
  });

  it('should load all 4 agent YAMLs without error', () => {
    expect(agents.size).toBe(4);
    AGENT_YAMLS.forEach((agentId) => {
      expect(agents.has(agentId)).toBe(true);
    });
  });

  it('each agent should have output_schema block', () => {
    AGENT_YAMLS.forEach((agentId) => {
      const agent = agents.get(agentId);
      expect(agent).toBeDefined();
      expect(agent?.output_schema).toBeDefined();
    });
  });

  it('each output_schema should have name === "implementation_report"', () => {
    AGENT_YAMLS.forEach((agentId) => {
      const agent = agents.get(agentId);
      expect(agent?.output_schema?.name).toBe('implementation_report');
    });
  });

  it('each output_schema should have strict === true', () => {
    AGENT_YAMLS.forEach((agentId) => {
      const agent = agents.get(agentId);
      expect(agent?.output_schema?.strict).toBe(true);
    });
  });

  it('each schema should have type === "object"', () => {
    AGENT_YAMLS.forEach((agentId) => {
      const agent = agents.get(agentId);
      const schema = agent?.output_schema?.schema;
      expect(schema?.type).toBe('object');
    });
  });

  it('each schema should have required array with 3 elements', () => {
    AGENT_YAMLS.forEach((agentId) => {
      const agent = agents.get(agentId);
      const schema = agent?.output_schema?.schema;
      expect(Array.isArray(schema?.required)).toBe(true);
      expect(schema?.required).toContain('files_modified');
      expect(schema?.required).toContain('tests_added');
      expect(schema?.required).toContain('summary');
      expect(schema?.required?.length).toBe(3);
    });
  });

  it('each schema should have properties object with correct types', () => {
    AGENT_YAMLS.forEach((agentId) => {
      const agent = agents.get(agentId);
      const props = agent?.output_schema?.schema?.properties;
      expect(props).toBeDefined();

      // Required properties
      expect(props?.files_modified?.type).toBe('array');
      expect(props?.files_modified?.items?.type).toBe('string');
      expect(props?.tests_added?.type).toBe('integer');
      expect(props?.tests_added?.minimum).toBe(0);
      expect(props?.summary?.type).toBe('string');

      // Optional properties
      expect(props?.lines_changed?.type).toBe('integer');
      expect(props?.lines_changed?.minimum).toBe(0);
      expect(props?.blockers?.type).toBe('array');
      expect(props?.blockers?.items?.type).toBe('string');
    });
  });

  it('each schema should have additionalProperties === false', () => {
    AGENT_YAMLS.forEach((agentId) => {
      const agent = agents.get(agentId);
      const schema = agent?.output_schema?.schema;
      expect(schema?.additionalProperties).toBe(false);
    });
  });
});
