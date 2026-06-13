import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { buildCodexReadinessReport } from '@agentforge/core';
import { codexReadinessRoutes } from '../codex-readiness.js';

const tempRoots: string[] = [];
type ReadinessReport = ReturnType<typeof buildCodexReadinessReport>;

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentforge-readiness-'));
  tempRoots.push(root);
  mkdirSync(join(root, '.agentforge', 'agents'), { recursive: true });
  mkdirSync(join(root, 'packages', 'mcp-server', 'dist'), { recursive: true });
  writeFileSync(join(root, 'packages', 'mcp-server', 'dist', 'index.js'), 'export {};');
  writeFileSync(join(root, '.agentforge', 'agents', 'coder.yaml'), [
    'name: Coder',
    'model: sonnet',
    'effort: high',
    '',
  ].join('\n'));
  return root;
}

function makeReadinessReport(
  projectRoot: string,
  overrides: Partial<ReadinessReport> = {},
): ReadinessReport {
  return {
    projectRoot,
    codexCliAvailable: true,
    codexCliLaunchKind: 'path-command',
    codexExecProbeChecked: true,
    codexExecProbeOk: true,
    codexExecProbeStatus: 'passed',
    codexExecProbeLaunchKind: 'path-command',
    codexExecProbeExitCode: 0,
    codexExecProbeDurationMs: 12,
    codexExecProbeMessage: 'codex exec preflight completed.',
    codexDoctorChecked: false,
    codexDoctorOk: null,
    mcpServerAvailable: true,
    mcpServerPath: join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js'),
    codexLoginChecked: false,
    codexLoginOk: null,
    codexAuthStatus: 'missing',
    codexAuthReason: 'CODEX_HOME/auth.json was not found.',
    agents: [{
      agentId: 'coder',
      name: 'Coder',
      tier: 'sonnet',
      sourceModel: 'sonnet',
      sourceEffort: 'high',
      codexModel: 'gpt-5.5',
      codexEffort: 'high',
      valid: true,
    }],
    warnings: [],
    ready: true,
    ...overrides,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('GET /api/v5/codex/readiness', () => {
  it('returns a stable dashboard readiness shape and honors skipLogin', async () => {
    const projectRoot = makeProjectRoot();
    const app = Fastify({ logger: false });
    const readinessReportBuilder = vi.fn((options: Parameters<typeof buildCodexReadinessReport>[0]) => {
      expect(options).toMatchObject({
        projectRoot,
        checkLogin: false,
        checkDoctor: false,
      });
      return makeReadinessReport(projectRoot);
    });
    await codexReadinessRoutes(app, { projectRoot, readinessReportBuilder });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/codex/readiness?skipLogin=true&projectRoot=${encodeURIComponent(projectRoot)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        projectRoot: string;
        ready: boolean;
        status: string;
        summary: {
          agentCount: number;
          warningCount: number;
          codexCliAvailable: boolean;
          codexExecProbeChecked: boolean;
          codexExecProbeOk: boolean | null;
          codexExecProbeStatus: string;
          codexExecProbeLaunchKind: string | null;
          codexExecProbeExitCode: number | null;
          codexExecProbeDurationMs: number | null;
          mcpServerAvailable: boolean;
          codexLoginChecked: boolean;
          codexLoginOk: boolean | null;
        };
        checks: Record<string, { ok: boolean | null; label: string; detail?: string }>;
        agents: Array<{ agentId: string; codexModel: string; codexEffort: string; valid: boolean }>;
        warnings: string[];
      };
      meta: { timestamp: string };
    }>();

    expect(body.data.projectRoot).toBe(projectRoot);
    expect(body.data.status).toMatch(/^(ready|degraded)$/);
    expect(body.data.summary.agentCount).toBe(1);
    expect(body.data.summary.codexExecProbeChecked).toBe(true);
    expect(body.data.summary.codexExecProbeOk).toBe(true);
    expect(body.data.summary.codexExecProbeStatus).toBe('passed');
    expect(body.data.checks.exec).toMatchObject({
      label: 'Codex exec preflight',
      ok: true,
    });
    expect(body.data.summary.codexLoginChecked).toBe(false);
    expect(body.data.summary.codexLoginOk).toBeNull();
    const loginCheck = body.data.checks.login;
    expect(loginCheck).toBeDefined();
    expect(loginCheck?.ok).toBeNull();
    expect(body.data.agents[0]).toMatchObject({
      agentId: 'coder',
      codexModel: 'gpt-5.5',
      codexEffort: 'high',
      valid: true,
    });
    expect(typeof body.meta.timestamp).toBe('string');
    expect(readinessReportBuilder).toHaveBeenCalledOnce();

    await app.close();
  });

  it('returns degraded exec preflight status with redacted detail and warnings', async () => {
    const projectRoot = makeProjectRoot();
    const leakedToken = 'sk-testSECRETSECRET1234567890';
    const app = Fastify({ logger: false });
    await codexReadinessRoutes(app, {
      projectRoot,
      readinessReportBuilder: () => makeReadinessReport(projectRoot, {
        ready: false,
        codexExecProbeOk: false,
        codexExecProbeStatus: 'failed',
        codexExecProbeExitCode: 2,
        codexExecProbeMessage: `${projectRoot} failed with ${leakedToken}`,
        warnings: [`codex exec preflight failed (failed, exit 2): ${projectRoot} failed with ${leakedToken}`],
      }),
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/codex/readiness?skipLogin=true',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        ready: boolean;
        status: string;
        summary: {
          codexExecProbeChecked: boolean;
          codexExecProbeOk: boolean | null;
          codexExecProbeStatus: string;
          codexExecProbeExitCode: number | null;
        };
        checks: Record<string, { ok: boolean | null; label: string; detail?: string }>;
        warnings: string[];
      };
    }>();

    expect(body.data.ready).toBe(false);
    expect(body.data.status).toBe('degraded');
    expect(body.data.summary).toMatchObject({
      codexExecProbeChecked: true,
      codexExecProbeOk: false,
      codexExecProbeStatus: 'failed',
      codexExecProbeExitCode: 2,
    });
    expect(body.data.checks.exec).toMatchObject({
      label: 'Codex exec preflight',
      ok: false,
    });
    const execDetail = body.data.checks.exec?.detail ?? '';
    expect(execDetail).toContain('[project-root]');
    expect(execDetail).toContain('[redacted-secret]');
    expect(execDetail).not.toContain(projectRoot);
    expect(execDetail).not.toContain(leakedToken);
    expect(body.data.warnings).toHaveLength(1);
    expect(body.data.warnings[0]).toContain('codex exec preflight failed');
    expect(body.data.warnings[0]).not.toContain(projectRoot);
    expect(body.data.warnings[0]).not.toContain(leakedToken);

    await app.close();
  });

  it('passes includeDoctor through as the optional diagnostic switch', async () => {
    const projectRoot = makeProjectRoot();
    const app = Fastify({ logger: false });
    const readinessReportBuilder = vi.fn(() => makeReadinessReport(projectRoot));
    await codexReadinessRoutes(app, { projectRoot, readinessReportBuilder });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/codex/readiness?skipLogin=true&includeDoctor=true',
    });

    expect(res.statusCode).toBe(200);
    expect(readinessReportBuilder).toHaveBeenCalledWith(expect.objectContaining({
      checkDoctor: true,
      checkLogin: false,
      projectRoot,
    }));

    await app.close();
  });

  it('rejects projectRoot values outside the server-configured root', async () => {
    const projectRoot = makeProjectRoot();
    const otherRoot = makeProjectRoot();
    const app = Fastify({ logger: false });
    await codexReadinessRoutes(app, { projectRoot });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/codex/readiness?skipLogin=true&projectRoot=${encodeURIComponent(otherRoot)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('code', 'PROJECT_ROOT_NOT_ALLOWED');

    await app.close();
  });
});
