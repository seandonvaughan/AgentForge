export type CycleStaleness = 'healthy' | 'stale' | 'dead' | 'unknown';

const STALE_THRESHOLD_MS = 120_000;
const DEAD_THRESHOLD_MS = 600_000;

export function computeCycleStaleness(lastHeartbeatAt: string | undefined, nowMs: number): CycleStaleness {
  if (!lastHeartbeatAt) return 'unknown';

  const heartbeatMs = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(heartbeatMs)) return 'unknown';

  const ageMs = nowMs - heartbeatMs;
  if (ageMs < STALE_THRESHOLD_MS) return 'healthy';
  if (ageMs < DEAD_THRESHOLD_MS) return 'stale';
  return 'dead';
}

export function aggregatePhaseErrorSummary(
  phases: Array<{ phase?: string; agentRuns?: Array<{ status?: string; attempts?: number }> }>,
): Record<string, { failed: number; retried: number }> {
  const summary: Record<string, { failed: number; retried: number }> = {};

  for (const phaseEntry of phases) {
    const phaseName = phaseEntry.phase;
    if (typeof phaseName !== 'string' || phaseName.length === 0) continue;

    const runs = Array.isArray(phaseEntry.agentRuns) ? phaseEntry.agentRuns : [];
    const failed = runs.reduce((count, run) => count + (run?.status === 'failed' ? 1 : 0), 0);
    const retried = runs.reduce(
      (count, run) => count + (typeof run?.attempts === 'number' && run.attempts > 1 ? 1 : 0),
      0,
    );

    const existing = summary[phaseName] ?? { failed: 0, retried: 0 };
    summary[phaseName] = {
      failed: existing.failed + failed,
      retried: existing.retried + retried,
    };
  }

  return summary;
}
