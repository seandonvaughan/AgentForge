import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCycleRecord } from '@agentforge/shared';
// ── Project root resolution ───────────────────────────────────────────────────
/** Walk up from CWD until we find a directory with a .agentforge/ subdirectory. */
function findProjectRoot() {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, '.agentforge')))
            return dir;
        const parent = join(dir, '..');
        if (parent === dir)
            break;
        dir = parent;
    }
    return process.cwd();
}
// ── Metric computation ────────────────────────────────────────────────────────
/** @internal Exported for unit testing only — do not call from client code. */
export function _computeMetrics(projectRoot) {
    // ── Cycles ──────────────────────────────────────────────────────────────────
    // Read from both cycles/ and cycles-archived/ so historical data contributes
    // to trend math even after archiving. Each directory may use either on-disk
    // format; readCycleRecord() handles both transparently.
    const cycleDirs = [
        join(projectRoot, '.agentforge/cycles'),
        join(projectRoot, '.agentforge/cycles-archived'),
    ];
    const cycles = [];
    for (const cyclesDir of cycleDirs) {
        if (!existsSync(cyclesDir))
            continue;
        for (const entry of readdirSync(cyclesDir, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const record = readCycleRecord(join(cyclesDir, entry.name), entry.name);
            if (record)
                cycles.push(record);
        }
    }
    cycles.sort((a, b) => {
        const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return ta - tb;
    });
    const meaningfulCycles = cycles.filter(c => c.stage === 'completed' || (c.tests?.passRate ?? 0) > 0);
    const completedCycles = cycles.filter(c => c.stage === 'completed');
    // ── Sprints ──────────────────────────────────────────────────────────────────
    // v14.2.0: legacy pre-cycle-era sprint files were moved to sprints/archive/.
    // Recent sprints live inside their cycle dir as plan.json. Read all three
    // sources for full flywheel history — mirrors dashboard-stubs.ts exactly.
    const sprintsDir = join(projectRoot, '.agentforge/sprints');
    const archiveDir = join(sprintsDir, 'archive');
    const sprints = [];
    for (const dir of [sprintsDir, archiveDir]) {
        if (!existsSync(dir))
            continue;
        for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
            try {
                const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
                if (Array.isArray(raw.sprints))
                    sprints.push(...raw.sprints);
                else if (raw.items)
                    sprints.push(raw);
            }
            catch { /* skip */ }
        }
    }
    // Also include plan.json from each cycle dir (current format since v14.2.0).
    const activeCyclesDir = join(projectRoot, '.agentforge/cycles');
    if (existsSync(activeCyclesDir)) {
        for (const cycleEntry of readdirSync(activeCyclesDir)) {
            const planPath = join(activeCyclesDir, cycleEntry, 'plan.json');
            if (!existsSync(planPath))
                continue;
            try {
                const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
                if (plan?.items)
                    sprints.push(plan);
            }
            catch { /* skip */ }
        }
    }
    let totalItems = 0;
    let completedItems = 0;
    for (const s of sprints) {
        const items = s.items ?? [];
        totalItems += items.length;
        completedItems += items.filter(i => i.status === 'completed').length;
    }
    // ── Agents ───────────────────────────────────────────────────────────────────
    const agentsDir = join(projectRoot, '.agentforge/agents');
    let agentCount = 0;
    if (existsSync(agentsDir)) {
        agentCount = readdirSync(agentsDir).filter(f => f.endsWith('.yaml')).length;
    }
    // ── Sessions ─────────────────────────────────────────────────────────────────
    const sessionsDir = join(projectRoot, '.agentforge/sessions');
    const sessions = [];
    if (existsSync(sessionsDir)) {
        for (const file of readdirSync(sessionsDir).filter(f => f.endsWith('.json')).sort()) {
            try {
                const raw = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'));
                if (raw.task_id)
                    sessions.push(raw);
            }
            catch { /* skip malformed */ }
        }
    }
    const satisfiedSessions = sessions.filter(s => s.is_request_satisfied === true).length;
    const sessionSuccessRate = sessions.length > 0 ? satisfiedSessions / sessions.length : null;
    // Session confidence trend
    const confSessions = sessions.map(s => s.confidence ?? null).filter((c) => c !== null);
    let sessionConfidenceBonus = 0;
    if (confSessions.length >= 4) {
        const half = Math.floor(confSessions.length / 2);
        const earlyConf = confSessions.slice(0, half).reduce((s, c) => s + c, 0) / half;
        const lateConf = confSessions.slice(-half).reduce((s, c) => s + c, 0) / half;
        sessionConfidenceBonus = Math.max(-10, Math.min(10, Math.round((lateConf - earlyConf) * 50)));
    }
    // ── 1. Meta-Learning Rate ────────────────────────────────────────────────────
    const sprintCount = sprints.length;
    const iterationBase = Math.min(100, Math.round((sprintCount / 32) * 60));
    let trendBonus = 0;
    const ratedCycles = meaningfulCycles.filter(c => (c.tests?.passRate ?? 0) > 0);
    if (ratedCycles.length >= 2) {
        const half = Math.floor(ratedCycles.length / 2);
        const earlyAvg = ratedCycles.slice(0, half).reduce((s, c) => s + (c.tests?.passRate ?? 0), 0) / half;
        const lateAvg = ratedCycles.slice(-half).reduce((s, c) => s + (c.tests?.passRate ?? 0), 0) / half;
        trendBonus = Math.max(-20, Math.min(40, Math.round((lateAvg - earlyAvg) * 400)));
    }
    else if (ratedCycles.length === 1) {
        trendBonus = 10;
    }
    const metaLearningScore = Math.max(0, Math.min(100, iterationBase + trendBonus + sessionConfidenceBonus));
    // Derive a human-readable trend label — thresholds mirror dashboard-stubs.ts exactly.
    // trendBonus >= +20 → ≥5% pass-rate gain (improving boundary)
    // trendBonus <= -20 → ≥5% pass-rate loss (declining boundary)
    // |trendBonus| < 20 → use sessionConfidenceBonus (±5 threshold = half its ±10 cap)
    const metaTrend = trendBonus >= 20 ? 'improving' :
        trendBonus <= -20 ? 'declining' :
            sessionConfidenceBonus > 5 ? 'improving' :
                sessionConfidenceBonus < -5 ? 'declining' :
                    'stable';
    // ── 2. Autonomy Score ────────────────────────────────────────────────────────
    let autonomyScore = 0;
    if (meaningfulCycles.length > 0) {
        const cycleSuccessRate = completedCycles.length / meaningfulCycles.length;
        const prBonus = completedCycles.some(c => c.pr?.number != null) ? 10 : 0;
        const blendedRate = sessionSuccessRate !== null
            ? cycleSuccessRate * 0.6 + sessionSuccessRate * 0.4
            : cycleSuccessRate;
        autonomyScore = Math.min(100, Math.round(blendedRate * 90 + prBonus));
    }
    else if (sessionSuccessRate !== null && sessions.length >= 3) {
        autonomyScore = Math.min(40, Math.round(sessionSuccessRate * 40));
    }
    // ── 3. Capability Inheritance ────────────────────────────────────────────────
    const AGENT_CEILING = 150;
    const agentBase = Math.round((agentCount / AGENT_CEILING) * 80);
    const cycleFileBonus = Math.min(20, meaningfulCycles.filter(c => (c.git?.filesChanged?.length ?? 0) > 0).length * 5);
    const inheritanceScore = Math.min(100, agentBase + cycleFileBonus);
    // ── 4. Velocity ──────────────────────────────────────────────────────────────
    let velocityScore = 0;
    if (totalItems > 0) {
        const itemRate = completedItems / totalItems;
        const cycleThroughput = Math.min(30, meaningfulCycles.length * 5);
        const sessionBoost = Math.min(15, Math.floor(satisfiedSessions / 2));
        velocityScore = Math.min(100, Math.round(itemRate * 70 + cycleThroughput + sessionBoost));
    }
    else if (meaningfulCycles.length > 0) {
        velocityScore = Math.min(100, meaningfulCycles.length * 10);
    }
    else if (sessions.length > 0) {
        velocityScore = Math.min(30, satisfiedSessions * 3);
    }
    // ── Memory stats ─────────────────────────────────────────────────────────────
    const memoryStats = computeMemoryStats(projectRoot, cycles, completedCycles);
    // ── Descriptions ─────────────────────────────────────────────────────────────
    const avgConf = confSessions.length > 0
        ? Math.round((confSessions.reduce((s, c) => s + c, 0) / confSessions.length) * 100)
        : null;
    const descriptions = {
        meta_learning: ratedCycles.length > 1
            ? `${sprintCount} sprint iterations; pass-rate ${metaTrend} across ${ratedCycles.length} cycles`
            : avgConf !== null
                ? `${sprintCount} sprint iterations; session confidence avg ${avgConf}% — ${metaTrend}`
                : `${sprintCount} sprint iterations — ${metaTrend}`,
        autonomy: meaningfulCycles.length > 0
            ? `${completedCycles.length}/${meaningfulCycles.length} cycles; ${satisfiedSessions}/${sessions.length} sessions satisfied`
            : sessions.length > 0 ? `${satisfiedSessions}/${sessions.length} sessions satisfied` : 'No cycle data yet',
        inheritance: `${agentCount} agents; ${meaningfulCycles.length} cycles with file evidence`,
        velocity: totalItems > 0
            ? `${completedItems}/${totalItems} sprint items; ${satisfiedSessions} sessions completed`
            : sessions.length > 0
                ? `${satisfiedSessions}/${sessions.length} sessions satisfied`
                : `${meaningfulCycles.length} meaningful cycles`,
    };
    // ── Assemble ─────────────────────────────────────────────────────────────────
    const overallScore = Math.round((metaLearningScore + autonomyScore + inheritanceScore + velocityScore) / 4);
    // Per-cycle history: expose the raw signals that drive autonomy + velocity
    // so the dashboard can render trajectory sparklines (not just static scores).
    const HISTORY_LIMIT = 20;
    const cycleHistory = cycles.slice(-HISTORY_LIMIT).map(c => ({
        cycleId: c.cycleId,
        sprintVersion: c.sprintVersion ?? null,
        // Use epoch as the fallback so cycles without a timestamp sort to the
        // beginning (oldest), not the end. Using new Date() here would silently
        // inflate the "recent" half of the trend split in the meta-learning
        // computation, producing misleadingly optimistic scores.
        startedAt: c.startedAt ?? '1970-01-01T00:00:00.000Z',
        stage: c.stage ?? 'unknown',
        testPassRate: c.tests?.passRate ?? null,
        testsTotal: (c.tests?.passed != null && c.tests?.failed != null)
            ? (c.tests.passed + c.tests.failed)
            : (c.tests?.total ?? null),
        costUsd: c.cost?.totalUsd ?? null,
        durationMs: c.durationMs ?? null,
        hasPr: c.pr?.number != null,
    }));
    return {
        metrics: [
            { key: 'meta_learning', label: 'Meta-Learning', score: metaLearningScore, description: descriptions.meta_learning, trend: metaTrend },
            { key: 'autonomy', label: 'Autonomy', score: autonomyScore, description: descriptions.autonomy },
            { key: 'inheritance', label: 'Inheritance', score: inheritanceScore, description: descriptions.inheritance },
            { key: 'velocity', label: 'Velocity', score: velocityScore, description: descriptions.velocity },
        ],
        overallScore,
        updatedAt: new Date().toISOString(),
        cycleHistory,
        debug: {
            cycleCount: cycles.length,
            meaningfulCycleCount: meaningfulCycles.length,
            completedCycleCount: completedCycles.length,
            sprintCount,
            agentCount,
            totalItems,
            completedItems,
            sessionCount: sessions.length,
            satisfiedSessionCount: satisfiedSessions,
        },
        memoryStats,
    };
}
function computeMemoryStats(projectRoot, cycles, completedCycles) {
    const memoryDir = join(projectRoot, '.agentforge/memory');
    let totalEntries = 0;
    const entriesByCycleId = new Map();
    const allEntryTimesMs = [];
    if (existsSync(memoryDir)) {
        for (const file of readdirSync(memoryDir).filter(f => f.endsWith('.jsonl'))) {
            try {
                const lines = readFileSync(join(memoryDir, file), 'utf-8')
                    .split('\n').filter(l => l.trim().length > 0);
                for (const line of lines) {
                    try {
                        const entry = JSON.parse(line);
                        totalEntries++;
                        if (entry.createdAt)
                            allEntryTimesMs.push(new Date(entry.createdAt).getTime());
                        if (entry.source) {
                            entriesByCycleId.set(entry.source, (entriesByCycleId.get(entry.source) ?? 0) + 1);
                        }
                    }
                    catch { /* skip */ }
                }
            }
            catch { /* skip */ }
        }
    }
    allEntryTimesMs.sort((a, b) => a - b);
    const TREND_LIMIT = 12;
    const entriesPerCycleTrend = cycles.slice(-TREND_LIMIT).map(c => ({
        cycleId: c.cycleId,
        count: entriesByCycleId.get(c.cycleId) ?? 0,
        // Epoch fallback: same reasoning as cycleHistory — using new Date() would
        // place timestamp-less cycles at the newest position in the sparkline,
        // distorting the per-cycle trend display.
        startedAt: c.startedAt ?? '1970-01-01T00:00:00.000Z',
    }));
    // Hit rate: prefer the precise `memoriesInjected` count written to each
    // cycle's audit.json by the audit phase handler (added in v9.0.x).
    // For cycles that pre-date this field, fall back to the timestamp proxy.
    const earliestEntryMs = allEntryTimesMs.at(0) ?? Infinity;
    const hitCount = completedCycles.filter(c => {
        const auditJsonPath = join(projectRoot, '.agentforge', 'cycles', c.cycleId, 'phases', 'audit.json');
        if (existsSync(auditJsonPath)) {
            try {
                const auditData = JSON.parse(readFileSync(auditJsonPath, 'utf-8'));
                if (typeof auditData.memoriesInjected === 'number') {
                    return auditData.memoriesInjected > 0;
                }
            }
            catch { /* fall through to proxy */ }
        }
        // Timestamp proxy fallback for older cycles lacking audit.json
        const startMs = c.startedAt ? new Date(c.startedAt).getTime() : 0;
        return startMs > earliestEntryMs;
    }).length;
    const hitRate = completedCycles.length > 0 ? hitCount / completedCycles.length : 0;
    return { totalEntries, entriesPerCycleTrend, hitRate };
}
// ── SvelteKit load ────────────────────────────────────────────────────────────
export const load = () => {
    try {
        const root = findProjectRoot();
        const flywheel = _computeMetrics(root);
        return { flywheel };
    }
    catch {
        // Non-fatal: client-side polling will still load data after mount.
        return { flywheel: null };
    }
};
