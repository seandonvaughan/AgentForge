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
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === '\\' && i + 1 < command.length) {
      current += char + command[i + 1];
      i += 1;
      continue;
    }

    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      current += char;
      continue;
    }

    if (quote !== null && char === quote) {
      quote = null;
      current += char;
      continue;
    }

    if (quote === null && char === '&' && command[i + 1] === '&') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
      current = '';
      i += 1;
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    segments.push(tail);
  }

  return segments;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === '\\' && i + 1 < command.length) {
      current += command[i + 1];
      i += 1;
      continue;
    }

    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }

    if (quote !== null && char === quote) {
      quote = null;
      continue;
    }

    if (quote === null && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

const PNPM_OPTIONS_WITH_VALUES = new Set([
  '--filter',
  '--dir',
  '--prefix',
  '--workspace-dir',
  '--store-dir',
  '--reporter',
  '--config',
  '-F',
  '-C',
]);

function isOption(token: string): boolean {
  return token.startsWith('-');
}

function consumesNextValue(token: string): boolean {
  if (token.includes('=')) {
    return false;
  }
  return PNPM_OPTIONS_WITH_VALUES.has(token);
}

function findRunScriptToken(tokens: string[], start: number): string | null {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!isOption(token)) {
      return token;
    }
    if (consumesNextValue(token)) {
      i += 1;
    }
  }
  return null;
}

type ResolvedScriptInvocation = {
  scriptName: string;
  strict: boolean;
};

function resolveScriptInvocation(
  command: string,
  scripts: ScriptDictionary,
): ResolvedScriptInvocation | null {
  const tokens = tokenize(command);
  if (tokens.length < 2 || tokens[0] !== 'pnpm') {
    return null;
  }

  let sawPnpmOption = false;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'run') {
      const scriptName = findRunScriptToken(tokens, i + 1);
      return scriptName ? { scriptName, strict: true } : null;
    }

    if (isOption(token)) {
      sawPnpmOption = true;
      if (consumesNextValue(token)) {
        i += 1;
      }
      continue;
    }

    if (!sawPnpmOption && scripts[token]) {
      return { scriptName: token, strict: false };
    }
    return null;
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
        if (referencedScript && this.scripts[referencedScript.scriptName]) {
          const nested = await this.runScript(referencedScript.scriptName, inFlight);
          trace.push(...nested.trace);
          if (!nested.ok) {
            return {
              ...nested,
              trace,
            };
          }
          continue;
        }

        if (
          referencedScript &&
          referencedScript.strict &&
          !this.scripts[referencedScript.scriptName]
        ) {
          throw new Error(`script not found: ${referencedScript.scriptName}`);
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
