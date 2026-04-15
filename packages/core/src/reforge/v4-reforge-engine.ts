/**
 * V4ReforgeEngine — Sprint 4.2b + v4.1 P0-3 (git integration)
 *
 * Self-modification protocol with guardrail pipeline.
 * Lifecycle: submit → evaluate (guardrails) → apply (snapshot) → verify → done
 *            at any point after apply: rollback
 *
 * v4.1: GitAdapter/FileAdapter/TestRunner interfaces enable real git operations.
 * Auto-rollback triggers on REFORGE_TIMEOUT_MS (120s) if not verified.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type {
  MessageCategory,
  V4MessagePriority,
  DisplayTierHint,
} from "../team/engine/types/v4-api.js";

export interface V4MessageBusLike {
  publish<TPayload>(options: {
    from: string;
    to: string;
    topic: string;
    category: MessageCategory;
    payload: TPayload;
    priority?: V4MessagePriority;
    replyTo?: string;
    conversationId?: string;
    ttl?: string;
    displayTierHint?: DisplayTierHint;
    metadata?: Record<string, unknown>;
  }): unknown;
}

export const REFORGE_TIMEOUT_MS = 120_000;

/**
 * GitAdapter — pluggable git operations for REFORGE.
 */
export interface GitAdapter {
  createTag(tag: string): void;
  deleteTag(tag: string): void;
  tagExists(tag: string): boolean;
}

export class RealGitAdapter implements GitAdapter {
  createTag(tag: string): void {
    execFileSync("git", ["tag", tag], { stdio: "pipe" });
  }
  deleteTag(tag: string): void {
    try { execFileSync("git", ["tag", "-d", tag], { stdio: "pipe" }); } catch { /* tag may not exist */ }
  }
  tagExists(tag: string): boolean {
    try {
      execFileSync("git", ["rev-parse", tag], { stdio: "pipe" });
      return true;
    } catch { return false; }
  }
}

export class InMemoryGitAdapter implements GitAdapter {
  tags = new Set<string>();
  createTag(tag: string): void { this.tags.add(tag); }
  deleteTag(tag: string): void { this.tags.delete(tag); }
  tagExists(tag: string): boolean { return this.tags.has(tag); }
}

/**
 * FileAdapter — pluggable file operations for REFORGE.
 */
export interface FileAdapter {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  deleteFile(path: string): void;
  fileExists(path: string): boolean;
}

export class RealFileAdapter implements FileAdapter {
  readFile(path: string): string { return readFileSync(path, "utf-8"); }
  writeFile(path: string, content: string): void { writeFileSync(path, content, "utf-8"); }
  deleteFile(path: string): void { unlinkSync(path); }
  fileExists(path: string): boolean { return existsSync(path); }
}

export class InMemoryFileAdapter implements FileAdapter {
  files = new Map<string, string>();
  readFile(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }
  writeFile(path: string, content: string): void { this.files.set(path, content); }
  deleteFile(path: string): void { this.files.delete(path); }
  fileExists(path: string): boolean { return this.files.has(path); }
}

/**
 * TestRunner — pluggable test execution for verify().
 */
export interface TestRunner {
  runTests(): { pass: boolean; output: string };
}

export class InMemoryTestRunner implements TestRunner {
  result: { pass: boolean; output: string } = { pass: true, output: "All tests passed" };
  runTests(): { pass: boolean; output: string } { return this.result; }
}

export type ReforgeStatus = "pending" | "approved" | "rejected" | "applied" | "verified" | "rolled_back";

export interface ReforgeProposal {
  proposalId: string;
  description: string;
  targetFile: string;
  changeType: "create" | "modify" | "delete";
  diff: string;
  proposedBy: string;
  rationale: string;
}

export interface GuardrailResult {
  name: string;
  pass: boolean;
  reason?: string;
}

export interface ReforgeGuardrail {
  name: string;
  validate: (proposal: ReforgeProposal) => { pass: boolean; reason?: string };
}

interface ReforgeRecord {
  proposal: ReforgeProposal;
  status: ReforgeStatus;
  guardrailResults: GuardrailResult[];
  snapshotTag?: string;
  appliedAt?: number;
  history: { status: ReforgeStatus; timestamp: string }[];
}

