import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

interface HibernatedSession {
  sessionId: string;
  autonomyLevel: string;
  hibernatedAt: string;
  projectRoot: string;
  teamManifest: {
    name: string;
  };
  feedEntries: unknown[];
  gitCommitAtHibernation: string;
  sessionBudgetUsd: number;
  spentUsd: number;
}

function isHibernatedSession(value: unknown): value is HibernatedSession {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<HibernatedSession>;
  return (
    typeof candidate.sessionId === 'string' &&
    typeof candidate.autonomyLevel === 'string' &&
    typeof candidate.hibernatedAt === 'string' &&
    typeof candidate.projectRoot === 'string' &&
    typeof candidate.gitCommitAtHibernation === 'string' &&
    typeof candidate.sessionBudgetUsd === 'number' &&
    typeof candidate.spentUsd === 'number' &&
    Array.isArray(candidate.feedEntries) &&
    !!candidate.teamManifest &&
    typeof candidate.teamManifest === 'object' &&
    typeof candidate.teamManifest.name === 'string'
  );
}

function sessionDirectories(projectRoot: string): string[] {
  return [
    join(projectRoot, '.agentforge', 'team-sessions'),
    join(projectRoot, '.agentforge', 'sessions'),
  ];
}

async function readSessionsFromDirectory(directory: string): Promise<HibernatedSession[]> {
  if (!existsSync(directory)) {
    return [];
  }

  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return [];
  }

  const sessions: HibernatedSession[] = [];
  for (const file of files) {
    if (!file.startsWith('session-') || !file.endsWith('.json')) {
      continue;
    }

    try {
      const content = await readFile(join(directory, file), 'utf-8');
      const parsed = JSON.parse(content) as unknown;
      if (isHibernatedSession(parsed)) {
        sessions.push(parsed);
      }
    } catch {
      // Skip malformed or non-session JSON files.
    }
  }

  return sessions;
}

async function loadSessions(projectRoot: string): Promise<HibernatedSession[]> {
  const deduped = new Map<string, HibernatedSession>();
  for (const directory of sessionDirectories(projectRoot)) {
    const sessions = await readSessionsFromDirectory(directory);
    for (const session of sessions) {
      const existing = deduped.get(session.sessionId);
      if (!existing || session.hibernatedAt > existing.hibernatedAt) {
        deduped.set(session.sessionId, session);
      }
    }
  }

  return [...deduped.values()].sort((left, right) =>
    right.hibernatedAt.localeCompare(left.hibernatedAt),
  );
}

function getCurrentCommit(projectRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function isStale(currentCommit: string, savedCommit: string): boolean {
  if (!currentCommit || !savedCommit) {
    return false;
  }

  return currentCommit !== savedCommit;
}

export async function listTeamSessions(projectRoot: string): Promise<number> {
  const sessions = await loadSessions(projectRoot);
  if (sessions.length === 0) {
    console.log('\n  No hibernated sessions found.\n');
    return 0;
  }

  const currentCommit = getCurrentCommit(projectRoot);
  console.log('\n  Hibernated Sessions');
  console.log('  -------------------');

  for (const session of sessions) {
    const stale = isStale(currentCommit, session.gitCommitAtHibernation);
    const staleMarker = stale ? ' [STALE]' : '';
    const budgetRemaining = (session.sessionBudgetUsd - session.spentUsd).toFixed(2);

    console.log(`\n  ${session.sessionId.slice(0, 8)}${staleMarker}`);
    console.log(`    Autonomy:  ${session.autonomyLevel}`);
    console.log(`    Team:      ${session.teamManifest.name}`);
    console.log(
      `    Spent:     $${session.spentUsd.toFixed(2)} / $${session.sessionBudgetUsd.toFixed(2)} ($${budgetRemaining} remaining)`,
    );
    console.log(`    Feed:      ${session.feedEntries.length} entries`);
    console.log(`    Saved:     ${session.hibernatedAt}`);
    if (stale) {
      console.log(
        `    Warning:   Codebase changed since hibernation (was ${session.gitCommitAtHibernation}, now ${currentCommit})`,
      );
    }
  }

  console.log('');
  return 0;
}

export async function deleteTeamSession(
  projectRoot: string,
  sessionId: string,
): Promise<number> {
  let deletedAny = false;

  for (const directory of sessionDirectories(projectRoot)) {
    if (!existsSync(directory)) {
      continue;
    }

    let files: string[];
    try {
      files = await readdir(directory);
    } catch {
      continue;
    }

    const matching = files.filter(
      (file) => file.startsWith(`session-${sessionId}-`) && file.endsWith('.json'),
    );

    for (const file of matching) {
      try {
        await unlink(join(directory, file));
        deletedAny = true;
      } catch {
        // Best-effort cleanup across compatibility directories.
      }
    }
  }

  if (!deletedAny) {
    console.log(`  Session ${sessionId} not found.`);
    return 1;
  }

  console.log(`  Session ${sessionId} deleted.`);
  return 0;
}
