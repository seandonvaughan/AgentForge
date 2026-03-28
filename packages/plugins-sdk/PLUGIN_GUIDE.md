# AgentForge v5 Plugin SDK — Complete Author Guide

This guide covers everything you need to build a production-quality AgentForge plugin: the IPC protocol, manifest schema, lifecycle hooks, skills, the Host API, permissions model, and security boundaries.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Getting Started](#2-getting-started)
3. [Plugin Manifest Reference](#3-plugin-manifest-reference)
4. [Hooks — Reacting to Agent Events](#4-hooks--reacting-to-agent-events)
5. [Skills — Exposing Capabilities to Claude Code](#5-skills--exposing-capabilities-to-claude-code)
6. [Host API — Calling Back into AgentForge](#6-host-api--calling-back-into-agentforge)
7. [Permissions](#7-permissions)
8. [Plugin Lifecycle](#8-plugin-lifecycle)
9. [Security Model](#9-security-model)
10. [Complete Example Plugin](#10-complete-example-plugin)
11. [Testing Your Plugin](#11-testing-your-plugin)
12. [Publishing & Distribution](#12-publishing--distribution)

---

## 1. Overview

### What are Plugins?

AgentForge plugins are isolated Node.js processes that extend the platform without modifying core. They can:

- **Listen to agent events** (invocations, session completions, cost anomalies) via hooks
- **Expose skills** that appear as slash commands in Claude Code
- **Call Host APIs** to list agents, create sessions, emit events, and write logs
- **Store persistent data** in their own SQLite database or use the workspace KV store

### The JSON-RPC 2.0 IPC Protocol

All communication between a plugin and the AgentForge host uses **JSON-RPC 2.0 over stdio**. The plugin process reads newline-delimited JSON from stdin and writes newline-delimited JSON to stdout.

```
Host                                  Plugin
  |---{ jsonrpc:"2.0", method:"plugin.init", params:{id:"my-plugin"} }-->|
  |<--{ jsonrpc:"2.0", method:"plugin.ready" }---------------------------|
  |                                                                       |
  |---{ jsonrpc:"2.0", method:"agent.invoked", params:{...} }----------->|  (hook event)
  |                                                                       |
  |---{ jsonrpc:"2.0", id:1, method:"host.log", params:{...} }---------->|  (skill call)
  |<--{ jsonrpc:"2.0", id:1, result:{sessionId:"..."} }------------------|
```

There are three message types:

| Type | Direction | Has `id`? | Purpose |
|---|---|---|---|
| Request | Host → Plugin or Plugin → Host | Yes | Expects a response |
| Response | Opposite direction | Yes (same as request) | Reply to a request |
| Notification | Either direction | No | Fire-and-forget |

### The Permissions Model

Every plugin declares the permissions it needs in its `plugin.json` manifest. AgentForge enforces these at runtime — if your plugin tries to call a Host API method it hasn't declared permission for, the call will be rejected with a `JsonRpcError`.

Permissions follow the principle of **least privilege**: declare only what your plugin actually uses.

---

## 2. Getting Started

### Prerequisites

- Node.js 20+
- AgentForge v5 running locally (for testing)
- TypeScript (recommended)

### Project Structure

```
my-plugin/
  plugin.json       # Manifest — required
  src/
    index.ts        # Entrypoint — exports the plugin class
  package.json
  tsconfig.json
```

### Install the SDK

```bash
npm install @agentforge/plugins-sdk
```

### Creating a Minimal Plugin

The fastest way to start is to subclass `PluginBase`:

```typescript
// src/index.ts
import { PluginBase } from '@agentforge/plugins-sdk';

class MyPlugin extends PluginBase {
  async onEvent(event: string, data: unknown): Promise<void> {
    // Handle hook events from the host
    if (event === 'agent.invoked') {
      await this.callHost('host.log', {
        level: 'info',
        message: `Agent invoked: ${JSON.stringify(data)}`,
      });
    }
  }
}

// Instantiate — this begins listening on stdin
new MyPlugin();
```

Write the manifest alongside it:

```json
// plugin.json
{
  "id": "my-plugin",
  "name": "My First Plugin",
  "version": "1.0.0",
  "description": "Logs agent invocations",
  "entrypoint": "dist/index.js",
  "permissions": [],
  "hooks": [
    { "event": "agent.invoked", "handler": "onEvent" }
  ],
  "skills": []
}
```

Load the plugin from your AgentForge configuration:

```yaml
# .agentforge/config/plugins.yaml
plugins:
  - manifestPath: ./plugins/my-plugin/plugin.json
```

---

## 3. Plugin Manifest Reference

The `plugin.json` file is the contract between your plugin and the AgentForge host. All fields except `author` are required.

```json
{
  "id": "string",
  "name": "string",
  "version": "string",
  "description": "string",
  "entrypoint": "string",
  "permissions": ["string"],
  "hooks": [{ "event": "string", "handler": "string" }],
  "skills": [{ "name": "string", "description": "string", "handler": "string" }],
  "author": "string"
}
```

### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique plugin identifier. Must be globally unique within the workspace. Use kebab-case (e.g. `"cost-alerter"`). |
| `name` | `string` | Yes | Human-readable name displayed in the dashboard. |
| `version` | `string` | Yes | SemVer string (e.g. `"1.2.3"`). |
| `description` | `string` | Yes | Short description of what the plugin does. |
| `entrypoint` | `string` | Yes | Path to the compiled JS entrypoint, relative to the directory containing `plugin.json`. |
| `permissions` | `string[]` | Yes | Array of permission strings the plugin needs. See [Permissions](#7-permissions). |
| `hooks` | `PluginHook[]` | Yes | Array of event hooks the plugin subscribes to. |
| `skills` | `PluginSkill[]` | Yes | Array of skills the plugin exposes to Claude Code. |
| `author` | `string` | No | Optional attribution string. |

### PluginHook

```json
{ "event": "agent.invoked", "handler": "onAgentInvoked" }
```

| Field | Description |
|---|---|
| `event` | The AgentForge event name to subscribe to. See [Hooks](#4-hooks--reacting-to-agent-events) for the full event taxonomy. |
| `handler` | The method name that will be called on your plugin instance when this event fires. The host sends a JSON-RPC notification with `method` set to `event`. |

### PluginSkill

```json
{ "name": "search-docs", "description": "Search the project documentation", "handler": "handleSearch" }
```

| Field | Description |
|---|---|
| `name` | Skill identifier. Becomes the slash command `/search-docs` in Claude Code. Must be kebab-case. |
| `description` | Used by Claude Code to decide when to invoke the skill. Write this as a clear, action-oriented sentence. |
| `handler` | The JSON-RPC method name the host will call when Claude Code invokes the skill. |

---

## 4. Hooks — Reacting to Agent Events

Hooks let your plugin respond to events that happen inside AgentForge. When a hook event fires, the host sends a JSON-RPC notification to your plugin's stdin. Your `onEvent` method receives the event name and the payload.

### Event Taxonomy

| Event | Category | Payload Shape | When it fires |
|---|---|---|---|
| `agent.invoked` | lifecycle | `{ agentId, task, model }` | An agent receives a new task |
| `session.started` | lifecycle | `{ sessionId, agentId, task }` | A session begins execution |
| `session.completed` | lifecycle | `{ sessionId, agentId, costUsd, durationMs }` | A session finishes successfully |
| `session.failed` | lifecycle | `{ sessionId, agentId, error }` | A session ends in failure |
| `cost.anomaly` | cost | `{ agentId, amount, threshold }` | A session's cost exceeds the anomaly threshold |
| `cost.budget.warning` | cost | `{ workspaceId, spentUsd, budgetUsd }` | Workspace budget is nearing its limit |
| `agent.promotion.proposed` | team | `{ agentId, fromTier, toTier }` | A promotion/demotion proposal is created |
| `plugin.event` | plugin | `{ pluginId, eventType, data }` | Another plugin emitted a cross-plugin event |

### Registering Hooks

Declare hooks in the manifest then implement them in `onEvent`:

```typescript
import { PluginBase } from '@agentforge/plugins-sdk';

class CostMonitor extends PluginBase {
  async onEvent(event: string, data: unknown): Promise<void> {
    switch (event) {
      case 'session.completed': {
        const { sessionId, costUsd } = data as { sessionId: string; costUsd: number };
        if (costUsd > 1.0) {
          await this.callHost('host.log', {
            level: 'warn',
            message: `High-cost session: ${sessionId} cost $${costUsd.toFixed(4)}`,
          });
        }
        break;
      }

      case 'cost.anomaly': {
        const { agentId, amount } = data as { agentId: string; amount: number };
        await this.callHost('host.emit', {
          event: 'plugin.alert',
          data: { source: 'cost-monitor', agentId, amount },
        });
        break;
      }

      case 'plugin.init': {
        // Sent by host on startup — signal ready
        this.notify('plugin.ready');
        break;
      }
    }
  }
}

new CostMonitor();
```

### The `plugin.init` Event

When the host starts your plugin it sends `plugin.init` as the very first message. Your plugin **must** respond with `plugin.ready` (a notification) within 10 seconds or the host will kill the process and mark the plugin as `error`.

`PluginBase` handles `plugin.init` / `plugin.ready` for you automatically when you call `this.notify('plugin.ready')` inside your `onEvent` switch.

---

## 5. Skills — Exposing Capabilities to Claude Code

Skills turn your plugin into a first-class Claude Code extension. A skill appears as a slash command that Claude Code can invoke during an agentic session.

### Declaring a Skill

In `plugin.json`:

```json
{
  "skills": [
    {
      "name": "summarize-session",
      "description": "Summarize the results of a completed AgentForge session given its session ID",
      "handler": "summarizeSession"
    }
  ]
}
```

### Handling a Skill Call

The host sends a JSON-RPC **request** (with an `id`) to your plugin's stdin. You must reply with a JSON-RPC response on stdout.

```typescript
import { PluginBase } from '@agentforge/plugins-sdk';
import type { JsonRpcRequest } from '@agentforge/plugins-sdk';

class SessionSummarizer extends PluginBase {
  async onEvent(event: string, data: unknown): Promise<void> {
    if (event === 'plugin.init') {
      this.notify('plugin.ready');
      return;
    }

    if (event === 'summarizeSession') {
      const { sessionId } = data as { sessionId: string };
      // Do work, then send result back via notify (the host correlates by id)
      const summary = await this.buildSummary(sessionId);
      this.notify('plugin.result', { summary });
    }
  }

  private async buildSummary(sessionId: string): Promise<string> {
    // Query host APIs, read files, etc.
    return `Session ${sessionId} completed successfully.`;
  }
}

new SessionSummarizer();
```

### Skill Design Tips

- Write `description` as a complete sentence explaining what the skill does and when Claude Code should call it.
- Skills should be **idempotent** where possible.
- Return structured JSON results so Claude Code can parse them programmatically.
- Keep skill execution under 30 seconds. For long-running work, return a job ID and expose a `check-status` skill.

---

## 6. Host API — Calling Back into AgentForge

Your plugin communicates back to the host by calling Host API methods via `this.callHost(method, params)`. The host handles these as JSON-RPC requests (it sends the response back over stdin).

### Available Methods

#### `host.agent.list`

Returns all agents in the current workspace.

```typescript
const agents = await this.callHost<Array<{ id: string; name: string; model: string }>>('host.agent.list');
// agents = [{ id: 'coder', name: 'Coder', model: 'sonnet' }, ...]
```

**Required permission:** `agent:invoke` (read-only list)

---

#### `host.session.create`

Create a new agent session programmatically.

```typescript
const { sessionId } = await this.callHost<{ sessionId: string }>('host.session.create', {
  agentId: 'coder',
  task: 'Write tests for the authentication module',
});
```

**Required permission:** `agent:invoke`

---

#### `host.log`

Write a structured log entry to the AgentForge log stream.

```typescript
await this.callHost('host.log', {
  level: 'info',   // 'info' | 'warn' | 'error'
  message: 'Plugin successfully processed session completion',
});
```

**Required permission:** None (always available)

---

#### `host.emit`

Broadcast an event to the AgentForge message bus. Other plugins can subscribe to these events.

```typescript
await this.callHost('host.emit', {
  event: 'plugin.my-plugin.alert',
  data: { severity: 'high', detail: 'Cost anomaly detected' },
});
```

**Required permission:** None (always available)

### The `notify` Method

For fire-and-forget messages where you do not need a response, use `this.notify(method, params)`:

```typescript
// Send without waiting for confirmation
this.notify('plugin.ready');
this.notify('plugin.log', { level: 'debug', message: 'Processing hook event' });
```

---

## 7. Permissions

The `permissions` array in your manifest gates access to sensitive operations. AgentForge checks permissions at the IPC boundary — if a call is denied, it returns a JSON-RPC error with code `-32601` (Method not found).

### Permission Reference

| Permission | What it grants |
|---|---|
| `filesystem:read` | Read files from the workspace directory |
| `filesystem:write` | Write or delete files in the workspace directory |
| `network` | Make outbound HTTP/HTTPS requests |
| `agent:invoke` | Call `host.agent.list` and `host.session.create` |
| `db:read` | Read from workspace SQLite databases |
| `db:write` | Write to workspace SQLite databases |

### Principle of Least Privilege

Only declare the permissions your plugin genuinely needs. The AgentForge dashboard surfaces each plugin's declared permissions so workspace owners can audit them before installation.

**Good:** A cost monitoring plugin that only logs alerts needs no permissions at all — `host.log` and `host.emit` are always available.

**Bad:** Requesting `filesystem:write` and `db:write` when your plugin only reads data.

### Example Manifest with Permissions

```json
{
  "id": "session-archiver",
  "name": "Session Archiver",
  "version": "1.0.0",
  "description": "Archives completed sessions to a local SQLite database",
  "entrypoint": "dist/index.js",
  "permissions": ["db:write", "filesystem:read"],
  "hooks": [
    { "event": "session.completed", "handler": "onSessionCompleted" }
  ],
  "skills": []
}
```

---

## 8. Plugin Lifecycle

A plugin moves through five states during its lifetime:

```
stopped → starting → running → stopping → stopped
                ↓
              error
```

### State Descriptions

| State | Description |
|---|---|
| `stopped` | Initial state. The process has not been started yet, or has cleanly exited. |
| `starting` | `PluginHost.start()` has been called. The child process is spawning and the host is waiting for `plugin.ready`. |
| `running` | The plugin sent `plugin.ready` and is fully operational. |
| `stopping` | `PluginHost.stop()` sent `SIGTERM`. The host is waiting for the process to exit. |
| `error` | The process exited with a non-zero code or timed out during startup. The `errorMessage` field on the instance will contain the reason. |

### Startup Sequence

1. Host calls `PluginHost.load(manifestPath)` — reads and validates `plugin.json`, sets status to `stopped`.
2. Host calls `PluginHost.start(pluginId, entrypointDir)` — forks the child process, sets status to `starting`.
3. Host sends `plugin.init` notification via IPC.
4. Plugin receives `plugin.init`, initializes itself, then sends `plugin.ready`.
5. Host receives `plugin.ready`, sets status to `running`.

If the plugin does not send `plugin.ready` within 10 seconds, the host rejects the start promise with `"Plugin start timeout"` and the process is killed.

### Shutdown Sequence

1. Host calls `PluginHost.stop(pluginId)`.
2. Host sets status to `stopping` and sends `SIGTERM` to the child process.
3. Plugin should handle `SIGTERM`, flush any pending state, and exit cleanly.
4. Host waits for the process `exit` event and resolves the stop promise.

### Error Handling in Your Plugin

Uncaught exceptions in your plugin are caught by `PluginBase` and reported to the host via a `plugin.error` notification:

```typescript
// PluginBase does this automatically:
process.on('uncaughtException', (err) => {
  this.notify('plugin.error', { type: 'uncaughtException', message: err.message });
});
```

For recoverable errors inside `onEvent`, catch them yourself and log via `host.log`:

```typescript
async onEvent(event: string, data: unknown): Promise<void> {
  try {
    await this.handleEvent(event, data);
  } catch (err) {
    await this.callHost('host.log', {
      level: 'error',
      message: `Plugin error handling ${event}: ${(err as Error).message}`,
    });
  }
}
```

---

## 9. Security Model

### Why `child_process.fork`?

AgentForge uses `child_process.fork()` to run plugins in isolated Node.js child processes. This means:

- **Separate memory space:** A plugin bug cannot corrupt the host's heap.
- **Separate event loop:** A plugin that blocks will not freeze the host.
- **Crash isolation:** If the plugin process crashes, the host catches the `exit` event and marks the plugin as `error`. The host continues running normally.
- **IPC is the only channel:** Plugins cannot import host internals or call host functions directly. All communication goes through the JSON-RPC pipe.

### What Is Sandboxed

- Plugin code runs in a completely separate Node.js process.
- The host strips its own environment before passing `env` to the fork (only `AGENTFORGE_PLUGIN=1` and `PLUGIN_ID` are injected).
- Plugins that do not declare `filesystem:read` should not be able to read arbitrary files — though note that Node.js itself is not hermetically sandboxed (the plugin process can still spawn subprocesses, read files, etc. at the OS level). The `filesystem:read` permission is an **application-level** guard, not a kernel-level one.

### What Is NOT Sandboxed

AgentForge v5 does not use a seccomp/jail/container sandbox. A malicious plugin can:

- Read files the plugin process user has access to.
- Make network requests regardless of the `network` permission (again, this is an application-level check).
- Spawn child processes of its own.

**Only install plugins from authors you trust.** The permissions model provides audit transparency, not kernel-level enforcement.

### Plugin Environment Variables

The host injects these into the plugin process environment:

| Variable | Value |
|---|---|
| `AGENTFORGE_PLUGIN` | `"1"` — tells the plugin it is running inside AgentForge |
| `PLUGIN_ID` | The plugin's `id` from the manifest |

All other environment variables from the parent process are passed through. Do not rely on host-internal environment variables being present.

---

## 10. Complete Example Plugin

This plugin listens for every agent invocation and records it to a local log file. It demonstrates: hooks, the Host API, error handling, and the full lifecycle.

### `plugin.json`

```json
{
  "id": "invocation-logger",
  "name": "Invocation Logger",
  "version": "1.0.0",
  "description": "Records all agent invocations to a timestamped NDJSON log file",
  "entrypoint": "dist/index.js",
  "permissions": ["filesystem:write"],
  "hooks": [
    { "event": "agent.invoked", "handler": "onAgentInvoked" },
    { "event": "session.completed", "handler": "onSessionCompleted" },
    { "event": "session.failed", "handler": "onSessionFailed" }
  ],
  "skills": [
    {
      "name": "invocation-stats",
      "description": "Return a summary of agent invocation counts from the current session",
      "handler": "getStats"
    }
  ],
  "author": "AgentForge Team"
}
```

### `src/index.ts`

```typescript
import { PluginBase } from '@agentforge/plugins-sdk';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

interface InvocationRecord {
  timestamp: string;
  event: string;
  agentId?: string;
  sessionId?: string;
  task?: string;
  costUsd?: number;
}

class InvocationLogger extends PluginBase {
  private logPath: string;
  private counts: Map<string, number> = new Map();

  constructor() {
    super();
    this.logPath = join(process.cwd(), 'invocation-logger.ndjson');
  }

  async onEvent(event: string, data: unknown): Promise<void> {
    try {
      switch (event) {
        case 'plugin.init':
          // Signal that we are ready to receive events
          this.notify('plugin.ready');
          await this.callHost('host.log', {
            level: 'info',
            message: 'Invocation Logger started',
          });
          break;

        case 'agent.invoked':
          await this.onAgentInvoked(data as { agentId: string; task: string });
          break;

        case 'session.completed':
          await this.onSessionCompleted(
            data as { sessionId: string; agentId: string; costUsd: number },
          );
          break;

        case 'session.failed':
          await this.onSessionFailed(
            data as { sessionId: string; agentId: string; error: string },
          );
          break;

        case 'getStats':
          this.handleGetStats();
          break;

        default:
          // Unknown events are silently ignored
          break;
      }
    } catch (err) {
      // Log errors back to host without crashing
      await this.callHost('host.log', {
        level: 'error',
        message: `InvocationLogger error in '${event}': ${(err as Error).message}`,
      });
    }
  }

  private async onAgentInvoked(data: { agentId: string; task: string }): Promise<void> {
    const record: InvocationRecord = {
      timestamp: new Date().toISOString(),
      event: 'agent.invoked',
      agentId: data.agentId,
      task: data.task,
    };
    this.writeRecord(record);

    // Increment invocation counter for this agent
    const current = this.counts.get(data.agentId) ?? 0;
    this.counts.set(data.agentId, current + 1);

    await this.callHost('host.log', {
      level: 'info',
      message: `[invocation-logger] ${data.agentId} invoked (total: ${current + 1})`,
    });
  }

  private async onSessionCompleted(data: {
    sessionId: string;
    agentId: string;
    costUsd: number;
  }): Promise<void> {
    const record: InvocationRecord = {
      timestamp: new Date().toISOString(),
      event: 'session.completed',
      agentId: data.agentId,
      sessionId: data.sessionId,
      costUsd: data.costUsd,
    };
    this.writeRecord(record);
  }

  private async onSessionFailed(data: {
    sessionId: string;
    agentId: string;
    error: string;
  }): Promise<void> {
    const record: InvocationRecord = {
      timestamp: new Date().toISOString(),
      event: 'session.failed',
      agentId: data.agentId,
      sessionId: data.sessionId,
    };
    this.writeRecord(record);

    // Emit a cross-plugin alert so other plugins (e.g. an alerter) can act
    await this.callHost('host.emit', {
      event: 'plugin.invocation-logger.session-failed',
      data: { agentId: data.agentId, sessionId: data.sessionId, error: data.error },
    });
  }

  private handleGetStats(): void {
    const stats: Record<string, number> = {};
    for (const [agentId, count] of this.counts) {
      stats[agentId] = count;
    }
    // Return via notification — host reads this as the skill result
    this.notify('plugin.result', { stats, totalInvocations: [...this.counts.values()].reduce((a, b) => a + b, 0) });
  }

  private writeRecord(record: InvocationRecord): void {
    try {
      appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      // If we can't write (permissions issue, disk full, etc.) log to host
      void this.callHost('host.log', {
        level: 'error',
        message: `Failed to write log: ${(err as Error).message}`,
      });
    }
  }
}

// Instantiate — PluginBase wires stdin/stdout automatically
new InvocationLogger();
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

### `package.json`

```json
{
  "name": "agentforge-plugin-invocation-logger",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@agentforge/plugins-sdk": "^5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

---

## 11. Testing Your Plugin

### Unit Testing Hook Logic

Extract your business logic into pure functions so you can test them without spawning processes:

```typescript
// src/invocation-counter.ts (extracted logic)
export function incrementCount(counts: Map<string, number>, agentId: string): number {
  const next = (counts.get(agentId) ?? 0) + 1;
  counts.set(agentId, next);
  return next;
}
```

```typescript
// tests/invocation-counter.test.ts
import { describe, it, expect } from 'vitest';
import { incrementCount } from '../src/invocation-counter.js';

describe('incrementCount', () => {
  it('starts at 1 for a new agent', () => {
    const counts = new Map<string, number>();
    expect(incrementCount(counts, 'coder')).toBe(1);
  });

  it('increments on subsequent calls', () => {
    const counts = new Map<string, number>();
    incrementCount(counts, 'coder');
    expect(incrementCount(counts, 'coder')).toBe(2);
  });
});
```

### Integration Testing with a Mock Host

For integration tests, create a mock host that speaks the same JSON-RPC protocol:

```typescript
// tests/helpers/mock-host.ts
import { fork } from 'node:child_process';

export async function startPlugin(entrypoint: string) {
  const child = fork(entrypoint, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, AGENTFORGE_PLUGIN: '1', PLUGIN_ID: 'test-plugin' },
  });

  // Wait for plugin.ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.method === 'plugin.ready') {
          clearTimeout(timeout);
          resolve();
        }
      }
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'plugin.init', params: { id: 'test-plugin' } }) + '\n');
  });

  return child;
}
```

---

## 12. Publishing & Distribution

### Naming Convention

Plugin packages should follow the pattern:

```
agentforge-plugin-{name}
```

Example: `agentforge-plugin-cost-alerts`, `agentforge-plugin-github-notifier`.

### Distribution via npm

```bash
npm publish --access public
```

Workspace owners install via:

```bash
npm install agentforge-plugin-cost-alerts
```

Then point the manifest at the installed package:

```yaml
# .agentforge/config/plugins.yaml
plugins:
  - manifestPath: ./node_modules/agentforge-plugin-cost-alerts/plugin.json
```

### Security Checklist Before Publishing

- [ ] Permissions list is minimal — only what the plugin actually uses
- [ ] No hardcoded secrets, API keys, or workspace-specific configuration
- [ ] All user-supplied data is validated before use
- [ ] The `onEvent` handler wraps all logic in try/catch so the plugin never crashes silently
- [ ] `plugin.ready` is always sent in response to `plugin.init`
- [ ] The plugin handles `SIGTERM` gracefully (flush state, close file handles)
- [ ] README includes a permissions explanation and a security contact

---

*This guide covers AgentForge v5. For the full API reference, see the [TypeScript source](src/types.ts).*
