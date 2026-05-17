import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';

import {
  CcNotAvailableError,
  isCcRuntimeAvailable,
  invokeViaClaudeCode,
  type CcAgentSpec,
  type CcInvokeMarker,
} from '../cc-native-invoker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'agentforge-cc-test-'));
}

function plantCcAgentFile(projectRoot: string, agentId: string): void {
  const dir = join(projectRoot, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentId}.md`), `---\nname: ${agentId}\ndescription: test\n---\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Env isolation — save / restore CLAUDE_CODE_RUNTIME around each test
// ---------------------------------------------------------------------------

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['CLAUDE_CODE_RUNTIME'];
  delete process.env['CLAUDE_CODE_RUNTIME'];
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env['CLAUDE_CODE_RUNTIME'];
  } else {
    process.env['CLAUDE_CODE_RUNTIME'] = savedEnv;
  }
});

// ---------------------------------------------------------------------------
// isCcRuntimeAvailable — pure detection tests
// ---------------------------------------------------------------------------

describe('isCcRuntimeAvailable', () => {
  it('returns false when env is absent and no .claude/agents/ file exists', () => {
    const root = makeTmpProject();
    try {
      expect(isCcRuntimeAvailable('my-agent', root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when CLAUDE_CODE_RUNTIME=1 even without the agent file (env wins)', () => {
    process.env['CLAUDE_CODE_RUNTIME'] = '1';
    const root = makeTmpProject();
    try {
      expect(isCcRuntimeAvailable('no-such-agent', root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when .claude/agents/<id>.md exists even if env is absent (file wins)', () => {
    const root = makeTmpProject();
    try {
      plantCcAgentFile(root, 'react-engineer');
      expect(isCcRuntimeAvailable('react-engineer', root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when CLAUDE_CODE_RUNTIME=0 and no file exists', () => {
    process.env['CLAUDE_CODE_RUNTIME'] = '0';
    const root = makeTmpProject();
    try {
      expect(isCcRuntimeAvailable('agent-x', root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns true when both env=1 and file exist', () => {
    process.env['CLAUDE_CODE_RUNTIME'] = '1';
    const root = makeTmpProject();
    try {
      plantCcAgentFile(root, 'dual-agent');
      expect(isCcRuntimeAvailable('dual-agent', root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CcNotAvailableError
// ---------------------------------------------------------------------------

describe('CcNotAvailableError', () => {
  it('has the correct name and agentId property', () => {
    const err = new CcNotAvailableError('my-agent');
    expect(err.name).toBe('CcNotAvailableError');
    expect(err.agentId).toBe('my-agent');
    expect(err.message).toContain('my-agent');
  });
});

// ---------------------------------------------------------------------------
// invokeViaClaudeCode — integration tests
// ---------------------------------------------------------------------------

describe('invokeViaClaudeCode', () => {
  it('throws CcNotAvailableError when neither env nor file is present', async () => {
    const root = makeTmpProject();
    try {
      await expect(
        invokeViaClaudeCode({ agentId: 'missing-agent', task: 'do stuff', projectRoot: root }),
      ).rejects.toThrow(CcNotAvailableError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns cc-native result when CLAUDE_CODE_RUNTIME=1 (env wins, no file)', async () => {
    process.env['CLAUDE_CODE_RUNTIME'] = '1';
    const root = makeTmpProject();
    try {
      const result = await invokeViaClaudeCode({
        agentId: 'env-only-agent',
        task: 'run the env path',
        projectRoot: root,
      });
      expect(result.via).toBe('cc-native');
      expect(result.marker.agentId).toBe('env-only-agent');
      expect(result.marker.task).toBe('run the env path');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns cc-native result when .claude/agents/ file exists (file wins, env absent)', async () => {
    const root = makeTmpProject();
    try {
      plantCcAgentFile(root, 'file-only-agent');
      const result = await invokeViaClaudeCode({
        agentId: 'file-only-agent',
        task: 'run the file path',
        projectRoot: root,
      });
      expect(result.via).toBe('cc-native');
      expect(result.marker.agentId).toBe('file-only-agent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a JSON marker file to .agentforge/ and its content matches the marker', async () => {
    process.env['CLAUDE_CODE_RUNTIME'] = '1';
    const root = makeTmpProject();
    try {
      const result = await invokeViaClaudeCode({
        agentId: 'marker-test-agent',
        task: 'verify marker file',
        projectRoot: root,
      });

      // The marker file must exist
      const markerPath = join(root, '.agentforge', `cc-invoke-marker-${result.marker.sessionId}.json`);
      expect(existsSync(markerPath)).toBe(true);

      const written = JSON.parse(readFileSync(markerPath, 'utf8')) as CcInvokeMarker;
      expect(written.agentId).toBe('marker-test-agent');
      expect(written.task).toBe('verify marker file');
      expect(written.sessionId).toBe(result.marker.sessionId);
      expect(written.requestedAt).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('response is valid JSON containing via, agentId, and sessionId', async () => {
    process.env['CLAUDE_CODE_RUNTIME'] = '1';
    const root = makeTmpProject();
    try {
      const result = await invokeViaClaudeCode({
        agentId: 'json-surface-agent',
        task: 'check json surface',
        projectRoot: root,
      });

      const parsed = JSON.parse(result.response) as Record<string, unknown>;
      expect(parsed['via']).toBe('cc-native');
      expect(parsed['agentId']).toBe('json-surface-agent');
      expect(parsed['sessionId']).toBe(result.marker.sessionId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('env=1 + file present: still returns cc-native (both detected)', async () => {
    process.env['CLAUDE_CODE_RUNTIME'] = '1';
    const root = makeTmpProject();
    try {
      plantCcAgentFile(root, 'dual-signal-agent');
      const result = await invokeViaClaudeCode({
        agentId: 'dual-signal-agent',
        task: 'both signals present',
        projectRoot: root,
      });
      expect(result.via).toBe('cc-native');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('each invocation produces a unique sessionId', async () => {
    process.env['CLAUDE_CODE_RUNTIME'] = '1';
    const root = makeTmpProject();
    try {
      const [r1, r2] = await Promise.all([
        invokeViaClaudeCode({ agentId: 'a', task: 't1', projectRoot: root }),
        invokeViaClaudeCode({ agentId: 'a', task: 't2', projectRoot: root }),
      ]);
      expect(r1.marker.sessionId).not.toBe(r2.marker.sessionId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CcAgentSpec — type-level smoke test (no runtime assertions needed)
// ---------------------------------------------------------------------------

describe('CcAgentSpec shape', () => {
  it('accepts a well-formed CcAgentSpec object', () => {
    const spec: CcAgentSpec = {
      id: 'react-component-engineer',
      description: 'Writes React components',
      systemPrompt: 'You are a React expert.',
      model: 'sonnet',
      tools: ['Read', 'Write', 'Edit'],
    };
    expect(spec.id).toBe('react-component-engineer');
    expect(spec.model).toBe('sonnet');
  });

  it('allows optional model and tools to be omitted', () => {
    const spec: CcAgentSpec = {
      id: 'minimal-agent',
      description: 'Minimal agent',
      systemPrompt: 'You help.',
    };
    expect(spec.model).toBeUndefined();
    expect(spec.tools).toBeUndefined();
  });
});
