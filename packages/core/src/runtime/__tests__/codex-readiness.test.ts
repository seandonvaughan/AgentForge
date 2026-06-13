import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCodexReadinessReport, redactCodexReadinessText } from '../codex-readiness.js';

const execProbeOk = () => ({ status: 0, stdout: 'agentforge-codex-readiness-ok\n', stderr: '' });

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
      runCodexExecProbe: execProbeOk,
    });

    expect(report.ready).toBe(true);
    expect(report.codexExecProbeChecked).toBe(true);
    expect(report.codexExecProbeOk).toBe(true);
    expect(report.codexExecProbeStatus).toBe('passed');
    expect(report.mcpServerAvailable).toBe(true);
    expect(report.agents[0]).toMatchObject({
      agentId: 'coder',
      codexModel: 'gpt-5.5',
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
      runCodexExecProbe: execProbeOk,
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
      runCodexExecProbe: execProbeOk,
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
      runCodexExecProbe: execProbeOk,
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
      runCodexExecProbe: execProbeOk,
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

  it('fails readiness with a redacted warning when codex exec preflight fails', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-codex-exec-fail-'));
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
      env: { OPENAI_API_KEY: 'sk-testSECRETSECRET1234567890' },
      doctorJson: JSON.stringify({ overallStatus: 'ok', checks: {} }),
      runCodexExecProbe: () => ({
        status: 2,
        stdout: '',
        stderr: `${projectRoot} failed with sk-testSECRETSECRET1234567890`,
      }),
    });

    expect(report.ready).toBe(false);
    expect(report.codexDoctorChecked).toBe(true);
    expect(report.codexDoctorOk).toBe(true);
    expect(report.codexExecProbeChecked).toBe(true);
    expect(report.codexExecProbeOk).toBe(false);
    expect(report.codexExecProbeStatus).toBe('failed');
    expect(report.codexExecProbeExitCode).toBe(2);
    expect(report.codexExecProbeMessage).toContain('[project-root]');
    expect(report.codexExecProbeMessage).toContain('[redacted-secret]');
    expect(report.codexExecProbeMessage).not.toContain(projectRoot);
    expect(report.codexExecProbeMessage).not.toContain('sk-testSECRETSECRET1234567890');
    expect(report.warnings.some((warning) => warning.includes('codex exec preflight failed'))).toBe(true);
  });

  it('fails readiness when codex exec exits 0 without the readiness sentinel', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-codex-exec-sentinel-'));
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
      checkDoctor: false,
      codexCliAvailable: true,
      mcpServerPath,
      env: {},
      runCodexExecProbe: () => ({
        status: 0,
        stdout: '{"type":"message","message":"wrong output"}\n',
        stderr: '',
      }),
    });

    expect(report.ready).toBe(false);
    expect(report.codexExecProbeOk).toBe(false);
    expect(report.codexExecProbeStatus).toBe('failed');
    expect(report.codexExecProbeExitCode).toBe(0);
    expect(report.codexExecProbeMessage).toContain('without the expected readiness sentinel');
  });

  it('requires the final Codex JSON agent message to exactly match the readiness sentinel', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-codex-exec-exact-sentinel-'));
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
      checkDoctor: false,
      codexCliAvailable: true,
      mcpServerPath,
      env: {},
      runCodexExecProbe: () => ({
        status: 0,
        stdout: [
          '{"type":"thread.started","thread_id":"test"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"prefix agentforge-codex-readiness-ok suffix"}}',
        ].join('\n'),
        stderr: '',
      }),
    });

    expect(report.ready).toBe(false);
    expect(report.codexExecProbeOk).toBe(false);
    expect(report.codexExecProbeMessage).toContain('without the expected readiness sentinel');
  });

  it('accepts the real Codex JSON event shape for an exact readiness sentinel', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-codex-exec-json-sentinel-'));
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
      checkDoctor: false,
      codexCliAvailable: true,
      mcpServerPath,
      env: {},
      runCodexExecProbe: () => ({
        status: 0,
        stdout: [
          '{"type":"thread.started","thread_id":"test"}',
          '{"type":"turn.started"}',
          '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"agentforge-codex-readiness-ok"}}',
          '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
        ].join('\n'),
        stderr: 'WARN diagnostic that should not affect success',
      }),
    });

    expect(report.ready).toBe(true);
    expect(report.codexExecProbeOk).toBe(true);
    expect(report.codexExecProbeStatus).toBe('passed');
  });

  it('redacts broad secret formats before diagnostics are exposed', () => {
    const projectRoot = join(tmpdir(), 'agentforge-secret-project');
    const text = [
      projectRoot,
      'Bearer abcdefghijklmnopqrstuvwxyz1234567890',
      'https://user:password@example.test/path',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop.qrstuvwxyz123456',
      'AccountKey=abc1234567890SECRET;',
      'github_pat_11SECRETSECRETSECRETSECRET',
      'custom secret is custom-secret-value-12345',
    ].join(' ');

    const redacted = redactCodexReadinessText(text, {
      projectRoot,
      env: { CUSTOM_SECRET: 'custom-secret-value-12345' },
    });

    expect(redacted).toContain('[project-root]');
    expect(redacted).toContain('Bearer [redacted-secret]');
    expect(redacted).toContain('https://[redacted-secret]@example.test/path');
    expect(redacted).toContain('AccountKey=[redacted-secret];');
    expect(redacted).not.toContain(projectRoot);
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    expect(redacted).not.toContain('user:password');
    expect(redacted).not.toContain('custom-secret-value-12345');
    expect(redacted).not.toContain('github_pat_11SECRETSECRETSECRETSECRET');
  });
});
