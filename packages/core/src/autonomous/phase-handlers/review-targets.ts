import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface ExecuteReviewTarget {
  itemId?: string;
  agentId?: string;
  status?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  changedFiles: string[];
}

export interface ExecuteReviewMaterialOptions {
  maxDiffChars?: number;
}

const DEFAULT_MAX_DIFF_CHARS = 120_000;
const MAX_REVIEW_TARGET_CHANGED_FILES = 100;
const GIT_EXEC_OPTIONS: Omit<ExecFileSyncOptionsWithStringEncoding, 'cwd'> = {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 8,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

const EXCLUDED_REVIEW_TARGET_PREFIXES = [
  '.agentforge/cycles/',
  '.agentforge/worktrees/',
  '.playwright-mcp/',
  '.pnpm-store/',
  '.svelte-kit/',
  'coverage/',
  'dist/',
  'node_modules/',
  'test-results/',
];

function isReviewTargetPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return !EXCLUDED_REVIEW_TARGET_PREFIXES.some((prefix) => (
    lower === prefix.slice(0, -1) || lower.startsWith(prefix)
  ));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter(isReviewTargetPath)
    .slice(0, MAX_REVIEW_TARGET_CHANGED_FILES);
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function resolveTargetPath(projectRoot: string, worktreePath: string): string {
  return isAbsolute(worktreePath) ? worktreePath : join(projectRoot, worktreePath);
}

export function loadExecuteReviewTargets(
  projectRoot: string,
  cycleId?: string,
): ExecuteReviewTarget[] {
  if (!cycleId) return [];

  const execPath = join(
    projectRoot,
    '.agentforge',
    'cycles',
    cycleId,
    'phases',
    'execute.json',
  );
  if (!existsSync(execPath)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(execPath, 'utf8'));
  } catch {
    return [];
  }

  const itemResults =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { itemResults?: unknown }).itemResults)
      ? (parsed as { itemResults: unknown[] }).itemResults
      : [];

  return itemResults
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    .map((entry) => {
      const itemId = asString(entry['itemId']);
      const agentId = asString(entry['agentId']);
      const status = asString(entry['status']);
      const worktreePath = asString(entry['worktreePath']);
      const worktreeBranch = asString(entry['worktreeBranch']);
      return {
        ...(itemId ? { itemId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(status ? { status } : {}),
        ...(worktreePath ? { worktreePath } : {}),
        ...(worktreeBranch ? { worktreeBranch } : {}),
        changedFiles: asStringArray(entry['worktreeChangedFiles']),
      };
    })
    .filter((target) => target.worktreePath || target.worktreeBranch || target.changedFiles.length > 0);
}

export function formatExecuteReviewTargets(
  targets: ExecuteReviewTarget[],
  projectRoot: string,
  baseBranch = 'main',
): string {
  if (targets.length === 0) {
    return [
      '## Execute-phase review targets',
      'No isolated execute worktrees were recorded. Fall back to reviewing the current checkout diff.',
    ].join('\n');
  }

  const sections = targets.map((target, index) => {
    const labelParts = [
      `Target ${index + 1}`,
      target.itemId ? `item=${target.itemId}` : null,
      target.agentId ? `agent=${target.agentId}` : null,
      target.status ? `status=${target.status}` : null,
    ].filter(Boolean);

    const resolvedPath = target.worktreePath
      ? resolveTargetPath(projectRoot, target.worktreePath)
      : '(no worktree path recorded)';
    const worktreeExists = target.worktreePath ? existsSync(resolvedPath) : false;

    const files =
      target.changedFiles.length > 0
        ? target.changedFiles.map((file) => `  - ${file}`).join('\n')
        : '  - (no changed files recorded)';

    const commands = target.worktreeBranch
      ? [
          `  git diff --stat origin/${baseBranch}...${target.worktreeBranch}`,
          `  git diff origin/${baseBranch}...${target.worktreeBranch}`,
          ...target.changedFiles.map((file) => `  git show ${target.worktreeBranch}:${file}`),
        ].join('\n')
      : target.worktreePath && worktreeExists
      ? [
          '  Use Read/Grep tools against the absolute worktree path, or these PowerShell reads:',
          ...target.changedFiles.map((file) => (
            `  Get-Content -LiteralPath ${quotePowerShellLiteral(join(resolvedPath, file))} -TotalCount 240`
          )),
        ].join('\n')
      : '  No live worktree or branch was recorded; use the changed-file list and execute output only.';

    return [
      `### ${labelParts.join(' ')}`,
      `Worktree path: ${resolvedPath}`,
      `Worktree available: ${worktreeExists ? 'yes' : 'no - use the branch commands below'}`,
      `Branch: ${target.worktreeBranch ?? '(not recorded)'}`,
      'Changed files:',
      files,
      'Suggested read-only commands:',
      commands,
    ].join('\n');
  });

  return [
    '## Execute-phase review targets',
    'IMPORTANT: In multi-PR mode, sprint changes live on isolated agent branches. The temporary worktree may already be removed and the parent checkout may be clean. Prefer the branch diff commands below. When only a live worktree path is listed, use Read/Grep tools or direct file reads against the listed changed files; avoid worktree-scoped git commands and Git grep in Codex read-only sandbox. Do not inspect unrelated directories under `.agentforge/worktrees`, and do not substitute `git diff HEAD` in the parent checkout when a target branch is listed.',
    ...sections,
  ].join('\n\n');
}

function runGit(
  cwd: string,
  args: string[],
): { output: string; error?: undefined } | { output?: undefined; error: string } {
  try {
    const isInsideWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      ...GIT_EXEC_OPTIONS,
    }).trim();
    if (isInsideWorkTree !== 'true') {
      return { error: `Not a git repository: ${cwd}` };
    }
    return {
      output: execFileSync('git', args, {
        cwd,
        ...GIT_EXEC_OPTIONS,
      }).trim(),
    };
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown }).stderr === 'string'
      ? (err as { stderr: string }).stderr.trim()
      : '';
    const message = err instanceof Error ? err.message : String(err);
    return { error: (stderr || message).trim() };
  }
}

function truncateSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[AgentForge truncated this diff at ${maxChars} characters. Review the visible changes and flag that the diff was truncated.]`;
}

function fenced(label: string, value: string): string {
  return [`${label}:`, '```', value.trim() || '(empty)', '```'].join('\n');
}

function formatGitResult(label: string, result: ReturnType<typeof runGit>, maxChars: number): string {
  if (result.error) {
    return fenced(`${label} unavailable`, truncateSection(result.error, Math.min(maxChars, 2_000)));
  }
  return fenced(label, truncateSection(result.output ?? '', maxChars));
}

function formatTargetSummary(target: ExecuteReviewTarget, projectRoot: string, index: number): string {
  const labelParts = [
    `Target ${index + 1}`,
    target.itemId ? `item=${target.itemId}` : null,
    target.agentId ? `agent=${target.agentId}` : null,
    target.status ? `status=${target.status}` : null,
  ].filter(Boolean);
  const resolvedPath = target.worktreePath
    ? resolveTargetPath(projectRoot, target.worktreePath)
    : '(no worktree path recorded)';
  const files = target.changedFiles.length > 0
    ? target.changedFiles.map((file) => `- ${file}`).join('\n')
    : '- (no changed files recorded)';

  return [
    `### ${labelParts.join(' ')}`,
    `Worktree path: ${resolvedPath}`,
    `Worktree available: ${target.worktreePath && existsSync(resolvedPath) ? 'yes' : 'no'}`,
    `Branch: ${target.worktreeBranch ?? '(not recorded)'}`,
    'Changed files:',
    files,
  ].join('\n');
}

export function formatExecuteReviewTargetSummary(
  targets: ExecuteReviewTarget[],
  projectRoot: string,
): string {
  if (targets.length === 0) {
    return [
      '## Execute-phase review targets',
      'No isolated execute worktrees were recorded. Review the current checkout material below.',
    ].join('\n');
  }

  return [
    '## Execute-phase review targets',
    'Sprint changes may live on isolated agent branches. AgentForge collected the target metadata below before invoking the reviewer.',
    ...targets.map((target, index) => formatTargetSummary(target, projectRoot, index)),
  ].join('\n\n');
}

export function collectExecuteReviewMaterials(
  targets: ExecuteReviewTarget[],
  projectRoot: string,
  baseBranch = 'main',
  options: ExecuteReviewMaterialOptions = {},
): string {
  const maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
  const baseRef = `origin/${baseBranch}`;

  if (targets.length === 0) {
    const stat = runGit(projectRoot, ['diff', '--stat', 'HEAD']);
    const diff = runGit(projectRoot, ['diff', 'HEAD']);
    const log = runGit(projectRoot, ['log', '-1', '--format=%B']);
    return [
      '## Precomputed review materials',
      '### Current checkout',
      formatGitResult('Latest commit message', log, maxDiffChars),
      formatGitResult('Diff stat', stat, maxDiffChars),
      formatGitResult('Full diff', diff, maxDiffChars),
    ].join('\n\n');
  }

  const sections = targets.map((target, index) => {
    const heading = `### Target ${index + 1}${target.itemId ? ` (${target.itemId})` : ''}`;
    if (target.worktreeBranch) {
      const range = `${baseRef}...${target.worktreeBranch}`;
      const stat = runGit(projectRoot, ['diff', '--stat', range]);
      const diff = runGit(projectRoot, ['diff', range]);
      const log = runGit(projectRoot, ['log', '-1', '--format=%B', target.worktreeBranch]);
      return [
        heading,
        `Diff range: ${range}`,
        formatGitResult('Latest branch commit message', log, maxDiffChars),
        formatGitResult('Diff stat', stat, maxDiffChars),
        formatGitResult('Full diff', diff, maxDiffChars),
      ].join('\n\n');
    }

    if (target.worktreePath) {
      const resolvedPath = resolveTargetPath(projectRoot, target.worktreePath);
      if (existsSync(resolvedPath)) {
        const range = `${baseRef}...HEAD`;
        const stat = runGit(resolvedPath, ['diff', '--stat', range]);
        const diff = runGit(resolvedPath, ['diff', range]);
        const log = runGit(resolvedPath, ['log', '-1', '--format=%B']);
        return [
          heading,
          `Worktree diff range: ${range}`,
          formatGitResult('Latest worktree commit message', log, maxDiffChars),
          formatGitResult('Diff stat', stat, maxDiffChars),
          formatGitResult('Full diff', diff, maxDiffChars),
        ].join('\n\n');
      }
    }

    const files = target.changedFiles.length > 0
      ? target.changedFiles.map((file) => `- ${file}`).join('\n')
      : '- (no changed files recorded)';
    return [
      heading,
      'No live worktree or branch was recorded for this target.',
      'Recorded changed files:',
      files,
    ].join('\n');
  });

  return [
    '## Precomputed review materials',
    ...sections,
  ].join('\n\n');
}
