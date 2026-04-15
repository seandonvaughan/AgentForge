/**
 * Git history analyzer for AgentForge (Haiku-tier scanner).
 *
 * Inspects a project's git repository to extract commit statistics,
 * contributor info, branch strategy, file churn, and commit frequency.
 *
 * NOTE: Uses execSync with hardcoded git sub-commands.  The `projectRoot`
 * argument is only ever passed as `cwd`, never interpolated into a shell
 * string, so there is no command-injection vector.
 */

import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitContributor {
  name: string;
  email: string;
  commits: number;
}

export interface ActiveFile {
  path: string;
  changes: number;
  last_modified: string;
}

export interface ChurnEntry {
  path: string;
  additions: number;
  deletions: number;
}

export interface CommitFrequency {
  period: string;
  count: number;
}

export interface GitAnalysis {
  total_commits: number;
  contributors: GitContributor[];
  active_files: ActiveFile[];
  branch_count: number;
  branch_strategy: "trunk-based" | "gitflow" | "github-flow" | "unknown";
  churn_rate: ChurnEntry[];
  commit_frequency: CommitFrequency[];
  age_days: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command inside `cwd` and return trimmed stdout.
 * Returns `null` when the command fails (e.g. not a git repo).
 */
function git(cmd: string, cwd: string): string | null {
  try {
    return execSync(`git ${cmd}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024, // 50 MB – large repos can produce a lot of output
    }).trim();
  } catch {
    return null;
  }
}

/** Parse a non-null git output into non-empty lines. */
function lines(output: string | null): string[] {
  if (!output) return [];
  return output.split("\n").filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Individual collectors
// ---------------------------------------------------------------------------

function getTotalCommits(cwd: string): number {
  const out = git("rev-list --count HEAD", cwd);
  return out ? parseInt(out, 10) || 0 : 0;
}

function getContributors(cwd: string): GitContributor[] {
  // git shortlog -sne HEAD produces lines like:
  //   123\tJane Doe <jane@example.com>
  const out = git("shortlog -sne HEAD", cwd);
  return lines(out).map((line) => {
    const match = line.match(/^\s*(\d+)\t(.+?)\s+<(.+?)>\s*$/);
    if (!match) return null;
    const commitCount = match[1];
    const contributorName = match[2];
    const contributorEmail = match[3];
    if (!commitCount || !contributorName || !contributorEmail) {
      return null;
    }
    return {
      commits: parseInt(commitCount, 10),
      name: contributorName,
      email: contributorEmail,
    };
  }).filter((c): c is GitContributor => c !== null);
}

function getActiveFiles(cwd: string): ActiveFile[] {
  // Collect every file name that appears in any commit's diff.
  const out = git("log --format='' --name-only", cwd);
  const counts = new Map<string, number>();
  for (const file of lines(out)) {
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }

  // Sort descending by change count, take top 20.
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // For each top file, grab the last modification date.
  return sorted.map(([path, changes]) => {
    const dateOut = git(
      `log -1 --format=%aI -- "${path}"`,
      cwd,
    );
    return {
      path,
      changes,
      last_modified: dateOut ?? "unknown",
    };
  });
}

function getBranches(cwd: string): string[] {
  const out = git("branch -a", cwd);
  return lines(out).map((b) => b.replace(/^\*?\s+/, "").trim());
}

function detectBranchStrategy(
  branches: string[],
): GitAnalysis["branch_strategy"] {
  const names = new Set(
    branches.map((b) =>
      b
        .replace("remotes/origin/", "")
        .replace("remotes/", "")
    ),
  );

  const hasMain = names.has("main") || names.has("master");
  const hasDevelop = names.has("develop") || names.has("development");
  const hasFeature = [...names].some((n) => n.startsWith("feature/"));
  const hasRelease = [...names].some((n) => n.startsWith("release/"));
  const hasHotfix = [...names].some((n) => n.startsWith("hotfix/"));

  // Gitflow: develop + feature|release|hotfix branches
  if (hasDevelop && (hasRelease || hasHotfix || hasFeature)) {
    return "gitflow";
  }

  // GitHub Flow: main/master + feature branches but no develop/release
  if (hasMain && hasFeature && !hasDevelop) {
    return "github-flow";
  }

  // Trunk-based: essentially only main/master, very few long-lived branches
  if (hasMain && names.size <= 3) {
    return "trunk-based";
  }

  return "unknown";
}

function getChurnRate(cwd: string): ChurnEntry[] {
  // git log --numstat produces lines like:
  //   10\t5\tsrc/index.ts
  // (additions \t deletions \t path)
  const out = git("log --numstat --format=''", cwd);
  const churn = new Map<string, { additions: number; deletions: number }>();

  for (const line of lines(out)) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    const rawAdditions = match[1];
    const rawDeletions = match[2];
    const path = match[3];
    if (!rawAdditions || !rawDeletions || !path) {
      continue;
    }
    const additions = rawAdditions === "-" ? 0 : parseInt(rawAdditions, 10);
    const deletions = rawDeletions === "-" ? 0 : parseInt(rawDeletions, 10);
    const existing = churn.get(path) ?? { additions: 0, deletions: 0 };
    existing.additions += additions;
    existing.deletions += deletions;
    churn.set(path, existing);
  }

  return [...churn.entries()]
    .sort((a, b) => (b[1].additions + b[1].deletions) - (a[1].additions + a[1].deletions))
    .slice(0, 20)
    .map(([path, stats]) => ({ path, ...stats }));
}

function getCommitFrequency(cwd: string): CommitFrequency[] {
  // Collect author dates in ISO format, bucket by YYYY-MM.
  const out = git("log --format=%aI", cwd);
  const buckets = new Map<string, number>();

  for (const line of lines(out)) {
    const period = line.slice(0, 7); // YYYY-MM
    if (period.length === 7) {
      buckets.set(period, (buckets.get(period) ?? 0) + 1);
    }
  }

  // Sort chronologically, take last 12 months.
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([period, count]) => ({ period, count }));
}

function getAgeDays(cwd: string): number {
  // Date of the very first commit (reverse chronological, take last).
  const out = git("log --reverse --format=%aI", cwd);
  const firstLine = lines(out)[0];
  if (!firstLine) return 0;
  const firstCommit = new Date(firstLine);
  if (isNaN(firstCommit.getTime())) return 0;
  const diffMs = Date.now() - firstCommit.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Analyze the git history of a project.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns A `GitAnalysis` object with all collected metrics.
 */
export async function analyzeGit(projectRoot: string): Promise<GitAnalysis> {
  // Quick sanity check – is this even a git repo?
  const isRepo = git("rev-parse --is-inside-work-tree", projectRoot);
  if (isRepo !== "true") {
    return emptyAnalysis();
  }

  // Check for at least one commit.
  const hasCommits = git("rev-list -1 HEAD", projectRoot);
  if (!hasCommits) {
    return emptyAnalysis();
  }

  const branches = getBranches(projectRoot);

  return {
    total_commits: getTotalCommits(projectRoot),
    contributors: getContributors(projectRoot),
    active_files: getActiveFiles(projectRoot),
    branch_count: branches.length,
    branch_strategy: detectBranchStrategy(branches),
    churn_rate: getChurnRate(projectRoot),
    commit_frequency: getCommitFrequency(projectRoot),
    age_days: getAgeDays(projectRoot),
  };
}

// ---------------------------------------------------------------------------
// Fallback for non-git or empty repos
// ---------------------------------------------------------------------------

function emptyAnalysis(): GitAnalysis {
  return {
    total_commits: 0,
    contributors: [],
    active_files: [],
    branch_count: 0,
    branch_strategy: "unknown",
    churn_rate: [],
    commit_frequency: [],
    age_days: 0,
  };
}
