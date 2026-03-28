/**
 * tests/v5/core-intelligence.test.ts
 * Tests for SelfProposalEngine, ConfidenceRouter, EscalationProtocol, AdaptiveRouter
 * Target: 45+ tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SelfProposalEngine } from '../../packages/core/src/intelligence/self-proposal.js';
import { ConfidenceRouter } from '../../packages/core/src/intelligence/confidence-router.js';
import { EscalationProtocol } from '../../packages/core/src/intelligence/escalation-protocol.js';
import { AdaptiveRouter } from '../../packages/core/src/intelligence/adaptive-routing.js';
import type { ProposalContext } from '../../packages/core/src/intelligence/types.js';

// ── SelfProposalEngine ────────────────────────────────────────────────────────

describe('SelfProposalEngine', () => {
  let engine: SelfProposalEngine;

  beforeEach(() => { engine = new SelfProposalEngine(); });

  it('propose() returns a valid proposal object', () => {
    const ctx: ProposalContext = { agentId: 'coder' };
    const p = engine.propose(ctx, 'Add tests', 'Write unit tests for the module');
    expect(p.id).toBeTruthy();
    expect(p.agentId).toBe('coder');
    expect(p.title).toBe('Add tests');
    expect(p.status).toBe('pending');
  });

  it('propose() stores the proposal so list() returns it', () => {
    const ctx: ProposalContext = { agentId: 'coder' };
    engine.propose(ctx, 'Add tests', 'Write unit tests');
    expect(engine.list().length).toBe(1);
  });

  it('propose() infers P0 priority when title contains "error"', () => {
    const p = engine.propose({ agentId: 'debugger' }, 'Fix error in auth', 'Critical error in auth flow');
    expect(p.priority).toBe('P0');
  });

  it('propose() infers P0 priority when description contains "crash"', () => {
    const p = engine.propose({ agentId: 'debugger' }, 'Stability fix', 'The server is crashing under load');
    expect(p.priority).toBe('P0');
  });

  it('propose() infers P0 for "urgent" signal', () => {
    const p = engine.propose({ agentId: 'cto' }, 'Urgent patch needed', 'Deploy immediately');
    expect(p.priority).toBe('P0');
  });

  it('propose() infers P1 when title contains "slow"', () => {
    const p = engine.propose({ agentId: 'coder' }, 'Fix slow queries', 'Database queries are taking too long');
    expect(p.priority).toBe('P1');
  });

  it('propose() infers P1 for "optimize" signal', () => {
    const p = engine.propose({ agentId: 'coder' }, 'Optimize rendering', 'Make it faster');
    expect(p.priority).toBe('P1');
  });

  it('propose() defaults to P2 when no high-priority signals present', () => {
    const p = engine.propose({ agentId: 'coder' }, 'Add feature', 'Add a nice new feature');
    expect(p.priority).toBe('P2');
  });

  it('confidence is 0.5 when no recent sessions', () => {
    const p = engine.propose({ agentId: 'coder' }, 'Task', 'Description');
    expect(p.confidence).toBe(0.5);
  });

  it('confidence is higher with all successful recent sessions', () => {
    const ctx: ProposalContext = {
      agentId: 'coder',
      recentSessions: [
        { task: 'write tests', outcome: 'success', model: 'sonnet' },
        { task: 'fix bug', outcome: 'success', model: 'sonnet' },
        { task: 'review code', outcome: 'success', model: 'sonnet' },
      ],
    };
    const p = engine.propose(ctx, 'Next task', 'Do something');
    expect(p.confidence).toBeGreaterThan(0.5);
    expect(p.confidence).toBeLessThanOrEqual(0.95);
  });

  it('confidence is lower with mostly failed sessions', () => {
    const ctx: ProposalContext = {
      agentId: 'coder',
      recentSessions: [
        { task: 'write tests', outcome: 'failure', model: 'sonnet' },
        { task: 'fix bug', outcome: 'failure', model: 'sonnet' },
        { task: 'review code', outcome: 'failure', model: 'sonnet' },
      ],
    };
    const p = engine.propose(ctx, 'Next task', 'Do something');
    expect(p.confidence).toBeLessThan(0.55);
  });

  it('approve() changes status to approved', () => {
    const ctx: ProposalContext = { agentId: 'coder' };
    const p = engine.propose(ctx, 'Task', 'Desc');
    const approved = engine.approve(p.id);
    expect(approved?.status).toBe('approved');
  });

  it('approve() returns null for unknown id', () => {
    expect(engine.approve('nonexistent')).toBeNull();
  });

  it('reject() changes status to rejected', () => {
    const ctx: ProposalContext = { agentId: 'coder' };
    const p = engine.propose(ctx, 'Task', 'Desc');
    const rejected = engine.reject(p.id);
    expect(rejected?.status).toBe('rejected');
  });

  it('reject() returns null for unknown id', () => {
    expect(engine.reject('nonexistent')).toBeNull();
  });

  it('list() without filter returns all proposals', () => {
    const ctx: ProposalContext = { agentId: 'coder' };
    engine.propose(ctx, 'A', 'Desc A');
    engine.propose(ctx, 'B', 'Desc B');
    expect(engine.list().length).toBe(2);
  });

  it('list("pending") returns only pending proposals', () => {
    const ctx: ProposalContext = { agentId: 'coder' };
    const p1 = engine.propose(ctx, 'A', 'Desc');
    engine.propose(ctx, 'B', 'Desc');
    engine.approve(p1.id);
    expect(engine.list('pending').length).toBe(1);
    expect(engine.list('pending')[0].status).toBe('pending');
  });

  it('list("approved") returns only approved proposals', () => {
    const ctx: ProposalContext = { agentId: 'coder' };
    const p = engine.propose(ctx, 'A', 'Desc');
    engine.approve(p.id);
    expect(engine.list('approved').length).toBe(1);
  });

  it('estimatedImpact is Low for short descriptions', () => {
    const p = engine.propose({ agentId: 'coder' }, 'Task', 'Short desc');
    expect(p.estimatedImpact).toContain('Low');
  });

  it('estimatedImpact is Medium for mid-length descriptions', () => {
    const p = engine.propose({ agentId: 'coder' }, 'Task', 'x'.repeat(300));
    expect(p.estimatedImpact).toContain('Medium');
  });

  it('estimatedImpact is High for long descriptions', () => {
    const p = engine.propose({ agentId: 'coder' }, 'Task', 'x'.repeat(600));
    expect(p.estimatedImpact).toContain('High');
  });

  it('tags array is attached to proposal', () => {
    const p = engine.propose({ agentId: 'coder' }, 'Task', 'Desc', ['perf', 'v5']);
    expect(p.tags).toEqual(['perf', 'v5']);
  });

  it('proposedAt is a valid ISO string', () => {
    const p = engine.propose({ agentId: 'coder' }, 'Task', 'Desc');
    expect(() => new Date(p.proposedAt)).not.toThrow();
  });
});

// ── ConfidenceRouter ──────────────────────────────────────────────────────────

describe('ConfidenceRouter', () => {
  let router: ConfidenceRouter;

  beforeEach(() => { router = new ConfidenceRouter(); });

  it('simple tasks route to haiku when agent default is haiku', () => {
    // When agent default is haiku, the don't-downgrade logic allows haiku to be chosen
    const decision = router.route('coder', 'list all files', 0.5, 'haiku');
    expect(decision.selectedModel).toBe('haiku');
  });

  it('simple tasks are not downgraded below the agent default model', () => {
    // Agent default is sonnet — haiku(1) < sonnet(2) so router keeps sonnet
    const decision = router.route('coder', 'list all files', 0.5, 'sonnet');
    expect(decision.selectedModel).toBe('sonnet');
  });

  it('strategic tasks route to opus when task contains "strategy"', () => {
    // "strategy" is a strategic signal and "architecture" contains "architect" (complex)
    // so use "plan strategy" to guarantee strategic classification
    const decision = router.route('cto', 'plan strategy and assess roadmap', 0.7);
    expect(decision.selectedModel).toBe('opus');
  });

  it('complex tasks route to at least sonnet', () => {
    const decision = router.route('architect', 'design the database schema');
    expect(['sonnet', 'opus']).toContain(decision.selectedModel);
  });

  it('agent default model is not downgraded', () => {
    // If agent default is opus, and task is simple, keep opus
    const decision = router.route('cto', 'list files', 0.5, 'opus');
    expect(decision.selectedModel).toBe('opus');
  });

  it('returns a reasoning string', () => {
    const decision = router.route('coder', 'write a function');
    expect(typeof decision.reasoning).toBe('string');
    expect(decision.reasoning.length).toBeGreaterThan(0);
  });

  it('confidence is a number between 0 and 1', () => {
    const decision = router.route('coder', 'sort this list');
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
  });

  it('opus decisions do not have a fallbackModel', () => {
    const decision = router.route('cto', 'plan strategy', 0.9, 'opus');
    expect(decision.fallbackModel).toBeUndefined();
  });

  it('haiku decisions have sonnet as fallback', () => {
    const decision = router.route('coder', 'list files', 0.5, 'haiku');
    expect(decision.fallbackModel).toBe('sonnet');
  });

  it('meetsThreshold returns true when confidence is above threshold', () => {
    const decision = router.route('cto', 'evaluate strategy');
    expect(router.meetsThreshold(decision, 0.5)).toBe(true);
  });

  it('meetsThreshold returns false when threshold is too high', () => {
    const decision = router.route('coder', 'list files', 0.5, 'haiku');
    // haiku confidence is 0.55, threshold 0.9 should fail
    expect(router.meetsThreshold(decision, 0.9)).toBe(false);
  });

  it('agentId is passed through to decision', () => {
    const decision = router.route('my-agent', 'write code');
    expect(decision.agentId).toBe('my-agent');
  });

  it('task is passed through to decision', () => {
    const task = 'write a comprehensive test suite';
    const decision = router.route('coder', task);
    expect(decision.task).toBe(task);
  });
});

// ── EscalationProtocol ────────────────────────────────────────────────────────

describe('EscalationProtocol', () => {
  let protocol: EscalationProtocol;

  beforeEach(() => { protocol = new EscalationProtocol(); });

  it('escalate() creates an escalation event with correct fields', () => {
    const event = protocol.escalate('coder', 'Fix bug', 'Cannot reproduce');
    expect(event.id).toBeTruthy();
    expect(event.fromAgentId).toBe('coder');
    expect(event.task).toBe('Fix bug');
    expect(event.reason).toBe('Cannot reproduce');
    expect(event.level).toBe(1);
  });

  it('coder level-1 escalates to cto', () => {
    const event = protocol.escalate('coder', 'Task', 'Reason', 1);
    expect(event.toAgentId).toBe('cto');
  });

  it('debugger level-1 escalates to cto', () => {
    const event = protocol.escalate('debugger', 'Task', 'Reason', 1);
    expect(event.toAgentId).toBe('cto');
  });

  it('level-3 always escalates to cto', () => {
    const event = protocol.escalate('coder', 'Critical task', 'Blocker', 3);
    expect(event.toAgentId).toBe('cto');
    expect(event.level).toBe(3);
  });

  it('escalation event has a valid escalatedAt timestamp', () => {
    const event = protocol.escalate('coder', 'Task', 'Reason');
    expect(() => new Date(event.escalatedAt)).not.toThrow();
  });

  it('resolve() sets resolvedAt and resolution', () => {
    const event = protocol.escalate('coder', 'Task', 'Reason');
    const resolved = protocol.resolve(event.id, 'Fixed it');
    expect(resolved?.resolvedAt).toBeTruthy();
    expect(resolved?.resolution).toBe('Fixed it');
  });

  it('resolve() returns null for unknown id', () => {
    expect(protocol.resolve('unknown-id', 'resolution')).toBeNull();
  });

  it('escalate() emits escalation.created event', () => {
    const handler = vi.fn();
    protocol.on('escalation.created', handler);
    protocol.escalate('coder', 'Task', 'Reason');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('resolve() emits escalation.resolved event', () => {
    const handler = vi.fn();
    protocol.on('escalation.resolved', handler);
    const event = protocol.escalate('coder', 'Task', 'Reason');
    protocol.resolve(event.id, 'Done');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('maybeEscalate() returns null below threshold', () => {
    expect(protocol.maybeEscalate('coder', 'Task', 2, 'error')).toBeNull();
  });

  it('maybeEscalate() escalates at or above threshold of 3', () => {
    const event = protocol.maybeEscalate('coder', 'Task', 3, 'timeout error');
    expect(event).not.toBeNull();
    expect(event?.level).toBe(1);
  });

  it('maybeEscalate() escalates at level 2 after 4 attempts', () => {
    const event = protocol.maybeEscalate('coder', 'Task', 4, 'timeout error');
    expect(event?.level).toBe(2);
  });

  it('maybeEscalate() escalates at level 3 after 6 attempts', () => {
    const event = protocol.maybeEscalate('coder', 'Task', 6, 'persistent failure');
    expect(event?.level).toBe(3);
  });

  it('getStats() returns correct total count', () => {
    protocol.escalate('coder', 'T1', 'R1');
    protocol.escalate('coder', 'T2', 'R2');
    expect(protocol.getStats().total).toBe(2);
  });

  it('getStats() counts open vs resolved correctly', () => {
    const e1 = protocol.escalate('coder', 'T1', 'R1');
    protocol.escalate('coder', 'T2', 'R2');
    protocol.resolve(e1.id, 'done');
    const stats = protocol.getStats();
    expect(stats.open).toBe(1);
    expect(stats.resolved).toBe(1);
  });

  it('getStats() tracks byLevel counts', () => {
    protocol.escalate('coder', 'T1', 'R1', 1);
    protocol.escalate('coder', 'T2', 'R2', 2);
    protocol.escalate('coder', 'T3', 'R3', 3);
    const stats = protocol.getStats();
    expect(stats.byLevel[1]).toBe(1);
    expect(stats.byLevel[2]).toBe(1);
    expect(stats.byLevel[3]).toBe(1);
  });

  it('list() returns all escalations', () => {
    protocol.escalate('coder', 'T1', 'R1');
    protocol.escalate('coder', 'T2', 'R2');
    expect(protocol.list().length).toBe(2);
  });

  it('list(false) returns only open escalations', () => {
    const e1 = protocol.escalate('coder', 'T1', 'R1');
    protocol.escalate('coder', 'T2', 'R2');
    protocol.resolve(e1.id, 'done');
    expect(protocol.list(false).length).toBe(1);
  });

  it('list(true) returns only resolved escalations', () => {
    const e1 = protocol.escalate('coder', 'T1', 'R1');
    protocol.escalate('coder', 'T2', 'R2');
    protocol.resolve(e1.id, 'done');
    expect(protocol.list(true).length).toBe(1);
  });
});

// ── AdaptiveRouter ─────────────────────────────────────────────────────────────

describe('AdaptiveRouter', () => {
  let router: AdaptiveRouter;

  beforeEach(() => { router = new AdaptiveRouter(); });

  it('recommend() returns defaultModel with no data', () => {
    expect(router.recommend('coder', 'sonnet')).toBe('sonnet');
  });

  it('recommend() returns defaultModel with fewer than 5 samples', () => {
    router.recordOutcome('coder', 'haiku', 'success', 'simple');
    router.recordOutcome('coder', 'haiku', 'success', 'simple');
    expect(router.recommend('coder', 'sonnet')).toBe('sonnet');
  });

  it('recommend() suggests cheaper model when haiku has high success rate', () => {
    // Provide 5+ samples all succeeding with haiku
    for (let i = 0; i < 5; i++) {
      router.recordOutcome('coder', 'haiku', 'success', 'simple');
    }
    // haiku has 5 samples with 100% success — should recommend haiku
    const rec = router.recommend('coder', 'sonnet');
    expect(rec).toBe('haiku');
  });

  it('recommend() keeps defaultModel when haiku success rate is below 70%', () => {
    for (let i = 0; i < 3; i++) {
      router.recordOutcome('coder', 'haiku', 'failure', 'simple');
    }
    for (let i = 0; i < 2; i++) {
      router.recordOutcome('coder', 'haiku', 'success', 'simple');
    }
    // 2/5 = 40% success — below threshold
    const rec = router.recommend('coder', 'sonnet');
    expect(rec).toBe('sonnet');
  });

  it('recordOutcome() adds to feedback', () => {
    router.recordOutcome('coder', 'sonnet', 'success', 'moderate');
    const perf = router.getPerformance();
    expect(perf.some(p => p.agentId === 'coder')).toBe(true);
  });

  it('getPerformance() returns stats per agent', () => {
    router.recordOutcome('coder', 'sonnet', 'success', 'moderate');
    router.recordOutcome('architect', 'opus', 'success', 'complex');
    const perf = router.getPerformance();
    const agentIds = perf.map(p => p.agentId);
    expect(agentIds).toContain('coder');
    expect(agentIds).toContain('architect');
  });

  it('getPerformance() includes sampleCount', () => {
    router.recordOutcome('coder', 'sonnet', 'success', 'moderate');
    router.recordOutcome('coder', 'sonnet', 'success', 'moderate');
    const perf = router.getPerformance().find(p => p.agentId === 'coder');
    expect(perf?.sampleCount).toBe(2);
  });

  it('recommend() is independent per agent', () => {
    for (let i = 0; i < 5; i++) {
      router.recordOutcome('coder', 'haiku', 'success', 'simple');
    }
    // 'architect' has no data — should get its own default
    expect(router.recommend('architect', 'opus')).toBe('opus');
  });
});
