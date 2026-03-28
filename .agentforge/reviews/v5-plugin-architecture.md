# v5 Plugin Architecture

**Author:** platform-engineer
**Sprint:** v4.9 (item v49-5)
**Date:** 2026-03-27
**Status:** Complete

---

## 1. Overview

The AgentForge plugin system enables third-party extensions without modifying core code. Plugins can add agents, dashboard sections, webhook handlers, CLI commands, and API routes — all running in a sandboxed child process.

**Design principles:**
1. **Sandboxed by default.** Plugins cannot access the host filesystem, network, or other plugins unless explicitly granted.
2. **Declarative permissions.** The manifest declares what the plugin needs. The user approves at install time.
3. **Crash isolation.** A crashing plugin does not take down the host. Auto-restart with circuit breaker.
4. **Typed IPC.** Host-plugin communication uses JSON-RPC 2.0 over Node.js IPC. All messages are typed.
5. **Hot-reload in dev.** Plugins can be reloaded without server restart during development.

---

## 2. Plugin Manifest Schema

Every plugin has a `plugin-manifest.json` at its root:

```json
{
  "$schema": "https://agentforge.dev/schemas/plugin-manifest-v1.json",
  "name": "@agentforge/plugin-example",
  "version": "1.0.0",
  "displayName": "Example Plugin",
  "description": "Demonstrates all plugin capabilities",
  "author": {
    "name": "AgentForge Team",
    "email": "plugins@agentforge.dev",
    "url": "https://agentforge.dev"
  },
  "license": "MIT",
  "engine": ">=5.0.0",
  "entry": "./dist/index.js",

  "permissions": [
    "agents:read",
    "agents:write",
    "sessions:read",
    "sessions:write",
    "events:subscribe",
    "dashboard:section",
    "api:route",
    "commands:register",
    "webhooks:outbound",
    "storage:kv"
  ],

  "agents": [
    {
      "name": "example-agent",
      "yamlPath": "./agents/example-agent.yaml",
      "description": "An example custom agent"
    }
  ],

  "dashboardSections": [
    {
      "id": "example-metrics",
      "title": "Example Metrics",
      "componentPath": "./components/ExampleMetrics.svelte",
      "position": "main",
      "order": 100,
      "icon": "bar-chart-2"
    }
  ],

  "webhooks": [
    {
      "id": "example-webhook",
      "events": ["session.completed", "delegation.created"],
      "description": "Sends session completion data to an external endpoint"
    }
  ],

  "commands": [
    {
      "name": "example-report",
      "description": "Generate an example report",
      "args": [
        { "name": "format", "type": "string", "required": false, "default": "json" }
      ]
    }
  ],

  "apiRoutes": [
    {
      "method": "GET",
      "path": "/stats",
      "description": "Get plugin statistics"
    },
    {
      "method": "POST",
      "path": "/analyze",
      "description": "Run analysis on session data"
    }
  ],

  "config": {
    "webhookUrl": {
      "type": "string",
      "description": "External webhook endpoint URL",
      "required": false
    },
    "analysisDepth": {
      "type": "number",
      "description": "How many sessions to analyze",
      "default": 100
    }
  }
}
```

---

## 3. Plugin Lifecycle

### 3.1 Installation

```bash
# From local directory
agentforge plugin install ./my-plugin

# From npm registry
agentforge plugin install @org/agentforge-plugin-slack

# From GitHub
agentforge plugin install github:org/agentforge-plugin-slack
```

Installation steps:
1. Validate `plugin-manifest.json` against schema
2. Check `engine` compatibility (plugin requires v5, host is v5 — OK)
3. Display requested permissions to user, require confirmation
4. Copy plugin to `{workspace}/plugins/{plugin-name}/`
5. Install plugin's npm dependencies (sandboxed `node_modules`)
6. Register in workspace `plugins` table
7. If plugin has agents, copy YAML files to workspace agent registry
8. If plugin has dashboard sections, register component paths

### 3.2 Startup

On server start, for each enabled plugin:

