import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CostRow,
  DecisionEventRow,
  SessionRow,
  TaskOutcomeRow,
  TestObservationRow,
} from '@agentforge/db';
import { WorkspaceManager } from '../workspace/index.js';
import type { ProposalAdapter } from './proposal-to-backlog.js';
import type { AdapterForScoring } from './scoring-pipeline.js';

export interface AutonomousTelemetryAdapters {
  proposalAdapter: ProposalAdapter;
  scoringAdapter: AdapterForScoring;
  close(): void;
}

interface SprintHistoryEntry {
  version: string;
  title: string;
  phase: string;
  itemCount: number;
  completedCount: number;
  createdAt: string | null;
}

const FAILED_TEST_STATUSES = new Set(['failed', 'flaky', 'error']);
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export function createAutonomousTelemetryAdapters(
  projectRoot: string,
): AutonomousTelemetryAdapters {
  const manager = new WorkspaceManager({
    dataDir: join(projectRoot, '.agentforge', 'v5'),
  });

  const getAdapter = async () => {
    const { adapter } = await manager.getOrCreateDefaultWorkspace();
    return adapter;
  };

  const proposalAdapter: ProposalAdapter = {
    async getRecentFailedSessions(days) {
      const adapter = await getAdapter();
      const since = isoDaysAgo(days);
      const sessions = adapter.listSessions({
        status: 'failed',
        since,
        limit: 100,
      }) as SessionRow[];

      return sessions.map((session) => {
        const failureOutcome = (
          adapter.listTaskOutcomes({
            sessionId: session.id,
            outcome: 'failure',
            limit: 1,
          }) as TaskOutcomeRow[]
        )[0];
        const runtimeTransport = (
          adapter.listDecisionEvents({
            sessionId: session.id,
            decisionType: 'runtime_transport',
            limit: 1,
          }) as DecisionEventRow[]
        )[0];

        const error =
          failureOutcome?.summary?.trim() ||
          runtimeTransport?.summary?.trim() ||
          session.task;

        return {
          id: session.id,
          agent: session.agent_id,
          error,
          confidence: failureOutcome ? 0.95 : 0.8,
        };
      });
    },

    async getCostAnomalies(days) {
      const adapter = await getAdapter();
      const since = isoDaysAgo(days);
      const costs = adapter.getAllCosts() as CostRow[];
      const recentCosts = costs.filter((row) => row.created_at >= since);

      const anomalies = new Map<
        string,
        { agent: string; anomaly: string; confidence: number; ratio: number }
      >();

      for (const row of recentCosts) {
        const baseline = costs
          .filter((candidate) => candidate.agent_id === row.agent_id)
          .map((candidate) => candidate.cost_usd)
          .filter((value) => Number.isFinite(value) && value > 0)
          .sort((left, right) => left - right);

        if (baseline.length < 3) {
          continue;
        }

        const median = computeMedian(baseline);
        if (median <= 0) {
          continue;
        }

        const ratio = row.cost_usd / median;
        const deltaUsd = row.cost_usd - median;
        if (ratio < 1.75 || deltaUsd < 1) {
          continue;
        }

        const confidence = Math.min(0.98, 0.6 + (ratio - 1.75) * 0.2);
        const existing = anomalies.get(row.agent_id);
        if (!existing || ratio > existing.ratio) {
          anomalies.set(row.agent_id, {
            agent: row.agent_id,
            anomaly: `recent run cost $${row.cost_usd.toFixed(2)} vs median $${median.toFixed(2)}`,
            confidence,
            ratio,
          });
        }
      }

      return [...anomalies.values()]
        .sort((left, right) => right.ratio - left.ratio)
        .map(({ agent, anomaly, confidence }) => ({ agent, anomaly, confidence }));
    },

    async getFailedTaskOutcomes(days) {
      const adapter = await getAdapter();
      const outcomes = adapter.listTaskOutcomes({
        outcome: 'failure',
        since: isoDaysAgo(days),
        limit: 100,
      }) as TaskOutcomeRow[];

      return outcomes.map((outcome) => ({
        taskId: outcome.id,
        description: outcome.summary?.trim() || outcome.task,
        confidence: outcome.session_id ? 0.85 : 0.75,
      }));
    },

    async getFlakingTests(days) {
      const adapter = await getAdapter();
      const observations = adapter.listTestObservations({
        since: isoDaysAgo(days),
        limit: 500,
      }) as TestObservationRow[];

      const grouped = new Map<
        string,
        {
          file: string;
          name: string;
          total: number;
          failed: number;
          passed: number;
        }
      >();

      for (const observation of observations) {
        const name = observation.test_name ?? observation.suite ?? 'unnamed-test';
        const file = observation.file_path ?? observation.suite ?? 'unknown-file';
        const key = `${file}::${name}`;
        const current = grouped.get(key) ?? {
          file,
          name,
          total: 0,
          failed: 0,
          passed: 0,
        };

        current.total += 1;
        if (FAILED_TEST_STATUSES.has(observation.status)) {
          current.failed += 1;
        }
        if (observation.status === 'passed') {
          current.passed += 1;
        }

        grouped.set(key, current);
      }

      return [...grouped.values()]
        .filter((entry) => entry.total >= 2 && entry.failed > 0 && entry.passed > 0)
        .map((entry) => ({
          file: entry.file,
          name: entry.name,
          failRate: entry.failed / entry.total,
        }))
        .sort((left, right) => right.failRate - left.failRate);
    },
  };

  const scoringAdapter: AdapterForScoring = {
    async getSprintHistory(limit) {
      return readSprintHistory(projectRoot, limit);
    },

    async getCostMedians() {
      const adapter = await getAdapter();
      const costs = adapter.getAllCosts() as CostRow[];
      const byAgent = new Map<string, number[]>();

      for (const row of costs) {
        const current = byAgent.get(row.agent_id) ?? [];
        current.push(row.cost_usd);
        byAgent.set(row.agent_id, current);
      }

      return Object.fromEntries(
        [...byAgent.entries()]
          .filter(([, values]) => values.length > 0)
          .map(([agentId, values]) => [
            agentId,
            computeMedian(values.sort((left, right) => left - right)),
          ]),
      );
    },

    async getTeamState() {
      const adapter = await getAdapter();
      const sessions = adapter.listSessions({
        since: new Date(Date.now() - TWO_WEEKS_MS).toISOString(),
        limit: 200,
      }) as SessionRow[];

      const counts = new Map<string, number>();
      for (const session of sessions) {
        counts.set(session.agent_id, (counts.get(session.agent_id) ?? 0) + 1);
      }

      const maxCount = Math.max(0, ...counts.values());
      if (maxCount === 0) {
        return { utilization: {} };
      }

      return {
        utilization: Object.fromEntries(
          [...counts.entries()].map(([agentId, count]) => [
            agentId,
            Number((count / maxCount).toFixed(3)),
          ]),
        ),
      };
    },
  };

  return {
    proposalAdapter,
    scoringAdapter,
    close: () => manager.close(),
  };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function computeMedian(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle] ?? 0;
  }

  return ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}

