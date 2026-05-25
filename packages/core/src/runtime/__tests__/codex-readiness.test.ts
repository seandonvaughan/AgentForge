import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCodexReadinessReport } from '../codex-readiness.js';

describe('buildCodexReadinessReport', () => {
  let projectRoot: string | undefined;

  afterEach(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = undefined;
    }
  });

  it('reports ready when agents, Codex CLI, model profiles, and MCP build output are valid', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-codex-ready-'));
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'agents', 'coder.yaml'),
      [
        'name: Coder',
        'model: sonnet',
        'effort: low',
        'system_prompt: You write code.',
        '',
      ].join('\n'),
    );
    const mcpServerPath = join(projectRoot, 'mcp-server.js');
    writeFileSync(mcpServerPath, 'console.log("ok");\n');

    const report = buildCodexReadinessReport({
      projectRoot,
      checkLogin: false,
      checkDoctor: false,
      codexCliAvailable: true,
      mcpServerPath,
      env: {},
    });

    expect(report.ready).toBe(true);
    expect(report.mcpServerAvailable).toBe(true);
    expect(report.agents[0]).toMatchObject({
      agentId: 'coder',
      codexModel: 'gpt-5.3-codex',
      codexEffort: 'low',
      valid: true,
    });
  });

  it('accepts max effort because the Codex runtime supports it', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-codex-ready-max-'));
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'agents', 'coder.yaml'),
      [
        'name: Coder',
        'model: sonnet',
        'effort: max',
        'system_prompt: You write code.',
        '',
      ].join('\n'),
    );
    const mcpServerPath = join(projectRoot, 'mcp-server.js');
    writeFileSync(mcpServerPath, 'console.log("ok");\n');

    const report = buildCodexReadinessReport({
      projectRoot,
      checkLogin: false,
      checkDoctor: false,
      codexCliAvailable: true,
      mcpServerPath,
      env: {},
    });

    expect(report.ready).toBe(true);
    expect(report.agents[0]).toMatchObject({
      agentId: 'coder',
      codexEffort: 'max',
      valid: true,
    });
  });

  it('fails readiness when MCP server build output is missing', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-codex-not-ready-'));
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'agents', 'coder.yaml'),
      [
        'name: Coder',
        'model: sonnet',
        'system_prompt: You write code.',
        '',
      ].join('\n'),
    );

    const report = buildCodexReadinessReport({
      projectRoot,
      checkLogin: false,
      checkDoctor: false,
      codexCliAvailable: true,
      mcpServerPath: join(projectRoot, 'missing.js'),
      env: {},
    });

    expect(report.ready).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('MCP server'))).toBe(true);
  });

  it('fails readiness when agent YAML uses a raw provider model instead of a capability tier', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-codex-invalid-tier-'));
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'agents', 'coder.yaml'),
      [
        'name: Coder',
        'model: gpt-5.3-codex',
        'system_prompt: You write code.',
        '',
      ].join('\n'),
    );
    const mcpServerPath = join(projectRoot, 'mcp-server.js');
    writeFileSync(mcpServerPath, 'console.log("ok");\n');

    const report = buildCodexReadinessReport({
      projectRoot,
      checkLogin: false,
      checkDoctor: false,
      codexCliAvailable: true,
      mcpServerPath,
      env: {},
    });

    expect(report.ready).toBe(false);
    expect(report.agents[0]).toMatchObject({
      agentId: 'coder',
      valid: false,
    });
    expect(report.warnings.some((warning) => warning.includes('model: gpt-5.3-codex'))).toBe(true);
  });

  it('includes codex doctor metadata and warnings when requested', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-codex-doctor-'));
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'agents', 'coder.yaml'),
      [
        'name: Coder',
        'model: sonnet',
        'system_prompt: You write code.',
        '',
      ].join('\n'),
    );
    const mcpServerPath = join(projectRoot, 'mcp-server.js');
    writeFileSync(mcpServerPath, 'console.log("ok");\n');

    const report = buildCodexReadinessReport({
      projectRoot,
      checkLogin: false,
      codexCliAvailable: true,
      mcpServerPath,
      env: {},
      doctorJson: JSON.stringify({
        overallStatus: 'warning',
        codexVersion: '0.131.0',
        checks: {
          installation: {
            id: 'installation',
            category: 'install',
            status: 'warning',
            summary: 'npm root unavailable',
          },
        },
      }),
    });

    expect(report.ready).toBe(true);
    expect(report.codexDoctorChecked).toBe(true);
    expect(report.codexDoctorOk).toBe(true);
    expect(report.codexDoctorStatus).toBe('warning');
    expect(report.codexDoctorVersion).toBe('0.131.0');
    expect(report.warnings.some((warning) => warning.includes('codex doctor warning'))).toBe(true);
  });
});
