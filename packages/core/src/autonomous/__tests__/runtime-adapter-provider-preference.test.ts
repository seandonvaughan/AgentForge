/**
 * Unit tests for the runtime-adapter's default provider-preference decision —
 * the keystone of "bulk on Codex, hard work on Claude, with failover": every
 * non-routed phase call defaults to a codex-first chain (preserving the
 * abundant-Codex strategy at giant scale), while explicit routing and forced
 * runtime modes are respected.
 */
import { describe, expect, it } from 'vitest';
import { effectiveProviderPreference } from '../runtime-adapter.js';

describe('effectiveProviderPreference', () => {
  it('uses an explicit per-item providerPreference verbatim (routing wins)', () => {
    expect(
      effectiveProviderPreference({ providerPreference: ['anthropic-sdk', 'claude-code-compat'] }),
    ).toEqual(['anthropic-sdk', 'claude-code-compat']);
  });

  it('defaults non-routed calls to the codex-first chain (keeps phases on abundant Codex)', () => {
    expect(effectiveProviderPreference({})).toEqual(['codex-cli', 'claude-code-compat']);
    expect(effectiveProviderPreference(undefined)).toEqual(['codex-cli', 'claude-code-compat']);
    expect(effectiveProviderPreference({ allowedTools: ['Read'] } as never)).toEqual([
      'codex-cli',
      'claude-code-compat',
    ]);
  });

  it('never overrides an explicitly forced runtimeMode (returns undefined → resolver honors the mode)', () => {
    expect(effectiveProviderPreference({ runtimeMode: 'sdk' })).toBeUndefined();
    expect(effectiveProviderPreference({ runtimeMode: 'codex-cli' })).toBeUndefined();
  });

  it('treats an empty preference array as "not provided" and falls back to the default', () => {
    expect(effectiveProviderPreference({ providerPreference: [] })).toEqual([
      'codex-cli',
      'claude-code-compat',
    ]);
  });

  it('explicit providerPreference wins even when a runtimeMode is also set', () => {
    expect(
      effectiveProviderPreference({ providerPreference: ['codex-cli'], runtimeMode: 'sdk' }),
    ).toEqual(['codex-cli']);
  });
});
