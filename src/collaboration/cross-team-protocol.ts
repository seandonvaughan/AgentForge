/**
 * CrossTeamProtocol — v4.6 P1-4
 *
 * Manages API contracts, work handoffs, and research transfers across teams.
 * Supports filtering by team, status, and readiness level.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TeamId = 'frontend' | 'backend' | 'infra' | 'r&d' | 'quality';

export interface ApiContract {
  contractId: string;
  version: string;
  producerTeam: TeamId;
  consumerTeam: TeamId;
  endpoint: string;
  schema: Record<string, unknown>;
  status: 'draft' | 'agreed' | 'deprecated';
  createdAt: string;
}

export interface HandoffRequest {
  handoffId: string;
  fromTeam: TeamId;
  toTeam: TeamId;
  artifact: string;
  description: string;
  status: 'pending' | 'accepted' | 'rejected' | 'completed';
  createdAt: string;
  resolvedAt?: string;
}

export interface ResearchTransfer {
  transferId: string;
  sprintId: string;
  finding: string;
  productionReadiness: 'not-ready' | 'experimental' | 'ready';
  assignedTeam?: TeamId;
  status: 'pending' | 'assigned' | 'in-progress' | 'shipped';
  createdAt: string;
}

export interface TeamStats {
  pendingHandoffs: number;
  activeContracts: number;
  researchItems: number;
}

// ---------------------------------------------------------------------------
// CrossTeamProtocol
// ---------------------------------------------------------------------------

export class CrossTeamProtocol {
  private contracts: ApiContract[] = [];
  private handoffs: HandoffRequest[] = [];
  private researchTransfers: ResearchTransfer[] = [];

  // -------------------------------------------------------------------------
  // API Contracts
  // -------------------------------------------------------------------------

  registerContract(contract: ApiContract): void {
    this.contracts.push({ ...contract });
  }

  getContracts(filter?: {
    producerTeam?: TeamId;
    consumerTeam?: TeamId;
    status?: ApiContract['status'];
  }): ApiContract[] {
    let result = this.contracts.map((c) => ({ ...c }));
    if (filter?.producerTeam !== undefined) {
      result = result.filter((c) => c.producerTeam === filter.producerTeam);
    }
    if (filter?.consumerTeam !== undefined) {
      result = result.filter((c) => c.consumerTeam === filter.consumerTeam);
    }
    if (filter?.status !== undefined) {
      result = result.filter((c) => c.status === filter.status);
    }
    return result;
  }

  updateContractStatus(contractId: string, status: ApiContract['status']): boolean {
    const contract = this.contracts.find((c) => c.contractId === contractId);
    if (!contract) return false;
    contract.status = status;
    return true;
  }

  // -------------------------------------------------------------------------
  // Handoff Requests
  // -------------------------------------------------------------------------

  createHandoff(request: HandoffRequest): void {
    this.handoffs.push({ ...request });
  }

  getHandoffs(filter?: {
    fromTeam?: TeamId;
    toTeam?: TeamId;
    status?: HandoffRequest['status'];
  }): HandoffRequest[] {
    let result = this.handoffs.map((h) => ({ ...h }));
    if (filter?.fromTeam !== undefined) {
      result = result.filter((h) => h.fromTeam === filter.fromTeam);
    }
    if (filter?.toTeam !== undefined) {
      result = result.filter((h) => h.toTeam === filter.toTeam);
    }
    if (filter?.status !== undefined) {
      result = result.filter((h) => h.status === filter.status);
    }
    return result;
  }

  resolveHandoff(handoffId: string, status: 'accepted' | 'rejected' | 'completed'): boolean {
    const handoff = this.handoffs.find((h) => h.handoffId === handoffId);
    if (!handoff) return false;
    handoff.status = status;
    handoff.resolvedAt = new Date().toISOString();
    return true;
  }

  // -------------------------------------------------------------------------
  // Research Transfers
  // -------------------------------------------------------------------------

  createResearchTransfer(transfer: ResearchTransfer): void {
    this.researchTransfers.push({ ...transfer });
  }

  getResearchTransfers(filter?: {
    status?: ResearchTransfer['status'];
    productionReadiness?: ResearchTransfer['productionReadiness'];
  }): ResearchTransfer[] {
    let result = this.researchTransfers.map((t) => ({ ...t }));
    if (filter?.status !== undefined) {
      result = result.filter((t) => t.status === filter.status);
    }
    if (filter?.productionReadiness !== undefined) {
      result = result.filter((t) => t.productionReadiness === filter.productionReadiness);
    }
    return result;
  }

  assignResearchTransfer(transferId: string, team: TeamId): boolean {
    const transfer = this.researchTransfers.find((t) => t.transferId === transferId);
    if (!transfer) return false;
    transfer.assignedTeam = team;
    transfer.status = 'assigned';
    return true;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getTeamStats(teamId: TeamId): TeamStats {
    const pendingHandoffs = this.handoffs.filter(
      (h) => (h.fromTeam === teamId || h.toTeam === teamId) && h.status === 'pending',
    ).length;

    const activeContracts = this.contracts.filter(
      (c) =>
        (c.producerTeam === teamId || c.consumerTeam === teamId) &&
        c.status === 'agreed',
    ).length;

    const researchItems = this.researchTransfers.filter(
      (t) => t.assignedTeam === teamId,
    ).length;

    return { pendingHandoffs, activeContracts, researchItems };
  }
}