export interface ReforgeEngineOptions {
  guardrails?: ReforgeGuardrail[];
  git?: GitAdapter;
  files?: FileAdapter;
  testRunner?: TestRunner;
  bus?: V4MessageBusLike;
}

export class V4ReforgeEngine {
  private records = new Map<string, ReforgeRecord>();
  private guardrails: ReforgeGuardrail[];
  private git: GitAdapter | undefined;
  private files: FileAdapter | undefined;
  private testRunner: TestRunner | undefined;
  private bus: V4MessageBusLike | undefined;
  private snapshots = new Map<string, string>(); // proposalId → original file content

  constructor(guardrailsOrOptions: ReforgeGuardrail[] | ReforgeEngineOptions = []) {
    if (Array.isArray(guardrailsOrOptions)) {
      this.guardrails = guardrailsOrOptions;
    } else {
      this.guardrails = guardrailsOrOptions.guardrails ?? [];
      this.git = guardrailsOrOptions.git;
      this.files = guardrailsOrOptions.files;
      this.testRunner = guardrailsOrOptions.testRunner;
      this.bus = guardrailsOrOptions.bus;
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  submit(proposal: ReforgeProposal): ReforgeRecord & { status: "pending" } {
    if (this.records.has(proposal.proposalId)) {
      throw new Error(`Proposal "${proposal.proposalId}" already exists`);
    }
    const record: ReforgeRecord = {
      proposal: { ...proposal },
      status: "pending",
      guardrailResults: [],
      history: [{ status: "pending", timestamp: new Date().toISOString() }],
    };
    this.records.set(proposal.proposalId, record);
    if (this.bus) {
      this.bus.publish({
        from: "reforge-engine",
        to: "broadcast",
        topic: "reforge.submitted",
        category: "status",
        payload: { proposalId: proposal.proposalId, description: proposal.description },
        priority: "normal",
      });
    }
    return this.cloneRecord(record) as ReforgeRecord & { status: "pending" };
  }

  evaluate(proposalId: string): ReforgeRecord {
    const record = this.require(proposalId);
    if (record.status !== "pending") {
      throw new Error(`Proposal "${proposalId}" must be pending to evaluate (current: "${record.status}")`);
    }

    const results: GuardrailResult[] = this.guardrails.map((g) => {
      const r = g.validate(record.proposal);
      return {
        name: g.name,
        pass: r.pass,
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
      };
    });

    record.guardrailResults = results;
    const allPass = results.every((r) => r.pass);
    record.status = allPass ? "approved" : "rejected";
    record.history.push({ status: record.status, timestamp: new Date().toISOString() });

    if (this.bus) {
      this.bus.publish({
        from: "reforge-engine",
        to: "broadcast",
        topic: allPass ? "reforge.approved" : "reforge.rejected",
        category: "status",
        payload: { proposalId, status: record.status },
        priority: "normal",
      });
    }
    return this.cloneRecord(record);
  }

  apply(proposalId: string): ReforgeRecord & { snapshotTag: string } {
    const record = this.require(proposalId);
    if (record.status !== "approved") {
      throw new Error(`Proposal "${proposalId}" must be approved to apply (current: "${record.status}")`);
    }

    record.snapshotTag = `reforge-${proposalId}-${Date.now()}`;
    record.appliedAt = Date.now();

    // Git: create snapshot tag
    if (this.git) {
      this.git.createTag(record.snapshotTag);
    }

    // Files: snapshot original content, then apply diff
    if (this.files) {
      const { targetFile, changeType, diff } = record.proposal;
      if (changeType === "modify" && this.files.fileExists(targetFile)) {
        this.snapshots.set(proposalId, this.files.readFile(targetFile));
        this.files.writeFile(targetFile, diff);
      } else if (changeType === "create") {
        this.snapshots.set(proposalId, "");
        this.files.writeFile(targetFile, diff);
      } else if (changeType === "delete" && this.files.fileExists(targetFile)) {
        this.snapshots.set(proposalId, this.files.readFile(targetFile));
        this.files.deleteFile(targetFile);
      }
    }

    record.status = "applied";
    record.history.push({ status: "applied", timestamp: new Date().toISOString() });

    if (this.bus) {
      this.bus.publish({
        from: "reforge-engine",
        to: "broadcast",
        topic: "reforge.applied",
        category: "status",
        payload: { proposalId, snapshotTag: record.snapshotTag },
        priority: "normal",
      });
    }
    return this.cloneRecord(record) as ReforgeRecord & { snapshotTag: string };
  }

  verify(proposalId: string): ReforgeRecord & { testOutput?: string } {
    const record = this.require(proposalId);
    if (record.status !== "applied") {
      throw new Error(`Proposal "${proposalId}" must be applied to verify (current: "${record.status}")`);
    }

    // If test runner provided, run tests and auto-rollback on failure
    if (this.testRunner) {
      const result = this.testRunner.runTests();
      if (!result.pass) {
        this.doRollback(record, proposalId);
        const cloned = this.cloneRecord(record);
        (cloned as any).testOutput = result.output;
        return cloned;
      }
    }

    record.status = "verified";
    record.history.push({ status: "verified", timestamp: new Date().toISOString() });
    if (this.bus) {
      this.bus.publish({
        from: "reforge-engine",
        to: "broadcast",
        topic: "reforge.verified",
        category: "status",
        payload: { proposalId },
        priority: "normal",
      });
    }
    return this.cloneRecord(record);
  }

  rollback(proposalId: string): ReforgeRecord {
    const record = this.require(proposalId);
    if (record.status !== "applied") {
      throw new Error(`Proposal "${proposalId}" must be applied to rollback (current: "${record.status}")`);
    }
    this.doRollback(record, proposalId);
    if (this.bus) {
      this.bus.publish({
        from: "reforge-engine",
        to: "broadcast",
        topic: "reforge.rolled_back",
        category: "status",
        payload: { proposalId },
        priority: "normal",
      });
    }
    return this.cloneRecord(record);
  }

  private doRollback(record: ReforgeRecord, proposalId: string): void {
    // Restore original file content
    if (this.files && this.snapshots.has(proposalId)) {
      const original = this.snapshots.get(proposalId)!;
      const { targetFile, changeType } = record.proposal;
      if (changeType === "create") {
        if (this.files.fileExists(targetFile)) this.files.deleteFile(targetFile);
      } else if (changeType === "delete") {
        this.files.writeFile(targetFile, original);
      } else {
        this.files.writeFile(targetFile, original);
      }
      this.snapshots.delete(proposalId);
    }

    // Remove git tag
    if (this.git && record.snapshotTag) {
      this.git.deleteTag(record.snapshotTag);
    }

    record.status = "rolled_back";
    record.history.push({ status: "rolled_back", timestamp: new Date().toISOString() });
  }

  // ---------------------------------------------------------------------------
  // Auto-rollback
  // ---------------------------------------------------------------------------

  checkTimeouts(): string[] {
    const rolledBack: string[] = [];
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.status === "applied" && record.appliedAt &&
          now - record.appliedAt > REFORGE_TIMEOUT_MS) {
        record.status = "rolled_back";
        record.history.push({ status: "rolled_back", timestamp: new Date().toISOString() });
        rolledBack.push(id);
        if (this.bus) {
          this.bus.publish({
            from: "reforge-engine",
            to: "broadcast",
            topic: "reforge.rolled_back",
            category: "status",
            payload: { proposalId: id },
            priority: "normal",
          });
        }
      }
    }
    return rolledBack;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getProposal(proposalId: string): (ReforgeRecord & { proposal: ReforgeProposal }) | null {
    const r = this.records.get(proposalId);
    return r ? this.cloneRecord(r) : null;
  }

  listProposals(): ReforgeRecord[] {
    return Array.from(this.records.values()).map((r) => this.cloneRecord(r));
  }

  getHistory(proposalId: string): { status: ReforgeStatus; timestamp: string }[] {
    const r = this.require(proposalId);
    return r.history.map((h) => ({ ...h }));
  }

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  _setAppliedAtForTest(proposalId: string, timestamp: number): void {
    const r = this.require(proposalId);
    r.appliedAt = timestamp;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private require(proposalId: string): ReforgeRecord {
    const r = this.records.get(proposalId);
    if (!r) throw new Error(`Proposal "${proposalId}" not found`);
    return r;
  }

  private cloneRecord(record: ReforgeRecord): ReforgeRecord {
    return {
      ...record,
      proposal: { ...record.proposal },
      guardrailResults: record.guardrailResults.map((g) => ({ ...g })),
      history: record.history.map((h) => ({ ...h })),
    };
  }
}
