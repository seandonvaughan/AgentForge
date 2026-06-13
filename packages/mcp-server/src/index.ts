#!/usr/bin/env node
/**
 * AgentForge MCP Server
 *
 * Exposes three tools to MCP clients (Claude Code, Claude Desktop, etc.):
 *   - af_agent_dispatch       — look up the best agent for given capability tags
 *   - af_kb_lookup            — fetch a Knowledge Base document
 *   - af_memory_query         — semantic search over AgentForge memory JSONL files
 *   - af_codex_readiness      — inspect Codex runtime readiness
 *   - af_cycle_preview        — preview a cycle without starting one
 *   - af_cycle_status         — list/show recorded cycle state
 *   - af_epic_decomposition   — child DAG summary of an objective cycle
 *   - af_epic_review          — epic judgment verdict for an objective cycle
 *   - af_spend_report         — planned-vs-actual spend for a cycle
 *   - af_agent_memory         — an agent's personal W2 memory, newest first
 *   - af_objective_preview    — sizing math + the exact CLI preview command
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
import {
  afAgentInvoke,
  afCodexReadiness,
  afCycleEvents,
  afCyclePreview,
  afCycleStatus,
} from './tools/af-codex-workflows.js';
import { afKbLookup } from './tools/af-kb-lookup.js';
import { afMemoryQuery } from './tools/af-memory-query.js';
import { afKbSearch } from './tools/af-kb-search.js';
import { afAgentMemory } from './tools/af-agent-memory.js';
import {
  afEpicDecomposition,
  afEpicReview,
  afObjectivePreview,
  afSpendReport,
} from './tools/af-objective-cycle.js';

const PROJECT_ROOT = process.env['AGENTFORGE_PROJECT_ROOT'] ?? process.cwd();

// ---------------------------------------------------------------------------
// Build and register the MCP server
// ---------------------------------------------------------------------------

const server = new McpServer(
  {
    name: 'agentforge',
    version: '10.5.1',
  },
  {
    instructions:
      'AgentForge MCP server. Drive objective (epic) cycles end-to-end from this session: ' +
      'size an objective with af_objective_preview (pure math + the exact CLI command — no LLM spend), ' +
      'inspect a running/completed cycle with af_cycle_status and af_cycle_events, ' +
      'read the child DAG with af_epic_decomposition, the judgment verdict with af_epic_review, ' +
      'and the planned-vs-actual spend with af_spend_report. ' +
      'Per-agent W2 memory is available via af_agent_memory; shared memory and knowledge via ' +
      'af_memory_query, af_kb_search, and af_kb_lookup. af_agent_invoke dispatches one forged ' +
      'agent under a hard budget cap.',
  },
);

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

// Tool: af_kb_search
server.tool(
  'af_kb_search',
  'Keyword search over the AgentForge knowledge base notes ' +
    '(.agentforge/knowledge/entities.jsonl — accumulated review/audit/learn findings). Read-only.',
  {
    query: z.string().min(1).max(1024).describe('Free-text search query'),
    k: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(5)
      .describe('Number of results to return (default: 5)'),
  },
  async ({ query, k }) => {
    const result = afKbSearch({ query, k: k ?? 5 }, PROJECT_ROOT);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// Tool: af_agent_invoke
server.tool(
  'af_agent_invoke',
  'Dispatch ONE forged AgentForge agent with a hard budget cap (USD, ≤25, required). ' +
    'Write-capable: the agent may modify the project per its tool hints. ' +
    'Wraps `agentforge run invoke`.',
  {
    agentId: z.string().min(1).max(64).describe('Forged agent id (e.g. coder, epic-planner)'),
    task: z.string().min(8).max(16384).describe('Task description for the agent'),
    budgetUsd: z.number().positive().max(25).describe('Hard spend cap in USD (required)'),
    tools: z.array(z.string().min(1).max(64)).max(16).optional().describe('Allowed tool hints (e.g. Read, Glob, Grep)'),
  },
  async ({ agentId, task, budgetUsd, tools }) => {
    const result = await afAgentInvoke(
      { agentId, task, budgetUsd, ...(tools !== undefined ? { tools } : {}) },
      PROJECT_ROOT,
    );
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// Tool: af_cycle_events
server.tool(
  'af_cycle_events',
  'Incremental tail of a running/completed cycle\'s events.jsonl. ' +
    'Pass the returned nextCursor on subsequent calls to read only new events. Read-only.',
  {
    cycleId: z.string().min(8).max(64).describe('Cycle id (.agentforge/cycles/<id>)'),
    cursor: z.number().int().min(0).optional().default(0).describe('Byte offset from the previous call (0 = start)'),
    limit: z.number().int().min(1).max(500).optional().default(100).describe('Max events per page'),
  },
  async ({ cycleId, cursor, limit }) => {
    const result = afCycleEvents({ cycleId, cursor: cursor ?? 0, limit: limit ?? 100 }, PROJECT_ROOT);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

// Tool: af_codex_readiness
server.tool(
  'af_codex_readiness',
  'Return the same AgentForge Codex readiness report as `agentforge codex readiness --json`. ' +
    'Read-only; optionally provide projectRoot, skipLogin, and includeDoctor diagnostics.',
  {
    projectRoot: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe('Project root to inspect (defaults to AGENTFORGE_PROJECT_ROOT or current working directory)'),
    skipLogin: z
      .boolean()
      .optional()
      .default(false)
      .describe('Skip `codex login status` check'),
    includeDoctor: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include `codex doctor --json` diagnostics; omitted by default because doctor can be slower'),
  },
  async ({ projectRoot, skipLogin, includeDoctor }) => {
    const result = await afCodexReadiness(
      { projectRoot, skipLogin: skipLogin ?? false, includeDoctor: includeDoctor ?? false },
      PROJECT_ROOT,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

// Tool: af_cycle_preview
server.tool(
  'af_cycle_preview',
  'Run the AgentForge cycle preview without starting a cycle. With `objective`, ' +
    'rehearses the epic decomposition (planner + deterministic validation, one ' +
    'LLM call ~\$5) and returns the children/waves/budget-band JSON. Never executes.',
  {
    projectRoot: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe('Project root to inspect (defaults to AGENTFORGE_PROJECT_ROOT or current working directory)'),
    budgetUsd: z.number().positive().optional().describe('Preview-only budget override'),
    maxItems: z.number().int().positive().optional().describe('Preview-only max item override (ignored in objective mode)'),
    objective: z
      .string()
      .min(8)
      .max(8192)
      .optional()
      .describe('Epic objective to decompose (rehearsal only — no cycle, no git, no execution)'),
  },
  async ({ projectRoot, budgetUsd, maxItems, objective }) => {
    const result = await afCyclePreview({ projectRoot, budgetUsd, maxItems, objective }, PROJECT_ROOT);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

// Tool: af_cycle_status
server.tool(
  'af_cycle_status',
  'Inspect recorded AgentForge cycle state from .agentforge/cycles. ' +
    'Read-only; provide cycleId to show one cycle or omit it to list recent cycles.',
  {
    projectRoot: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe('Project root to inspect (defaults to AGENTFORGE_PROJECT_ROOT or current working directory)'),
    cycleId: z
      .string()
      .min(8)
      .max(64)
      .optional()
      .describe('Cycle id to inspect; omit to list cycles'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(20)
      .describe('Maximum cycles to return when listing'),
  },
  async ({ projectRoot, cycleId, limit }) => {
    const result = afCycleStatus({ projectRoot, cycleId, limit: limit ?? 20 }, PROJECT_ROOT);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

// Tool: af_epic_decomposition
server.tool(
  'af_epic_decomposition',
  'Read an objective cycle\'s epic decomposition (.agentforge/cycles/<id>/decomposition.json). ' +
    'Returns the child DAG summary (id/title/files/estimatedCostUsd/wave/predecessors) ' +
    'plus the validation-report budget block. Read-only.',
  {
    cycleId: z.string().min(8).max(64).describe('Cycle id (.agentforge/cycles/<id>)'),
  },
  async ({ cycleId }) => {
    const result = afEpicDecomposition({ cycleId }, PROJECT_ROOT);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

// Tool: af_epic_review
server.tool(
  'af_epic_review',
  'Read an objective cycle\'s epic-review verdict ' +
    '(.agentforge/cycles/<id>/phases/epic-review.json): verdict, rationale, ' +
    'faultedItems, triageUsed, costUsd. Read-only.',
  {
    cycleId: z.string().min(8).max(64).describe('Cycle id (.agentforge/cycles/<id>)'),
  },
  async ({ cycleId }) => {
    const result = afEpicReview({ cycleId }, PROJECT_ROOT);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

// Tool: af_spend_report
server.tool(
  'af_spend_report',
  'Read a cycle\'s planned-vs-actual spend report ' +
    '(.agentforge/cycles/<id>/spend-report.json) plus a compact totals line. Read-only.',
  {
    cycleId: z.string().min(8).max(64).describe('Cycle id (.agentforge/cycles/<id>)'),
  },
  async ({ cycleId }) => {
    const result = afSpendReport({ cycleId }, PROJECT_ROOT);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

// Tool: af_agent_memory
server.tool(
  'af_agent_memory',
  'Read an agent\'s personal W2 memory ' +
    '(.agentforge/memory/agents/<agentId>.jsonl), newest first. Read-only.',
  {
    agentId: z.string().min(1).max(64).describe('Forged agent id (e.g. coder, epic-planner)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe('Maximum entries to return (default: 10)'),
  },
  async ({ agentId, limit }) => {
    const result = afAgentMemory({ agentId, ...(limit !== undefined ? { limit } : {}) }, PROJECT_ROOT);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

// Tool: af_objective_preview
server.tool(
  'af_objective_preview',
  'Size an objective cycle WITHOUT spending anything: returns the exact ' +
    '`agentforge cycle preview --objective … --budget-usd …` command to run, plus the ' +
    'spendable/band math (spendable=(budget−6)/1.2, band 0.7–1.0×). Pure function — ' +
    'never spawns LLM work from MCP.',
  {
    objective: z.string().min(8).max(8192).describe('Epic objective text to decompose'),
    budgetUsd: z.number().positive().optional().describe('Planned cycle budget in USD (optional)'),
  },
  async ({ objective, budgetUsd }) => {
    const result = afObjectivePreview({ objective, ...(budgetUsd !== undefined ? { budgetUsd } : {}) });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
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
