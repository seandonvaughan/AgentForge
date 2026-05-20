export interface RunnerNlEntity {
  type?: string;
  value?: string;
}

export interface RunnerNlParsedIntent {
  intent?: string;
  confidence?: number;
  rawInput?: string;
  entities?: RunnerNlEntity[];
}

export interface RunnerNlAction {
  method?: string;
  path?: string;
  description?: string;
  params?: Record<string, unknown>;
}

export interface RunnerNlParseData {
  parsed?: RunnerNlParsedIntent;
  action?: RunnerNlAction | null;
}

export interface RunnerNlRunDraft {
  agentId: string | null;
  task: string;
  warnings: string[];
}

const RUN_AGENT_INTENT = 'run_agent';

export function normalizeNlParseResponse(payload: unknown): RunnerNlParseData | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const inner = (root['data'] && typeof root['data'] === 'object')
    ? (root['data'] as Record<string, unknown>)
    : root;

  const parsed = inner['parsed'];
  if (!parsed || typeof parsed !== 'object') return null;

  const parsedObj = parsed as Record<string, unknown>;
  const entitiesRaw = Array.isArray(parsedObj['entities']) ? parsedObj['entities'] : [];
  const entities = entitiesRaw
    .filter((entity) => entity && typeof entity === 'object')
    .map((entity) => {
      const row = entity as Record<string, unknown>;
      return {
        type: typeof row['type'] === 'string' ? row['type'] : undefined,
        value: typeof row['value'] === 'string' ? row['value'] : undefined,
      };
    });

  const action = inner['action'] && typeof inner['action'] === 'object'
    ? (inner['action'] as Record<string, unknown>)
    : null;

  return {
    parsed: {
      intent: typeof parsedObj['intent'] === 'string' ? parsedObj['intent'] : undefined,
      confidence: typeof parsedObj['confidence'] === 'number' ? parsedObj['confidence'] : undefined,
      rawInput: typeof parsedObj['rawInput'] === 'string' ? parsedObj['rawInput'] : undefined,
      entities,
    },
    action: action
      ? {
          method: typeof action['method'] === 'string' ? action['method'] : undefined,
          path: typeof action['path'] === 'string' ? action['path'] : undefined,
          description: typeof action['description'] === 'string' ? action['description'] : undefined,
          params: action['params'] && typeof action['params'] === 'object'
            ? (action['params'] as Record<string, unknown>)
            : undefined,
        }
      : null,
  };
}

export function buildRunDraftFromNl(parsed: RunnerNlParseData, fallbackInput: string): RunnerNlRunDraft | null {
  if (parsed.parsed?.intent !== RUN_AGENT_INTENT) return null;

  const commandInput = (parsed.parsed.rawInput ?? fallbackInput).trim();
  const agentId = pickAgentEntity(parsed.parsed.entities);
  const stripped = stripRunPrefix(commandInput, agentId);
  const task = (stripped || commandInput).trim();
  const warnings: string[] = [];

  if (!task) {
    warnings.push('The command did not include a runnable task body.');
  } else if (!stripped) {
    warnings.push('Used the full command as task because no run prefix was detected.');
  }

  return { agentId, task, warnings };
}

function pickAgentEntity(entities: RunnerNlEntity[] | undefined): string | null {
  if (!entities) return null;
  for (const entity of entities) {
    if (entity.type !== 'agent_name' || !entity.value) continue;
    const normalized = entity.value.trim().toLowerCase();
    if (normalized) return normalized;
  }
  return null;
}

function stripRunPrefix(raw: string, agentId: string | null): string {
  const input = raw.trim();
  if (!input) return '';

  const escapedAgent = agentId ? escapeRegExp(agentId) : '[a-zA-Z0-9_-]+';
  const patterns = [
    new RegExp(`^(?:please\\s+)?run\\s+(?:the\\s+)?${escapedAgent}\\s+agent\\b\\s*(?:to\\s+)?`, 'i'),
    new RegExp(`^(?:please\\s+)?run\\s+(?:the\\s+)?agent\\s+${escapedAgent}\\b\\s*(?:to\\s+)?`, 'i'),
    /^(?:please\s+)?run\s+(?:the\s+)?agent\b\s*(?:to\s+)?/i,
    /^(?:please\s+)?run\s+/i,
  ];

  let stripped = input;
  for (const pattern of patterns) {
    if (!pattern.test(stripped)) continue;
    stripped = stripped.replace(pattern, '').trim();
    break;
  }

  return stripped.replace(/^[:,-]\s*/, '').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
