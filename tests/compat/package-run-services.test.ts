import { describe, it, expect } from "vitest";
import { Command } from "commander";
import registerInvokeCommand from "../../src/cli/commands/invoke.js";

/**
 * Verifies that the root `invoke` command's Commander registration no longer
 * exposes a `--loop` option.  The flag was a dead placeholder that misled
 * operators into believing loop mode was invokable from the root CLI.
 * It has been removed in favour of `agentforge cycle run`.
 */
describe("invoke command CLI registration", () => {
  it("does not register --loop as a recognised option", () => {
    const program = new Command();
    registerInvokeCommand(program);

    const invokeCmd = program.commands.find((c) => c.name() === "invoke");
    expect(invokeCmd).toBeDefined();

    const optionNames = invokeCmd!.options.map((o) => o.long);
    expect(optionNames).not.toContain("--loop");
  });

  it("still exposes the core invoke options", () => {
    const program = new Command();
    registerInvokeCommand(program);

    const invokeCmd = program.commands.find((c) => c.name() === "invoke")!;
    const optionNames = invokeCmd.options.map((o) => o.long);

    expect(optionNames).toContain("--project-root");
    expect(optionNames).toContain("--runtime");
    expect(optionNames).toContain("--tool");
    expect(optionNames).toContain("--budget");
  });
});
