/**
 * Cross-module integration tests for v5.9
 *
 * Verifies that modules interact correctly across boundaries:
 * BudgetEnforcer ↔ ModelSelector, SprintPlanner → Runner → Evaluator,
 * WorkflowRunner, GitBranchManager + MergeQueue, ExecutionLog,
 * KnowledgeGraph, CanaryManager, FederationManager.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BudgetEnforcer,
  BudgetExceededError,
  KillSwitchError,
  ModelSelector,
  SprintPlanner,
  SprintRunner,
  SprintEvaluator,
  SprintPromoter,
  WorkflowRunner,
  GitBranchManager,
  ExecutionLog,
  KnowledgeGraph,
  CanaryManager,
  FederationManager,
} from '@agentforge/core';
import type { BacklogItem, WorkflowDefinition } from '@agentforge/core';

// ── BudgetEnforcer ↔ ModelSelector ─────────────────────────────────────────

describe('BudgetEnforcer + ModelSelector — cost ceiling drives model downgrade', () => {
  it('ModelSelector picks haiku for trivial tasks and budget does not exceed agent limit', () => {
    const enforcer = new BudgetEnforcer({ agentLimitUsd: 1.0, dailyLimitUsd: 100 });
    const selector = new ModelSelector();
    const tier = selector.select('rename a variable');
    expect(tier).toBe('haiku');
    // Haiku call costs far below agent ceiling — should not throw
    expect(() => enforcer.record(0.001, 'agent')).not.toThrow();
  });

  it('ModelSelector picks opus for strategic tasks; budget enforcer blocks overspend', () => {
    const enforcer = new BudgetEnforcer({ agentLimitUsd: 0.02, dailyLimitUsd: 100 });
    const selector = new ModelSelector();
    const tier = selector.select('architect the entire platform migration strategy');
    expect(tier).toBe('opus');
    // Opus call cost 0.05 > agentLimitUsd 0.02 → should throw
    expect(() => enforcer.record(0.05, 'agent')).toThrow(BudgetExceededError);
  });

  it('budget.wouldExceed gates the model selection decision', () => {
    const enforcer = new BudgetEnforcer({ agentLimitUsd: 0.01, dailyLimitUsd: 100 });
    const selector = new ModelSelector();
    const tier = selector.select('design a distributed consensus algorithm');
    expect(tier).toBe('opus');
    // Simulate check before calling
    const wouldExceed = enforcer.wouldExceed(0.05, 'agent');
    expect(wouldExceed).toBe(true);
    // Downgrade decision: use sonnet instead
    const safeTier = wouldExceed ? 'sonnet' : tier;
    expect(safeTier).toBe('sonnet');
  });

  it('daily budget kill switch halts all subsequent records', () => {
    const enforcer = new BudgetEnforcer({ dailyLimitUsd: 0.001, sprintLimitUsd: 1 });
    expect(() => enforcer.record(0.002, 'agent')).toThrow(KillSwitchError);
    // After kill, even tiny amounts throw
    expect(() => enforcer.record(0.0001, 'agent')).toThrow(KillSwitchError);
  });

  it('sprint budget can be reset between sprints', () => {
    const enforcer = new BudgetEnforcer({ sprintLimitUsd: 0.1, dailyLimitUsd: 100 });
    enforcer.record(0.09, 'sprint');
    enforcer.resetSprint();
    expect(() => enforcer.record(0.09, 'sprint')).not.toThrow();
  });

  it('budget status reflects cumulative spend across multiple records', () => {
    const enforcer = new BudgetEnforcer({ dailyLimitUsd: 10, sprintLimitUsd: 5 });
    enforcer.record(0.10, 'agent');
    enforcer.record(0.20, 'agent');
    enforcer.record(0.30, 'sprint');
    const status = enforcer.status();
    expect(status.dailySpend).toBeCloseTo(0.6);
    expect(status.sprintSpend).toBeCloseTo(0.6);
  });
});

// ── SprintPlanner → SprintRunner → SprintEvaluator full cycle ───────────────

const SAMPLE_BACKLOG: BacklogItem[] = [
  { id: 'ci-1', title: 'Setup', description: 'Init project', priority: 'P0', estimatedComplexity: 'medium', tags: [] },
  { id: 'ci-2', title: 'Auth', description: 'Add RBAC', priority: 'P0', estimatedComplexity: 'high', tags: [] },
  { id: 'ci-3', title: 'Dashboard', description: 'Build UI', priority: 'P1', estimatedComplexity: 'medium', tags: [] },
  { id: 'ci-4', title: 'Docs', description: 'Write docs', priority: 'P2', estimatedComplexity: 'low', tags: [] },
];

describe('SprintPlanner → SprintRunner → SprintEvaluator full cycle', () => {
  it('full happy path: plan → run → evaluate → ship', async () => {
    const planner = new SprintPlanner();
    planner.seed(SAMPLE_BACKLOG);
    const plan = planner.plan('5.9');

    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 50 });
    const result = await runner.run(plan);

    expect(result.sprintVersion).toBe('5.9');
    expect(result.itemsCompleted).toBeGreaterThan(0);

    const evaluator = new SprintEvaluator();
    const evaluation = evaluator.evaluate(result, 3283, 0, true);

    expect(evaluation.verdict).toBe('ship');
    expect(evaluation.passed).toBe(true);
    expect(evaluation.sprintVersion).toBe('5.9');
  });

  it('evaluator marks regression when dryRun introduces failures', async () => {
    const planner = new SprintPlanner();
    planner.seed([{ id: 'r1', title: 'Risky', description: '', priority: 'P0', estimatedComplexity: 'high', tags: [] }]);
    const plan = planner.plan('5.9');
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 50 });
    const result = await runner.run(plan);

    const evaluator = new SprintEvaluator();
    // Simulate failures being introduced in dry-run
    const fakeRun = { ...result, itemsFailed: 1, itemsCompleted: result.itemsCompleted - 1 };
    const evaluation = evaluator.evaluate(fakeRun, 3283, 0, true);
    expect(['retry', 'revert']).toContain(evaluation.verdict);
  });

  it('SprintPromoter advances version on ship verdict', async () => {
    const planner = new SprintPlanner();
    planner.seed(SAMPLE_BACKLOG);
    // Use version 5.8 so next is 5.9 (well-defined increment)
    const plan = planner.plan('5.8');
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 50 });
    const evaluator = new SprintEvaluator();
    const promoter = new SprintPromoter();
    const { promotion } = await promoter.runCycle(plan, runner, evaluator, 3283, true);
    expect(promotion.promoted).toBe(true);
    expect(promotion.nextSprintVersion).toBe('5.9');
  });

  it('plan respects budget — stops early when budget is tiny', async () => {
    const planner = new SprintPlanner();
    planner.seed(SAMPLE_BACKLOG);
    const plan = planner.plan('5.9');
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 0.001 });
    const result = await runner.run(plan);
    expect(result.itemsCompleted).toBeLessThan(plan.items.length);
  });
});

// ── WorkflowRunner → concurrency ─────────────────────────────────────────────

describe('WorkflowRunner — concurrency and cost tracking', () => {
  const workflow: WorkflowDefinition = {
    id: 'wf-ci',
    name: 'CI Integration Workflow',
    steps: [
      { id: 's1', type: 'agent', agentId: 'linter', task: 'lint all files', model: 'haiku' },
      {
        id: 's2',
        type: 'parallel',
        steps: [
          { id: 's2a', type: 'agent', agentId: 'tester', task: 'run unit tests', model: 'haiku' },
          { id: 's2b', type: 'agent', agentId: 'builder', task: 'build project', model: 'sonnet' },
        ],
      },
      { id: 's3', type: 'agent', agentId: 'deployer', task: 'deploy to staging', model: 'sonnet' },
    ],
    budgetUsd: 10,
  };

  it('completes all steps and tracks total cost', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(workflow);
    expect(result.status).toBe('completed');
    expect(result.steps.length).toBe(3);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it('parallel step contains child results', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(workflow);
    const parallel = result.steps.find(s => s.stepId === 's2');
    expect(parallel).toBeDefined();
    expect(parallel?.children?.length).toBe(2);
  });

  it('respects budget ceiling — stops at budget_exceeded', async () => {
    const tinyBudget: WorkflowDefinition = {
      ...workflow,
      budgetUsd: 0.0000001,
    };
    const runner = new WorkflowRunner();
    const result = await runner.run(tinyBudget);
    expect(result.status).toBe('budget_exceeded');
  });

  it('logs execution details on workflow result', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(workflow);
    expect(result.workflowId).toBeTruthy();
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();
    expect(new Date(result.startedAt).getTime()).toBeGreaterThan(0);
  });
});

// ── GitBranchManager + MergeQueue lifecycle ───────────────────────────────────

describe('GitBranchManager + MergeQueue lifecycle', () => {
  let gitMgr: GitBranchManager;

  beforeEach(() => {
    gitMgr = new GitBranchManager(true);
  });

  it('create → review → approve → merge lifecycle', () => {
    const branch = gitMgr.createBranch('agent-coder', 'task-001');
    expect(branch.status).toBe('active');

    const queueItem = gitMgr.submitForReview(branch.id);
    expect(queueItem.status).toBe('pending');

    gitMgr.approveReview(branch.id, 'lead-agent');
    const updated = gitMgr.getBranch(branch.id);
    expect(updated?.reviewStatus).toBe('approved');

    const merged = gitMgr.mergeBranch(branch.id);
    expect(merged.status).toBe('merged');
  });

  it('merge queue reflects current state', () => {
    const b1 = gitMgr.createBranch('agent-a', 't1');
    const b2 = gitMgr.createBranch('agent-b', 't2');
    gitMgr.submitForReview(b1.id);
    gitMgr.submitForReview(b2.id);

    const pending = gitMgr.getMergeQueue('pending');
    expect(pending.length).toBe(2);

    gitMgr.mergeBranch(b1.id);
    const stillPending = gitMgr.getMergeQueue('pending');
    expect(stillPending.length).toBe(1);
  });

  it('conflict marks branch and queue item', () => {
    const branch = gitMgr.createBranch('agent-c', 't3');
    gitMgr.submitForReview(branch.id);
    gitMgr.markConflict(branch.id, 'merge conflict on src/index.ts');
    const b = gitMgr.getBranch(branch.id);
    expect(b?.status).toBe('conflict');
    const queue = gitMgr.getMergeQueue('conflict');
    expect(queue.length).toBe(1);
  });

  it('report totals are consistent', () => {
    gitMgr.createBranch('a1', 't1');
    const b2 = gitMgr.createBranch('a2', 't2');
    gitMgr.submitForReview(b2.id);
    gitMgr.mergeBranch(b2.id);

    const report = gitMgr.report();
    expect(report.total).toBe(2);
    expect(report.merged).toBe(1);
    expect(report.active).toBe(1);
  });

  it('delete removes branch from registry', () => {
    const b = gitMgr.createBranch('agent-x', 'task-del');
    expect(gitMgr.getBranch(b.id)).toBeDefined();
    gitMgr.deleteBranch(b.id);
    expect(gitMgr.getBranch(b.id)).toBeUndefined();
  });
});

// ── ExecutionLog capturing events across modules ────────────────────────────

describe('ExecutionLog — cross-module event capture', () => {
  it('records events from multiple categories', () => {
    const log = new ExecutionLog();
    log.log('info', 'sprint', 'Sprint started', { sprintVersion: '5.9' });
    log.log('info', 'agent', 'Agent completed task', { agentId: 'coder', costUsd: 0.01 });
    log.log('warn', 'cost', 'Budget alert fired', { sprintVersion: '5.9' });
    log.log('error', 'workflow', 'Workflow step failed');

    expect(log.count()).toBe(4);
  });

  it('query by category returns filtered results', () => {
    const log = new ExecutionLog();
    log.log('info', 'sprint', 'Sprint 5.9 started', { sprintVersion: '5.9' });
    log.log('info', 'agent', 'Agent ran');
    log.log('info', 'sprint', 'Sprint 5.9 ended', { sprintVersion: '5.9' });

    const sprintEntries = log.query({ category: 'sprint' });
    expect(sprintEntries.length).toBe(2);
  });

  it('query by sprintVersion isolates sprint events', () => {
    const log = new ExecutionLog();
    log.log('info', 'sprint', 'v5.8 event', { sprintVersion: '5.8' });
    log.log('info', 'sprint', 'v5.9 event', { sprintVersion: '5.9' });

    const v59 = log.query({ sprintVersion: '5.9' });
    expect(v59.length).toBe(1);
    expect(v59[0]?.sprintVersion).toBe('5.9');
  });

  it('query by agentId returns only that agent entries', () => {
    const log = new ExecutionLog();
    log.log('info', 'agent', 'coder ran', { agentId: 'coder' });
    log.log('info', 'agent', 'linter ran', { agentId: 'linter' });
    log.log('info', 'agent', 'coder ran again', { agentId: 'coder' });

    const coderEntries = log.query({ agentId: 'coder' });
    expect(coderEntries.length).toBe(2);
  });

  it('clear resets count to zero', () => {
    const log = new ExecutionLog();
    log.log('info', 'system', 'hello');
    log.log('info', 'system', 'world');
    log.clear();
    expect(log.count()).toBe(0);
  });
});

// ── KnowledgeGraph storing and retrieving facts ──────────────────────────────

describe('KnowledgeGraph — storing and retrieving cross-module facts', () => {
  let kg: KnowledgeGraph;

  beforeEach(() => {
    kg = new KnowledgeGraph();
  });

  it('stores and retrieves an entity', () => {
    const e = kg.addEntity({ type: 'agent', name: 'coder-v1', description: 'Writes code' });
    expect(kg.getEntity(e.id)).toBeDefined();
    expect(kg.getEntity(e.id)?.name).toBe('coder-v1');
  });

  it('adds a relationship between two entities', () => {
    const a = kg.addEntity({ type: 'agent', name: 'coder' });
    const b = kg.addEntity({ type: 'agent', name: 'reviewer' });
    const rel = kg.addRelationship({ sourceId: a.id, targetId: b.id, type: 'reviews' });
    expect('error' in rel).toBe(false);
    if (!('error' in rel)) {
      expect(rel.type).toBe('reviews');
    }
  });

  it('query returns entities matching the search term', () => {
    kg.addEntity({ type: 'agent', name: 'budget-enforcer', description: 'Tracks cost governance' });
    kg.addEntity({ type: 'module', name: 'knowledge-graph', description: 'Semantic memory' });
    const result = kg.query({ query: 'budget' });
    expect(result.entities.some(e => e.name.includes('budget'))).toBe(true);
  });

  it('delete entity removes associated relationships', () => {
    const a = kg.addEntity({ type: 'agent', name: 'a' });
    const b = kg.addEntity({ type: 'agent', name: 'b' });
    kg.addRelationship({ sourceId: a.id, targetId: b.id, type: 'depends_on' });
    expect(kg.relationshipCount()).toBe(1);
    kg.deleteEntity(a.id);
    expect(kg.relationshipCount()).toBe(0);
  });

  it('stats returns correct counts', () => {
    kg.addEntity({ type: 'agent', name: 'x' });
    kg.addEntity({ type: 'module', name: 'y' });
    const stats = kg.stats();
    expect(stats.entityCount).toBe(2);
    expect(stats.relationshipCount).toBe(0);
  });
});

// ── CanaryManager promoting a deployment ─────────────────────────────────────

describe('CanaryManager — promote a canary deployment', () => {
  let canary: CanaryManager;

  beforeEach(() => {
    canary = new CanaryManager();
  });

  it('creates a flag and routes traffic to canary variant', () => {
    const flag = canary.createFlag({
      name: 'v5.9-feature',
      description: 'New feature canary',
      trafficPercent: 100,
    });
    canary.activateFlag(flag.id);
    const result = canary.route(flag.id, 'req-001');
    expect(['control', 'canary']).toContain(result.variant);
  });

  it('healthy canary (no errors) keeps flag active', () => {
    const flag = canary.createFlag({ name: 'healthy-feature', trafficPercent: 10 });
    canary.activateFlag(flag.id);
    for (let i = 0; i < 10; i++) {
      canary.recordOutcome(flag.id, false);
    }
    const metrics = canary.getMetrics(flag.id);
    expect(metrics?.isHealthy).toBe(true);
  });

  it('high error rate triggers auto-rollback', () => {
    const flag = canary.createFlag({
      name: 'bad-feature',
      trafficPercent: 50,
      rollbackThreshold: 0.1,
    });
    canary.activateFlag(flag.id);
    for (let i = 0; i < 10; i++) {
      canary.recordOutcome(flag.id, true); // all errors
    }
    const logs = canary.getRollbackLog();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.success).toBe(true);
  });

  it('manual rollback is recorded in rollback log', () => {
    const flag = canary.createFlag({ name: 'manual-rb', trafficPercent: 20 });
    canary.activateFlag(flag.id);
    const result = canary.performRollback(flag.id, 'Manual operator override');
    expect(result).not.toBeNull();
    expect(result?.reason).toContain('Manual');
    expect(canary.getRollbackLog().length).toBe(1);
  });
});

// ── FederationManager — dry-run learning exchange ────────────────────────────

describe('FederationManager — dry-run learning exchange', () => {
  let fed: FederationManager;

  beforeEach(() => {
    fed = new FederationManager({ dryRun: true });
  });

  it('registers a peer and lists it', () => {
    fed.registerPeer({ id: 'peer-1', name: 'Instance A', endpoint: 'https://a.example.com', version: '5.9' });
    expect(fed.listPeers().length).toBe(1);
    expect(fed.listPeers()[0]?.id).toBe('peer-1');
  });

  it('shares a learning and retrieves it', () => {
    const learning = fed.shareLearning({
      domain: 'cost-governance',
      content: 'Haiku is sufficient for lint tasks',
      confidence: 0.9,
      sourcePeerId: null,
    });
    expect(learning.id).toBeTruthy();
    expect(fed.getSharedLearnings().length).toBe(1);
  });

  it('strips PII from shared learnings', () => {
    const learning = fed.shareLearning({
      domain: 'agent-ops',
      content: 'Contact user@example.com for issues',
      confidence: 0.7,
      sourcePeerId: null,
    });
    expect(learning.content).not.toContain('user@example.com');
    expect(learning.content).toContain('[REDACTED]');
  });

  it('status reflects peer and learning counts', () => {
    fed.registerPeer({ id: 'p1', name: 'P1', endpoint: 'https://p1.example.com', version: '5.9' });
    fed.shareLearning({ domain: 'cost', content: 'Optimize early', confidence: 0.8, sourcePeerId: null });
    const status = fed.getStatus();
    expect(status.peerCount).toBe(1);
    expect(status.learningCount).toBe(1);
    expect(status.dryRun).toBe(true);
  });

  it('dry-run mode marks peers as reachable', () => {
    fed.registerPeer({ id: 'p2', name: 'P2', endpoint: 'https://p2.example.com', version: '5.9' });
    const peers = fed.listPeers();
    expect(peers[0]?.reachable).toBe(true);
  });
});
