import type { NLResponse, ActionDescriptor, IntentType } from './types.js';
import { IntentClassifier } from './intent-classifier.js';
import { NLEntityExtractor } from './entity-extractor.js';

const INTENT_TO_ACTION: Record<IntentType, (entities: ReturnType<NLEntityExtractor['extract']>) => ActionDescriptor | null> = {
  run_agent: (entities) => {
    const agent = entities.find(e => e.type === 'agent_name');
    return {
      method: 'POST',
      path: '/api/v5/agents/run',
      params: { agentId: agent?.value ?? null },
      description: `Run agent${agent ? ': ' + agent.value : ''}`,
    };
  },
  get_status: (_entities) => ({
    method: 'GET',
    path: '/api/v5/health',
    params: {},
    description: 'Get system health status',
  }),
  list_agents: (_entities) => ({
    method: 'GET',
    path: '/api/v5/agents',
    params: {},
    description: 'List all available agents',
  }),
  show_cost: (entities) => {
    const version = entities.find(e => e.type === 'version' || e.type === 'sprint_version');
    return {
      method: 'GET',
      path: '/api/v5/costs',
      params: version ? { version: version.value } : {},
      description: 'Show cost information',
    };
  },
  create_workflow: (entities) => {
    const workflow = entities.find(e => e.type === 'workflow_name');
    return {
      method: 'POST',
      path: '/api/v5/workflows',
      params: { name: workflow?.value ?? null },
      description: `Create workflow${workflow ? ': ' + workflow.value : ''}`,
    };
  },
  query_knowledge: (_entities) => ({
    method: 'POST',
    path: '/api/v5/knowledge/query',
    params: {},
    description: 'Query the knowledge graph',
  }),
  get_sprint: (entities) => {
    const version = entities.find(e => e.type === 'sprint_version' || e.type === 'version');
    return {
      method: 'GET',
      path: '/api/v5/sprints' + (version ? `/${version.value}` : ''),
      params: {},
      description: `Get sprint${version ? ' ' + version.value : ' information'}`,
    };
  },
  unknown: (_entities) => null,
};

export class NLCommander {
  private classifier = new IntentClassifier();
  private extractor = new NLEntityExtractor();

  parse(input: string): NLResponse {
    const parsed = this.classifier.classify(input);
    const entities = this.extractor.extract(input);
    parsed.entities = entities;

    const actionFn = INTENT_TO_ACTION[parsed.intent];
    const action = actionFn ? actionFn(entities) : null;

    return { parsed, action };
  }
}
