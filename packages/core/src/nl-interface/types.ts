export type IntentType =
  | 'run_agent'
  | 'get_status'
  | 'list_agents'
  | 'show_cost'
  | 'create_workflow'
  | 'query_knowledge'
  | 'get_sprint'
  | 'unknown';

export interface Entity {
  type: 'agent_name' | 'version' | 'cost_amount' | 'sprint_version' | 'workflow_name';
  value: string;
  raw: string;
  startIndex: number;
  endIndex: number;
}

export interface ParsedIntent {
  intent: IntentType;
  confidence: number;
  entities: Entity[];
  rawInput: string;
}

export interface NLResponse {
  parsed: ParsedIntent;
  action: ActionDescriptor | null;
  executionResult?: unknown;
}

export interface ActionDescriptor {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  params: Record<string, unknown>;
  description: string;
}
