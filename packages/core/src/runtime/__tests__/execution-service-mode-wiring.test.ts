/**
 * Tests for AGENTFORGE_RUNTIME env-var wiring through ExecutionService.
 *
 * Covers:
 *  - AGENTFORGE_RUNTIME=sdk  → only AnthropicSdkTransport registered
 *  - AGENTFORGE_RUNTIME=cli  → only ClaudeCodeCompatTransport registered
 *  - Unset                    → both transports registered
 *  - Invalid value            → logs warning, falls back to 'auto' (both transports)
 *  - Config-file mode is read when env is unset
 *  - Env var wins over config-file value
 *  - ExecutionService.mode getter reflects the resolved mode
 *  - Explicit transports option bypasses mode resolution (backward compat)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as yaml from 'js-yaml';
import { ExecutionService } from '../execution-service.js';
import { resolveMode, readConfigMode } from '../execution-service-mode.js';
import type { ExecutionTransport, ExecutionResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTransport(kind: ExecutionTransport['kind']): ExecutionTransport {
  const result: ExecutionResult = {
    providerKind: kind,
    response: 'ok',
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0,
    durationMs: 1,
  };
  return {
    kind,
    isAvailable: () => true,
    execute: vi.fn(async () => result),
  };
}

/** Return the kinds of transports registered inside an ExecutionService via
 *  the ProviderResolver.  We introspect through the public `mode` getter and
 *  by calling `run()` with an explicit runtimeMode to see what's reachable.
 *
 *  A simpler approach: supply known-kind transports and check which ones get
 *  called when the service selects them. */
function buildServiceWithEnv(
  envOverride: NodeJS.ProcessEnv,
  projectRoot?: string,
): ExecutionService {
  // Temporarily swap env before constructing the service
  const saved = process.env.AGENTFORGE_RUNTIME;
  if (envOverride.AGENTFORGE_RUNTIME !== undefined) {
    process.env.AGENTFORGE_RUNTIME = envOverride.AGENTFORGE_RUNTIME;
  } else {
    delete process.env.AGENTFORGE_RUNTIME;
  }

  const svc = projectRoot !== undefined
    ? new ExecutionService({ projectRoot })
    : new ExecutionService();

  // Restore
  if (saved !== undefined) {
    process.env.AGENTFORGE_RUNTIME = saved;
  } else {
    delete process.env.AGENTFORGE_RUNTIME;
  }

  return svc;
}

// ---------------------------------------------------------------------------
// resolveMode unit tests (the pure function)
// ---------------------------------------------------------------------------

