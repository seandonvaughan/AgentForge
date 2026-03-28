// Agent model tiers
export type ModelTier = 'opus' | 'sonnet' | 'haiku';

// Workspace identifier
export type WorkspaceId = string;

// Agent identifier
export type AgentId = string;

// Session identifier
export type SessionId = string;

// Base entity with timestamps
export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
}

// Workspace definition
export interface Workspace extends BaseEntity {
  name: string;
  slug: string;
  ownerId: string;
  settings: WorkspaceSettings;
}

export interface WorkspaceSettings {
  defaultModel: ModelTier;
  budgetLimitUsd: number;
  pluginsEnabled: string[];
  features: Record<string, boolean>;
}

// Agent definition
export interface AgentDefinition extends BaseEntity {
  workspaceId: WorkspaceId;
  name: string;
  agentId: AgentId;
  model: ModelTier;
  team: string;
  systemPrompt: string;
  skills: string[];
  autonomyTier: number;
}

// Session record
export interface SessionRecord extends BaseEntity {
  workspaceId: WorkspaceId;
  agentId: AgentId;
  parentSessionId: SessionId | null;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'suspended';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: string;
  completedAt: string | null;
}

// API response envelope
export interface ApiResponse<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiMeta {
  total?: number;
  limit?: number;
  offset?: number;
  workspaceId?: WorkspaceId;
  requestId?: string;
  timestamp: string;
}

// Pagination params
export interface PaginationParams {
  limit?: number;
  offset?: number;
}

// Error response
export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
  requestId?: string;
}
