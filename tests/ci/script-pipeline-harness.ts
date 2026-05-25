import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ScriptDictionary = Record<string, string>;

type LeafCommandRunner = (command: string) => number | Promise<number>;

export type ScriptRunResult = {
  ok: boolean;
  trace: string[];
  failedScript?: string;
  failedCommand?: string;
  error?: string;
};

function splitAndChain(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }

    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '&' && command[i + 1] === '&') {
      const trimmed = current.trim();
      if (trimmed.length > 0) parts.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) parts.push(trimmed);
  return parts;
}

function resolveScriptInvocation(
  command: string,
  scripts: ScriptDictionary,
): string | null {
  const rawTokens = command.trim().split(/\s+/);
  const tokens = rawTokens[0] === 'corepack' && rawTokens[1] === 'pnpm'
    ? rawTokens.slice(1)
    : rawTokens;
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

    try {
      for (const segment of splitAndChain(scriptBody)) {
        const referencedScript = resolveScriptInvocation(segment, this.scripts);
        if (referencedScript) {
          const nested = await this.runScript(referencedScript, inFlight);
          trace.push(...nested.trace);
          if (!nested.ok) {
            return {
              ...nested,
              trace,
            };
          }
          continue;
        }

        trace.push(segment);
        let exitCode: number;
        try {
          exitCode = await this.runLeafCommand(segment);
        } catch (error) {
          return {
            ok: false,
            trace,
            failedScript: scriptName,
            failedCommand: segment,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        if (exitCode !== 0) {
          return {
            ok: false,
            trace,
            failedScript: scriptName,
            failedCommand: segment,
          };
        }
      }

      return { ok: true, trace };
    } finally {
      inFlight.delete(scriptName);
    }
  }
}

export function loadRootScripts(cwd = process.cwd()): ScriptDictionary {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
    scripts?: ScriptDictionary;
  };
  return pkg.scripts ?? {};
}
