#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "packages", "cli", "dist", "bin.js");
const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const expectedVersion = rootManifest.version;
const failures = [];

if (!existsSync(cliPath)) {
  console.error(`Built CLI was not found at ${cliPath}. Run pnpm build before check:help.`);
  process.exit(1);
}

assertCommand(["--version"], [expectedVersion]);
assertCommand(["--help"], [
  "agentforge",
  "init",
  "start",
  "migrate",
  "info",
  "cycle",
  "autonomous:cycle",
  "run",
  "invoke",
  "delegate",
  "costs",
  "cost-report",
  "team",
  "team-sessions",
  "sessions",
  "workspaces",
]);
assertCommand(["cycle", "--help"], ["run", "preview", "list", "show", "approve"]);
assertCommand(["run", "--help"], ["invoke", "delegate", "history", "show"]);
assertCommand(["costs", "--help"], ["report"]);
assertCommand(["team", "--help"], ["forge", "genesis", "rebuild", "reforge"]);
assertCommand(["team", "reforge", "--help"], ["apply", "list", "rollback", "status"]);
assertCommand(["team-sessions", "--help"], ["list", "delete"]);
assertCommand(["workspaces", "--help"], ["list", "add", "remove", "default"]);

if (failures.length > 0) {
  console.error("CLI help output check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("CLI help output check passed.");

function assertCommand(args, expectedFragments) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  });

  const commandLabel = `agentforge ${args.join(" ")}`;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  if (result.status !== 0) {
    failures.push(`${commandLabel} exited with ${result.status}: ${output.trim()}`);
    return;
  }

  for (const fragment of expectedFragments) {
    if (!output.includes(fragment)) {
      failures.push(`${commandLabel} did not include "${fragment}".`);
    }
  }
}
