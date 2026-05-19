import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ScriptDictionary = Record<string, string>;

type LeafCommandRunner = (command: string) => number | Promise<number>;

export type ScriptRunResult = {
  ok: boolean;
  trace: string[];
  failedScript?: string;
  failedCommand?: string;
};

function splitAndChain(command: string): string[] {
  return command
    .split(/\s*&&\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function resolveScriptInvocation(
  command: string,
  scripts: ScriptDictionary,
): string | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 2 || tokens[0] !== 'pnpm') {
    return null;
  }

  if (tokens.length === 2 && scripts[tokens[1]]) {
    return tokens[1];
  }

  if (tokens.length === 3 && tokens[1] === 'run' && scripts[tokens[2]]) {
    return tokens[2];
  }

  return null;
}

export class ScriptPipelineHarness {
  constructor(
    private readonly scripts: ScriptDictionary,
    private readonly runLeafCommand: LeafCommandRunner,
  ) {}

  async run(scriptName: string): Promise<ScriptRunResult> {
    return this.runScript(scriptName, new Set<string>());
  }

  private async runScript(
    scriptName: string,
    inFlight: Set<string>,
  ): Promise<ScriptRunResult> {
    if (inFlight.has(scriptName)) {
      throw new Error(`circular script reference detected: ${scriptName}`);
    }

    const scriptBody = this.scripts[scriptName];
    if (!scriptBody) {
      throw new Error(`script not found: ${scriptName}`);
    }

    inFlight.add(scriptName);
    const trace: string[] = [];

    for (const segment of splitAndChain(scriptBody)) {
      const referencedScript = resolveScriptInvocation(segment, this.scripts);
      if (referencedScript) {
        const nested = await this.runScript(referencedScript, inFlight);
        trace.push(...nested.trace);
        if (!nested.ok) {
          inFlight.delete(scriptName);
          return nested;
        }
        continue;
      }

      const exitCode = await this.runLeafCommand(segment);
      trace.push(segment);

      if (exitCode !== 0) {
        inFlight.delete(scriptName);
        return {
          ok: false,
          trace,
          failedScript: scriptName,
          failedCommand: segment,
        };
      }
    }

    inFlight.delete(scriptName);
    return { ok: true, trace };
  }
}

export function loadRootScripts(cwd = process.cwd()): ScriptDictionary {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
    scripts?: ScriptDictionary;
  };
  return pkg.scripts ?? {};
}
