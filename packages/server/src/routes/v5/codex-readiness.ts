import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { buildCodexReadinessReport } from '@agentforge/core';

type CodexReadinessReport = ReturnType<typeof buildCodexReadinessReport>;
type CodexReadinessReportBuilder = typeof buildCodexReadinessReport;

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
  opts: { projectRoot?: string; readinessReportBuilder?: CodexReadinessReportBuilder } = {},
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
    const buildReport = opts.readinessReportBuilder ?? buildCodexReadinessReport;
    const report = buildReport({
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
          codexExecProbeChecked: report.codexExecProbeChecked,
          codexExecProbeOk: report.codexExecProbeOk,
          codexExecProbeStatus: report.codexExecProbeStatus,
          codexExecProbeLaunchKind: report.codexExecProbeLaunchKind ?? null,
          codexExecProbeExitCode: report.codexExecProbeExitCode ?? null,
          codexExecProbeDurationMs: report.codexExecProbeDurationMs ?? null,
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
          exec: {
            label: 'Codex exec preflight',
            ok: report.codexExecProbeOk,
            detail: codexExecProbeDetail(report),
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
        warnings: report.warnings.map((warning) => redactReadinessDetail(warning, report.projectRoot)),
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  });
}

function codexExecProbeDetail(report: CodexReadinessReport): string | undefined {
  const detail = [
    `status ${report.codexExecProbeStatus}`,
    report.codexExecProbeLaunchKind ? `launch ${report.codexExecProbeLaunchKind}` : null,
    report.codexExecProbeExitCode !== undefined ? `exit ${report.codexExecProbeExitCode ?? 'null'}` : null,
    report.codexExecProbeDurationMs !== undefined ? `${report.codexExecProbeDurationMs}ms` : null,
    report.codexExecProbeMessage ?? null,
  ].filter(Boolean).join(', ');
  return redactReadinessDetail(detail, report.projectRoot);
}

function redactReadinessDetail(value: string, projectRoot: string): string {
  let redacted = projectRoot.trim() ? value.split(projectRoot).join('[project-root]') : value;
  for (const prefix of ['sk-ant-', 'sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
    redacted = redactTokenPrefix(redacted, prefix);
  }
  return redacted;
}

function redactTokenPrefix(value: string, prefix: string): string {
  let redacted = value;
  let index = redacted.indexOf(prefix);
  while (index !== -1) {
    let end = index + prefix.length;
    while (end < redacted.length && isTokenChar(redacted[end] ?? '')) end += 1;
    if (end - index >= prefix.length + 12) {
      redacted = `${redacted.slice(0, index)}[redacted-secret]${redacted.slice(end)}`;
      index = redacted.indexOf(prefix, index + '[redacted-secret]'.length);
    } else {
      index = redacted.indexOf(prefix, end);
    }
  }
  return redacted;
}

function isTokenChar(char: string): boolean {
  return (char >= 'a' && char <= 'z')
    || (char >= 'A' && char <= 'Z')
    || (char >= '0' && char <= '9')
    || char === '_'
    || char === '-';
}
