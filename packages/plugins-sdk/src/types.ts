export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  entrypoint: string;
  permissions: PluginPermission[];
  hooks: PluginHook[];
  skills: PluginSkill[];
  author?: string;
}

export type PluginPermission = 'filesystem:read' | 'filesystem:write' | 'network' | 'agent:invoke' | 'db:read' | 'db:write';

export interface PluginHook {
  event: string;     // e.g. 'agent.invoked', 'session.started'
  handler: string;   // exported function name in entrypoint
}

export interface PluginSkill {
  name: string;
  description: string;
  handler: string;
}

// JSON-RPC 2.0 types
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcNotification = Omit<JsonRpcRequest, 'id'>;

// Plugin lifecycle
export type PluginStatus = 'stopped' | 'starting' | 'running' | 'error' | 'stopping';

export interface PluginInstance {
  id: string;
  manifest: PluginManifest;
  status: PluginStatus;
  startedAt?: string;
  errorMessage?: string;
  pid?: number;
}

// Host API surface exposed to plugins via IPC
export interface HostApi {
  'host.agent.list': () => Promise<Array<{ id: string; name: string; model: string }>>;
  'host.session.create': (params: { agentId: string; task: string }) => Promise<{ sessionId: string }>;
  'host.log': (params: { level: 'info' | 'warn' | 'error'; message: string }) => Promise<void>;
  'host.emit': (params: { event: string; data: unknown }) => Promise<void>;
}
