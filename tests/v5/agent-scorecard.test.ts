import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';

describe('agent scorecard', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => {
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  });

  it('recordSessionOutcome creates a new scorecard', () => {
    adapter.recordSessionOutcome('coder', 'completed', 0.01, 1500);
    const score = adapter.getAgentScore('coder');
    expect(score).not.toBeNull();
    expect(score!.agentId).toBe('coder');
    expect(score!.totalSessions).toBe(1);
    expect(score!.successRate).toBe(1);
  });

  it('records multiple outcomes and computes rates', () => {
    adapter.recordSessionOutcome('coder', 'completed', 0.01, 1000);
    adapter.recordSessionOutcome('coder', 'completed', 0.02, 2000);
    adapter.recordSessionOutcome('coder', 'failed', 0.01, 500);
    const score = adapter.getAgentScore('coder');
    expect(score!.totalSessions).toBe(3);
    expect(score!.successRate).toBeCloseTo(2/3);
    expect(score!.avgLatencyMs).toBeCloseTo(1166.67, 0);
  });

  it('listAgentScores returns all agents', () => {
    adapter.recordSessionOutcome('coder', 'completed', 0.01);
    adapter.recordSessionOutcome('architect', 'completed', 0.05);
    const scores = adapter.listAgentScores();
    expect(scores.length).toBe(2);
    expect(scores.map(s => s.agentId)).toContain('coder');
    expect(scores.map(s => s.agentId)).toContain('architect');
  });

  it('score is between 0 and 100', () => {
    adapter.recordSessionOutcome('coder', 'completed', 0.005, 800);
    const score = adapter.getAgentScore('coder');
    expect(score!.score).toBeGreaterThanOrEqual(0);
    expect(score!.score).toBeLessThanOrEqual(100);
  });

  it('getAgentScore returns null for unknown agent', () => {
    expect(adapter.getAgentScore('unknown-agent')).toBeNull();
  });
});
