/**
 * KnowledgeStore — Multi-scope knowledge persistence for the v3 communication layer.
 *
 * Three scopes:
 *   - session:  In-memory only, cleared between sessions
 *   - project:  Persisted to `.agentforge/knowledge/project/`
 *   - entity:   Persisted to `.agentforge/knowledge/entity/`
 *
 * Iron Law 5: Zero new npm dependencies — uses fs + JSON.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { KnowledgeScope, KnowledgeEntry } from "../types/knowledge.js";

// ---------------------------------------------------------------------------
// KnowledgeStore
// ---------------------------------------------------------------------------

export class KnowledgeStore {
  private readonly baseDir: string;
  private readonly sessionCache = new Map<string, KnowledgeEntry>();
  private entriesCreated = 0;

  constructor(projectRoot: string) {
    this.baseDir = path.join(projectRoot, ".agentforge", "knowledge");
  }

  // =========================================================================
  // Write
  // =========================================================================

  /**
   * Set a knowledge entry. Creates or updates.
   *
   * Session-scope entries are stored in memory only.
   * Project and entity entries are persisted to disk.
   */
  async set(
    scope: KnowledgeScope,
    key: string,
    value: unknown,
    createdBy: string,
    tags?: string[],
  ): Promise<KnowledgeEntry> {
    const now = new Date().toISOString();
    const existing = await this.get(scope, key);

    const entry: KnowledgeEntry = {
      id: existing?.id ?? randomUUID(),
      scope,
      key,
      value,
      createdBy: existing?.createdBy ?? createdBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      tags,
    };

    if (scope === "session") {
      this.sessionCache.set(key, entry);
    } else {
      await this.writeToDisk(scope, key, entry);
    }

    if (!existing) this.entriesCreated++;
    return entry;
  }

  // =========================================================================
  // Read
  // =========================================================================

  /** Retrieve a single entry by scope and key. Returns null if not found. */
  async get(
    scope: KnowledgeScope,
    key: string,
  ): Promise<KnowledgeEntry | null> {
    if (scope === "session") {
      return this.sessionCache.get(key) ?? null;
    }
    return this.readFromDisk(scope, key);
  }

  /**
   * Query entries within a scope, optionally filtered by tags or creator.
   */
  async query(
    scope: KnowledgeScope,
    options?: { tags?: string[]; createdBy?: string },
  ): Promise<KnowledgeEntry[]> {
    let entries: KnowledgeEntry[];

    if (scope === "session") {
      entries = [...this.sessionCache.values()];
    } else {
      entries = await this.loadAllFromDisk(scope);
    }

    if (options?.tags && options.tags.length > 0) {
      const filterTags = new Set(options.tags);
      entries = entries.filter(
        (e) => e.tags && e.tags.some((t) => filterTags.has(t)),
      );
    }

    if (options?.createdBy) {
      entries = entries.filter((e) => e.createdBy === options.createdBy);
    }

    return entries;
  }

  // =========================================================================
  // Delete
  // =========================================================================

  /** Delete a single entry. Returns true if the entry existed. */
  async delete(scope: KnowledgeScope, key: string): Promise<boolean> {
    if (scope === "session") {
      return this.sessionCache.delete(key);
    }
    return this.deleteFromDisk(scope, key);
  }

  /** Clear all session-scope entries. Called between sessions. */
  clearSession(): void {
    this.sessionCache.clear();
  }

  // =========================================================================
  // Metrics
  // =========================================================================

  /** Number of entries created during this store's lifetime. */
  getEntriesCreatedCount(): number {
    return this.entriesCreated;
  }

  // =========================================================================
  // Disk I/O
  // =========================================================================

  private scopeDir(scope: KnowledgeScope): string {
    return path.join(this.baseDir, scope);
  }

  private keyToFilename(key: string): string {
    // Sanitize key for filesystem: replace non-alphanumeric (except - and _) with _
    return key.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
  }

  private async writeToDisk(
    scope: KnowledgeScope,
    key: string,
    entry: KnowledgeEntry,
  ): Promise<void> {
    const dir = this.scopeDir(scope);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, this.keyToFilename(key));
    await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }

  private async readFromDisk(
    scope: KnowledgeScope,
    key: string,
  ): Promise<KnowledgeEntry | null> {
    const filePath = path.join(this.scopeDir(scope), this.keyToFilename(key));
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as KnowledgeEntry;
    } catch {
      return null;
    }
  }

  private async loadAllFromDisk(
    scope: KnowledgeScope,
  ): Promise<KnowledgeEntry[]> {
    const dir = this.scopeDir(scope);
    try {
      const files = await fs.readdir(dir);
      const results: KnowledgeEntry[] = [];
      for (const file of files.filter((f) => f.endsWith(".json"))) {
        try {
          const raw = await fs.readFile(path.join(dir, file), "utf-8");
          results.push(JSON.parse(raw) as KnowledgeEntry);
        } catch {
          // Skip corrupted files
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  private async deleteFromDisk(
    scope: KnowledgeScope,
    key: string,
  ): Promise<boolean> {
    const filePath = path.join(this.scopeDir(scope), this.keyToFilename(key));
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
