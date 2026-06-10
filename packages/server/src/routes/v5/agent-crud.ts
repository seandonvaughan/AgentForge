import type { FastifyInstance } from 'fastify';
import { join, dirname } from 'node:path';
import {
  readFileSync,
  statSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { emitClaudeCodeAgents } from '@agentforge/core';
import { globalStream } from './stream.js';
import { safeJoin } from '../../lib/safe-join.js';
import { appendAuditEntry, openAuditDb } from './audit.js';
import { writeFileAtomicSync } from '../../lib/atomic-write.js';

/** Agent IDs must be kebab-case slugs — mirrors the POST-create validation. */
const SAFE_AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// ESM-safe __dirname
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// YAML shape for agent files
// ---------------------------------------------------------------------------

interface AgentYaml {
  name: string;
  model: string;
  version: string;
  description: string;
  system_prompt: string;
  seniority?: string;
  layer?: string;
  effort?: string;
  skills?: string[];
  tools?: string[];
  triggers?: {
    file_patterns?: string[];
    keywords?: string[];
  };
  collaboration?: {
    reports_to?: string;
    reviews_from?: string[];
    can_delegate_to?: string[];
    parallel?: boolean;
  };
  context?: {
    max_files?: number;
    auto_include?: string[];
    project_specific?: string[];
  };
}

type DelegationMap = Record<string, string[]>;
type ModelsMap = Record<string, unknown>;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// ---------------------------------------------------------------------------
// Request body interfaces
// ---------------------------------------------------------------------------

type AgentEffort = 'xhigh' | 'high' | 'medium' | 'low';

interface CreateAgentBody {
  id: string;
  name: string;
  model: 'fable' | 'opus' | 'sonnet' | 'haiku';
  description: string;
  system_prompt: string;
  effort?: AgentEffort;
  skills?: string[];
  tools?: string[];
  reports_to?: string;
  seniority?: string;
  layer?: string;
}

interface UpdateAgentBody {
  name?: string;
  model?: 'fable' | 'opus' | 'sonnet' | 'haiku';
  description?: string;
  system_prompt?: string;
  effort?: AgentEffort;
  skills?: string[];
  tools?: string[];
  reports_to?: string;
  seniority?: string;
}

interface ForkAgentBody {
  newId: string;
  name?: string;
  model?: string;
  system_prompt?: string;
}

interface PromoteBody {
  newSeniority: 'mid' | 'senior' | 'lead' | 'principal';
  approvedBy: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readYaml<T>(filePath: string): T {
  return yaml.load(readFileSync(filePath, 'utf-8')) as T;
}

function writeYaml(filePath: string, data: unknown): void {
  const dumped = yaml.dump(data, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  writeFileAtomicSync(filePath, dumped);
}

/**
 * Map seniority level → default model tier.
 * lead/principal → opus; junior → haiku; everything else → sonnet.
 */
function modelForSeniority(seniority: string): string {
  if (seniority === 'lead' || seniority === 'principal') return 'opus';
  if (seniority === 'junior') return 'haiku';
  return 'sonnet';
}

/** Valid reasoning-effort levels accepted on create/patch. */
const VALID_EFFORTS: readonly string[] = ['xhigh', 'high', 'medium', 'low'];

const VALID_MODEL_TIERS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
type ModelTier = (typeof VALID_MODEL_TIERS)[number];

function asModelTier(value: string): ModelTier | null {
  return (VALID_MODEL_TIERS as readonly string[]).includes(value) ? (value as ModelTier) : null;
}

/** True when `tools` is a valid string array (or absent). */
function isValidToolsField(tools: unknown): tools is string[] | undefined {
  if (tools === undefined) return true;
  return Array.isArray(tools) && tools.every((t) => typeof t === 'string');
}

// ---------------------------------------------------------------------------
// Config mutation helpers (scoped to resolved paths)
// ---------------------------------------------------------------------------

/** Add agentId to supervisor's delegation list. No-op if already present. */
function addToDelegation(delPath: string, supervisorId: string, agentId: string): void {
  if (!existsSync(delPath)) return;
  const map = readYaml<DelegationMap>(delPath);
  const list = map[supervisorId] ?? [];
  if (!list.includes(agentId)) {
    map[supervisorId] = [...list, agentId];
    writeYaml(delPath, map);
  }
}

/**
 * Remove agentId from ALL supervisor lists and also remove it as a supervisor key.
 * This handles both "agent is a report" and "agent is a supervisor" cases.
 */
function removeFromDelegation(delPath: string, agentId: string): void {
  if (!existsSync(delPath)) return;
  const map = readYaml<DelegationMap>(delPath);
  let changed = false;

  for (const supervisor of Object.keys(map)) {
    const before = map[supervisor] ?? [];
    const after = before.filter((r) => r !== agentId);
    if (after.length !== before.length) {
      map[supervisor] = after;
      changed = true;
    }
  }

  // Remove own supervisor entry if present
  if (agentId in map) {
    delete map[agentId];
    changed = true;
  }

  if (changed) writeYaml(delPath, map);
}

/**
 * Move agentId to the target model bucket in models.yaml.
 * Removes it from any other bucket first.
 */
function setModelRouting(mdlPath: string, agentId: string, model: string): void {
  if (!existsSync(mdlPath)) return;
  const map = readYaml<ModelsMap>(mdlPath);

  // Strip from existing buckets
  for (const tier of Object.keys(map)) {
    if (Array.isArray(map[tier])) {
      map[tier] = asStringArray(map[tier]).filter((id) => id !== agentId);
    }
  }

  // Append to target bucket
  const target = asStringArray(map[model]);
  if (!target.includes(agentId)) {
    map[model] = [...target, agentId];
  }

  writeYaml(mdlPath, map);
}

/** Remove agentId from every bucket in models.yaml. */
function removeFromModels(mdlPath: string, agentId: string): void {
  if (!existsSync(mdlPath)) return;
  const map = readYaml<ModelsMap>(mdlPath);
  let changed = false;

  for (const tier of Object.keys(map)) {
    if (!Array.isArray(map[tier])) continue;
    const before = asStringArray(map[tier]);
    const after = before.filter((id) => id !== agentId);
    if (after.length !== before.length) {
      map[tier] = after;
      changed = true;
    }
  }

  if (changed) writeYaml(mdlPath, map);
}

/**
 * Scan all agent YAML files and return IDs of agents whose `collaboration.reports_to`
 * matches the given supervisorId.
 */
function getDirectReports(agentsDir: string, supervisorId: string): string[] {
  if (!existsSync(agentsDir)) return [];
  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
  const reports: string[] = [];

  for (const file of files) {
    try {
      const data = readYaml<AgentYaml>(join(agentsDir, file));
      if (data?.collaboration?.reports_to === supervisorId) {
        reports.push(file.replace('.yaml', ''));
      }
    } catch {
      // skip malformed YAML
    }
  }

  return reports;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

// Required top-level fields for a valid AgentTemplate YAML
const REQUIRED_AGENT_FIELDS: ReadonlyArray<keyof AgentYaml> = [
  'name',
  'model',
  'system_prompt',
];

/** Verify a parsed object satisfies the minimum AgentTemplate shape. */
function isValidAgentYaml(parsed: unknown): parsed is AgentYaml {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  for (const field of REQUIRED_AGENT_FIELDS) {
    if (typeof obj[field] !== 'string' || !(obj[field] as string).trim()) return false;
  }
  return true;
}

export async function agentCrudRoutes(
  app: FastifyInstance,
  opts: { projectRoot?: string },
): Promise<void> {
  const root = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const agentsDir = join(root, '.agentforge/agents');
  const cfgDir = join(root, '.agentforge/config');
  const delPath = join(cfgDir, 'delegation.yaml');
  const mdlPath = join(cfgDir, 'models.yaml');

  // Ensure agents directory exists
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

  // Audit DB for raw-YAML mutations
  const auditDb = openAuditDb(root);
  app.addHook('onClose', async () => { auditDb.close(); });

  /**
   * Full path to an agent YAML file, or null if `id` would escape agentsDir.
   * This is the single path-construction point for all agent CRUD operations.
   */
  function agentFilePath(id: string): string | null {
    return safeJoin(agentsDir, `${id}.yaml`);
  }

  /** Read agent YAML; returns null if the file does not exist or id is unsafe. */
  function readAgent(id: string): AgentYaml | null {
    const p = agentFilePath(id);
    if (!p || !existsSync(p)) return null;
    return readYaml<AgentYaml>(p);
  }

  /**
   * Regenerate the Claude Code mirror at .claude/agents/<id>.md after a
   * successful mutation, so the native Claude Code Agent tool always sees the
   * current YAML state. Best-effort: a mirror failure must never fail the API
   * call that triggered it.
   */
  async function regenerateClaudeMirror(agentId: string, agent: AgentYaml): Promise<void> {
    try {
      const tier = asModelTier(agent.model);
      await emitClaudeCodeAgents({
        projectRoot: root,
        agents: [{
          id: agentId,
          description:
            typeof agent.description === 'string' && agent.description.trim()
              ? agent.description
              : agent.name,
          systemPrompt: agent.system_prompt,
          ...(tier ? { model: tier } : {}),
          ...(agent.tools?.length ? { tools: agent.tools } : {}),
        }],
      });
    } catch {
      // Mirror regen is best-effort — never fail the API mutation.
    }
  }

  /** Best-effort removal of the Claude Code mirror when an agent is deleted. */
  function removeClaudeMirror(agentId: string): void {
    try {
      const mirrorPath = safeJoin(join(root, '.claude', 'agents'), `${agentId}.md`);
      if (mirrorPath && existsSync(mirrorPath)) unlinkSync(mirrorPath);
    } catch {
      // Best-effort — never fail the API mutation.
    }
  }

  // ── GET /api/v5/agents/:id/raw — Return raw YAML file content ────────────

  app.get<{ Params: { id: string } }>('/api/v5/agents/:id/raw', async (req, reply) => {
    const { id } = req.params;
    if (!SAFE_AGENT_ID.test(id)) return reply.status(400).send({ error: 'Invalid agent id' });

    const filePath = agentFilePath(id);
    if (!filePath || !existsSync(filePath)) {
      return reply.status(404).send({ error: `Agent "${id}" not found` });
    }

    try {
      const yamlContent = readFileSync(filePath, 'utf-8');
      const stat = statSync(filePath);
      return reply.send({
        data: {
          yaml: yamlContent,
          agentId: id,
          modifiedAt: stat.mtime.toISOString(),
        },
      });
    } catch {
      return reply.status(500).send({ error: 'Failed to read agent file' });
    }
  });

  // ── PUT /api/v5/agents/:id/raw — Write raw YAML file content ─────────────

  app.put<{ Params: { id: string }; Body: { yaml: string } }>(
    '/api/v5/agents/:id/raw',
    async (req, reply) => {
      const { id } = req.params;
      if (!SAFE_AGENT_ID.test(id)) return reply.status(400).send({ error: 'Invalid agent id' });

      const filePath = agentFilePath(id);
      if (!filePath) return reply.status(400).send({ error: 'Invalid agent id' });

      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: `Agent "${id}" not found` });
      }

      const { yaml: yamlContent } = req.body ?? {};
      if (typeof yamlContent !== 'string' || !yamlContent.trim()) {
        return reply.status(400).send({ error: 'Body must include { yaml: string }' });
      }

      // Validate: must parse as valid YAML
      let parsed: unknown;
      try {
        parsed = yaml.load(yamlContent);
      } catch (e) {
        return reply.status(400).send({
          error: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
        });
      }

      // Validate: must satisfy minimum AgentTemplate shape
      if (!isValidAgentYaml(parsed)) {
        return reply.status(400).send({
          error: `YAML must include required string fields: ${REQUIRED_AGENT_FIELDS.join(', ')}`,
        });
      }

      writeFileAtomicSync(filePath, yamlContent);

      // Audit log
      appendAuditEntry(auditDb, {
        actor: 'api',
        action: 'agent.raw.write',
        target: id,
        details: { agentId: id, source: 'PUT /api/v5/agents/:id/raw' },
      });

      // Keep the Claude Code mirror in sync with the new YAML (best-effort).
      await regenerateClaudeMirror(id, parsed);

      globalStream.emit({
        type: 'agent_activity',
        category: 'agent_crud',
        message: `Agent "${id}" raw YAML updated`,
        data: { type: 'raw_yaml_updated', agentId: id },
      });

      const stat = statSync(filePath);
      return reply.send({
        data: {
          yaml: yamlContent,
          agentId: id,
          modifiedAt: stat.mtime.toISOString(),
        },
      });
    },
  );

  // ── POST /api/v5/agents — Create a new agent ──────────────────────────────

  app.post<{ Body: CreateAgentBody }>('/api/v5/agents', async (req, reply) => {
    const { id, name, model, description, system_prompt, effort, skills, tools, reports_to, seniority, layer } =
      req.body;

    // Required field validation
    if (!id || !name || !model || !description || !system_prompt) {
      return reply.status(400).send({
        error: 'Missing required fields: id, name, model, description, system_prompt',
      });
    }

    // id must be kebab-case
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      return reply.status(400).send({
        error: 'id must be kebab-case (e.g. "my-agent")',
      });
    }

    // Validate model tier
    if (!['fable', 'opus', 'sonnet', 'haiku'].includes(model)) {
      return reply.status(400).send({ error: 'model must be one of: fable, opus, sonnet, haiku' });
    }

    // Validate effort if provided
    if (effort !== undefined && !VALID_EFFORTS.includes(effort)) {
      return reply.status(400).send({ error: 'effort must be one of: xhigh, high, medium, low' });
    }

    // Validate tools if provided
    if (!isValidToolsField(tools)) {
      return reply.status(400).send({ error: 'tools must be an array of strings' });
    }

    // Resolve and contain the file path (id already validated as kebab-case above)
    const newFilePath = agentFilePath(id);
    if (!newFilePath) return reply.status(400).send({ error: 'Invalid agent id' });

    // Prevent overwriting an existing agent
    if (existsSync(newFilePath)) {
      return reply.status(409).send({ error: `Agent "${id}" already exists` });
    }

    const agentYaml: AgentYaml = {
      name,
      model,
      version: '1.0',
      description,
      system_prompt,
      ...(effort ? { effort } : {}),
      ...(seniority ? { seniority } : {}),
      ...(layer ? { layer } : {}),
      ...(skills?.length ? { skills } : {}),
      ...(tools?.length ? { tools } : {}),
      collaboration: {
        ...(reports_to ? { reports_to } : {}),
        can_delegate_to: [],
        parallel: false,
      },
    };

    writeYaml(newFilePath, agentYaml);

    // Wire into delegation hierarchy
    if (reports_to) addToDelegation(delPath, reports_to, id);

    // Register in model routing
    setModelRouting(mdlPath, id, model);

    appendAuditEntry(auditDb, {
      actor: 'api',
      action: 'agent.create',
      target: id,
      details: { agentId: id, model, source: 'POST /api/v5/agents' },
    });

    // Keep the Claude Code mirror in sync (best-effort).
    await regenerateClaudeMirror(id, agentYaml);

    globalStream.emit({
      type: 'agent_activity',
      category: 'agent_crud',
      message: `Agent "${id}" created`,
      data: { type: 'created', agentId: id },
    });

    return reply.status(201).send({ data: agentYaml });
  });

  // ── PATCH /api/v5/agents/:id — Update agent config ───────────────────────

  app.patch<{ Params: { id: string }; Body: UpdateAgentBody }>(
    '/api/v5/agents/:id',
    async (req, reply) => {
      const { id } = req.params;
      if (!SAFE_AGENT_ID.test(id)) return reply.status(400).send({ error: 'Invalid agent id' });

      const existing = readAgent(id);
      if (!existing) return reply.status(404).send({ error: `Agent "${id}" not found` });

      const { name, model, description, system_prompt, effort, skills, tools, reports_to, seniority } = req.body;

      // Validate model if provided
      if (model !== undefined && !['fable', 'opus', 'sonnet', 'haiku'].includes(model)) {
        return reply.status(400).send({ error: 'model must be one of: fable, opus, sonnet, haiku' });
      }

      // Validate effort if provided
      if (effort !== undefined && !VALID_EFFORTS.includes(effort)) {
        return reply.status(400).send({ error: 'effort must be one of: xhigh, high, medium, low' });
      }

      // Validate tools if provided
      if (!isValidToolsField(tools)) {
        return reply.status(400).send({ error: 'tools must be an array of strings' });
      }

      const updated: AgentYaml = {
        ...existing,
        ...(name !== undefined ? { name } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(system_prompt !== undefined ? { system_prompt } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(skills !== undefined ? { skills } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(seniority !== undefined ? { seniority } : {}),
        collaboration: {
          ...existing.collaboration,
          ...(reports_to !== undefined ? { reports_to } : {}),
        },
      };

      // agentFilePath returns null only if id escapes agentsDir; SAFE_AGENT_ID
      // check above ensures this cannot happen, but we guard for type safety.
      const patchPath = agentFilePath(id);
      if (!patchPath) return reply.status(400).send({ error: 'Invalid agent id' });
      writeYaml(patchPath, updated);

      // Delegation update: if reports_to changed, rewire
      if (reports_to !== undefined) {
        // Remove from all existing supervisor slots
        removeFromDelegation(delPath, id);
        if (reports_to) addToDelegation(delPath, reports_to, id);
      }

      // Model routing update
      if (model !== undefined) {
        setModelRouting(mdlPath, id, model);
      }

      appendAuditEntry(auditDb, {
        actor: 'api',
        action: 'agent.patch',
        target: id,
        details: { agentId: id, fields: Object.keys(req.body ?? {}), source: 'PATCH /api/v5/agents/:id' },
      });

      // Keep the Claude Code mirror in sync (best-effort).
      await regenerateClaudeMirror(id, updated);

      globalStream.emit({
        type: 'agent_activity',
        category: 'agent_crud',
        message: `Agent "${id}" updated`,
        data: { type: 'updated', agentId: id },
      });

      return reply.send({ data: updated });
    },
  );

  // ── DELETE /api/v5/agents/:id — Terminate agent ───────────────────────────

  app.delete<{ Params: { id: string } }>('/api/v5/agents/:id', async (req, reply) => {
    const { id } = req.params;
    if (!SAFE_AGENT_ID.test(id)) return reply.status(400).send({ error: 'Invalid agent id' });

    const deletePath = agentFilePath(id);
    if (!deletePath || !existsSync(deletePath)) {
      return reply.status(404).send({ error: `Agent "${id}" not found` });
    }

    // Guard against orphaning direct reports
    const directReports = getDirectReports(agentsDir, id);
    if (directReports.length > 0) {
      return reply.status(409).send({
        error: `Cannot delete "${id}" — it has direct reports: ${directReports.join(', ')}. Reassign them first.`,
        data: { directReports },
      });
    }

    unlinkSync(deletePath);
    removeFromDelegation(delPath, id);
    removeFromModels(mdlPath, id);

    appendAuditEntry(auditDb, {
      actor: 'api',
      action: 'agent.delete',
      target: id,
      details: { agentId: id, source: 'DELETE /api/v5/agents/:id' },
    });

    // Remove the stale Claude Code mirror (best-effort).
    removeClaudeMirror(id);

    globalStream.emit({
      type: 'agent_activity',
      category: 'agent_crud',
      message: `Agent "${id}" terminated`,
      data: { type: 'terminated', agentId: id },
    });

    return reply.send({ ok: true, agentId: id });
  });

  // ── POST /api/v5/agents/:id/fork — Fork an agent ─────────────────────────

  app.post<{ Params: { id: string }; Body: ForkAgentBody }>(
    '/api/v5/agents/:id/fork',
    async (req, reply) => {
      const { id } = req.params;
      if (!SAFE_AGENT_ID.test(id)) return reply.status(400).send({ error: 'Invalid agent id' });

      const source = readAgent(id);
      if (!source) return reply.status(404).send({ error: `Agent "${id}" not found` });

      const { newId, name, model, system_prompt } = req.body;

      if (!newId) return reply.status(400).send({ error: 'newId is required' });

      if (!SAFE_AGENT_ID.test(newId)) {
        return reply.status(400).send({ error: 'newId must be kebab-case' });
      }

      const forkPath = agentFilePath(newId);
      if (!forkPath) return reply.status(400).send({ error: 'Invalid newId' });

      if (existsSync(forkPath)) {
        return reply.status(409).send({ error: `Agent "${newId}" already exists` });
      }

      if (model !== undefined && !['fable', 'opus', 'sonnet', 'haiku'].includes(model)) {
        return reply.status(400).send({ error: 'model must be one of: fable, opus, sonnet, haiku' });
      }

      const forked: AgentYaml = {
        ...source,
        name: name ?? `${source.name} (fork of ${id})`,
        model: model ?? source.model,
        system_prompt: system_prompt ?? source.system_prompt,
        version: '1.0',
      };

      writeYaml(forkPath, forked);

      // Register forked agent in model routing
      setModelRouting(mdlPath, newId, forked.model);

      // Preserve reports_to relationship if source had one
      if (forked.collaboration?.reports_to) {
        addToDelegation(delPath, forked.collaboration.reports_to, newId);
      }

      appendAuditEntry(auditDb, {
        actor: 'api',
        action: 'agent.fork',
        target: newId,
        details: { agentId: newId, sourceAgentId: id, source: 'POST /api/v5/agents/:id/fork' },
      });

      // Keep the Claude Code mirror in sync (best-effort).
      await regenerateClaudeMirror(newId, forked);

      globalStream.emit({
        type: 'agent_activity',
        category: 'agent_crud',
        message: `Agent "${newId}" forked from "${id}"`,
        data: { type: 'forked', agentId: newId, sourceAgentId: id },
      });

      return reply.status(201).send({ data: forked });
    },
  );

  // ── POST /api/v5/agents/:id/promote — Promote seniority ──────────────────

  app.post<{ Params: { id: string }; Body: PromoteBody }>(
    '/api/v5/agents/:id/promote',
    async (req, reply) => {
      const { id } = req.params;
      if (!SAFE_AGENT_ID.test(id)) return reply.status(400).send({ error: 'Invalid agent id' });

      const existing = readAgent(id);
      if (!existing) return reply.status(404).send({ error: `Agent "${id}" not found` });

      const { newSeniority, approvedBy } = req.body;

      if (!newSeniority) return reply.status(400).send({ error: 'newSeniority is required' });
      if (!approvedBy) return reply.status(400).send({ error: 'approvedBy is required' });

      const validSeniorities = ['mid', 'senior', 'lead', 'principal'];
      if (!validSeniorities.includes(newSeniority)) {
        return reply.status(400).send({
          error: `newSeniority must be one of: ${validSeniorities.join(', ')}`,
        });
      }

      // Determine model tier based on new seniority
      const newModel = modelForSeniority(newSeniority);

      const updated: AgentYaml = {
        ...existing,
        seniority: newSeniority,
        model: newModel,
      };

      // agentFilePath returns null only if id escapes agentsDir; SAFE_AGENT_ID
      // check above ensures this cannot happen, but we guard for type safety.
      const promotePath = agentFilePath(id);
      if (!promotePath) return reply.status(400).send({ error: 'Invalid agent id' });
      writeYaml(promotePath, updated);

      // Sync model routing
      setModelRouting(mdlPath, id, newModel);

      appendAuditEntry(auditDb, {
        actor: 'api',
        action: 'agent.promote',
        target: id,
        details: { agentId: id, newSeniority, newModel, approvedBy, source: 'POST /api/v5/agents/:id/promote' },
      });

      // Keep the Claude Code mirror in sync (best-effort).
      await regenerateClaudeMirror(id, updated);

      globalStream.emit({
        type: 'agent_activity',
        category: 'agent_crud',
        message: `Agent "${id}" promoted to ${newSeniority} (approved by ${approvedBy})`,
        data: { type: 'promoted', agentId: id, newSeniority, newModel, approvedBy },
      });

      return reply.send({ data: updated });
    },
  );
}
