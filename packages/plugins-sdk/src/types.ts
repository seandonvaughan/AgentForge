/**
 * Supported runtime permissions for AgentForge plugins.
 */
export type PluginPermission = 'filesystem:read' | 'filesystem:write' | 'network' | 'agent:invoke' | 'db:read' | 'db:write';

/**
 * Declares a host event subscription and the plugin handler that processes it.
 */
export interface PluginHook {
  /** AgentForge event name, for example `agent.invoked` or `session.started`. */
  event: string;
  /** Exported function name in the plugin entrypoint module. */
  handler: string;
}

/**
 * Declares a plugin capability that may be invoked by the runtime.
 */
export interface PluginSkill {
  /** Stable skill name exposed by the plugin. */
  name: string;
  /** Human-readable summary of what the skill does. */
  description: string;
  /** Exported function name in the plugin entrypoint module. */
  handler: string;
}

/**
 * Compatibility constraints declared by a plugin for host/runtime selection.
 */
export interface PluginCompatibility {
  /** Minimum AgentForge version this plugin supports. */
  minAgentforgeVersion?: string;
  /** Maximum AgentForge version this plugin supports. */
  maxAgentforgeVersion?: string;
  /** Node.js engine constraint (semver range). */
  node?: string;
}

/**
 * Repository metadata for marketplace and registry displays.
 */
export interface PluginRepositoryMetadata {
  /** Repository type, typically `git` or `npm`. */
  type: string;
  /** Source URL for repository or package homepage. */
  url: string;
  /** Optional subdirectory containing plugin sources. */
  directory?: string;
}

/**
 * Optional plugin metadata used by marketplace and registry workflows.
 */
export interface PluginMarketplaceMetadata {
  /** Discoverability labels. */
  tags?: string[];
  /** Registry category such as `productivity` or `observability`. */
  category?: string;
  /** SPDX-style license identifier when available. */
  license?: string;
  /** Public plugin homepage URL. */
  homepage?: string;
  /** Source repository details. */
  repository?: PluginRepositoryMetadata;
  /** Additional search terms for marketplace indexing. */
  keywords?: string[];
  /** Optional integrity digest for distribution artifacts. */
  checksumSha256?: string;
}

/**
 * Public plugin manifest contract consumed by AgentForge runtime and tooling.
 */
export interface PluginManifest {
  /** Unique plugin identifier. */
  id: string;
  /** Human-readable plugin name. */
  name: string;
  /** Semantic version of the plugin package. */
  version: string;
  /** Short plugin summary. */
  description: string;
  /** Relative path to the runtime entrypoint JS file. */
  entrypoint: string;
  /** Declared runtime permissions. */
  permissions: PluginPermission[];
  /** Event hooks handled by this plugin. */
  hooks: PluginHook[];
  /** Skills exposed by this plugin. */
  skills: PluginSkill[];
  /** Optional author/maintainer string. */
  author?: string;
  /** Optional runtime compatibility declarations. */
  compatibility?: PluginCompatibility;
  /** Optional marketplace and registry metadata. */
  marketplace?: PluginMarketplaceMetadata;
}

/**
 * JSON-RPC 2.0 request shape.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 response shape.
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 error envelope.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 notification payload.
 */
export type JsonRpcNotification = Omit<JsonRpcRequest, 'id'>;

/**
 * Runtime lifecycle state for a loaded plugin process.
 */
export type PluginStatus = 'stopped' | 'starting' | 'running' | 'error' | 'stopping';

/**
 * Runtime snapshot for a plugin known to the host.
 */
export interface PluginInstance {
  /** Plugin identifier. */
  id: string;
  /** Loaded plugin manifest. */
  manifest: PluginManifest;
  /** Current process lifecycle state. */
  status: PluginStatus;
  /** ISO timestamp when the plugin entered running state. */
  startedAt?: string;
  /** Last error message reported by host/runtime. */
  errorMessage?: string;
  /** Child process ID when started. */
  pid?: number;
}

/**
 * Host API methods exposed to plugins over JSON-RPC.
 */
export interface HostApi {
  'host.agent.list': () => Promise<Array<{ id: string; name: string; model: string }>>;
  'host.session.create': (params: { agentId: string; task: string }) => Promise<{ sessionId: string }>;
  'host.log': (params: { level: 'info' | 'warn' | 'error'; message: string }) => Promise<void>;
  'host.emit': (params: { event: string; data: unknown }) => Promise<void>;
}
