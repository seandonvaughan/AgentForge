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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
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

    const files =
      target.changedFiles.length > 0
        ? target.changedFiles.map((file) => `  - ${file}`).join('\n')
        : '  - (no changed files recorded)';

    const commands = target.worktreePath
      ? [
          `  git -C "${resolvedPath}" diff --stat origin/${baseBranch}...HEAD`,
          `  git -C "${resolvedPath}" diff origin/${baseBranch}...HEAD`,
        ].join('\n')
      : '  Use the recorded branch/changed files to inspect the diff.';

    return [
      `### ${labelParts.join(' ')}`,
      `Worktree path: ${resolvedPath}`,
      `Branch: ${target.worktreeBranch ?? '(not recorded)'}`,
      'Changed files:',
      files,
      'Suggested read-only commands:',
      commands,
    ].join('\n');
  });

  return [
    '## Execute-phase review targets',
    'IMPORTANT: In multi-PR mode, sprint changes live in isolated agent worktrees and the parent checkout may be clean. Review the targets below; do not substitute `git diff HEAD` in the parent checkout when a target worktree is listed.',
    ...sections,
  ].join('\n\n');
}
