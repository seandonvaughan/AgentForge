/**
 * V4ReforgeEngine — Sprint 4.2b
 *
 * Self-modification protocol with guardrail pipeline.
 * Lifecycle: submit → evaluate (guardrails) → apply (snapshot) → verify → done
 *            at any point after apply: rollback
 *
 * Auto-rollback triggers on REFORGE_TIMEOUT_MS (120s) if not verified.
 */

export const REFORGE_TIMEOUT_MS = 120_000;

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

export class V4ReforgeEngine {
  private records = new Map<string, ReforgeRecord>();
  private guardrails: ReforgeGuardrail[];

  constructor(guardrails: ReforgeGuardrail[] = []) {
    this.guardrails = guardrails;
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
    return this.cloneRecord(record) as ReforgeRecord & { status: "pending" };
  }

  evaluate(proposalId: string): ReforgeRecord {
    const record = this.require(proposalId);
    if (record.status !== "pending") {
      throw new Error(`Proposal "${proposalId}" must be pending to evaluate (current: "${record.status}")`);
    }

    const results: GuardrailResult[] = this.guardrails.map((g) => {
      const r = g.validate(record.proposal);
      return { name: g.name, pass: r.pass, reason: r.reason };
    });

    record.guardrailResults = results;
    const allPass = results.every((r) => r.pass);
    record.status = allPass ? "approved" : "rejected";
    record.history.push({ status: record.status, timestamp: new Date().toISOString() });

    return this.cloneRecord(record);
  }

  apply(proposalId: string): ReforgeRecord & { snapshotTag: string } {
    const record = this.require(proposalId);
    if (record.status !== "approved") {
      throw new Error(`Proposal "${proposalId}" must be approved to apply (current: "${record.status}")`);
    }

    record.snapshotTag = `reforge-${proposalId}-${Date.now()}`;
    record.appliedAt = Date.now();
    record.status = "applied";
    record.history.push({ status: "applied", timestamp: new Date().toISOString() });

    return this.cloneRecord(record) as ReforgeRecord & { snapshotTag: string };
  }

  verify(proposalId: string): ReforgeRecord {
    const record = this.require(proposalId);
    if (record.status !== "applied") {
      throw new Error(`Proposal "${proposalId}" must be applied to verify (current: "${record.status}")`);
    }
    record.status = "verified";
    record.history.push({ status: "verified", timestamp: new Date().toISOString() });
    return this.cloneRecord(record);
  }

  rollback(proposalId: string): ReforgeRecord {
    const record = this.require(proposalId);
    if (record.status !== "applied") {
      throw new Error(`Proposal "${proposalId}" must be applied to rollback (current: "${record.status}")`);
    }
    record.status = "rolled_back";
    record.history.push({ status: "rolled_back", timestamp: new Date().toISOString() });
    return this.cloneRecord(record);
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
