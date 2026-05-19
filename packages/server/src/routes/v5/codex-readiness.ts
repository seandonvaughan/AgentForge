import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { buildCodexReadinessReport } from '@agentforge/core';

interface CodexReadinessQuery {
  projectRoot?: string;
  skipLogin?: string | boolean;
  includeDoctor?: string | boolean;
}

function parseBoolean(value: string | boolean | undefined): boolean {
  return value === true || value === 'true' || value === '1';
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

export async function codexReadinessRoutes(
  app: FastifyInstance,
  opts: { projectRoot?: string } = {},
): Promise<void> {
  app.get<{ Querystring: CodexReadinessQuery }>('/api/v5/codex/readiness', async (req, reply) => {
    const projectRoot = resolve(opts.projectRoot || process.cwd());
    const requestedProjectRoot = req.query.projectRoot?.trim();
    if (requestedProjectRoot && !samePath(requestedProjectRoot, projectRoot)) {
      return reply.status(400).send({
        error: 'projectRoot must match the server-configured AgentForge project root',
        code: 'PROJECT_ROOT_NOT_ALLOWED',
      });
    }
    const skipLogin = parseBoolean(req.query.skipLogin);
    const includeDoctor = parseBoolean(req.query.includeDoctor);
    const report = buildCodexReadinessReport({
      projectRoot,
      checkLogin: !skipLogin,
      checkDoctor: includeDoctor,
    });

    const status = report.ready ? 'ready' : 'degraded';

    return reply.send({
      data: {
        projectRoot: report.projectRoot,
        ready: report.ready,
        status,
        summary: {
          agentCount: report.agents.length,
          warningCount: report.warnings.length,
          codexCliAvailable: report.codexCliAvailable,
          codexDoctorChecked: report.codexDoctorChecked,
          codexDoctorOk: report.codexDoctorOk,
          codexDoctorStatus: report.codexDoctorStatus ?? null,
          codexDoctorVersion: report.codexDoctorVersion ?? null,
          mcpServerAvailable: report.mcpServerAvailable,
          codexLoginChecked: report.codexLoginChecked,
          codexLoginOk: report.codexLoginOk,
        },
        checks: {
          cli: {
            label: 'Codex CLI',
            ok: report.codexCliAvailable,
          },
          doctor: {
            label: 'Codex doctor',
            ok: report.codexDoctorOk,
            detail: [
              report.codexDoctorVersion ? `Codex ${report.codexDoctorVersion}` : null,
              report.codexDoctorStatus ? `status ${report.codexDoctorStatus}` : null,
            ].filter(Boolean).join(', ') || undefined,
          },
          mcpServer: {
            label: 'AgentForge MCP server',
            ok: report.mcpServerAvailable,
            detail: report.mcpServerPath,
          },
          login: {
            label: 'Codex login',
            ok: report.codexLoginOk,
            ...(report.codexLoginMessage ? { detail: report.codexLoginMessage } : {}),
          },
          agents: {
            label: 'Agent profiles',
            ok: report.agents.length > 0 && report.agents.every((agent) => agent.valid),
            detail: `${report.agents.length} agent${report.agents.length === 1 ? '' : 's'}`,
          },
        },
        agents: report.agents,
        warnings: report.warnings,
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  });
}
