/**
 * Declared capabilities that require host-side authorization.
 */
export type PluginPermission =
  | 'filesystem:read'
  | 'filesystem:write'
  | 'network'
  | 'agent:invoke'
  | 'db:read'
  | 'db:write';

/**
 * Supported visibility levels for registry publishing.
 */
export type PluginVisibility = 'public' | 'private' | 'unlisted';

/**
 * Marketplace metadata consumed by registry and publishing surfaces.
 */
export interface PluginMarketplaceMetadata {
  /** SPDX license identifier or equivalent license string. */
  license?: string;
  /** Public homepage for docs and usage examples. */
  homepage?: string;
  /** Source repository URL. */
  repository?: string;
  /** Searchable tags used by registry filters. */
  tags?: string[];
  /** Searchable keywords used by marketplace indexing. */
  keywords?: string[];
  /** Marketplace category label. */
  category?: string;
  /** Intended publication visibility for registry consumers. */
  visibility?: PluginVisibility;
}

/**
 * Declarative sandbox intent from plugin authors.
 *
 * This is advisory metadata for the host policy engine and registry review.
 */
export interface PluginSandboxPolicy {
  /** Isolation boundary requested by the plugin. */
  mode: 'process' | 'inherit';
  /** Optional list of allowed network hostnames. */
  allowedHosts?: string[];
  /** Optional list of environment variables the plugin needs. */
  allowedEnv?: string[];
  /** Whether write access should be constrained to workspace-relative paths. */
  workspaceWriteOnly?: boolean;
}

/**
 * Hook subscription mapping from host event to plugin handler.
 */
export interface PluginHook {
  /** AgentForge event name, e.g. `agent.invoked` or `session.completed`. */
  event: string;
  /** Handler function name implemented in plugin entrypoint. */
  handler: string;
}

/**
 * Skill descriptor exposed by the plugin.
 */
export interface PluginSkill {
  /** Slash-command name or skill identifier. */
  name: string;
  /** Human-readable summary shown in discovery UIs. */
  description: string;
  /** Handler function name implemented in plugin entrypoint. */
  handler: string;
}

/**
 * Plugin manifest contract loaded by `PluginHost`.
 */
export interface PluginManifest {
  /** Globally unique plugin identifier. */
  id: string;
  /** Display name shown in host and marketplace views. */
  name: string;
  /** Semantic version for upgrade/install flows. */
  version: string;
  /** Short description shown in plugin listings. */
  description: string;
  /** Entrypoint path relative to the manifest directory. */
  entrypoint: string;
  /** Permissions required for host API access. */
  permissions: PluginPermission[];
  /** Event hooks subscribed by this plugin. */
  hooks: PluginHook[];
  /** Skills exposed by this plugin. */
  skills: PluginSkill[];
  /** Optional publisher attribution. */
  author?: string;
  /** Optional metadata for marketplace listing and indexing. */
  marketplace?: PluginMarketplaceMetadata;
  /** Optional declared sandbox intent. */
  sandbox?: PluginSandboxPolicy;
}

/**
 * JSON-RPC 2.0 request envelope.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 response envelope.
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 error payload.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC notification envelope (request without an id).
 */
export type JsonRpcNotification = Omit<JsonRpcRequest, 'id'>;

/**
 * Runtime lifecycle states for a loaded plugin.
 */
export type PluginStatus = 'stopped' | 'starting' | 'running' | 'error' | 'stopping';

/**
 * Runtime record tracked by the plugin host.
 */
export interface PluginInstance {
  /** Stable plugin identifier. */
  id: string;
  /** Parsed and validated plugin manifest. */
  manifest: PluginManifest;
  /** Current host lifecycle status. */
  status: PluginStatus;
  /** ISO timestamp when the plugin entered running status. */
  startedAt?: string;
  /** Last fatal error summary recorded by the host. */
  errorMessage?: string;
  /** Plugin child process pid, when running. */
  pid?: number;
  /** Absolute path of the manifest file used at load time. */
  manifestPath?: string;
  /** ISO timestamp when the manifest was loaded. */
  loadedAt?: string;
}

/**
 * Host API surface exposed to plugins via JSON-RPC.
 */
export interface HostApi {
  'host.agent.list': () => Promise<Array<{ id: string; name: string; model: string }>>;
  'host.session.create': (params: { agentId: string; task: string }) => Promise<{ sessionId: string }>;
  'host.log': (params: { level: 'info' | 'warn' | 'error'; message: string }) => Promise<void>;
  'host.emit': (params: { event: string; data: unknown }) => Promise<void>;
  'host.marketplace.search': (params: { query: string }) => Promise<Array<{ id: string; name: string; version: string }>>;
  'host.marketplace.publish': (params: {
    manifest: PluginManifest;
    readme?: string;
    changelog?: string;
  }) => Promise<{ published: boolean; entryId: string }>;
  'host.marketplace.install': (params: { pluginId: string; version?: string }) => Promise<{ installed: boolean; path?: string }>;
}
