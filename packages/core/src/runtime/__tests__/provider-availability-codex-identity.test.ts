import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCodexBinaryIdentityMock = vi.hoisted(() => vi.fn());

vi.mock('../transports/codex-cli-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transports/codex-cli-transport.js')>();
  return { ...actual, verifyCodexBinaryIdentity: verifyCodexBinaryIdentityMock };
});

import { createProviderAvailabilityProbe } from '../provider-availability.js';

/**
 * Wiring test for the Claude-primary degradation seam: the DEFAULT codex
 * probe must route through binary identity validation so a wrong `codex` on
 * PATH (e.g. an unrelated homebrew tool after macOS purged a /tmp shim) makes
 * the provider report unavailable instead of poisoning a run.
 */
describe('provider availability default codex probe (binary identity seam)', () => {
  beforeEach(() => {
    verifyCodexBinaryIdentityMock.mockReset();
  });

  it('reports codex-cli unavailable when binary identity validation fails', () => {
    verifyCodexBinaryIdentityMock.mockReturnValue({
      ok: false,
      command: '/opt/homebrew/bin/codex',
      reason: 'binary at /opt/homebrew/bin/codex failed codex identity validation',
    });
    const probe = createProviderAvailabilityProbe({
      probes: {
        isClaudeCliAvailable: () => true,
        isCodexAuthenticated: () => true,
      },
    });

    const map = probe.get({});

    expect(verifyCodexBinaryIdentityMock).toHaveBeenCalled();
    expect(map['codex-cli'].available).toBe(false);
    expect(map['codex-cli'].reason).toMatch(/identity validation/i);
    // Claude-primary: the claude provider stays available so the run proceeds.
    expect(map['claude-code-compat'].available).toBe(true);
  });

  it('reports codex-cli available when identity passes and codex is authenticated', () => {
    verifyCodexBinaryIdentityMock.mockReturnValue({
      ok: true,
      command: 'codex',
      reason: 'codex CLI identity verified (codex-cli 0.135.0)',
    });
    const probe = createProviderAvailabilityProbe({
      probes: {
        isClaudeCliAvailable: () => true,
        isCodexAuthenticated: () => true,
      },
    });

    expect(probe.get({})['codex-cli'].available).toBe(true);
  });
});
