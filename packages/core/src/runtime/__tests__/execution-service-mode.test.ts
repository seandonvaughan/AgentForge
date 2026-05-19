import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveMode, resolveAutoMode } from '../execution-service-mode.js';

function withEmptyProjectRoot<T>(fn: (projectRoot: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-runtime-mode-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests for resolveMode()
// ---------------------------------------------------------------------------

describe('resolveMode()', () => {
  it('returns "sdk" when AGENTFORGE_RUNTIME=sdk', () => {
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'sdk' })).toBe('sdk');
  });

  it('returns "cli" when AGENTFORGE_RUNTIME=cli', () => {
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'cli' })).toBe('cli');
  });

  it('returns "auto" when AGENTFORGE_RUNTIME and config runtime are not set', () => {
    withEmptyProjectRoot((projectRoot) => {
      expect(resolveMode({}, projectRoot)).toBe('auto');
    });
  });

  it('returns "auto" when AGENTFORGE_RUNTIME is an unrecognised value', () => {
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'turbo' })).toBe('auto');
  });

  it('is case-insensitive for env var values', () => {
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'SDK' })).toBe('sdk');
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'CLI' })).toBe('cli');
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'CODEX-CLI' })).toBe('codex-cli');
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'OPENAI-SDK' })).toBe('openai-sdk');
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'Auto' })).toBe('auto');
  });

  it('accepts explicit provider names', () => {
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'anthropic-sdk' })).toBe('anthropic-sdk');
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'claude-cli' })).toBe('claude-cli');
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'codex-cli' })).toBe('codex-cli');
    expect(resolveMode({ AGENTFORGE_RUNTIME: 'openai-sdk' })).toBe('openai-sdk');
  });
});

// ---------------------------------------------------------------------------
// Tests for resolveAutoMode()
// ---------------------------------------------------------------------------

describe('resolveAutoMode()', () => {
  it('returns "sdk" directly when AGENTFORGE_RUNTIME=sdk (no PATH probe)', () => {
    expect(resolveAutoMode({ AGENTFORGE_RUNTIME: 'sdk' })).toBe('sdk');
  });

  it('returns "cli" directly when AGENTFORGE_RUNTIME=cli (no PATH probe)', () => {
    expect(resolveAutoMode({ AGENTFORGE_RUNTIME: 'cli' })).toBe('cli');
  });

  it('returns "codex-cli" directly when AGENTFORGE_RUNTIME=codex-cli', () => {
    expect(resolveAutoMode({ AGENTFORGE_RUNTIME: 'codex-cli' })).toBe('codex-cli');
  });

  it('returns a "cli" or "sdk" string when mode is auto (PATH probe)', () => {
    withEmptyProjectRoot((projectRoot) => {
      const result = resolveAutoMode({}, projectRoot);
      expect(['cli', 'sdk']).toContain(result);
    });
  });

  it('returns "cli" | "sdk" — never "auto"', () => {
    withEmptyProjectRoot((projectRoot) => {
      const result = resolveAutoMode({}, projectRoot);
      expect(result).not.toBe('auto');
    });
  });
});
