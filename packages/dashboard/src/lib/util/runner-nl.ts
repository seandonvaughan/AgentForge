export interface RunnerAgentLike {
  agentId: string;
}

export interface RunnerNlEntity {
  type: string;
  value: string;
}

export interface RunnerNlAction {
  method: string;
  path: string;
  description: string;
  agentId: string | null;
}

export interface RunnerNlParseView {
  intent: string;
  confidence: number;
  rawInput: string;
  entities: RunnerNlEntity[];
  action: RunnerNlAction | null;
  agentCandidate: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function canonicalAgentId(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bagent\b/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .trim();
}

export function normalizeNlParseResponse(payload: unknown): RunnerNlParseView | null {
  if (!isRecord(payload)) return null;

  const root = isRecord(payload['data']) ? payload['data'] : payload;
  if (!isRecord(root)) return null;

  const parsed = isRecord(root['parsed']) ? root['parsed'] : null;
  if (!parsed) return null;

  const entitiesRaw = Array.isArray(parsed['entities']) ? parsed['entities'] : [];
  const entities: RunnerNlEntity[] = entitiesRaw.flatMap((entity) => {
    if (!isRecord(entity)) return [];
    const type = readString(entity['type']);
    const value = readString(entity['value']);
    if (!type || !value) return [];
    return [{ type, value }];
  });

  const actionRaw = isRecord(root['action']) ? root['action'] : null;
  const actionParams = actionRaw && isRecord(actionRaw['params']) ? actionRaw['params'] : null;
  const actionAgentId = readString(actionParams?.['agentId']);
  const entityAgent = entities.find((entity) => entity.type === 'agent_name')?.value ?? '';
  const candidate = actionAgentId || entityAgent;

  const action: RunnerNlAction | null = actionRaw
    ? {
        method: readString(actionRaw['method']),
        path: readString(actionRaw['path']),
        description: readString(actionRaw['description']),
        agentId: actionAgentId || null,
      }
    : null;

  return {
    intent: readString(parsed['intent']) || 'unknown',
    confidence: normalizeConfidence(parsed['confidence']),
    rawInput: readString(parsed['rawInput']),
    entities,
    action,
    agentCandidate: candidate || null,
  };
}

export function resolveAgentId(candidate: string | null, agents: RunnerAgentLike[]): string | null {
  if (!candidate) return null;

  const exact = agents.find((agent) => agent.agentId.toLowerCase() === candidate.toLowerCase());
  if (exact) return exact.agentId;

  const canonical = canonicalAgentId(candidate);
  if (!canonical) return null;

  const canonicalMatch = agents.find((agent) => canonicalAgentId(agent.agentId) === canonical);
  if (canonicalMatch) return canonicalMatch.agentId;

  const compact = canonical.replace(/[-_]/g, '');
  const compactMatch = agents.find(
    (agent) => canonicalAgentId(agent.agentId).replace(/[-_]/g, '') === compact,
  );
  return compactMatch?.agentId ?? null;
}

export function deriveTaskFromCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex > 0) {
    const prefix = trimmed.slice(0, colonIndex);
    if (/\b(run|execute|start|launch|trigger|invoke)\b/i.test(prefix)) {
      const explicitTask = trimmed.slice(colonIndex + 1).trim();
      if (explicitTask) return explicitTask;
    }
  }

  const taskAfterToFor = trimmed.match(
    /(?:run|execute|start|launch|trigger|invoke)\s+(?:the\s+)?[a-z0-9_-]+(?:\s+agent)?\s+(?:to|for)\s+(.+)/i,
  );
  if (taskAfterToFor?.[1]) return taskAfterToFor[1].trim();

  return trimmed;
}
