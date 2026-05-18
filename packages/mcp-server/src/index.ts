#!/usr/bin/env node
/**
 * AgentForge MCP Server
 *
 * Exposes three tools to MCP clients (Claude Code, Claude Desktop, etc.):
 *   - af_agent_dispatch   — look up the best agent for given capability tags
 *   - af_kb_lookup        — fetch a Knowledge Base document
 *   - af_memory_query     — semantic search over AgentForge memory JSONL files
 *
 * Transport: stdio (default) or HTTP (set AGENTFORGE_MCP_HTTP=1).
 * Auth:      bearer token from AGENTFORGE_MCP_TOKEN (optional).
 *
 * Usage:
 *   node dist/index.js                         # stdio
 *   AGENTFORGE_MCP_HTTP=1 node dist/index.js  # HTTP on port 3741
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';

import { validateToken, extractBearer } from './auth.js';
import { afAgentDispatch } from './tools/af-agent-dispatch.js';
import { afKbLookup } from './tools/af-kb-lookup.js';
import { afMemoryQuery } from './tools/af-memory-query.js';

const PROJECT_ROOT = process.env['AGENTFORGE_PROJECT_ROOT'] ?? process.cwd();

// ---------------------------------------------------------------------------
// Build and register the MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'agentforge',
  version: '10.5.1',
});

// Tool: af_agent_dispatch
server.tool(
  'af_agent_dispatch',
  'Look up the best AgentForge agent for a set of capability tags. ' +
    'Returns a dispatch handle (agentId, model, subsystems) — does NOT execute anything.',
  {
    capability_tags: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(20)
      .describe('One or more capability tags to match against the routing index'),
  },
  async ({ capability_tags }) => {
    const result = afAgentDispatch({ capability_tags }, PROJECT_ROOT);
    if (!result.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// Tool: af_kb_lookup
server.tool(
  'af_kb_lookup',
  'Fetch a Knowledge Base document from AgentForge. ' +
    'Calls the local AgentForge server API (/api/v5/kbs/*). ' +
    'Provide kb_id (required), doc_id (optional), and version (optional).',
  {
    kb_id: z.string().min(1).max(63).describe('KB slug (lowercase alphanum + dashes)'),
    doc_id: z
      .string()
      .min(1)
      .max(63)
      .optional()
      .describe('Document slug within the KB (optional)'),
    version: z.number().int().positive().optional().describe('Specific version number (optional)'),
  },
  async ({ kb_id, doc_id, version }) => {
    const result = await afKbLookup({ kb_id, doc_id, version });
    if (!result.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// Tool: af_memory_query
server.tool(
  'af_memory_query',
  'Semantic search over AgentForge memory JSONL files ' +
    '(.agentforge/memory/*.jsonl). Returns the top-k most relevant records.',
  {
    text: z.string().min(1).max(1024).describe('Free-text search query'),
    k: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(5)
      .describe('Number of results to return (default: 5)'),
  },
  async ({ text, k }) => {
    const result = await afMemoryQuery({ text, k: k ?? 5 }, PROJECT_ROOT);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env['AGENTFORGE_MCP_HTTP'] === '1') {
    // HTTP transport — stateless mode (no session management)
    const port = parseInt(process.env['AGENTFORGE_MCP_PORT'] ?? '3741', 10);

    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Bearer token auth check
      const token = extractBearer(req.headers['authorization']);
      const auth = validateToken(token);
      if (!auth.ok) {
        res.writeHead(auth.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: auth.message }));
        return;
      }

      // Create a per-request stateless transport (sessionIdGenerator omitted → stateless)
      const transport = new StreamableHTTPServerTransport();

      // Cast needed because exactOptionalPropertyTypes exposes a setter/getter
      // mismatch in the SDK's Transport interface under strict mode.
      server.connect(transport as unknown as Transport).then(() => {
        return transport.handleRequest(req, res);
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: msg }));
        }
      });
    });

    httpServer.listen(port, () => {
      process.stderr.write(`[agentforge-mcp] HTTP server listening on port ${port}\n`);
    });
  } else {
    // Stdio transport (default — used by Claude Code / Claude Desktop)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('[agentforge-mcp] stdio transport ready\n');
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[agentforge-mcp] fatal: ${msg}\n`);
  process.exit(1);
});
