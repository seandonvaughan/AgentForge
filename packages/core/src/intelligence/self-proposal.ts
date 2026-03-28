import { randomUUID } from 'node:crypto';
import type { AgentProposal, ProposalContext } from './types.js';

/** Keywords that indicate high-priority issues. */
const P0_SIGNALS = ['error', 'fail', 'crash', 'broken', 'urgent', 'critical', 'outage'];
const P1_SIGNALS = ['slow', 'performance', 'improve', 'optimize', 'missing', 'incomplete'];

function inferPriority(title: string, description: string): AgentProposal['priority'] {
  const text = `${title} ${description}`.toLowerCase();
  if (P0_SIGNALS.some(s => text.includes(s))) return 'P0';
  if (P1_SIGNALS.some(s => text.includes(s))) return 'P1';
  return 'P2';
}

function inferConfidence(ctx: ProposalContext): number {
  if (!ctx.recentSessions?.length) return 0.5;
  const successRate = ctx.recentSessions.filter(s => s.outcome === 'success').length / ctx.recentSessions.length;
  return Math.min(0.95, 0.4 + successRate * 0.5);
}

export class SelfProposalEngine {
  private proposals: Map<string, AgentProposal> = new Map();

  /** Generate a proposal from an agent based on its context. */
  propose(
    ctx: ProposalContext,
    title: string,
    description: string,
    tags: string[] = [],
  ): AgentProposal {
    const id = randomUUID();
    const proposal: AgentProposal = {
      id,
      agentId: ctx.agentId,
      title,
      description,
      priority: inferPriority(title, description),
      confidence: inferConfidence(ctx),
      estimatedImpact: this._estimateImpact(description),
      tags,
      proposedAt: new Date().toISOString(),
      status: 'pending',
    };
    this.proposals.set(id, proposal);
    return proposal;
  }

  /** Approve a proposal. */
  approve(id: string): AgentProposal | null {
    const p = this.proposals.get(id);
    if (!p) return null;
    p.status = 'approved';
    return p;
  }

  /** Reject a proposal. */
  reject(id: string): AgentProposal | null {
    const p = this.proposals.get(id);
    if (!p) return null;
    p.status = 'rejected';
    return p;
  }

  /** Get all proposals, optionally filtered by status. */
  list(status?: AgentProposal['status']): AgentProposal[] {
    const all = [...this.proposals.values()];
    return status ? all.filter(p => p.status === status) : all;
  }

  /**
   * Auto-generate proposals by analyzing recent session outcomes.
   * Creates proposals for agents with failures, high costs, or slow tasks.
   */
  fromSessions(
    sessions: Array<{
      agentId: string;
      status: 'completed' | 'failed' | string;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      task?: string;
    }>,
  ): AgentProposal[] {
    const generated: AgentProposal[] = [];

    // Group by agent
    const byAgent = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const list = byAgent.get(s.agentId) ?? [];
      list.push(s);
      byAgent.set(s.agentId, list);
    }

    for (const [agentId, agentSessions] of byAgent) {
      const failures = agentSessions.filter(s => s.status === 'failed');
      const totalCost = agentSessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
      const avgCost = agentSessions.length > 0 ? totalCost / agentSessions.length : 0;

      // Propose reliability improvement if failure rate > 20%
      if (failures.length > 0 && failures.length / agentSessions.length > 0.2) {
        const p = this.propose(
          { agentId, recentSessions: agentSessions.map(s => ({ task: s.task ?? '', model: '', outcome: s.status === 'completed' ? 'success' as const : 'failure' as const })) },
          `Improve ${agentId} reliability`,
          `${agentId} failed ${failures.length}/${agentSessions.length} recent sessions. Investigate error patterns and add retry logic.`,
          ['reliability', 'error-handling'],
        );
        generated.push(p);
      }

      // Propose cost optimization if avg cost > $0.10
      if (avgCost > 0.10) {
        const p = this.propose(
          { agentId, recentSessions: agentSessions.map(s => ({ task: s.task ?? '', model: '', outcome: s.status === 'completed' ? 'success' as const : 'failure' as const })) },
          `Optimize ${agentId} token usage`,
          `${agentId} averages $${avgCost.toFixed(3)} per session. Consider model downgrade or prompt compression.`,
          ['cost', 'optimization'],
        );
        generated.push(p);
      }
    }

    return generated;
  }

  private _estimateImpact(description: string): string {
    const len = description.length;
    if (len > 500) return 'High — complex multi-step improvement';
    if (len > 200) return 'Medium — focused enhancement';
    return 'Low — minor improvement';
  }
}
