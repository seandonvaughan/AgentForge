export const MODEL_IDS = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
} as const;

export const API_VERSION = 'v5' as const;
export const API_BASE = `/api/${API_VERSION}` as const;

export const DEFAULT_PAGINATION = {
  limit: 50,
  maxLimit: 500,
  offset: 0,
} as const;

export const WEBSOCKET_EVENTS = {
  SESSION_STARTED: 'session:started',
  SESSION_COMPLETED: 'session:completed',
  SESSION_FAILED: 'session:failed',
  AGENT_MESSAGE: 'agent:message',
  COST_UPDATE: 'cost:update',
  ANOMALY_DETECTED: 'anomaly:detected',
  PLUGIN_EVENT: 'plugin:event',
  BUS_EVENT: 'bus:event',
} as const;

export const AUTONOMY_TIERS = {
  1: 'supervised',
  2: 'assisted',
  3: 'autonomous',
  4: 'expert',
  5: 'principal',
} as const;
