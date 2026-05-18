import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMode, resolveAutoMode } from '../execution-service-mode.js';

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

  it('returns "auto" when AGENTFORGE_RUNTIME is not set', () => {
    expect(resolveMode({})).toBe('auto');
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
    const result = resolveAutoMode({});
    expect(['cli', 'sdk']).toContain(result);
  });

  it('returns "cli" | "sdk" — never "auto"', () => {
    const result = resolveAutoMode({});
    expect(result).not.toBe('auto');
  });
});
