/**
 * CLI surface single-source-of-truth test.
 *
 * Enforces that the canonical `agentforge` binary program (`createCliProgram()`)
 * registers EXACTLY the command set produced by the shared registry
 * (`registerAllCommands()`) — no more, no less. This is the "one CLI surface"
 * guarantee: it fails if anyone adds a command directly onto the binary program
 * (bypassing the registry) or registers a command on the binary that the shared
 * registry does not, so the binary cannot drift from the single source of truth.
 *
 * ARCHITECTURE NOTE: The Codex host does NOT expose a second Commander program;
 * it surfaces a curated SUBSET of capabilities as MCP tools (af_codex_readiness,
 * af_cycle_preview, af_cycle_status — see packages/mcp-server). True binary↔MCP
 * derivation parity (every Codex MCP tool maps to a registry command) is a
 * distinct contract tracked as follow-up; this test guards binary↔registry SSOT.
 *
 * ANTI-FAKE GUARD: The test introspects ACTUAL Commander program objects via
 * `program.commands.map(c => c.name())`. Hard-coding two matching string arrays
 * would NOT satisfy the assertion — the comparison is against live programs, and
 * a direct `program.command(...)` added to the binary outside the registry makes
 * it fail.
 *
 * EXCLUSION LIST (documented):
 *   None at this time. If a future command must be binary-only (e.g., an
 *   interactive terminal command), add it here with a justification comment;
 *   its presence in the binary set is asserted so stale exclusions are caught.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { createCliProgram } from '../bin.js';
import { registerAllCommands } from '../commands/registry.js';

/**
 * Commands that are intentionally absent from the shared registry surface.
 * Each entry must include a justification comment.
 *
 * Currently empty — all commands registered by `createCliProgram` must
 * also be registered by `registerAllCommands`.
 */
const EXCLUSIONS: ReadonlySet<string> = new Set<string>([
  // Example (do not add without justification):
  // 'some-interactive-command',  // reason: requires a TTY; not usable via Codex
]);

describe('CLI surface parity', () => {
  it('createCliProgram and registerAllCommands register the same top-level command names', () => {
    // Build the canonical CLI program.
    const binaryProgram = createCliProgram();

    // Build a fresh program using only the shared registry.
    const registryProgram = new Command();
    registryProgram.name('agentforge');
    registerAllCommands(registryProgram);

    // Introspect actual registered commands — NOT hard-coded string arrays.
    const binaryNames = new Set(
      binaryProgram.commands.map((c) => c.name()),
    );
    const registryNames = new Set(
      registryProgram.commands.map((c) => c.name()),
    );

    // Assert the exclusion set is a subset of binaryNames (so stale exclusions
    // are caught when commands are removed).
    for (const excluded of EXCLUSIONS) {
      expect(binaryNames.has(excluded)).toBe(true);
    }

    // Remove exclusions from the binary set for the final comparison.
    const binaryNamesWithoutExclusions = new Set(
      [...binaryNames].filter((name) => !EXCLUSIONS.has(name)),
    );

    // Compute symmetric differences for a useful failure message.
    const onlyInBinary = [...binaryNamesWithoutExclusions].filter(
      (name) => !registryNames.has(name),
    );
    const onlyInRegistry = [...registryNames].filter(
      (name) => !binaryNamesWithoutExclusions.has(name),
    );

    expect(onlyInBinary).toEqual([]);
    expect(onlyInRegistry).toEqual([]);

    // Canonical set-equality assertion.
    expect(registryNames).toEqual(binaryNamesWithoutExclusions);
  });

  it('registerAllCommands registers at least the known canonical command names', () => {
    // This is a canary: if the registry is empty or near-empty (e.g., someone
    // accidentally returns early), this catches it.
    const program = new Command();
    program.name('agentforge');
    registerAllCommands(program);

    const names = program.commands.map((c) => c.name());

    // These are the well-known top-level commands that must always be present.
    const required = [
      'cycle',
      'run',
      'costs',
      'team',
      'workspaces',
      'demo',
      'replay',
      'skills',
      'codex',
      'research',
      'backlog',
    ];

    for (const name of required) {
      expect(names, `Expected command "${name}" to be registered`).toContain(name);
    }
  });
});
