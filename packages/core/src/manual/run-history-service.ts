import { join } from 'node:path';
import { WorkspaceManager } from '../workspace/index.js';
import type { RuntimeMode, ExecutionProviderKind } from '../runtime/types.js';

interface SessionSnapshot {
  id: string;
  agent_id: string;
  task: string;
  status: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  started_at: string;
  completed_at: string | null;
}

interface DecisionEventSnapshot {
  decision_type: string;
  summary: string;
  rationale: string | null;
  created_at: string;
  payload_json: string;
}

interface TestObservationSnapshot {
  status: string;
  suite: string | null;
  test_name: string | null;
  file_path: string | null;
  message: string | null;
  observed_at: string;
}

interface TaskOutcomeSnapshot {
  summary: string | null;
}

export interface RunHistoryEntry {
  sessionId: string;
  agentId: string;
  task: string;
  status: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: string;
  completedAt?: string | null;
  providerKind?: ExecutionProviderKind;
  runtimeModeResolved?: RuntimeMode;
  outcomeSummary?: string;
}

export interface RunSessionDetails extends RunHistoryEntry {
  decisionEvents: Array<{
    type: string;
    summary: string;
    rationale?: string | null;
    createdAt: string;
  }>;
  recentTests: Array<{
    status: string;
    suite?: string | null;
    testName?: string | null;
    filePath?: string | null;
    message?: string | null;
    observedAt: string;
  }>;
}

export async function listRunHistory(
  projectRoot: string,
  limit = 20,
): Promise<RunHistoryEntry[]> {
  const manager = new WorkspaceManager({
    dataDir: join(projectRoot, '.agentforge', 'v5'),
  });

  try {
    const { adapter } = await manager.getOrCreateDefaultWorkspace();
    const sessions = adapter.listSessions({ limit }) as SessionSnapshot[];
    return sessions.map((session) => hydrateRunHistoryEntry(adapter, session.id, {
      sessionId: session.id,
      agentId: session.agent_id,
      task: session.task,
      status: session.status,
      model: session.model,
      inputTokens: session.input_tokens,
      outputTokens: session.output_tokens,
      costUsd: session.cost_usd,
      startedAt: session.started_at,
      completedAt: session.completed_at,
    }));
  } finally {
    manager.close();
  }
}

export async function getRunSessionDetails(
  projectRoot: string,
  sessionId: string,
): Promise<RunSessionDetails | null> {
  const manager = new WorkspaceManager({
    dataDir: join(projectRoot, '.agentforge', 'v5'),
  });

  try {
    const { adapter } = await manager.getOrCreateDefaultWorkspace();
    const session = adapter.getSession(sessionId) as SessionSnapshot | undefined;
    if (!session) return null;

    const base = hydrateRunHistoryEntry(adapter, session.id, {
      sessionId: session.id,
      agentId: session.agent_id,
      task: session.task,
      status: session.status,
      model: session.model,
      inputTokens: session.input_tokens,
      outputTokens: session.output_tokens,
      costUsd: session.cost_usd,
      startedAt: session.started_at,
      completedAt: session.completed_at,
    });

    const decisionEvents = (adapter.listDecisionEvents({ sessionId, limit: 10 }) as DecisionEventSnapshot[]).map((event) => ({
      type: event.decision_type,
      summary: event.summary,
      rationale: event.rationale,
      createdAt: event.created_at,
    }));

    const recentTests = (adapter.listTestObservations({ sessionId, limit: 10 }) as TestObservationSnapshot[]).map((test) => ({
      status: test.status,
      suite: test.suite,
      testName: test.test_name,
      filePath: test.file_path,
      message: test.message,
      observedAt: test.observed_at,
    }));

    return {
      ...base,
      decisionEvents,
      recentTests,
    };
  } finally {
    manager.close();
  }
}

function hydrateRunHistoryEntry(
  adapter: Awaited<ReturnType<WorkspaceManager['getOrCreateDefaultWorkspace']>>['adapter'],
  sessionId: string,
  base: RunHistoryEntry,
): RunHistoryEntry {
  const runtimeTransportEvent = (adapter.listDecisionEvents({
    sessionId,
    decisionType: 'runtime_transport',
    limit: 1,
  }) as DecisionEventSnapshot[])[0];
  const taskOutcome = (adapter.listTaskOutcomes({ sessionId, limit: 1 }) as TaskOutcomeSnapshot[])[0];
  const runtimeMetadata = parseRuntimeMetadata(runtimeTransportEvent?.payload_json);

  return {
    ...base,
    ...(runtimeMetadata.providerKind ? { providerKind: runtimeMetadata.providerKind } : {}),
    ...(runtimeMetadata.runtimeModeResolved
      ? { runtimeModeResolved: runtimeMetadata.runtimeModeResolved }
      : {}),
    ...(taskOutcome?.summary ? { outcomeSummary: taskOutcome.summary } : {}),
  };
}

function parseRuntimeMetadata(payloadJson?: string): {
  providerKind?: ExecutionProviderKind;
  runtimeModeResolved?: RuntimeMode;
} {
  if (!payloadJson) return {};

  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    return {
      ...(typeof payload.providerKind === 'string'
        ? { providerKind: payload.providerKind as ExecutionProviderKind }
        : {}),
      ...(typeof payload.runtimeModeResolved === 'string'
        ? { runtimeModeResolved: payload.runtimeModeResolved as RuntimeMode }
        : {}),
    };
  } catch {
    return {};
  }
}