function readSprintHistory(
  projectRoot: string,
  limit: number,
): SprintHistoryEntry[] {
  const sprintsDir = join(projectRoot, '.agentforge', 'sprints');
  if (!existsSync(sprintsDir)) {
    return [];
  }

  return readdirSync(sprintsDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const path = join(sprintsDir, entry);
      let sprint: Record<string, unknown> | undefined;
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        sprint = Array.isArray(raw.sprints)
          ? (raw.sprints[0] as Record<string, unknown> | undefined)
          : raw;
      } catch {
        sprint = undefined;
      }

      const items = Array.isArray(sprint?.items) ? sprint.items : [];
      const completedCount = items.filter((item) => {
        if (!item || typeof item !== 'object') return false;
        return (item as { status?: string }).status === 'completed';
      }).length;

      return {
        path,
        mtimeMs: safeMtime(path),
        entry: {
          version:
            typeof sprint?.version === 'string'
              ? sprint.version
              : entry.replace(/\.json$/u, ''),
          title:
            typeof sprint?.title === 'string'
              ? sprint.title
              : `Sprint ${entry.replace(/\.json$/u, '')}`,
          phase: typeof sprint?.phase === 'string' ? sprint.phase : 'unknown',
          itemCount: items.length,
          completedCount,
          createdAt: typeof sprint?.createdAt === 'string' ? sprint.createdAt : null,
        } satisfies SprintHistoryEntry,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
