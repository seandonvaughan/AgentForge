/**
 * OpenAPI 3.1 spec served at GET /api/v6/openapi.json
 *
 * Describes all /api/v6/ endpoints with their HTTP method, path, and a
 * short human-readable description.  Full request/response schemas are
 * intentionally omitted to keep this file maintainable — add them as needed.
 */

import type { FastifyInstance } from 'fastify';

// ── Endpoint catalogue ────────────────────────────────────────────────────────

interface PathItem {
  [method: string]: {
    summary: string;
    description?: string;
    tags?: string[];
    parameters?: Array<{
      name: string;
      in: 'path' | 'query' | 'header';
      required?: boolean;
      schema: { type: string };
      description?: string;
    }>;
    deprecated?: boolean;
    responses: {
      [status: string]: { description: string };
    };
  };
}

const paths: Record<string, PathItem> = {
  // ── Health ──────────────────────────────────────────────────────────────────
  '/api/v6/health': {
    get: {
      tags: ['System'],
      summary: 'v6 health check',
      description: 'Returns server status, API version, and workspace context.',
      responses: {
        '200': { description: 'Server is healthy.' },
      },
    },
  },
  '/api/v6/health/services': {
    get: {
      tags: ['System'],
      summary: 'Per-service circuit-breaker status',
      description: 'Returns the health state of individual backend services.',
      responses: {
        '200': { description: 'Service health matrix.' },
      },
    },
  },

  // ── Workspaces ──────────────────────────────────────────────────────────────
  '/api/v6/workspaces': {
    get: {
      tags: ['Workspaces'],
      summary: 'List registered workspaces',
      responses: {
        '200': { description: 'Array of workspace descriptors.' },
      },
    },
  },
  '/api/v6/workspaces/compare': {
    get: {
      tags: ['Workspaces'],
      summary: 'Compare metrics across workspaces',
      responses: {
        '200': { description: 'Comparative cost and session data.' },
      },
    },
  },
  '/api/v6/workspaces/summary': {
    get: {
      tags: ['Workspaces'],
      summary: 'Aggregated workspace summary',
      responses: {
        '200': { description: 'Cross-workspace aggregation.' },
      },
    },
  },

  // ── Sessions ────────────────────────────────────────────────────────────────
  '/api/v6/sessions': {
    get: {
      tags: ['Sessions'],
      summary: 'List sessions',
      description: 'Supports limit, offset, agentId and status query params.',
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Max results (default 50, max 500).' },
        { name: 'offset', in: 'query', schema: { type: 'integer' }, description: 'Pagination offset.' },
        { name: 'agentId', in: 'query', schema: { type: 'string' }, description: 'Filter by agent ID.' },
        { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Filter by session status.' },
      ],
      responses: {
        '200': { description: 'Paginated session list.' },
      },
    },
  },
  '/api/v6/sessions/{id}': {
    get: {
      tags: ['Sessions'],
      summary: 'Get session by ID',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'Session object.' },
        '404': { description: 'Session not found.' },
      },
    },
  },

  // ── Costs ───────────────────────────────────────────────────────────────────
  '/api/v6/costs': {
    get: {
      tags: ['Costs'],
      summary: 'List all cost records',
      responses: {
        '200': { description: 'Cost records with workspace total.' },
      },
    },
  },
  '/api/v6/costs/summary': {
    get: {
      tags: ['Costs'],
      summary: 'Cost summary by agent and model',
      responses: {
        '200': { description: 'Aggregated cost breakdown.' },
      },
    },
  },

  // ── Autonomy ─────────────────────────────────────────────────────────────────
  '/api/v6/autonomy': {
    get: {
      tags: ['Autonomy'],
      summary: 'List promotion and demotion records',
      responses: {
        '200': { description: 'Autonomy tier change history.' },
      },
    },
  },

  // ── Approvals ────────────────────────────────────────────────────────────────
  '/api/v6/approvals': {
    get: {
      tags: ['Approvals'],
      summary: 'List pending approvals',
      responses: {
        '200': { description: 'Approval request queue.' },
      },
    },
    post: {
      tags: ['Approvals'],
      summary: 'Submit an approval request',
      responses: {
        '201': { description: 'Approval request created.' },
      },
    },
  },
  '/api/v6/approvals/{id}': {
    get: {
      tags: ['Approvals'],
      summary: 'Get approval by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Approval object.' },
        '404': { description: 'Approval not found.' },
      },
    },
  },
  '/api/v6/approvals/{id}/approve': {
    post: {
      tags: ['Approvals'],
      summary: 'Approve a pending request',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Approval granted.' },
      },
    },
  },
  '/api/v6/approvals/{id}/reject': {
    post: {
      tags: ['Approvals'],
      summary: 'Reject a pending request',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Approval rejected.' },
      },
    },
  },
  '/api/v6/approvals/{id}/rollback': {
    post: {
      tags: ['Approvals'],
      summary: 'Roll back an approved action',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Rollback queued.' },
      },
    },
  },

  // ── RBAC ────────────────────────────────────────────────────────────────────
  '/api/v6/roles': {
    get: {
      tags: ['RBAC'],
      summary: 'List all roles',
      responses: { '200': { description: 'Role list.' } },
    },
  },
  '/api/v6/roles/{name}/permissions': {
    get: {
      tags: ['RBAC'],
      summary: 'Get permissions for a role',
      parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Permission set.' } },
    },
  },
  '/api/v6/access/check': {
    post: {
      tags: ['RBAC'],
      summary: 'Check if an action is permitted',
      responses: { '200': { description: 'Allowed/denied decision.' } },
    },
  },
  '/api/v6/audit': {
    get: {
      tags: ['RBAC'],
      summary: 'RBAC audit log',
      responses: { '200': { description: 'Access audit records.' } },
    },
  },
  '/api/v6/audit/stats/{workspaceId}': {
    get: {
      tags: ['RBAC'],
      summary: 'RBAC audit statistics per workspace',
      parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Audit aggregates.' } },
    },
  },

  // ── Workflows ────────────────────────────────────────────────────────────────
  '/api/v6/workflows/run': {
    post: {
      tags: ['Workflows'],
      summary: 'Execute a workflow definition',
      responses: { '200': { description: 'Execution result.' } },
    },
  },
  '/api/v6/workflows/validate': {
    post: {
      tags: ['Workflows'],
      summary: 'Validate a workflow definition',
      responses: { '200': { description: 'Validation report.' } },
    },
  },

  // ── Budget ───────────────────────────────────────────────────────────────────
  '/api/v6/budget': {
    get: {
      tags: ['Budget'],
      summary: 'Current budget status',
      responses: { '200': { description: 'Budget state.' } },
    },
  },
  '/api/v6/budget/config': {
    get: { tags: ['Budget'], summary: 'Get budget configuration', responses: { '200': { description: 'Budget config.' } } },
    post: { tags: ['Budget'], summary: 'Update budget configuration', responses: { '200': { description: 'Updated config.' } } },
  },
  '/api/v6/budget/reset': {
    post: { tags: ['Budget'], summary: 'Reset budget counters', responses: { '200': { description: 'Reset confirmed.' } } },
  },
  '/api/v6/budget/select-model': {
    post: { tags: ['Budget'], summary: 'Auto-select model within budget', responses: { '200': { description: 'Model recommendation.' } } },
  },

  // ── Observability ─────────────────────────────────────────────────────────────
  '/api/v6/evaluation/metrics': {
    get: { tags: ['Observability'], summary: 'Evaluation metric summaries', responses: { '200': { description: 'Metric records.' } } },
  },
  '/api/v6/evaluation/record': {
    post: { tags: ['Observability'], summary: 'Record an evaluation event', responses: { '201': { description: 'Event stored.' } } },
  },
  '/api/v6/evaluation/trigger': {
    post: { tags: ['Observability'], summary: 'Trigger an evaluation run', responses: { '200': { description: 'Evaluation started.' } } },
  },
  '/api/v6/execution-log': {
    get: { tags: ['Observability'], summary: 'Agent execution log', responses: { '200': { description: 'Execution entries.' } } },
  },
  '/api/v6/proposals': {
    get: { tags: ['Observability'], summary: 'List self-correction proposals', responses: { '200': { description: 'Proposal list.' } } },
  },
  '/api/v6/proposals/from-sessions': {
    post: { tags: ['Observability'], summary: 'Derive proposals from sessions', responses: { '200': { description: 'Generated proposals.' } } },
  },
  '/api/v6/proposals/{id}/approve': {
    post: { tags: ['Observability'], summary: 'Approve a proposal', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Proposal approved.' } } },
  },
  '/api/v6/proposals/{id}/reject': {
    post: { tags: ['Observability'], summary: 'Reject a proposal', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } } ], responses: { '200': { description: 'Proposal rejected.' } } },
  },
  '/api/v6/escalations': {
    get: { tags: ['Observability'], summary: 'List active escalations', responses: { '200': { description: 'Escalation records.' } } },
  },
  '/api/v6/escalations/{id}/resolve': {
    post: { tags: ['Observability'], summary: 'Resolve an escalation', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Escalation resolved.' } } },
  },
  '/api/v6/routing/decide': {
    post: { tags: ['Observability'], summary: 'Route an action to an agent', responses: { '200': { description: 'Routing decision.' } } },
  },
  '/api/v6/routing/feedback': {
    post: { tags: ['Observability'], summary: 'Submit routing feedback', responses: { '200': { description: 'Feedback recorded.' } } },
  },
  '/api/v6/routing/performance': {
    get: { tags: ['Observability'], summary: 'Routing performance stats', responses: { '200': { description: 'Performance metrics.' } } },
  },

  // ── SSE Stream ────────────────────────────────────────────────────────────────
  '/api/v6/stream': {
    get: { tags: ['Stream'], summary: 'Subscribe to SSE event stream', responses: { '200': { description: 'Server-Sent Events stream.' } } },
  },
  '/api/v6/stream/emit': {
    post: { tags: ['Stream'], summary: 'Emit an event to the stream', responses: { '200': { description: 'Event emitted.' } } },
  },
  '/api/v6/stream/status': {
    get: { tags: ['Stream'], summary: 'SSE stream status', responses: { '200': { description: 'Connected client count.' } } },
  },
  '/api/v6/dashboard/refresh-signal': {
    post: { tags: ['Stream'], summary: 'Send dashboard refresh signal via SSE', responses: { '200': { description: 'Signal sent.' } } },
  },

  // ── Merge Queue ───────────────────────────────────────────────────────────────
  '/api/v6/merge-queue': {
    get: { tags: ['MergeQueue'], summary: 'List branches in the merge queue', responses: { '200': { description: 'Branch list.' } } },
  },
  '/api/v6/branches': {
    get: { tags: ['MergeQueue'], summary: 'List tracked branches', responses: { '200': { description: 'Branch records.' } } },
    post: { tags: ['MergeQueue'], summary: 'Register a new branch', responses: { '201': { description: 'Branch registered.' } } },
  },
  '/api/v6/branches/report': {
    get: { tags: ['MergeQueue'], summary: 'Branch conflict report', responses: { '200': { description: 'Conflict analysis.' } } },
  },
  '/api/v6/branches/{id}/submit': {
    post: { tags: ['MergeQueue'], summary: 'Submit branch for merge', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Branch queued.' } } },
  },
  '/api/v6/branches/{id}/merge': {
    post: { tags: ['MergeQueue'], summary: 'Merge a branch', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Merge result.' } } },
  },
  '/api/v6/branches/{id}/conflict': {
    post: { tags: ['MergeQueue'], summary: 'Mark branch as conflicted', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Conflict flagged.' } } },
  },

  // ── Knowledge Graph ───────────────────────────────────────────────────────────
  '/api/v6/knowledge/graph': {
    get: { tags: ['Knowledge'], summary: 'Full knowledge graph', responses: { '200': { description: 'Entities and relationships.' } } },
  },
  '/api/v6/knowledge/entities': {
    get: { tags: ['Knowledge'], summary: 'List knowledge entities', responses: { '200': { description: 'Entity list.' } } },
    post: { tags: ['Knowledge'], summary: 'Create a knowledge entity', responses: { '201': { description: 'Entity created.' } } },
  },
  '/api/v6/knowledge/entities/{id}': {
    get: { tags: ['Knowledge'], summary: 'Get knowledge entity', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Entity.' }, '404': { description: 'Not found.' } } },
    delete: { tags: ['Knowledge'], summary: 'Delete knowledge entity', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted.' } } },
  },
  '/api/v6/knowledge/relationships': {
    post: { tags: ['Knowledge'], summary: 'Create a knowledge relationship', responses: { '201': { description: 'Relationship created.' } } },
  },
  '/api/v6/knowledge/query': {
    post: { tags: ['Knowledge'], summary: 'Query the knowledge graph', responses: { '200': { description: 'Query results.' } } },
  },

  // ── Canary ────────────────────────────────────────────────────────────────────
  '/api/v6/canary/flags': {
    get: { tags: ['Canary'], summary: 'List canary flags', responses: { '200': { description: 'Flag list.' } } },
    post: { tags: ['Canary'], summary: 'Create a canary flag', responses: { '201': { description: 'Flag created.' } } },
  },
  '/api/v6/canary/flags/{id}': {
    get: { tags: ['Canary'], summary: 'Get canary flag', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Flag.' } } },
    delete: { tags: ['Canary'], summary: 'Delete canary flag', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted.' } } },
  },
  '/api/v6/canary/flags/{id}/activate': {
    post: { tags: ['Canary'], summary: 'Activate a canary flag', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Flag activated.' } } },
  },
  '/api/v6/canary/flags/{id}/rollback': {
    post: { tags: ['Canary'], summary: 'Roll back a canary flag', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Rolled back.' } } },
  },
  '/api/v6/canary/metrics': {
    get: { tags: ['Canary'], summary: 'All canary metrics', responses: { '200': { description: 'Metrics list.' } } },
    post: { tags: ['Canary'], summary: 'Record a canary metric', responses: { '201': { description: 'Metric recorded.' } } },
  },
  '/api/v6/canary/metrics/{flagId}': {
    get: { tags: ['Canary'], summary: 'Metrics for a specific flag', parameters: [{ name: 'flagId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Flag metrics.' } } },
  },
  '/api/v6/canary/rollback-log': {
    get: { tags: ['Canary'], summary: 'Rollback history log', responses: { '200': { description: 'Rollback entries.' } } },
  },
  '/api/v6/canary/split': {
    post: { tags: ['Canary'], summary: 'Evaluate traffic split for a request', responses: { '200': { description: 'Split decision.' } } },
  },

  // ── Tracing ──────────────────────────────────────────────────────────────────
  '/api/v6/traces': {
    get: { tags: ['Tracing'], summary: 'List traces', responses: { '200': { description: 'Trace list.' } } },
    post: { tags: ['Tracing'], summary: 'Create a trace', responses: { '201': { description: 'Trace created.' } } },
  },
  '/api/v6/traces/{traceId}': {
    get: { tags: ['Tracing'], summary: 'Get trace by ID', parameters: [{ name: 'traceId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Trace.' }, '404': { description: 'Not found.' } } },
  },
  '/api/v6/traces/stats/summary': {
    get: { tags: ['Tracing'], summary: 'Trace statistics summary', responses: { '200': { description: 'Stats.' } } },
  },

  // ── Cost Autopilot ────────────────────────────────────────────────────────────
  '/api/v6/cost-autopilot/stats': {
    get: { tags: ['CostAutopilot'], summary: 'Cost autopilot statistics', responses: { '200': { description: 'Stats.' } } },
  },
  '/api/v6/cost-autopilot/process': {
    post: { tags: ['CostAutopilot'], summary: 'Run cost autopilot pass', responses: { '200': { description: 'Result.' } } },
  },
  '/api/v6/cost-autopilot/cache/clear': {
    post: { tags: ['CostAutopilot'], summary: 'Clear autopilot cache', responses: { '200': { description: 'Cache cleared.' } } },
  },

  // ── Predictive Planning ───────────────────────────────────────────────────────
  '/api/v6/planning/predict': {
    post: { tags: ['Planning'], summary: 'Predict sprint cost and duration', responses: { '200': { description: 'Prediction.' } } },
  },
  '/api/v6/planning/history': {
    get: { tags: ['Planning'], summary: 'Historical planning data', responses: { '200': { description: 'History.' } } },
  },

  // ── Marketplace ───────────────────────────────────────────────────────────────
  '/api/v6/marketplace': {
    get: { tags: ['Marketplace'], summary: 'List marketplace items', responses: { '200': { description: 'Items.' } } },
  },
  '/api/v6/marketplace/search': {
    get: { tags: ['Marketplace'], summary: 'Search marketplace', responses: { '200': { description: 'Search results.' } } },
  },
  '/api/v6/marketplace/publish': {
    post: { tags: ['Marketplace'], summary: 'Publish an item to marketplace', responses: { '201': { description: 'Published.' } } },
  },
  '/api/v6/marketplace/{id}': {
    get: { tags: ['Marketplace'], summary: 'Get marketplace item', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Item.' } } },
  },
  '/api/v6/marketplace/{id}/install': {
    post: { tags: ['Marketplace'], summary: 'Install a marketplace item', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Installed.' } } },
  },

  // ── Natural Language Interface ─────────────────────────────────────────────────
  '/api/v6/nl/parse': {
    post: { tags: ['NL'], summary: 'Parse natural language command', responses: { '200': { description: 'Parsed intent.' } } },
  },
  '/api/v6/nl/execute': {
    post: { tags: ['NL'], summary: 'Parse and execute NL command', responses: { '200': { description: 'Execution result.' } } },
  },
  '/api/v6/nl/intents': {
    get: { tags: ['NL'], summary: 'List supported NL intents', responses: { '200': { description: 'Intent catalogue.' } } },
  },

  // ── Agent Streaming ───────────────────────────────────────────────────────────
  '/api/v6/agents/{id}/run': {
    post: { tags: ['AgentStreaming'], summary: 'Run agent with SSE streaming', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'SSE token stream.' } } },
  },

  // ── Multi-Workspace ───────────────────────────────────────────────────────────
  '/api/v6/agents/{id}/versions': {
    get: { tags: ['AgentVersioning'], summary: 'List agent versions', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Version history.' } } },
  },
  '/api/v6/agents/{id}/pin': {
    post: { tags: ['AgentVersioning'], summary: 'Pin agent to a version', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Pinned.' } } },
  },
  '/api/v6/agents/{id}/rollback': {
    post: { tags: ['AgentVersioning'], summary: 'Roll back agent to previous version', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Rolled back.' } } },
  },

  // ── Federation ────────────────────────────────────────────────────────────────
  '/api/v6/federation/peers': {
    get: { tags: ['Federation'], summary: 'List federated peers', responses: { '200': { description: 'Peer list.' } } },
    post: { tags: ['Federation'], summary: 'Register a peer', responses: { '201': { description: 'Peer registered.' } } },
  },
  '/api/v6/federation/status': {
    get: { tags: ['Federation'], summary: 'Federation health status', responses: { '200': { description: 'Status.' } } },
  },
  '/api/v6/federation/share': {
    post: { tags: ['Federation'], summary: 'Share data with peers', responses: { '200': { description: 'Share result.' } } },
  },
  '/api/v6/federation/learnings': {
    get: { tags: ['Federation'], summary: 'Shared learnings from peers', responses: { '200': { description: 'Learnings.' } } },
  },

  // ── Sprint Orchestration ──────────────────────────────────────────────────────
  '/api/v6/sprints': {
    get: { tags: ['Sprints'], summary: 'List sprints', responses: { '200': { description: 'Sprint list.' } } },
    post: { tags: ['Sprints'], summary: 'Create a sprint', responses: { '201': { description: 'Sprint created.' } } },
  },
  '/api/v6/sprints/{version}': {
    get: { tags: ['Sprints'], summary: 'Get sprint by version', parameters: [{ name: 'version', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Sprint.' }, '404': { description: 'Not found.' } } },
    put: { tags: ['Sprints'], summary: 'Advance/update sprint', parameters: [{ name: 'version', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated sprint.' } } },
  },
  '/api/v6/sprint-reports': {
    get: { tags: ['Sprints'], summary: 'List sprint reports', responses: { '200': { description: 'Reports.' } } },
  },
  '/api/v6/sprint-reports/{version}': {
    get: { tags: ['Sprints'], summary: 'Get sprint report', parameters: [{ name: 'version', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Report.' } } },
  },

  // ── Settings ─────────────────────────────────────────────────────────────────
  '/api/v6/settings': {
    get: { tags: ['Settings'], summary: 'Get current settings', responses: { '200': { description: 'Settings object.' } } },
    put: { tags: ['Settings'], summary: 'Update settings', responses: { '200': { description: 'Updated settings.' } } },
  },
  '/api/v6/settings/export': {
    get: { tags: ['Settings'], summary: 'Export settings as JSON', responses: { '200': { description: 'Settings export.' } } },
  },
  '/api/v6/settings/import': {
    post: { tags: ['Settings'], summary: 'Import settings from JSON', responses: { '200': { description: 'Import result.' } } },
  },

  // ── Agent CRUD ────────────────────────────────────────────────────────────────
  '/api/v6/agents': {
    get: { tags: ['Agents'], summary: 'List agents', responses: { '200': { description: 'Agent list.' } } },
    post: { tags: ['Agents'], summary: 'Create an agent', responses: { '201': { description: 'Agent created.' } } },
  },
  '/api/v6/agents/{id}': {
    get: { tags: ['Agents'], summary: 'Get agent by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Agent.' }, '404': { description: 'Not found.' } } },
    put: { tags: ['Agents'], summary: 'Update agent', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated agent.' } } },
    delete: { tags: ['Agents'], summary: 'Delete agent', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted.' } } },
  },
  '/api/v6/agents/{id}/scorecard': {
    get: { tags: ['Agents'], summary: 'Get agent scorecard', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Scorecard.' } } },
  },
  '/api/v6/scorecards': {
    get: { tags: ['Agents'], summary: 'List all scorecards', responses: { '200': { description: 'All scorecards.' } } },
  },

  // ── Chat Interface ────────────────────────────────────────────────────────────
  '/api/v6/chat/{agentId}': {
    get: { tags: ['Chat'], summary: 'Get chat history for agent', parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Message history.' } } },
    post: { tags: ['Chat'], summary: 'Send a message to agent', parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Agent reply.' } } },
  },

  // ── Execution (Run) ────────────────────────────────────────────────────────────
  '/api/v6/run': {
    post: { tags: ['Run'], summary: 'Dispatch an agent run', responses: { '200': { description: 'Run result.' } } },
  },
  '/api/v6/run/history': {
    get: { tags: ['Run'], summary: 'List run history', responses: { '200': { description: 'Run records.' } } },
  },
  '/api/v6/run/{sessionId}': {
    get: { tags: ['Run'], summary: 'Get run by session ID', parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Run.' } } },
  },

  // ── Memory ────────────────────────────────────────────────────────────────────
  '/api/v6/memory': {
    get: { tags: ['Memory'], summary: 'List memory entries', responses: { '200': { description: 'Memory records.' } } },
    post: { tags: ['Memory'], summary: 'Create a memory entry', responses: { '201': { description: 'Entry created.' } } },
  },
  '/api/v6/memory/{id}': {
    delete: { tags: ['Memory'], summary: 'Delete a memory entry', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted.' } } },
  },

  // ── Org Graph ─────────────────────────────────────────────────────────────────
  '/api/v6/org-graph': {
    get: { tags: ['OrgGraph'], summary: 'Get the agent org hierarchy', responses: { '200': { description: 'Delegation graph.' } } },
  },

  // ── Flywheel ──────────────────────────────────────────────────────────────────
  '/api/v6/flywheel': {
    get: { tags: ['Flywheel'], summary: 'Flywheel metrics and state', responses: { '200': { description: 'Flywheel data.' } } },
  },

  // ── Embeddings ────────────────────────────────────────────────────────────────
  '/api/v6/embeddings/search': {
    post: { tags: ['Embeddings'], summary: 'Semantic similarity search', responses: { '200': { description: 'Search results.' } } },
  },
  '/api/v6/embeddings/index': {
    post: { tags: ['Embeddings'], summary: 'Index a document', responses: { '200': { description: 'Indexed.' } } },
  },
  '/api/v6/embeddings/index/batch': {
    post: { tags: ['Embeddings'], summary: 'Batch index documents', responses: { '200': { description: 'Batch result.' } } },
  },
  '/api/v6/embeddings/stats': {
    get: { tags: ['Embeddings'], summary: 'Embedding index statistics', responses: { '200': { description: 'Stats.' } } },
  },
  '/api/v6/embeddings/learn-session': {
    post: { tags: ['Embeddings'], summary: 'Learn from a session', responses: { '200': { description: 'Learned.' } } },
  },
  '/api/v6/embeddings/{id}': {
    delete: { tags: ['Embeddings'], summary: 'Remove a document from index', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Removed.' } } },
  },

  // ── Plugins ───────────────────────────────────────────────────────────────────
  '/api/v6/plugins': {
    get: { tags: ['Plugins'], summary: 'List loaded plugins', responses: { '200': { description: 'Plugin list.' } } },
  },
  '/api/v6/plugins/load': {
    post: { tags: ['Plugins'], summary: 'Hot-load a plugin', responses: { '200': { description: 'Loaded.' } } },
  },
  '/api/v6/plugins/{id}/start': {
    post: { tags: ['Plugins'], summary: 'Start a plugin', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Started.' } } },
  },
  '/api/v6/plugins/{id}/stop': {
    post: { tags: ['Plugins'], summary: 'Stop a plugin', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Stopped.' } } },
  },

  // ── Dev ────────────────────────────────────────────────────────────────────────
  '/api/v6/dev/status': {
    get: { tags: ['Dev'], summary: 'Dev server status', responses: { '200': { description: 'Status.' } } },
  },
  '/api/v6/dev/reload': {
    post: { tags: ['Dev'], summary: 'Hot-reload dev server', responses: { '200': { description: 'Reloaded.' } } },
  },

  // ── v1 Lifecycle (v6 canonical paths) ────────────────────────────────────────
  '/api/v6/teams': {
    get: {
      tags: ['Lifecycle'],
      summary: 'List team units',
      description: 'Reads team structure from .agentforge/config/teams.yaml or team.yaml.',
      responses: { '200': { description: 'Array of team units.' } },
    },
  },
  '/api/v6/teams/{teamId}': {
    get: {
      tags: ['Lifecycle'],
      summary: 'Get team by ID',
      parameters: [{ name: 'teamId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Team unit.' }, '404': { description: 'Not found.' } },
    },
  },
  '/api/v6/careers': {
    get: {
      tags: ['Lifecycle'],
      summary: 'List agent career records',
      responses: { '200': { description: 'Career rows from agent_careers table.' } },
    },
  },
  '/api/v6/careers/{agentId}': {
    get: {
      tags: ['Lifecycle'],
      summary: 'Get career + skills for an agent',
      parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Career with embedded skills.' }, '404': { description: 'Not found.' } },
    },
  },
  '/api/v6/careers/{agentId}/skills': {
    get: {
      tags: ['Lifecycle'],
      summary: 'Get skill profile for an agent',
      parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Skill profile.' } },
    },
  },
  '/api/v6/hiring-recommendations': {
    get: {
      tags: ['Lifecycle'],
      summary: 'List hiring recommendations',
      parameters: [{ name: 'status', in: 'query', schema: { type: 'string' }, description: 'Filter by status (pending, approved, rejected).' }],
      responses: { '200': { description: 'Hiring recommendation records.' } },
    },
  },

  // ── WebSocket ─────────────────────────────────────────────────────────────────
  '/ws': {
    get: {
      tags: ['WebSocket'],
      summary: 'WebSocket upgrade endpoint',
      description: 'Upgrades an HTTP connection to WebSocket. Supports chat, replay, and ping messages. See ws-handler.ts for protocol details.',
      responses: {
        '101': { description: 'Switching Protocols — WebSocket connection established.' },
      },
    },
  },
};

// ── OpenAPI document builder ──────────────────────────────────────────────────

function buildOpenApiDoc() {
  const tagSet = new Set<string>();
  for (const item of Object.values(paths)) {
    for (const op of Object.values(item)) {
      if (op.tags) op.tags.forEach((t: string) => tagSet.add(t));
    }
  }

  const tags = Array.from(tagSet).sort().map((name) => ({ name }));

  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentForge API v6',
      version: '6.2.0',
      description:
        'Unified API namespace for AgentForge. Consolidates v5 workspace-scoped ' +
        'routes and v1 lifecycle routes (teams, careers, hiring-recommendations) ' +
        'under a single /api/v6/ prefix. Also exposes the /ws WebSocket endpoint.',
      contact: {
        name: 'AgentForge Team',
        url: 'https://github.com/agentforge/agentforge',
      },
      license: { name: 'MIT' },
    },
    servers: [
      { url: 'http://127.0.0.1:4750', description: 'Local dev server (packages/server)' },
      { url: 'http://127.0.0.1:4700', description: 'Legacy v1 server (src/server)' },
    ],
    tags,
    paths,
    components: {
      schemas: {},
      securitySchemes: {
        workspaceHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'x-workspace-id',
          description: 'Optional workspace ID header. Defaults to "default".',
        },
      },
    },
  };
}

// ── Route registration ────────────────────────────────────────────────────────

/**
 * Register GET /api/v6/openapi.json on the given Fastify instance.
 * The spec is generated once at startup and cached.
 */
export async function openApiRoutes(app: FastifyInstance): Promise<void> {
  const spec = buildOpenApiDoc();

  app.get('/api/v6/openapi.json', async (_req, reply) => {
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Cache-Control', 'public, max-age=60')
      .send(spec);
  });
}
