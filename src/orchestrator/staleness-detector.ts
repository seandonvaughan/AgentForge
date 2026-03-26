import { execFileSync } from "node:child_process";

export class StalenessDetector {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async getCurrentCommit(): Promise<string> {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: this.projectRoot,
        encoding: "utf-8",
      }).trim();
    } catch {
      return "";
    }
  }

  async getCommitsBetween(fromCommit: string, toCommit: string): Promise<string[]> {
    if (fromCommit === toCommit) return [];
    try {
      const output = execFileSync("git", ["log", "--oneline", `${fromCommit}..${toCommit}`], {
        cwd: this.projectRoot,
        encoding: "utf-8",
      }).trim();
      return output ? output.split("\n") : [];
    } catch {
      return [];
    }
  }

  async isStale(savedCommit: string): Promise<boolean> {
    if (!savedCommit) return false;
    const current = await this.getCurrentCommit();
    return current !== savedCommit;
  }

  async getCommitDistance(fromCommit: string, toCommit: string): Promise<number> {
    const commits = await this.getCommitsBetween(fromCommit, toCommit);
    return commits.length;
  }

  formatStalenessWarning(isStale: boolean, commitDistance: number): string | null {
    if (!isStale) return null;
    if (commitDistance > 0) {
      return `  ⚠ Session is ${commitDistance} commit(s) behind current HEAD. Context may be stale.`;
    }
    return `  ⚠ Repository has changed since session was hibernated. Context may be stale.`;
  }
}
