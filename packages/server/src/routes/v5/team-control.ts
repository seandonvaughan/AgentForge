import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { forgeTeamService, rebuildTeamService } from '@agentforge/core';
import { globalStream } from './stream.js';

type CapabilityTier = 'fable' | 'opus' | 'sonnet' | 'haiku';

interface TeamActionBody {
  dryRun?: boolean;
  verbose?: boolean;
  domains?: string;
  autoApply?: boolean;
  upgrade?: boolean;
}

interface TeamStatus {
  teamName: string | null;
  forgedAt: string | null;
  agentCount: number;
  modelCounts: Record<CapabilityTier, number>;
  hasTeamYaml: boolean;
  modifiedAt: string | null;
}

const TIERS: CapabilityTier[] = ['fable', 'opus', 'sonnet', 'haiku'];

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readYamlFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = yaml.load(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function countAgentsByModel(projectRoot: string): Pick<TeamStatus, 'agentCount' | 'modelCounts'> {
  const modelCounts: Record<CapabilityTier, number> = { fable: 0, opus: 0, sonnet: 0, haiku: 0 };
  const agentsDir = join(projectRoot, '.agentforge', 'agents');
  if (!existsSync(agentsDir)) return { agentCount: 0, modelCounts };

  let agentCount = 0;
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    agentCount += 1;
    const parsed = readYamlFile(join(agentsDir, file));
    const tier = safeString(parsed?.['model'])?.toLowerCase();
    if (tier === 'opus' || tier === 'sonnet' || tier === 'haiku') {
      modelCounts[tier] += 1;
    }
  }

  return { agentCount, modelCounts };
}

function readTeamStatus(projectRoot: string): TeamStatus {
  const teamYamlPath = join(projectRoot, '.agentforge', 'team.yaml');
  const parsed = existsSync(teamYamlPath) ? readYamlFile(teamYamlPath) : null;
  const { agentCount, modelCounts } = countAgentsByModel(projectRoot);
  const stat = existsSync(teamYamlPath) ? statSync(teamYamlPath) : null;

  return {
    teamName: safeString(parsed?.['name']),
    forgedAt: safeString(parsed?.['forged_at']),
    agentCount,
    modelCounts,
    hasTeamYaml: existsSync(teamYamlPath),
    modifiedAt: stat ? stat.mtime.toISOString() : null,
  };
}

function parseDomains(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const domains = value
    .split(',')
    .map((domain) => domain.trim())
    .filter(Boolean);
  return domains.length > 0 ? domains.join(',') : undefined;
}

export async function teamControlRoutes(
  app: FastifyInstance,
  opts: { projectRoot?: string } = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  app.get('/api/v5/team/status', async (_req, reply) => {
    return reply.send({ data: readTeamStatus(projectRoot) });
  });

  app.post<{ Body: TeamActionBody }>('/api/v5/team/forge', async (req, reply) => {
    const body = req.body ?? {};
    const domains = parseDomains(body.domains);
    const exitCode = await forgeTeamService(projectRoot, {
      dryRun: body.dryRun === true,
      verbose: body.verbose === true,
      ...(domains !== undefined ? { domains } : {}),
    });
    const status = readTeamStatus(projectRoot);
    globalStream.emit({
      type: 'system',
      category: 'team',
      message: body.dryRun === true ? 'Team forge preview completed' : 'Team forge completed',
      data: { action: body.dryRun === true ? 'team.forge.preview' : 'team.forge', exitCode, status },
    });
    return reply.status(exitCode === 0 ? 200 : 500).send({ data: { exitCode, status } });
  });

  app.post<{ Body: TeamActionBody }>('/api/v5/team/rebuild', async (req, reply) => {
    const body = req.body ?? {};
    const exitCode = await rebuildTeamService(projectRoot, {
      autoApply: body.autoApply === true,
      upgrade: body.upgrade === true,
    });
    const status = readTeamStatus(projectRoot);
    globalStream.emit({
      type: 'system',
      category: 'team',
      message: 'Team rebuild completed',
      data: { action: 'team.rebuild', exitCode, status },
    });
    return reply.status(exitCode === 0 ? 200 : 500).send({ data: { exitCode, status } });
  });
}
