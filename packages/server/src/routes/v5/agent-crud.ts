import type { FastifyInstance } from 'fastify';
import { join, dirname } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { globalStream } from './stream.js';

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
  skills?: string[];
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
type ModelsMap = Record<string, string[]>;

// ---------------------------------------------------------------------------
// Request body interfaces
// ---------------------------------------------------------------------------

interface CreateAgentBody {
  id: string;
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  description: string;
  system_prompt: string;
  skills?: string[];
  reports_to?: string;
  seniority?: string;
  layer?: string;
}

interface UpdateAgentBody {
  name?: string;
  model?: 'opus' | 'sonnet' | 'haiku';
  description?: string;
  system_prompt?: string;
  skills?: string[];
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
  writeFileSync(filePath, yaml.dump(data, { lineWidth: 120 }), 'utf-8');
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
    map[tier] = (map[tier] ?? []).filter((id) => id !== agentId);
  }

  // Append to target bucket
  if (!map[model]) map[model] = [];
  if (!map[model].includes(agentId)) {
    map[model] = [...map[model], agentId];
  }

  writeYaml(mdlPath, map);
}

/** Remove agentId from every bucket in models.yaml. */
function removeFromModels(mdlPath: string, agentId: string): void {
  if (!existsSync(mdlPath)) return;
  const map = readYaml<ModelsMap>(mdlPath);
  let changed = false;

  for (const tier of Object.keys(map)) {
    const before = map[tier] ?? [];
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

  /** Full path to an agent YAML file. */
  function agentFilePath(id: string): string {
    return join(agentsDir, `${id}.yaml`);
  }

  /** Read agent YAML; returns null if the file does not exist. */
  function readAgent(id: string): AgentYaml | null {
    const p = agentFilePath(id);
    if (!existsSync(p)) return null;
    return readYaml<AgentYaml>(p);
  }

  // ── POST /api/v5/agents — Create a new agent ──────────────────────────────

  app.post<{ Body: CreateAgentBody }>('/api/v5/agents', async (req, reply) => {
    const { id, name, model, description, system_prompt, skills, reports_to, seniority, layer } =
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
    if (!['opus', 'sonnet', 'haiku'].includes(model)) {
      return reply.status(400).send({ error: 'model must be one of: opus, sonnet, haiku' });
    }

    // Prevent overwriting an existing agent
    if (existsSync(agentFilePath(id))) {
      return reply.status(409).send({ error: `Agent "${id}" already exists` });
    }

    const agentYaml: AgentYaml = {
      name,
      model,
      version: '1.0',
      description,
      system_prompt,
      ...(seniority ? { seniority } : {}),
      ...(layer ? { layer } : {}),
      ...(skills?.length ? { skills } : {}),
      collaboration: {
        ...(reports_to ? { reports_to } : {}),
        can_delegate_to: [],
        parallel: false,
      },
    };

    writeYaml(agentFilePath(id), agentYaml);

    // Wire into delegation hierarchy
    if (reports_to) addToDelegation(delPath, reports_to, id);

    // Register in model routing
    setModelRouting(mdlPath, id, model);

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
      const existing = readAgent(id);
      if (!existing) return reply.status(404).send({ error: `Agent "${id}" not found` });

      const { name, model, description, system_prompt, skills, reports_to, seniority } = req.body;

      // Validate model if provided
      if (model !== undefined && !['opus', 'sonnet', 'haiku'].includes(model)) {
        return reply.status(400).send({ error: 'model must be one of: opus, sonnet, haiku' });
      }

      const updated: AgentYaml = {
        ...existing,
        ...(name !== undefined ? { name } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(system_prompt !== undefined ? { system_prompt } : {}),
        ...(skills !== undefined ? { skills } : {}),
        ...(seniority !== undefined ? { seniority } : {}),
        collaboration: {
          ...existing.collaboration,
          ...(reports_to !== undefined ? { reports_to } : {}),
        },
      };

      writeYaml(agentFilePath(id), updated);

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
    if (!existsSync(agentFilePath(id))) {
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

    unlinkSync(agentFilePath(id));
    removeFromDelegation(delPath, id);
    removeFromModels(mdlPath, id);

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
      const source = readAgent(id);
      if (!source) return reply.status(404).send({ error: `Agent "${id}" not found` });

      const { newId, name, model, system_prompt } = req.body;

      if (!newId) return reply.status(400).send({ error: 'newId is required' });

      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newId)) {
        return reply.status(400).send({ error: 'newId must be kebab-case' });
      }

      if (existsSync(agentFilePath(newId))) {
        return reply.status(409).send({ error: `Agent "${newId}" already exists` });
      }

      if (model !== undefined && !['opus', 'sonnet', 'haiku'].includes(model)) {
        return reply.status(400).send({ error: 'model must be one of: opus, sonnet, haiku' });
      }

      const forked: AgentYaml = {
        ...source,
        name: name ?? `${source.name} (fork of ${id})`,
        model: model ?? source.model,
        system_prompt: system_prompt ?? source.system_prompt,
        version: '1.0',
      };

      writeYaml(agentFilePath(newId), forked);

      // Register forked agent in model routing
      setModelRouting(mdlPath, newId, forked.model);

      // Preserve reports_to relationship if source had one
      if (forked.collaboration?.reports_to) {
        addToDelegation(delPath, forked.collaboration.reports_to, newId);
      }

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

      writeYaml(agentFilePath(id), updated);

      // Sync model routing
      setModelRouting(mdlPath, id, newModel);

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
