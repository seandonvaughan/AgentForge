import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, extname, join } from 'node:path';

export function parseCommandArgs(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i]!;

    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < cmd.length && cmd[i] !== quote) {
        current += cmd[i];
        i++;
      }
      i++;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      i++;
    } else {
      current += ch;
      i++;
    }
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

export interface ResolvedExecFileCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export function resolveCommandForExecFile(
  cmd: string,
  args: string[] = [],
  platform: NodeJS.Platform = process.platform,
  nodeExecPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedExecFileCommand {
  if (platform !== 'win32') return { command: cmd, args };

  const corepackDirect = corepackNodeInvocation(cmd, args, nodeExecPath);
  if (corepackDirect) return corepackDirect;

  const explicitExt = extname(cmd).toLowerCase();
  if (explicitExt === '.cmd' || explicitExt === '.bat') {
    return windowsBatchInvocation(cmd, args, env);
  }
  if (cmd.includes('/') || cmd.includes('\\') || explicitExt) {
    return { command: cmd, args };
  }

  const resolved = findWindowsCommand(cmd, nodeExecPath, env);
  const corepackResolved = resolved
    ? corepackNodeInvocation(resolved, args, nodeExecPath)
    : null;
  if (corepackResolved) return corepackResolved;
  if (resolved?.endsWith('.cmd') || resolved?.endsWith('.bat')) {
    return windowsBatchInvocation(resolved, args, env);
  }
  if (resolved) return { command: resolved, args };

  return windowsBatchInvocation(cmd, args, env);
}

function corepackNodeInvocation(
  cmd: string,
  args: string[],
  nodeExecPath: string,
): ResolvedExecFileCommand | null {
  const name = basename(cmd).toLowerCase();
  const withoutExt = name.replace(/\.(cmd|bat|exe)$/i, '');
  if (withoutExt !== 'corepack' && withoutExt !== 'pnpm') return null;

  const corepackJs = join(dirname(nodeExecPath), 'node_modules', 'corepack', 'dist', 'corepack.js');
  if (!existsSync(corepackJs)) return null;

  return {
    command: nodeExecPath,
    args: [
      corepackJs,
      ...(withoutExt === 'pnpm' ? ['pnpm'] : []),
      ...args,
    ],
  };
}

function findWindowsCommand(
  cmd: string,
  nodeExecPath: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const nodeDir = dirname(nodeExecPath);
  const pathDirs = (env['PATH'] ?? env['Path'] ?? '')
    .split(delimiter)
    .filter(Boolean);
  const dirs = [nodeDir, ...pathDirs];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const candidate = join(dir, `${cmd}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function windowsBatchInvocation(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ResolvedExecFileCommand {
  return {
    command: env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', ['call', quoteWindowsCmdArg(cmd), ...args.map(quoteWindowsCmdArg)].join(' ')],
    windowsVerbatimArguments: true,
  };
}

function quoteWindowsCmdArg(value: string): string {
  if (/^[A-Za-z0-9._=:/\\~\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""').replace(/%/g, '%%')}"`;
}
