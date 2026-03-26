import { describe, it, expect, beforeEach } from 'vitest';
import {
  CrossTeamProtocol,
  type ApiContract,
  type HandoffRequest,
  type ResearchTransfer,
} from '../../src/collaboration/cross-team-protocol.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContract(overrides: Partial<ApiContract> = {}): ApiContract {
  return {
    contractId: 'contract-1',
    version: '1.0.0',
    producerTeam: 'backend',
    consumerTeam: 'frontend',
    endpoint: '/api/users',
    schema: { userId: 'string' },
    status: 'draft',
    createdAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

function makeHandoff(overrides: Partial<HandoffRequest> = {}): HandoffRequest {
  return {
    handoffId: 'handoff-1',
    fromTeam: 'backend',
    toTeam: 'frontend',
    artifact: 'feature/auth-api',
    description: 'Auth API ready for integration',
    status: 'pending',
    createdAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

function makeTransfer(overrides: Partial<ResearchTransfer> = {}): ResearchTransfer {
  return {
    transferId: 'transfer-1',
    sprintId: 'sprint-46',
    finding: 'New caching strategy reduces latency by 40%',
    productionReadiness: 'experimental',
    status: 'pending',
    createdAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossTeamProtocol', () => {
  let protocol: CrossTeamProtocol;

  beforeEach(() => {
    protocol = new CrossTeamProtocol();
  });

  // -------------------------------------------------------------------------
  // API Contracts
  // -------------------------------------------------------------------------

  describe('registerContract', () => {
    it('stores a contract and returns it via getContracts', () => {
      const contract = makeContract();
      protocol.registerContract(contract);
      const result = protocol.getContracts();
      expect(result).toHaveLength(1);
      expect(result[0]?.contractId).toBe('contract-1');
    });

    it('stores multiple contracts independently', () => {
      protocol.registerContract(makeContract({ contractId: 'c-1' }));
      protocol.registerContract(makeContract({ contractId: 'c-2' }));
      expect(protocol.getContracts()).toHaveLength(2);
    });

    it('returns a copy so mutations do not affect internal state', () => {
      protocol.registerContract(makeContract());
      const result = protocol.getContracts();
      result[0]!.status = 'deprecated';
      expect(protocol.getContracts()[0]?.status).toBe('draft');
    });
  });

  describe('getContracts with filters', () => {
    beforeEach(() => {
      protocol.registerContract(makeContract({ contractId: 'c-1', producerTeam: 'backend', consumerTeam: 'frontend', status: 'draft' }));
      protocol.registerContract(makeContract({ contractId: 'c-2', producerTeam: 'infra', consumerTeam: 'backend', status: 'agreed' }));
      protocol.registerContract(makeContract({ contractId: 'c-3', producerTeam: 'backend', consumerTeam: 'quality', status: 'agreed' }));
    });

    it('filters by producerTeam', () => {
      const result = protocol.getContracts({ producerTeam: 'backend' });
      expect(result).toHaveLength(2);
      expect(result.every((c) => c.producerTeam === 'backend')).toBe(true);
    });

    it('filters by consumerTeam', () => {
      const result = protocol.getContracts({ consumerTeam: 'backend' });
      expect(result).toHaveLength(1);
      expect(result[0]?.contractId).toBe('c-2');
    });

    it('filters by status', () => {
      const result = protocol.getContracts({ status: 'agreed' });
      expect(result).toHaveLength(2);
      expect(result.every((c) => c.status === 'agreed')).toBe(true);
    });

    it('applies multiple filters together', () => {
      const result = protocol.getContracts({ producerTeam: 'backend', status: 'agreed' });
      expect(result).toHaveLength(1);
      expect(result[0]?.contractId).toBe('c-3');
    });

    it('returns all contracts when no filter provided', () => {
      expect(protocol.getContracts()).toHaveLength(3);
    });
  });

  describe('updateContractStatus', () => {
    it('updates status and returns true for known contractId', () => {
      protocol.registerContract(makeContract({ contractId: 'c-1', status: 'draft' }));
      const result = protocol.updateContractStatus('c-1', 'agreed');
      expect(result).toBe(true);
      expect(protocol.getContracts()[0]?.status).toBe('agreed');
    });

    it('returns false for unknown contractId', () => {
      expect(protocol.updateContractStatus('nonexistent', 'agreed')).toBe(false);
    });

    it('can deprecate an agreed contract', () => {
      protocol.registerContract(makeContract({ contractId: 'c-1', status: 'agreed' }));
      protocol.updateContractStatus('c-1', 'deprecated');
      expect(protocol.getContracts()[0]?.status).toBe('deprecated');
    });
  });

  // -------------------------------------------------------------------------
  // Handoff Requests
  // -------------------------------------------------------------------------

  describe('createHandoff', () => {
    it('stores a handoff and retrieves it', () => {
      protocol.createHandoff(makeHandoff());
      const result = protocol.getHandoffs();
      expect(result).toHaveLength(1);
      expect(result[0]?.handoffId).toBe('handoff-1');
    });

    it('returns a copy so mutations do not affect internal state', () => {
      protocol.createHandoff(makeHandoff());
      const result = protocol.getHandoffs();
      result[0]!.status = 'accepted';
      expect(protocol.getHandoffs()[0]?.status).toBe('pending');
    });
  });

  describe('getHandoffs with filters', () => {
    beforeEach(() => {
      protocol.createHandoff(makeHandoff({ handoffId: 'h-1', fromTeam: 'backend', toTeam: 'frontend', status: 'pending' }));
      protocol.createHandoff(makeHandoff({ handoffId: 'h-2', fromTeam: 'infra', toTeam: 'backend', status: 'accepted' }));
      protocol.createHandoff(makeHandoff({ handoffId: 'h-3', fromTeam: 'backend', toTeam: 'quality', status: 'pending' }));
    });

    it('filters by fromTeam', () => {
      const result = protocol.getHandoffs({ fromTeam: 'backend' });
      expect(result).toHaveLength(2);
    });

    it('filters by toTeam', () => {
      const result = protocol.getHandoffs({ toTeam: 'frontend' });
      expect(result).toHaveLength(1);
      expect(result[0]?.handoffId).toBe('h-1');
    });

    it('filters by status', () => {
      const result = protocol.getHandoffs({ status: 'pending' });
      expect(result).toHaveLength(2);
    });
  });

  describe('resolveHandoff', () => {
    it('updates status and sets resolvedAt for known handoffId', () => {
      protocol.createHandoff(makeHandoff({ handoffId: 'h-1' }));
      const result = protocol.resolveHandoff('h-1', 'accepted');
      expect(result).toBe(true);
      const handoff = protocol.getHandoffs()[0]!;
      expect(handoff.status).toBe('accepted');
      expect(handoff.resolvedAt).toBeDefined();
    });

    it('returns false for unknown handoffId', () => {
      expect(protocol.resolveHandoff('nonexistent', 'completed')).toBe(false);
    });

    it('can resolve to completed', () => {
      protocol.createHandoff(makeHandoff({ handoffId: 'h-1' }));
      protocol.resolveHandoff('h-1', 'completed');
      expect(protocol.getHandoffs()[0]?.status).toBe('completed');
    });

    it('can resolve to rejected', () => {
      protocol.createHandoff(makeHandoff({ handoffId: 'h-1' }));
      protocol.resolveHandoff('h-1', 'rejected');
      expect(protocol.getHandoffs()[0]?.status).toBe('rejected');
    });
  });

  // -------------------------------------------------------------------------
  // Research Transfers
  // -------------------------------------------------------------------------

  describe('createResearchTransfer', () => {
    it('stores and retrieves a transfer', () => {
      protocol.createResearchTransfer(makeTransfer());
      expect(protocol.getResearchTransfers()).toHaveLength(1);
    });
  });

  describe('getResearchTransfers with filters', () => {
    beforeEach(() => {
      protocol.createResearchTransfer(makeTransfer({ transferId: 't-1', productionReadiness: 'not-ready', status: 'pending' }));
      protocol.createResearchTransfer(makeTransfer({ transferId: 't-2', productionReadiness: 'experimental', status: 'assigned' }));
      protocol.createResearchTransfer(makeTransfer({ transferId: 't-3', productionReadiness: 'ready', status: 'pending' }));
    });

    it('filters by productionReadiness', () => {
      const result = protocol.getResearchTransfers({ productionReadiness: 'experimental' });
      expect(result).toHaveLength(1);
      expect(result[0]?.transferId).toBe('t-2');
    });

    it('filters by status', () => {
      const result = protocol.getResearchTransfers({ status: 'pending' });
      expect(result).toHaveLength(2);
    });

    it('returns all transfers when no filter provided', () => {
      expect(protocol.getResearchTransfers()).toHaveLength(3);
    });
  });

  describe('assignResearchTransfer', () => {
    it('sets assignedTeam and status=assigned, returns true', () => {
      protocol.createResearchTransfer(makeTransfer({ transferId: 't-1' }));
      const result = protocol.assignResearchTransfer('t-1', 'frontend');
      expect(result).toBe(true);
      const transfer = protocol.getResearchTransfers()[0]!;
      expect(transfer.assignedTeam).toBe('frontend');
      expect(transfer.status).toBe('assigned');
    });

    it('returns false for unknown transferId', () => {
      expect(protocol.assignResearchTransfer('nonexistent', 'backend')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Team Stats
  // -------------------------------------------------------------------------

  describe('getTeamStats', () => {
    it('counts pending handoffs for team (as fromTeam or toTeam)', () => {
      protocol.createHandoff(makeHandoff({ handoffId: 'h-1', fromTeam: 'backend', toTeam: 'frontend', status: 'pending' }));
      protocol.createHandoff(makeHandoff({ handoffId: 'h-2', fromTeam: 'infra', toTeam: 'backend', status: 'pending' }));
      protocol.createHandoff(makeHandoff({ handoffId: 'h-3', fromTeam: 'backend', toTeam: 'quality', status: 'accepted' }));
      const stats = protocol.getTeamStats('backend');
      expect(stats.pendingHandoffs).toBe(2);
    });

    it('counts active (agreed) contracts for team', () => {
      protocol.registerContract(makeContract({ contractId: 'c-1', producerTeam: 'backend', consumerTeam: 'frontend', status: 'agreed' }));
      protocol.registerContract(makeContract({ contractId: 'c-2', producerTeam: 'backend', consumerTeam: 'quality', status: 'draft' }));
      protocol.registerContract(makeContract({ contractId: 'c-3', producerTeam: 'infra', consumerTeam: 'backend', status: 'agreed' }));
      const stats = protocol.getTeamStats('backend');
      expect(stats.activeContracts).toBe(2);
    });

    it('counts research items assigned to team', () => {
      protocol.createResearchTransfer(makeTransfer({ transferId: 't-1', assignedTeam: 'backend' }));
      protocol.createResearchTransfer(makeTransfer({ transferId: 't-2', assignedTeam: 'frontend' }));
      protocol.createResearchTransfer(makeTransfer({ transferId: 't-3', assignedTeam: 'backend' }));
      const stats = protocol.getTeamStats('backend');
      expect(stats.researchItems).toBe(2);
    });

    it('returns zeros for team with no activity', () => {
      const stats = protocol.getTeamStats('quality');
      expect(stats).toEqual({ pendingHandoffs: 0, activeContracts: 0, researchItems: 0 });
    });
  });
});