1. Fork a child process: `child_process.fork(plugin.entry, { execArgv: ['--max-old-space-size=256'] })`
2. Set up IPC channel (JSON-RPC 2.0)
3. Send `INIT` message with plugin config and workspace context
4. Plugin responds with `READY` and registers its handlers
5. Host registers plugin's API routes, event subscriptions, commands
6. Plugin is now active

### 3.3 Runtime Communication (IPC Protocol)

```typescript
// Host -> Plugin messages
interface InitMessage {
  jsonrpc: '2.0';
  method: 'init';
  params: {
    pluginId: string;
    workspaceId: string;
    config: Record<string, unknown>;
    permissions: string[];
  };
}

interface EventMessage {
  jsonrpc: '2.0';
  method: 'event';
  params: {
    type: string;
    payload: unknown;
  };
}

interface ApiRequestMessage {
  jsonrpc: '2.0';
  id: string;
  method: 'apiRequest';
  params: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
  };
}

interface ShutdownMessage {
  jsonrpc: '2.0';
  method: 'shutdown';
}

// Plugin -> Host messages
interface ReadyMessage {
  jsonrpc: '2.0';
  result: { ready: true; capabilities: string[] };
}

interface ApiResponseMessage {
  jsonrpc: '2.0';
  id: string;
  result: {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  };
}

interface HostApiCall {
  jsonrpc: '2.0';
  id: string;
  method: 'hostApi';
  params: {
    action: string;
    args: unknown[];
  };
}
```

### 3.4 Shutdown

1. Host sends `SHUTDOWN` message
2. Plugin has 5 seconds to clean up (close connections, flush buffers)
3. After 5s, host sends `SIGTERM`
4. After 2s more, host sends `SIGKILL`

### 3.5 Crash Recovery

- Plugin crashes are detected via process `exit` event
- Restart up to 3 times with exponential backoff (1s, 2s, 4s)
- After 3 crashes in 60 seconds, plugin is disabled and error logged
- Admin can re-enable from dashboard or CLI: `agentforge plugin enable {name}`

---

## 4. Sandboxing Model

### 4.1 Process Isolation

Each plugin runs in its own Node.js child process:
- Separate V8 heap (256MB default limit)
- No shared memory with host
- No access to host `require()` — plugin has its own `node_modules`
- `process.env` is sanitized: only `NODE_ENV`, `PLUGIN_ID`, and plugin-specific config

### 4.2 Filesystem Restriction

Plugins cannot access the host filesystem. Instead:
- **KV Store:** Plugins get a key-value store via the `hostApi` IPC call (`storage.get`, `storage.set`, `storage.delete`). Data stored in the workspace DB `plugins` config.
- **Temp files:** Plugins get a temp directory (`/tmp/agentforge-plugins/{pluginId}/`) cleared on restart.
- **No access to:** workspace DB files, agent YAMLs, `.agentforge/` directory, user home directory.

### 4.3 Network Restriction

- Outbound HTTP is blocked by default
- Plugins that declare `webhooks:outbound` permission can make HTTP requests to URLs the user has approved
- No inbound network access — all communication goes through the host API routes

### 4.4 Permission Enforcement

Every `hostApi` call from a plugin is checked against the plugin's declared permissions:

```typescript
function handleHostApiCall(pluginId: string, call: HostApiCall): unknown {
  const plugin = getPlugin(pluginId);
  const requiredPermission = permissionMap[call.params.action];

  if (!plugin.permissions.includes(requiredPermission)) {
    throw new PluginPermissionError(
      `Plugin '${plugin.name}' lacks permission '${requiredPermission}' ` +
      `required for action '${call.params.action}'`
    );
  }

  return executeHostAction(call.params.action, call.params.args);
}
```

---

## 5. Plugin Development SDK

The `@agentforge/plugins-sdk` package provides:

