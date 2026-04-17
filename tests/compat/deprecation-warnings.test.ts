import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { warnDeprecation } from "../../src/cli/utils/run-helpers.js";
import registerForgeCommand from "../../src/cli/commands/forge.js";
import registerGenesisCommand from "../../src/cli/commands/genesis.js";
import registerRebuildCommand from "../../src/cli/commands/rebuild.js";
import registerStatusCommand from "../../src/cli/commands/status.js";
import registerInvokeCommand from "../../src/cli/commands/invoke.js";
import registerDelegateCommand from "../../src/cli/commands/delegate.js";
import registerCostReportCommand from "../../src/cli/commands/cost-report.js";
import registerActivateCommand from "../../src/cli/commands/activate.js";
import registerDeactivateCommand from "../../src/cli/commands/deactivate.js";
import registerSessionsCommand from "../../src/cli/commands/sessions.js";

// vitest.config.ts sets AGENTFORGE_SUPPRESS_DEPRECATION=1 globally so normal
// test runs never see [compat] noise. Tests below temporarily unset the
// variable to exercise the "flag not present" path, then restore it.
function restoreSuppression(): void {
  process.env.AGENTFORGE_SUPPRESS_DEPRECATION = "1";
  vi.restoreAllMocks();
}

describe("warnDeprecation utility", () => {
  afterEach(restoreSuppression);

  it("emits a console.warn to stderr when suppression flag is absent", () => {
    delete process.env.AGENTFORGE_SUPPRESS_DEPRECATION;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnDeprecation("[compat] test warning");

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith("[compat] test warning");
  });

  it("is silent when AGENTFORGE_SUPPRESS_DEPRECATION=1", () => {
    process.env.AGENTFORGE_SUPPRESS_DEPRECATION = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnDeprecation("[compat] test warning");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("only checks AGENTFORGE_SUPPRESS_DEPRECATION, not AGENTFORGE_BRIDGED", () => {
    delete process.env.AGENTFORGE_SUPPRESS_DEPRECATION;
    process.env.AGENTFORGE_BRIDGED = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnDeprecation("[compat] test warning");

    expect(warnSpy).toHaveBeenCalledOnce();

    delete process.env.AGENTFORGE_BRIDGED;
  });

  it("passes the full message string verbatim to console.warn", () => {
    delete process.env.AGENTFORGE_SUPPRESS_DEPRECATION;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const msg = "[compat] `forge` is a root compatibility wrapper. Prefer `agentforge team forge` from the package CLI.";

    warnDeprecation(msg);

    expect(warnSpy).toHaveBeenCalledWith(msg);
  });
});

describe("root CLI command deprecation message coverage", () => {
  afterEach(restoreSuppression);

  const cases: Array<{
    name: string;
    register: (p: Command) => void;
    commandPath: string[];
    expectedCanonical: string;
    invokeArgs: string[];
  }> = [
    {
      name: "forge",
      register: registerForgeCommand,
      commandPath: ["forge"],
      expectedCanonical: "team forge",
      invokeArgs: ["forge"],
    },
    {
      name: "genesis",
      register: registerGenesisCommand,
      commandPath: ["genesis"],
      expectedCanonical: "team genesis",
      invokeArgs: ["genesis", "--yes"],
    },
    {
      name: "rebuild",
      register: registerRebuildCommand,
      commandPath: ["rebuild"],
      expectedCanonical: "team rebuild",
      invokeArgs: ["rebuild"],
    },
    {
      name: "status",
      register: registerStatusCommand,
      commandPath: ["status"],
      expectedCanonical: "agentforge team",
      invokeArgs: ["status"],
    },
    {
      name: "invoke",
      register: registerInvokeCommand,
      commandPath: ["invoke"],
      expectedCanonical: "run invoke",
      invokeArgs: ["invoke", "--agent", "test-agent", "--task", "do something"],
    },
    {
      name: "delegate",
      register: registerDelegateCommand,
      commandPath: ["delegate"],
      expectedCanonical: "run delegate",
      invokeArgs: ["delegate", "some task"],
    },
    {
      name: "cost-report",
      register: registerCostReportCommand,
      commandPath: ["cost-report"],
      expectedCanonical: "costs report",
      invokeArgs: ["cost-report"],
    },
    {
      name: "activate",
      register: registerActivateCommand,
      commandPath: ["activate"],
      expectedCanonical: "activate",
      invokeArgs: ["activate"],
    },
    {
      name: "deactivate",
      register: registerDeactivateCommand,
      commandPath: ["deactivate"],
      expectedCanonical: "deactivate",
      invokeArgs: ["deactivate"],
    },
  ];

  it.each(cases)(
    "$name description mentions [compat] or Compatibility",
    ({ register, commandPath }) => {
      const program = new Command();
      register(program);

      // Walk the command path (handles nested sub-commands).
      let cmd: Command = program;
      for (const segment of commandPath) {
        const found = cmd.commands.find((c) => c.name() === segment);
        expect(found, `command '${segment}' not found`).toBeDefined();
        cmd = found!;
      }

      const desc = cmd.description().toLowerCase();
      expect(
        desc.includes("compat") || desc.includes("deprecated"),
        `Expected description to mention 'compat' or 'deprecated', got: "${cmd.description()}"`,
      ).toBe(true);
    },
  );

  it.each(cases)(
    "$name calls warnDeprecation (emits to stderr) when suppression flag is absent",
    async ({ name, register, expectedCanonical, invokeArgs }) => {
      delete process.env.AGENTFORGE_SUPPRESS_DEPRECATION;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Stub any @agentforge/core imports used by the action so we can invoke
      // the action without a real workspace. Vitest hoists this vi.mock call.
      vi.mock("@agentforge/core", () => ({
        forgeTeamService: vi.fn().mockResolvedValue(0),
        genesisTeamService: vi.fn().mockResolvedValue(0),
        rebuildTeamService: vi.fn().mockResolvedValue(0),
        showGeneratedTeam: vi.fn().mockResolvedValue(0),
        invokeAgentRun: vi.fn().mockResolvedValue({
          agent: { name: "a", agentId: "a", model: "haiku" },
          result: {
            runtimeModeResolved: "auto",
            providerKind: "anthropic-sdk",
            sessionId: "s1",
            status: "success",
            response: "ok",
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          },
        }),
        delegateTask: vi.fn().mockResolvedValue({ recommendations: [], invoked: null, task: "t" }),
        generateCostReport: vi.fn().mockResolvedValue({ source: "empty", pricingReference: {} }),
        listTeamSessions: vi.fn().mockResolvedValue(0),
        deleteTeamSession: vi.fn().mockResolvedValue(0),
        applyReforgeProposalService: vi.fn().mockResolvedValue(0),
        listReforgeStateService: vi.fn().mockResolvedValue(0),
        rollbackReforgeOverrideService: vi.fn().mockResolvedValue(0),
        showReforgeStatusService: vi.fn().mockResolvedValue(0),
      }));

      const program = new Command();
      program.exitOverride(); // Silence Commander's error output during tests.
      register(program);

      try {
        await program.parseAsync(invokeArgs, { from: "user" });
      } catch {
        // activate/deactivate set process.exitCode and Commander may throw
        // via exitOverride; that's fine — we only care the warn fired.
      }

      expect(
        warnSpy.mock.calls.some((args) =>
          typeof args[0] === "string" && args[0].toLowerCase().includes("compat"),
        ),
        `Expected a [compat] warning from '${name}', canonical='${expectedCanonical}'. Got: ${JSON.stringify(warnSpy.mock.calls)}`,
      ).toBe(true);
    },
  );
});

describe("sessions command deprecation", () => {
  afterEach(restoreSuppression);

  it("registers list and delete subcommands", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessions = program.commands.find((c) => c.name() === "sessions");
    expect(sessions).toBeDefined();

    const subNames = sessions!.commands.map((c) => c.name());
    expect(subNames).toContain("list");
    expect(subNames).toContain("delete");
  });

  it("description mentions compat", () => {
    const program = new Command();
    registerSessionsCommand(program);

    const sessions = program.commands.find((c) => c.name() === "sessions")!;
    expect(sessions.description().toLowerCase()).toContain("compat");
  });
});