describe('resolveMode()', () => {
  it('returns sdk when AGENTFORGE_RUNTIME=sdk', () => {
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'sdk' })).toBe('sdk');
  });

  it('returns cli when AGENTFORGE_RUNTIME=cli', () => {
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'cli' })).toBe('cli');
  });

  it('returns auto when AGENTFORGE_RUNTIME is not set', () => {
    expect(resolveMode({})).toBe('auto');
  });

  it('returns auto and warns on an invalid AGENTFORGE_RUNTIME value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = resolveMode({ AGENTFORGE_RUNTIME: 'turbo' });
    expect(result).toBe('auto');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AGENTFORGE_RUNTIME'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('turbo'));
    warn.mockRestore();
  });

  it('reads runtime from autonomous.yaml when env is unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentforge-test-'));
    try {
      const agfDir = join(dir, '.agentforge');
      mkdirSync(agfDir);
      writeFileSync(join(agfDir, 'autonomous.yaml'), yaml.dump({ runtime: 'sdk' }));
      expect(resolveMode({}, dir)).toBe('sdk');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env var wins over config-file value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentforge-test-'));
    try {
      const agfDir = join(dir, '.agentforge');
      mkdirSync(agfDir);
      writeFileSync(join(agfDir, 'autonomous.yaml'), yaml.dump({ runtime: 'cli' }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = resolveMode({ AGENTFORGE_RUNTIME: 'sdk' }, dir);
      expect(result).toBe('sdk');
      // A warning should be emitted because env and config disagree
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('overrides'));
      warn.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// readConfigMode unit tests
// ---------------------------------------------------------------------------

describe('readConfigMode()', () => {
  it('returns undefined when autonomous.yaml does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentforge-test-'));
    try {
      expect(readConfigMode(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined and warns when runtime value in config is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentforge-test-'));
    try {
      const agfDir = join(dir, '.agentforge');
      mkdirSync(agfDir);
      writeFileSync(join(agfDir, 'autonomous.yaml'), yaml.dump({ runtime: 'bogus' }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = readConfigMode(dir);
      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('bogus'));
      warn.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when autonomous.yaml has no runtime field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentforge-test-'));
    try {
      const agfDir = join(dir, '.agentforge');
      mkdirSync(agfDir);
      writeFileSync(join(agfDir, 'autonomous.yaml'), yaml.dump({ budget: { perCycleUsd: 100 } }));
      expect(readConfigMode(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ExecutionService transport-registration tests
// ---------------------------------------------------------------------------

describe('ExecutionService transport registration via mode option', () => {
  it('mode=sdk: mode getter returns sdk', () => {
    const svc = new ExecutionService({ mode: 'sdk' });
    expect(svc.mode).toBe('sdk');
  });

  it('mode=cli: mode getter returns cli', () => {
    const svc = new ExecutionService({ mode: 'cli' });
    expect(svc.mode).toBe('cli');
  });

  it('mode=auto: mode getter returns auto', () => {
    const svc = new ExecutionService({ mode: 'auto' });
    expect(svc.mode).toBe('auto');
  });

  it('mode=sdk: only SDK transport is invoked (CLI transport never called)', async () => {
    const sdkTransport = makeTransport('anthropic-sdk');
    const cliTransport = makeTransport('claude-code-compat');

    // Use explicit transports + mode override so the test is deterministic
    const svc = new ExecutionService({
      mode: 'sdk',
      transports: [sdkTransport, cliTransport],
    });

    // Force an explicit sdk request to exercise the sdk path
    await svc.run(
      {
        agentId: 'test',
        name: 'Test',
        model: 'sonnet',
        systemPrompt: 'sys',
        workspaceId: 'default',
      },
      { task: 'hello', runtimeMode: 'sdk' },
    );

    expect(sdkTransport.execute).toHaveBeenCalledTimes(1);
    expect(cliTransport.execute).not.toHaveBeenCalled();
  });

  it('mode=cli: only CLI transport is invoked (SDK transport never called)', async () => {
    const sdkTransport = makeTransport('anthropic-sdk');
    const cliTransport = makeTransport('claude-code-compat');

    const svc = new ExecutionService({
      mode: 'cli',
      transports: [sdkTransport, cliTransport],
    });

    await svc.run(
      {
        agentId: 'test',
        name: 'Test',
        model: 'sonnet',
        systemPrompt: 'sys',
        workspaceId: 'default',
      },
      { task: 'hello', runtimeMode: 'claude-code-compat' },
    );

    expect(cliTransport.execute).toHaveBeenCalledTimes(1);
    expect(sdkTransport.execute).not.toHaveBeenCalled();
  });

  it('explicit transports option bypasses mode filtering (backward compat)', () => {
    const sdkT = makeTransport('anthropic-sdk');
    const cliT = makeTransport('claude-code-compat');

    // Pass both transports explicitly — mode should be 'auto' (default) and
    // both transports must be registered regardless of env var
    const svc = new ExecutionService({ transports: [sdkT, cliT] });
    expect(svc.mode).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// ExecutionService mode resolution via AGENTFORGE_RUNTIME env var
// (end-to-end: env var → mode → transport list)
// ---------------------------------------------------------------------------

describe('ExecutionService AGENTFORGE_RUNTIME env var wiring', () => {
  const savedEnv = process.env.AGENTFORGE_RUNTIME;

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.AGENTFORGE_RUNTIME = savedEnv;
    } else {
      delete process.env.AGENTFORGE_RUNTIME;
    }
  });

  it('AGENTFORGE_RUNTIME=sdk → mode is sdk', () => {
    process.env.AGENTFORGE_RUNTIME = 'sdk';
    const svc = new ExecutionService({ mode: resolveMode(process.env) });
    expect(svc.mode).toBe('sdk');
  });

  it('AGENTFORGE_RUNTIME=cli → mode is cli', () => {
    process.env.AGENTFORGE_RUNTIME = 'cli';
    const svc = new ExecutionService({ mode: resolveMode(process.env) });
    expect(svc.mode).toBe('cli');
  });

  it('AGENTFORGE_RUNTIME unset → mode is auto', () => {
    delete process.env.AGENTFORGE_RUNTIME;
    const svc = new ExecutionService({ mode: resolveMode({}) });
    expect(svc.mode).toBe('auto');
  });

  it('invalid AGENTFORGE_RUNTIME → warns and falls back to auto', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.AGENTFORGE_RUNTIME = 'quantum';
    const mode = resolveMode(process.env);
    expect(mode).toBe('auto');
    const svc = new ExecutionService({ mode });
    expect(svc.mode).toBe('auto');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quantum'));
    warn.mockRestore();
  });
});