```typescript
import { definePlugin, type PluginContext } from '@agentforge/plugins-sdk';

export default definePlugin({
  async onInit(ctx: PluginContext) {
    console.log(`Plugin initialized for workspace ${ctx.workspaceId}`);
  },

  async onEvent(ctx: PluginContext, event: AgentEvent) {
    if (event.type === 'session.completed') {
      const session = await ctx.sessions.get(event.payload.sessionId);
      await ctx.webhooks.send('example-webhook', {
        url: ctx.config.webhookUrl,
        body: { session },
      });
    }
  },

  routes: {
    'GET /stats': async (ctx, req) => {
      const sessions = await ctx.sessions.list({ limit: 100 });
      return { status: 200, body: { totalSessions: sessions.length } };
    },

    'POST /analyze': async (ctx, req) => {
      const depth = ctx.config.analysisDepth ?? 100;
      const sessions = await ctx.sessions.list({ limit: depth });
      return { status: 200, body: { analysis: result } };
    },
  },

  commands: {
    'example-report': async (ctx, args) => {
      const format = args.format ?? 'json';
      return { output: reportString };
    },
  },

  async onShutdown(ctx: PluginContext) {
    // Cleanup
  },
});
```

### 5.1 PluginContext API

```typescript
interface PluginContext {
  pluginId: string;
  workspaceId: string;
  config: Record<string, unknown>;

  agents: {
    list(opts?: ListOpts): Promise<Agent[]>;
    get(id: string): Promise<Agent | null>;
    create(data: CreateAgent): Promise<Agent>;
  };

  sessions: {
    list(opts?: ListOpts): Promise<Session[]>;
    get(id: string): Promise<Session | null>;
    create(data: CreateSession): Promise<Session>;
  };

  events: {
    subscribe(types: string[]): void;
    emit(type: string, payload: unknown): void;
  };

  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };

  webhooks: {
    send(webhookId: string, data: WebhookPayload): Promise<WebhookResult>;
  };

  log: {
    info(msg: string, data?: unknown): void;
    warn(msg: string, data?: unknown): void;
    error(msg: string, data?: unknown): void;
  };
}
```

---

## 6. Dashboard Section Plugins

Plugins can contribute dashboard sections as Svelte components:

### 6.1 Component Contract

```svelte
<!-- plugins/example-plugin/components/ExampleMetrics.svelte -->
<script lang="ts">
  import type { DashboardSectionProps } from '@agentforge/plugins-sdk/dashboard';

  let { data, loading, error, refresh }: DashboardSectionProps = $props();
</script>

{#if loading}
  <div class="skeleton" />
{:else if error}
  <div class="error">{error.message}</div>
{:else}
  <div class="metrics-grid">
    <div class="metric">
      <span class="label">Total Sessions</span>
      <span class="value">{data.totalSessions}</span>
    </div>
  </div>
{/if}
```

### 6.2 Loading Mechanism

Dashboard sections from plugins are loaded dynamically at runtime:

1. Host reads plugin manifest's `dashboardSections`
2. Svelte component is compiled at plugin install time (or pre-built by plugin author)
3. Component is served as a JS module from `/api/v5/plugins/{pluginId}/components/{sectionId}.js`
4. Dashboard loads it via dynamic `import()`
5. Component receives data through a standardized `DashboardSectionProps` interface
6. Data is fetched from the plugin's own API routes (not direct DB access)

---

## 7. Security Considerations

1. **No dynamic code generation.** Plugin child processes are started with `--disallow-code-generation-from-strings`. This blocks all forms of dynamic string-to-code execution, preventing injection attacks.
2. **No native addons.** Plugin `node_modules` are installed with `--ignore-scripts` to prevent postinstall exploits.
3. **Rate limiting.** Plugin IPC calls are rate-limited: 1000 calls/second. Exceeding triggers throttle, then disable.
4. **Audit trail.** All plugin actions are logged to workspace `audit_log` table with `resource_type: 'plugin'`.
5. **Version pinning.** Plugin versions are pinned at install time. Updates require explicit `agentforge plugin update`.
6. **Manifest validation.** Manifest is validated against JSON Schema. Unknown fields are rejected. This prevents manifest injection.
