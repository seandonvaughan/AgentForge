/**
 * Tests for EventCollector — P0-3: EventBus → SQLite middleware
 *
 * All tests use in-memory bus + :memory: AgentDatabase for isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { V4MessageBus } from '../../src/communication/v4-message-bus.js';
import { AgentDatabase } from '../../src/db/database.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { EventCollector, createEventCollector } from '../../src/event-collector/index.js';

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function makeSetup() {
  const bus = new V4MessageBus();
  const db = new AgentDatabase({ path: ':memory:' });
  const adapter = new SqliteAdapter({ db });
  const collector = new EventCollector({ bus, adapter });
  return { bus, db, adapter, collector };
}

function publishAndDrain(bus: V4MessageBus, options: Parameters<V4MessageBus['publish']>[0]) {
  bus.publish(options);
  bus.drain();
}

// ---------------------------------------------------------------------------
// 1. session.started → insertSession
// ---------------------------------------------------------------------------

describe('session.started', () => {
  it('inserts a session row with status=running', () => {
    const { bus, adapter } = makeSetup();
    publishAndDrain(bus, {
      from: 'sys',
      to: 'db',
      topic: 'session.started',
      category: 'event',
      payload: {
        sessionId: 'sess-001',
        agentId: 'agent-a',
        agentName: 'TestAgent',
        model: 'claude-sonnet-4-6',
        task: 'Run tests',
      },
    });

    const row = adapter.getSession('sess-001');
    expect(row).not.toBeNull();
    expect(row!.id).toBe('sess-001');
    expect(row!.agent_id).toBe('agent-a');
    expect(row!.agent_name).toBe('TestAgent');
    expect(row!.model).toBe('claude-sonnet-4-6');
    expect(row!.task).toBe('Run tests');
    expect(row!.status).toBe('running');
  });

  it('handles missing optional fields gracefully', () => {
    const { bus, adapter } = makeSetup();
    publishAndDrain(bus, {
      from: 'sys',
      to: 'db',
      topic: 'session.started',
      category: 'event',
      payload: { sessionId: 'sess-002', agentId: 'agent-b' },
    });

    const row = adapter.getSession('sess-002');
    expect(row).not.toBeNull();
    expect(row!.model).toBeNull();
    expect(row!.agent_name).toBeNull();
    expect(row!.task).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. session.completed → updateSession status=completed
// ---------------------------------------------------------------------------

describe('session.completed', () => {
  it('updates status to completed', () => {
    const { bus, adapter } = makeSetup();
    // Insert the session first so FK and row exist
    adapter.insertSession({
      id: 'sess-010',
      agent_id: 'agent-a',
      agent_name: null,
      model: null,
      task: 'do work',
      response: null,
      status: 'running',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: null,
      estimated_tokens: null,
      autonomy_tier: null,
      resume_count: 0,
      parent_session_id: null,
      delegation_depth: 0,
    });

    publishAndDrain(bus, {
      from: 'sys',
      to: 'db',
      topic: 'session.completed',
      category: 'event',
      payload: {
        sessionId: 'sess-010',
        response: 'All done',
        estimatedTokens: 500,
      },
    });

    const row = adapter.getSession('sess-010');
    expect(row!.status).toBe('completed');
    expect(row!.response).toBe('All done');
    expect(row!.estimated_tokens).toBe(500);
    expect(row!.completed_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. session.failed → updateSession status=failed
// ---------------------------------------------------------------------------

describe('session.failed', () => {
  it('updates status to failed', () => {
    const { bus, adapter } = makeSetup();
    adapter.insertSession({
      id: 'sess-020',
      agent_id: 'agent-a',
      agent_name: null,
      model: null,
      task: 'do work',
      response: null,
      status: 'running',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: null,
      estimated_tokens: null,
      autonomy_tier: null,
      resume_count: 0,
      parent_session_id: null,
      delegation_depth: 0,
    });

    publishAndDrain(bus, {
      from: 'sys',
      to: 'db',
      topic: 'session.failed',
      category: 'event',
      payload: { sessionId: 'sess-020', error: 'Timeout' },
    });

    const row = adapter.getSession('sess-020');
    expect(row!.status).toBe('failed');
    expect(row!.completed_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. feedback.submitted → insertFeedback
// ---------------------------------------------------------------------------

describe('feedback.submitted', () => {
  it('inserts a feedback row', () => {
    const { bus, adapter } = makeSetup();
    publishAndDrain(bus, {
      from: 'agent-a',
      to: 'db',
      topic: 'feedback.submitted',
      category: 'event',
      payload: {
        agentId: 'agent-a',
        taskId: 'task-1',
        sprintId: 'v4.7',
        category: 'improvement',
        message: 'Needs better error handling',
      },
    });

    const rows = adapter.listFeedback({ agentId: 'agent-a' });
    expect(rows.length).toBe(1);
    expect(rows[0].message).toBe('Needs better error handling');
    expect(rows[0].agent_id).toBe('agent-a');
    expect(rows[0].category).toBe('improvement');
  });

  it('falls back to sprintId as category when category is absent', () => {
    const { bus, adapter } = makeSetup();
    publishAndDrain(bus, {
      from: 'agent-b',
      to: 'db',
      topic: 'feedback.submitted',
      category: 'event',
      payload: {
        agentId: 'agent-b',
        sprintId: 'v4.7',
        message: 'Sprint feedback',
      },
    });

    const rows = adapter.listFeedback({ agentId: 'agent-b' });
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe('v4.7');
  });
});

// ---------------------------------------------------------------------------
// 5. task.completed → insertTaskOutcome
// ---------------------------------------------------------------------------

describe('task.completed', () => {
  it('inserts a task_outcome row', () => {
    const { bus, adapter } = makeSetup();
    // session must exist before task outcome (FK constraint)
    adapter.insertSession({
      id: 'sess-030',
      agent_id: 'agent-a',
      agent_name: null,
      model: null,
      task: 'Write tests',
      response: null,
      status: 'running',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: null,
      estimated_tokens: null,
      autonomy_tier: null,
      resume_count: 0,
      parent_session_id: null,
      delegation_depth: 0,
    });
    publishAndDrain(bus, {
      from: 'agent-a',
      to: 'db',
      topic: 'task.completed',
      category: 'event',
      payload: {
        sessionId: 'sess-030',
        agentId: 'agent-a',
        task: 'Write tests',
        success: true,
        qualityScore: 0.95,
        model: 'claude-sonnet-4-6',
        durationMs: 1200,
      },
    });

    const outcomes = adapter.listTaskOutcomes({ sessionId: 'sess-030' });
    expect(outcomes.length).toBe(1);
    const o = outcomes[0];
    expect(o.session_id).toBe('sess-030');
    expect(o.agent_id).toBe('agent-a');
    expect(o.task).toBe('Write tests');
    expect(o.success).toBe(1);
    expect(o.quality_score).toBe(0.95);
    expect(o.model).toBe('claude-sonnet-4-6');
    expect(o.duration_ms).toBe(1200);
  });

  it('records failed tasks with success=0', () => {
    const { bus, adapter } = makeSetup();
    // session must exist before task outcome (FK constraint)
    adapter.insertSession({
      id: 'sess-031',
      agent_id: 'agent-a',
      agent_name: null,
      model: null,
      task: 'Failing task',
      response: null,
      status: 'running',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: null,
      estimated_tokens: null,
      autonomy_tier: null,
      resume_count: 0,
      parent_session_id: null,
      delegation_depth: 0,
    });
    publishAndDrain(bus, {
      from: 'agent-a',
      to: 'db',
      topic: 'task.completed',
      category: 'event',
      payload: {
        sessionId: 'sess-031',
        agentId: 'agent-a',
        task: 'Failing task',
        success: false,
      },
    });

    const outcomes = adapter.listTaskOutcomes({ sessionId: 'sess-031' });
    expect(outcomes[0].success).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. cost.incurred → insertCost
// ---------------------------------------------------------------------------

describe('cost.incurred', () => {
  it('inserts a cost row', () => {
    const { bus, adapter } = makeSetup();
    // session must exist before cost row (FK constraint)
    adapter.insertSession({
      id: 'sess-040',
      agent_id: 'agent-a',
      agent_name: null,
      model: null,
      task: 'Cost test',
      response: null,
      status: 'running',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: null,
      estimated_tokens: null,
      autonomy_tier: null,
      resume_count: 0,
      parent_session_id: null,
      delegation_depth: 0,
    });
    publishAndDrain(bus, {
      from: 'agent-a',
      to: 'db',
      topic: 'cost.incurred',
      category: 'event',
      payload: {
        sessionId: 'sess-040',
        agentId: 'agent-a',
        model: 'claude-opus-4',
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.025,
      },
    });

    const costs = adapter.getAgentCosts('agent-a');
    expect(costs.length).toBe(1);
    const c = costs[0];
    expect(c.session_id).toBe('sess-040');
    expect(c.model).toBe('claude-opus-4');
    expect(c.input_tokens).toBe(1000);
    expect(c.output_tokens).toBe(500);
    expect(c.cost_usd).toBe(0.025);
  });

  it('accumulates total cost across multiple events', () => {
    const { bus, adapter } = makeSetup();
    const costPayload = (costUsd: number) => ({
      agentId: 'agent-a',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      costUsd,
    });

    publishAndDrain(bus, { from: 'a', to: 'db', topic: 'cost.incurred', category: 'event', payload: costPayload(0.01) });
    publishAndDrain(bus, { from: 'a', to: 'db', topic: 'cost.incurred', category: 'event', payload: costPayload(0.02) });

    const total = adapter.getTotalCostUsd();
    expect(total).toBeCloseTo(0.03, 5);
  });
});

// ---------------------------------------------------------------------------
// 7. autonomy.promoted / flywheel.autonomy.promoted → insertPromotion
// ---------------------------------------------------------------------------

describe('autonomy promotions', () => {
  it('inserts a promotion row for autonomy.promoted', () => {
    const { bus, adapter } = makeSetup();
    publishAndDrain(bus, {
      from: 'flywheel',
      to: 'db',
      topic: 'autonomy.promoted',
      category: 'event',
      payload: {
        agentId: 'agent-a',
        previousTier: 1,
        newTier: 2,
        reason: 'Consistent quality',
      },
    });

    const promotions = adapter.listPromotions({ agentId: 'agent-a' });
    expect(promotions.length).toBe(1);
    expect(promotions[0].promoted).toBe(1);
    expect(promotions[0].demoted).toBe(0);
    expect(promotions[0].previous_tier).toBe(1);
    expect(promotions[0].new_tier).toBe(2);
    expect(promotions[0].reason).toBe('Consistent quality');
  });

  it('inserts a demotion row for autonomy.demoted', () => {
    const { bus, adapter } = makeSetup();
    publishAndDrain(bus, {
      from: 'flywheel',
      to: 'db',
      topic: 'autonomy.demoted',
      category: 'event',
      payload: {
        agentId: 'agent-a',
        previousTier: 3,
        newTier: 2,
        reason: 'Failed tasks',
      },
    });

    const promotions = adapter.listPromotions({ agentId: 'agent-a' });
    expect(promotions.length).toBe(1);
    expect(promotions[0].promoted).toBe(0);
    expect(promotions[0].demoted).toBe(1);
  });

  it('inserts a promotion row for flywheel.autonomy.promoted', () => {
    const { bus, adapter } = makeSetup();
    publishAndDrain(bus, {
      from: 'flywheel',
      to: 'db',
      topic: 'flywheel.autonomy.promoted',
      category: 'event',
      payload: { agentId: 'agent-b', previousTier: 0, newTier: 1 },
    });

    const promotions = adapter.listPromotions({ agentId: 'agent-b' });
    expect(promotions.length).toBe(1);
    expect(promotions[0].promoted).toBe(1);
  });

  it('inserts a demotion row for flywheel.autonomy.demoted', () => {
    const { bus, adapter } = makeSetup();
    publishAndDrain(bus, {
      from: 'flywheel',
      to: 'db',
      topic: 'flywheel.autonomy.demoted',
      category: 'event',
      payload: { agentId: 'agent-c', previousTier: 2, newTier: 1 },
    });

    const promotions = adapter.listPromotions({ agentId: 'agent-c' });
    expect(promotions.length).toBe(1);
    expect(promotions[0].demoted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. destroy() detaches all listeners
// ---------------------------------------------------------------------------

describe('destroy()', () => {
  it('detaches listeners so events after destroy are not persisted', () => {
    const { bus, adapter, collector } = makeSetup();

    // Verify it works before destroy
    publishAndDrain(bus, {
      from: 'sys',
      to: 'db',
      topic: 'session.started',
      category: 'event',
      payload: { sessionId: 'sess-pre', agentId: 'agent-a', task: 'before' },
    });
    expect(adapter.getSession('sess-pre')).not.toBeNull();

    // Destroy the collector
    collector.destroy();

    // Events published after destroy should NOT be persisted
    publishAndDrain(bus, {
      from: 'sys',
      to: 'db',
      topic: 'session.started',
      category: 'event',
      payload: { sessionId: 'sess-post', agentId: 'agent-a', task: 'after' },
    });
    expect(adapter.getSession('sess-post')).toBeNull();
  });

  it('calling destroy() twice does not throw', () => {
    const { collector } = makeSetup();
    expect(() => {
      collector.destroy();
      collector.destroy();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. Error isolation — malformed payloads must not crash
// ---------------------------------------------------------------------------

describe('error isolation', () => {
  it('does not throw when session.started payload is missing sessionId', () => {
    const { bus } = makeSetup();
    expect(() => {
      publishAndDrain(bus, {
        from: 'sys',
        to: 'db',
        topic: 'session.started',
        category: 'event',
        payload: { agentId: 'agent-a' }, // missing sessionId
      });
    }).not.toThrow();
  });

  it('does not throw when cost.incurred payload is completely empty', () => {
    const { bus } = makeSetup();
    expect(() => {
      publishAndDrain(bus, {
        from: 'sys',
        to: 'db',
        topic: 'cost.incurred',
        category: 'event',
        payload: {},
      });
    }).not.toThrow();
  });

  it('does not throw when feedback.submitted payload is missing message', () => {
    const { bus } = makeSetup();
    expect(() => {
      publishAndDrain(bus, {
        from: 'sys',
        to: 'db',
        topic: 'feedback.submitted',
        category: 'event',
        payload: { agentId: 'agent-a' }, // missing message
      });
    }).not.toThrow();
  });

  it('does not throw when autonomy.promoted payload has no agentId', () => {
    const { bus } = makeSetup();
    expect(() => {
      publishAndDrain(bus, {
        from: 'sys',
        to: 'db',
        topic: 'autonomy.promoted',
        category: 'event',
        payload: { previousTier: 1, newTier: 2 }, // missing agentId
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. createEventCollector factory
// ---------------------------------------------------------------------------

describe('createEventCollector factory', () => {
  it('returns a working EventCollector instance', () => {
    const bus = new V4MessageBus();
    const db = new AgentDatabase({ path: ':memory:' });
    const adapter = new SqliteAdapter({ db });
    const collector = createEventCollector({ bus, adapter });

    expect(collector).toBeInstanceOf(EventCollector);

    publishAndDrain(bus, {
      from: 'sys',
      to: 'db',
      topic: 'session.started',
      category: 'event',
      payload: { sessionId: 'factory-sess', agentId: 'agent-x', task: 'test' },
    });

    const row = adapter.getSession('factory-sess');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('running');
  });
});
