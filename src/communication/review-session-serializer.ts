/**
 * ReviewSessionSerializer — Sprint 2.2a
 *
 * Serializes long-running review state to /.forge/reviews/{reviewId}.json
 * so reviews survive agent deactivation/reactivation cycles.
 *
 * Persistence-lead condition: flock(2) advisory locks on write.
 * In Node.js single-threaded context: we use a write mutex (promise chain)
 * as a safe in-process equivalent. Cross-process locking deferred to Sprint 3.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReviewRecord } from "./review-router.js";

export interface SerializedReviewSession {
  schemaVersion: string;
  reviewId: string;
  record: ReviewRecord;
  serializedAt: string;
  agentSessionId?: string;     // Which agent session was processing this
}

export class ReviewSessionSerializer {
  private readonly reviewsDir: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.reviewsDir = path.join(projectRoot, ".forge", "reviews");
  }

  /** Serialize a review to disk. Uses promise-chained write lock. */
  async save(
    record: ReviewRecord,
    agentSessionId?: string
  ): Promise<string> {
    const session: SerializedReviewSession = {
      schemaVersion: "4.0",
      reviewId: record.reviewId,
      record,
      serializedAt: new Date().toISOString(),
      agentSessionId,
    };
    const filepath = path.join(this.reviewsDir, `${record.reviewId}.json`);
    this.writeLock = this.writeLock.then(async () => {
      await fs.mkdir(this.reviewsDir, { recursive: true });
      await fs.writeFile(filepath, JSON.stringify(session, null, 2), "utf-8");
    });
    await this.writeLock;
    return filepath;
  }

  /** Load a review session by ID. Returns null if not found. */
  async load(reviewId: string): Promise<SerializedReviewSession | null> {
    const filepath = path.join(this.reviewsDir, `${reviewId}.json`);
    try {
      const content = await fs.readFile(filepath, "utf-8");
      return JSON.parse(content) as SerializedReviewSession;
    } catch {
      return null;
    }
  }

  /** List all serialized review sessions, newest first. */
  async list(): Promise<SerializedReviewSession[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.reviewsDir);
    } catch {
      return [];
    }
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    const sessions = await Promise.all(
      jsonFiles.map(async (f) => {
        try {
          const content = await fs.readFile(
            path.join(this.reviewsDir, f), "utf-8"
          );
          return JSON.parse(content) as SerializedReviewSession;
        } catch {
          return null;
        }
      })
    );
    return sessions
      .filter((s): s is SerializedReviewSession => s !== null)
      .sort((a, b) => b.serializedAt.localeCompare(a.serializedAt));
  }

  /** Delete a review session file. */
  async delete(reviewId: string): Promise<boolean> {
    const filepath = path.join(this.reviewsDir, `${reviewId}.json`);
    try {
      await fs.unlink(filepath);
      return true;
    } catch {
      return false;
    }
  }

  /** Number of serialized sessions on disk. */
  async count(): Promise<number> {
    const sessions = await this.list();
    return sessions.length;
  }
}
