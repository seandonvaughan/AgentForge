import { promises as fs } from "node:fs";
import path from "node:path";
import type { HibernatedSession } from "../types/team-mode.js";

function isHibernatedSession(value: unknown): value is HibernatedSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<HibernatedSession>;
  return (
    typeof candidate.sessionId === "string" &&
    typeof candidate.hibernatedAt === "string" &&
    typeof candidate.projectRoot === "string" &&
    typeof candidate.gitCommitAtHibernation === "string" &&
    typeof candidate.sessionBudgetUsd === "number" &&
    typeof candidate.spentUsd === "number" &&
    Array.isArray(candidate.feedEntries) &&
    !!candidate.teamManifest &&
    typeof candidate.teamManifest === "object"
  );
}

export class SessionSerializer {
  private sessionsDir: string;

  constructor(projectRoot: string) {
    this.sessionsDir = path.join(projectRoot, ".agentforge", "sessions");
  }

  async save(snapshot: HibernatedSession): Promise<string> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const filename = `session-${snapshot.sessionId}-${Date.now()}.json`;
    const filepath = path.join(this.sessionsDir, filename);
    await fs.writeFile(filepath, JSON.stringify(snapshot, null, 2), "utf-8");
    return filepath;
  }

  async loadLatest(): Promise<HibernatedSession | null> {
    const all = await this.list();
    return all[0] ?? null;
  }

  async loadById(sessionId: string): Promise<HibernatedSession | null> {
    const all = await this.list();
    return all.find((s) => s.sessionId === sessionId) ?? null;
  }

  async list(): Promise<HibernatedSession[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.sessionsDir);
    } catch {
      return [];
    }

    const sessionFiles = files.filter((f) => f.startsWith("session-") && f.endsWith(".json"));
    const sessions: HibernatedSession[] = [];

    for (const file of sessionFiles) {
      try {
        const content = await fs.readFile(path.join(this.sessionsDir, file), "utf-8");
        const parsed = JSON.parse(content) as unknown;
        if (isHibernatedSession(parsed)) {
          sessions.push(parsed);
        }
      } catch {
        // Skip malformed files
      }
    }

    return sessions.sort((a, b) => b.hibernatedAt.localeCompare(a.hibernatedAt));
  }

  async deleteById(sessionId: string): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.sessionsDir);
    } catch {
      return;
    }

    const matching = files.filter(
      (f) => f.startsWith(`session-${sessionId}-`) && f.endsWith(".json")
    );

    for (const file of matching) {
      await fs.unlink(path.join(this.sessionsDir, file)).catch(() => undefined);
    }
  }
}
