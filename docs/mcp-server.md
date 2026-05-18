# AgentForge MCP Server

The `@agentforge/mcp-server` package exposes three AgentForge tools as an MCP server, making them available to Claude Code, Claude Desktop, and any other MCP-compatible client.

## Tools

### `af_agent_dispatch`

Look up the best AgentForge agent for a set of capability tags. Returns a dispatch handle — does **not** execute anything. Execution stays in the AgentForge runtime.

**Input:**
```json
{
  "capability_tags": ["sqlite", "migrations"]
}
```

**Output:**
```json
{
  "ok": true,
  "data": {
    "agentId": "db-workspace-engineer",
    "ownsSubsystems": ["packages/db/src"],
    "recommendedModel": "sonnet",
    "capabilityTags": ["sqlite", "migrations", "workspace-adapter"]
  },
  "error": null
}
```

Requires `.agentforge/routing-index.json` — run `agentforge team forge` first.

---

### `af_kb_lookup`

Fetch a Knowledge Base document from AgentForge. Calls the local server at `http://localhost:4751` (override with `AGENTFORGE_API_URL`).

**Input:**
```json
{
  "kb_id": "engineering-docs",
  "doc_id": "readme",
  "version": 3
}
```

`doc_id` and `version` are optional. Without `doc_id`, returns KB metadata.

**Output:**
```json
{
  "ok": true,
  "data": {
    "kbId": "engineering-docs",
    "docId": "readme",
    "version": 3,
    "body": "# Engineering Docs\n..."
  },
  "error": null
}
```

---

### `af_memory_query`

Semantic search over AgentForge memory JSONL files (`.agentforge/memory/*.jsonl`). Uses `@agentforge/embeddings` (Xenova/all-MiniLM-L6-v2) with keyword fallback.

**Input:**
```json
{
  "text": "cycle failed test coverage",
  "k": 5
}
```

**Output:**
```json
{
  "ok": true,
  "data": {
    "hits": [
      { "file": "gate-verdict.jsonl", "line": 2, "score": 0.87, "excerpt": "..." }
    ]
  },
  "error": null
}
```

---

## Setup

### Install

```bash
pnpm --filter @agentforge/mcp-server build
```

### Add to Claude Code

In your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "agentforge": {
      "command": "node",
      "args": ["/path/to/agentforge/packages/mcp-server/dist/index.js"],
      "env": {
        "AGENTFORGE_PROJECT_ROOT": "/path/to/your-project",
        "AGENTFORGE_MCP_TOKEN": "your-secret-token"
      }
    }
  }
}
```

### Add to Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentforge": {
      "command": "node",
      "args": ["/path/to/agentforge/packages/mcp-server/dist/index.js"],
      "env": {
        "AGENTFORGE_PROJECT_ROOT": "/path/to/your-project"
      }
    }
  }
}
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AGENTFORGE_PROJECT_ROOT` | `process.cwd()` | Root of the project with `.agentforge/` directory |
| `AGENTFORGE_MCP_TOKEN` | — | Bearer token for auth (omit to disable auth) |
| `AGENTFORGE_API_URL` | `http://localhost:4751` | AgentForge server URL for `af_kb_lookup` |
| `AGENTFORGE_MCP_HTTP` | — | Set to `1` to use HTTP transport instead of stdio |
| `AGENTFORGE_MCP_PORT` | `3741` | HTTP server port (only used when `AGENTFORGE_MCP_HTTP=1`) |

---

## Authentication

When `AGENTFORGE_MCP_TOKEN` is set, all requests must include:

```
Authorization: Bearer <token>
```

Missing or wrong tokens return `401 Unauthorized`. If the env var is not set, auth is disabled (development mode).

---

## MCP SDK

This server uses `@modelcontextprotocol/sdk` (the official Anthropic MCP TypeScript SDK).
