<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import { withWorkspace } from '$lib/stores/workspace';
  import { relativeTime, formatDuration } from '$lib/util/relative-time';
  import {
    Btn, Card, Badge, Tabs, StageRail, ModelChip, PulseDot, Ring, Sparkline, AnimNum,
  } from '$lib/components/v2';

  type Tab =
    | 'overview' | 'pipeline' | 'items' | 'agents'
    | 'scoring' | 'events' | 'files' | 'prs' | 'logs';
  type StageBrick = 'pending' | 'active' | 'done' | 'failed';
  type FileName = 'tests' | 'git' | 'pr' | 'approval-pending' | 'approval-decision';
  type LogName = 'cli-stdout' | 'tests-raw';

  interface PhaseInfo {
    name: string;
    status: 'pending' | 'active' | 'done' | 'failed';
    agent?: string;
    model?: string;
    costUsd?: number;
    durationMs?: number;
    detail?: string;
  }

  interface AgentRunRow {
    phase: string;
    agentId: string;
    itemId?: string;
    status: string;
    costUsd: number;
    durationMs: number;
    response?: string;
    error?: string;
    attempts?: number;
    model?: string;
    effort?: string;
  }

  interface AgentsResponse {
    runs: AgentRunRow[];
    byAgent: Record<string, { runs: number; totalCostUsd: number; totalDurationMs: number; phases: string[] }>;
    totalCostUsd: number;
    totalRuns: number;
  }

  interface SprintItem {
    id: string;
    title: string;
    status: 'planned' | 'in_progress' | 'completed' | 'failed' | 'killed' | 'pending';
    assignee?: string;
    rank?: number;
    estimatedCostUsd?: number;
    costUsd?: number;
    durationMs?: number;
    model?: string;
    error?: string;
  }

  const TERMINAL = new Set(['completed', 'failed', 'killed', 'crashed']);
  const PHASE_ORDER = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'] as const;
  const PHASE_TO_RAIL: Record<string, number> = {
    audit: 0, plan: 0,
    assign: 1, stage: 1,
    execute: 2, run: 2,
    test: 3, verify: 3,
    review: 4, gate: 4, commit: 4,
    release: 5, learn: 5,
  };
  const PHASE_DETAILS: Record<string, string> = {
    audit:   'Review the backlog and approve candidate items for this sprint.',
    plan:    'Build the sprint plan, pick the version, and rank items.',
    assign:  'Resolve assignees, model tiers, and effort per item.',
    execute: 'Run items through agents — produce code, tests, and docs.',
    test:    'Run the test suite; collect pass/fail counts.',
    review:  'Self-review changes; raise blockers as needed.',
    gate:    'Gate keepers (security, qa, ops) sign off or reject.',
    release: 'Create the PR / merge branch; publish artifacts.',
    learn:   'Capture lessons; update the memory index.',
  };

  let id = $derived($page.params.id ?? '');

  let cycle = $state<Record<string, unknown> | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let activeTab = $state<Tab>('overview');

  let sprint = $state<{ version?: string; title?: string; items?: SprintItem[]; versionDecision?: { rationale?: string } } | null>(null);
  let sprintError = $state<string | null>(null);
  let sprintLoading = $state(false);

  let agentsData = $state<AgentsResponse | null>(null);
  let agentsLoading = $state(false);

  interface CycleEvent { type?: string; at?: string; phase?: string; agent?: string; msg?: string; [k: string]: unknown }
  let events = $state<CycleEvent[]>([]);
  let eventsSince = $state<number>(0);
  let eventSource: EventSource | null = null;
  let sseConnected = $state(false);

  let activeFile = $state<FileName>('tests');
  let fileData = $state<Record<string, unknown>>({});
  let fileLoading = $state<Record<string, boolean>>({});
  let fileError = $state<Record<string, string | null>>({});

  let activeLog = $state<LogName>('cli-stdout');
  let logText = $state<Record<LogName, string | null>>({ 'cli-stdout': null, 'tests-raw': null });
  let logLoading = $state<Record<LogName, boolean>>({ 'cli-stdout': false, 'tests-raw': false });
  let logError = $state<Record<LogName, string | null>>({ 'cli-stdout': null, 'tests-raw': null });
  let logStreamSource: EventSource | null = null;
  let logStreamLines = $state<string[]>([]);

  interface ScoringResponse {
    summary?: string;
    warnings?: string[];
    items?: Array<{
      id?: string; title?: string; rank?: number; score?: number; confidence?: string;
      cost?: number; estimatedCost?: number; withinBudget?: boolean; rationale?: string;
    }>;
  }
  let scoring = $state<ScoringResponse | null>(null);

  // ── PRs tab ──────────────────────────────────────────────────────────────────
  interface PrCiInfo {
    bucket: 'pass' | 'fail' | 'pending' | 'unknown';
    lastCheckedAt: string;
  }
  interface PrRow {
    prNumber: number;
    prUrl: string;
    branch: string;
    agentId: string;
    itemIds: string[];
    status: 'open' | 'merged' | 'closed' | 'skipped-no-gh' | 'dry-run';
    openedAt: string;
    ci: PrCiInfo | null;
  }
  interface PrsMeta {
    cycleId: string;
    total: number;
    counts: { open: number; merged: number; closed: number; pending: number };
    timestamp: string;
  }
  interface PrsResponse {
    data: PrRow[];
    meta: PrsMeta;
  }

  let prsData = $state<PrsResponse | null>(null);
  let prsLoading = $state(false);
  let prsError = $state<string | null>(null);
  let prsCacheAt = $state<number>(0);
  const PRS_CACHE_MS = 30_000;
  let prsPollTimer: ReturnType<typeof setInterval> | null = null;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let now = $state(Date.now());

  const STALL_MS = 5 * 60 * 1000;
  const lastHeartbeatAt = $derived<string | null>(
    ((cycle as { lastHeartbeatAt?: string })?.lastHeartbeatAt as string | undefined) ?? null,
  );
  // Stage falls back to "run" when the heartbeat is fresh but cycle-runner
  // hasn't yet written a stage to cycle.json. This window covers STAGE 1
  // (backlog/scoring) and STAGE 2 (sprint assignment) — the cycle IS running
  // there, just not in the 9-phase RUN loop yet. Showing "unknown" while the
  // process is actively spending money is worse than the slight imprecision.
  // (PR #71 stopped the heartbeat from inventing stage="run"; this is the
  // operator-facing display fallback to preserve UX.)
  const stage = $derived.by<string>(() => {
    const raw = (cycle?.stage as string | undefined);
    if (raw) return raw;
    // No stage yet: if heartbeat is fresh, the cycle is alive — call it run.
    if (lastHeartbeatAt) {
      const ageMs = now - new Date(lastHeartbeatAt).getTime();
      if (ageMs < STALL_MS) return 'run';
    }
    return 'unknown';
  });
  const isStalled = $derived.by<boolean>(() => {
    if (TERMINAL.has(stage.toLowerCase())) return false;
    if (!lastHeartbeatAt) return false;
    return now - new Date(lastHeartbeatAt).getTime() > STALL_MS;
  });
  const isTerminal = $derived<boolean>(TERMINAL.has(stage.toLowerCase()) || isStalled);
  const costUsd = $derived<number>(
    ((cycle as { cost?: { totalUsd?: number } })?.cost?.totalUsd
    ?? (cycle as { costUsd?: number })?.costUsd
    ?? 0) as number,
  );
  const budgetUsd = $derived<number>(
    ((cycle as { cost?: { budgetUsd?: number } })?.cost?.budgetUsd
    ?? (cycle as { budgetUsd?: number })?.budgetUsd
    ?? 200) as number,
  );
  const testsPassed = $derived<number>(
    ((cycle as { tests?: { passed?: number } })?.tests?.passed
    ?? (cycle as { testsPassed?: number })?.testsPassed
    ?? 0) as number,
  );
  const testsTotal = $derived<number>(
    ((cycle as { tests?: { total?: number } })?.tests?.total
    ?? (cycle as { testsTotal?: number })?.testsTotal
    ?? 0) as number,
  );
  const testsFailed = $derived<number>(Math.max(0, testsTotal - testsPassed));
  const prUrl = $derived<string | null>(
    (((cycle as { pr?: { url?: string } })?.pr?.url
    ?? (cycle as { prUrl?: string })?.prUrl) as string | undefined) ?? null,
  );
  const branch = $derived<string | null>(
    (((cycle as { git?: { branch?: string } })?.git?.branch
    ?? (cycle as { branch?: string })?.branch) as string | undefined) ?? null,
  );
  const commitSha = $derived<string | null>(
    (((cycle as { git?: { sha?: string; commitSha?: string } })?.git?.sha
    ?? (cycle as { git?: { sha?: string; commitSha?: string } })?.git?.commitSha
    ?? (cycle as { commitSha?: string })?.commitSha) as string | undefined) ?? null,
  );
  const sprintVersion = $derived<string | null>(
    ((cycle as { sprintVersion?: string })?.sprintVersion as string | undefined) ?? null,
  );
  const startedAt = $derived<string | null>(
    ((cycle as { startedAt?: string })?.startedAt as string | undefined) ?? null,
  );
  const completedAt = $derived<string | null>(
    ((cycle as { completedAt?: string })?.completedAt as string | undefined) ?? null,
  );
  const durationMs = $derived<number | null>(
    ((cycle as { durationMs?: number })?.durationMs as number | undefined) ?? null,
  );
  // Killed-mid-flight cycles never write startedAt/completedAt/durationMs to
  // cycle.json, so fall back to the events stream. events[0].at is the first
  // observed activity; events[last].at is the last write before the kill.
  const firstEventAt = $derived.by<string | null>(() => {
    for (const ev of events) if (ev.at) return ev.at;
    return null;
  });
  const lastEventAt = $derived.by<string | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const at = events[i]?.at;
      if (at) return at;
    }
    return null;
  });
  const effectiveStartedAt = $derived<string | null>(startedAt ?? firstEventAt);
  const elapsedMs = $derived.by<number>(() => {
    if (durationMs != null) return durationMs;
    const start = effectiveStartedAt;
    if (!start) return 0;
    const startMs = new Date(start).getTime();
    if (completedAt) return Math.max(0, new Date(completedAt).getTime() - startMs);
    if (isTerminal && lastEventAt) {
      return Math.max(0, new Date(lastEventAt).getTime() - startMs);
    }
    return Math.max(0, now - startMs);
  });
  const elapsedDisplay = $derived<string>(formatDuration(elapsedMs));

  const activeRailIdx = $derived.by<number>(() => {
    if (isTerminal) return -1;
    const s = stage.toLowerCase();
    const idx = PHASE_TO_RAIL[s];
    return idx ?? 0;
  });

  const railStages = $derived.by<StageBrick[]>(() => {
    const s = stage.toLowerCase();
    if (s === 'completed') return Array.from({ length: 6 }, () => 'done' as StageBrick);
    const idx = activeRailIdx;
    if (s === 'failed' || s === 'killed' || s === 'crashed') {
      const out: StageBrick[] = Array.from({ length: 6 }, () => 'pending');
      const lastDone = Math.max(0, idx - 1);
      for (let i = 0; i < lastDone; i++) out[i] = 'done';
      if (idx >= 0) out[idx] = 'failed';
      return out;
    }
    const out: StageBrick[] = Array.from({ length: 6 }, () => 'pending');
    for (let i = 0; i < idx; i++) out[i] = 'done';
    if (idx >= 0 && idx < 6) out[idx] = 'active';
    return out;
  });

  const railPhases = $derived.by<{ durMs?: number; agent?: string }[]>(() => {
    const out: { durMs?: number; agent?: string }[] = Array.from({ length: 6 }, () => ({}));
    const runs = agentsData?.runs ?? [];
    for (let railIdx = 0; railIdx < 6; railIdx++) {
      const matching = runs.filter((r) => PHASE_TO_RAIL[r.phase] === railIdx);
      if (matching.length === 0) continue;
      const durMs = matching.reduce((s, r) => s + (r.durationMs ?? 0), 0);
      const lastAgent = matching[matching.length - 1]!.agentId;
      out[railIdx] = { durMs, agent: lastAgent };
    }
    return out;
  });

  // Phase completion comes from TWO signals merged:
  //   1. `agentsData.runs[]` — phases that dispatched LLM agents (audit/plan/
  //      execute/test/review/gate/learn). Each agent run carries cost/duration.
  //   2. `events[]` `phase.result` / `phase.failure` events — covers DETERMINISTIC
  //      phases (assign, release, sometimes gate) that don't produce agent runs
  //      but still emit phase events.
  // Earlier versions used (1) only, which caused ASSIGN/RELEASE/LEARN to show
  // as never-completed even after the cycle ran them successfully.
  const pipelinePhases = $derived.by<PhaseInfo[]>(() => {
    const runs = agentsData?.runs ?? [];

    // Build a phase-event map from events.jsonl
    const eventPhaseStatus = new Map<string, 'done' | 'failed' | 'active'>();
    for (const ev of events) {
      const ph = (ev.phase as string | undefined)?.toLowerCase();
      if (!ph) continue;
      if (ev.type === 'phase.start') {
        if (!eventPhaseStatus.has(ph)) eventPhaseStatus.set(ph, 'active');
      } else if (ev.type === 'phase.result') {
        eventPhaseStatus.set(ph, 'done');
      } else if (ev.type === 'phase.failure') {
        eventPhaseStatus.set(ph, 'failed');
      }
    }

    const out: PhaseInfo[] = [];
    for (const name of PHASE_ORDER) {
      const matching = runs.filter((r) => r.phase === name);
      const hasRuns = matching.length > 0;
      const isCurrent = !isTerminal && name === stage.toLowerCase();
      const evStatus = eventPhaseStatus.get(name);
      const isFailed = matching.some((r) => r.status === 'failed') || evStatus === 'failed';
      const hasResult = evStatus === 'done';
      const sumCost = matching.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      const sumDur = matching.reduce((s, r) => s + (r.durationMs ?? 0), 0);
      const lastRun = matching[matching.length - 1];

      // Done if: agent runs exist OR phase.result event emitted
      // Active if: current stage AND not yet done
      // Failed if: any run failed OR phase.failure event emitted
      // Pending otherwise
      let status: PhaseInfo['status'];
      if (isFailed) status = 'failed';
      else if (hasRuns || hasResult) status = 'done';
      else if (isCurrent || evStatus === 'active') status = 'active';
      else status = 'pending';

      // Skip rendering only when truly nothing happened AND the cycle is
      // terminal (so we don't show stale "pending" rows on a finished cycle).
      if (status === 'pending' && isTerminal && !hasResult && !hasRuns) continue;

      out.push({
        name: name.toUpperCase(),
        status,
        agent: lastRun?.agentId,
        model: lastRun?.model,
        costUsd: hasRuns ? sumCost : undefined,
        durationMs: hasRuns ? sumDur : undefined,
        detail: PHASE_DETAILS[name],
      });
    }
    return out;
  });

  // When a cycle is killed before phase.result flushes back to plan.json,
  // sprint items stay stuck at 'in_progress' even though the agent runs are
  // status='completed'. Override item status from execute-phase agent runs so
  // the UI reflects the agents' actual outcome.
  const executeStatusByItem = $derived.by<Map<string, SprintItem['status']>>(() => {
    const m = new Map<string, SprintItem['status']>();
    for (const r of agentsData?.runs ?? []) {
      if (r.phase !== 'execute' || !r.itemId) continue;
      const s = r.status === 'completed' ? 'completed'
              : r.status === 'failed'    ? 'failed'
              : r.status === 'killed'    ? 'killed'
              : 'in_progress';
      const prev = m.get(r.itemId);
      // Promote: completed wins over in_progress; failed wins over in_progress
      if (!prev || (prev === 'in_progress' && s !== 'in_progress')) m.set(r.itemId, s);
    }
    return m;
  });

  const effectiveItems = $derived.by<SprintItem[]>(() => {
    const items = (sprint?.items ?? []) as SprintItem[];
    return items.map((it) => {
      const override = executeStatusByItem.get(it.id);
      if (!override) return it;
      // Only override when sprint hasn't already advanced past in_progress
      if (it.status === 'planned' || it.status === 'pending' || it.status === 'in_progress') {
        return { ...it, status: override };
      }
      return it;
    });
  });

  const itemsByStatus = $derived.by(() => {
    const items = effectiveItems;
    return {
      planned: items.filter((i) => i.status === 'planned' || i.status === 'pending'),
      inProgress: items.filter((i) => i.status === 'in_progress'),
      completed: items.filter((i) => i.status === 'completed'),
      failed: items.filter((i) => i.status === 'failed' || i.status === 'killed'),
    };
  });

  const itemsPct = $derived.by<number>(() => {
    const items = effectiveItems;
    if (items.length === 0) return 0;
    const done = items.filter((i) => i.status === 'completed').length;
    return (done / items.length) * 100;
  });

  const costByPhase = $derived.by(() => {
    const runs = agentsData?.runs ?? [];
    const map: Record<string, number> = {};
    for (const r of runs) map[r.phase] = (map[r.phase] ?? 0) + (r.costUsd ?? 0);
    return PHASE_ORDER
      .map((name) => ({ name: name.toUpperCase(), costUsd: map[name] ?? 0 }))
      .filter((p) => p.costUsd > 0);
  });

  interface AgentSummary {
    agentId: string;
    runs: number;
    totalCostUsd: number;
    totalDurationMs: number;
    phases: string[];
    model?: string;
    effort?: string;
    spark: number[];
  }
  const agentSummaries = $derived.by<AgentSummary[]>(() => {
    if (!agentsData) return [];
    const byId = new Map<string, AgentSummary>();
    for (const r of agentsData.runs) {
      const existing = byId.get(r.agentId);
      if (existing) {
        existing.runs += 1;
        existing.totalCostUsd += r.costUsd ?? 0;
        existing.totalDurationMs += r.durationMs ?? 0;
        if (!existing.phases.includes(r.phase)) existing.phases.push(r.phase);
        existing.spark.push(r.costUsd ?? 0);
      } else {
        byId.set(r.agentId, {
          agentId: r.agentId,
          runs: 1,
          totalCostUsd: r.costUsd ?? 0,
          totalDurationMs: r.durationMs ?? 0,
          phases: [r.phase],
          model: r.model,
          effort: r.effort,
          spark: [r.costUsd ?? 0],
        });
      }
    }
    return [...byId.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  });

  interface RadarDim {
    key: string;
    label: string;
    score: number;
    max: number;
    color: string;
    detail: string;
  }
  const radarDims = $derived.by<RadarDim[]>(() => {
    const items = effectiveItems;
    const itemsTotal = items.length;
    const itemsDone = items.filter((i) => i.status === 'completed').length;
    const velocity = itemsTotal > 0 ? Math.round((itemsDone / itemsTotal) * 100) : 0;
    const quality = testsTotal > 0 ? Math.round((testsPassed / testsTotal) * 100) : 0;
    const costPct = budgetUsd > 0 ? Math.min(1, costUsd / budgetUsd) : 0;
    const cost = Math.round((1 - costPct) * 100);
    const erroredItems = items.filter((i) => i.status === 'failed' || i.status === 'killed').length;
    const autonomy = itemsTotal > 0 ? Math.round(((itemsTotal - erroredItems) / itemsTotal) * 100) : 0;
    const runs = agentsData?.runs ?? [];
    const failedRuns = runs.filter((r) => r.status === 'failed').length;
    const safety = runs.length > 0 ? Math.round((1 - failedRuns / runs.length) * 100) : 100;
    const learnReached = runs.some((r) => r.phase === 'learn');
    const learning = learnReached ? 80 : itemsDone > 0 ? 50 : 20;
    return [
      { key: 'velocity', label: 'Velocity', score: velocity, max: 100, color: 'var(--af-purple)',  detail: `${itemsDone}/${itemsTotal} items completed` },
      { key: 'quality',  label: 'Quality',  score: quality,  max: 100, color: 'var(--af-success)', detail: testsTotal > 0 ? `${testsPassed}/${testsTotal} tests passing` : 'no tests run' },
      { key: 'cost',     label: 'Cost',     score: cost,     max: 100, color: 'var(--af-warning)', detail: `$${costUsd.toFixed(2)} of $${budgetUsd.toFixed(0)} budget` },
      { key: 'autonomy', label: 'Autonomy', score: autonomy, max: 100, color: 'var(--af-accent2)', detail: `${itemsTotal - erroredItems}/${itemsTotal} items unblocked` },
      { key: 'safety',   label: 'Safety',   score: safety,   max: 100, color: 'var(--af-sonnet)',  detail: failedRuns === 0 ? 'no failed runs' : `${failedRuns} failed runs` },
      { key: 'learning', label: 'Learning', score: learning, max: 100, color: 'var(--af-haiku)',   detail: learnReached ? 'learn phase reached' : 'pending' },
    ];
  });

  const radarOverall = $derived<number>(
    Math.round(radarDims.reduce((s, d) => s + d.score, 0) / Math.max(1, radarDims.length)),
  );

  const tabs = $derived.by(() => {
    const items = sprint?.items ?? [];
    return [
      { id: 'overview', label: 'Overview' },
      { id: 'pipeline', label: 'Pipeline', count: pipelinePhases.length },
      { id: 'items',    label: 'Items',    count: items.length },
      { id: 'agents',   label: 'Agents',   count: agentsData?.totalRuns },
      { id: 'scoring',  label: 'Scoring',  count: radarOverall },
      { id: 'events',   label: 'Events',   count: events.length },
      { id: 'files',    label: 'Files' },
      { id: 'prs',      label: 'PRs',      count: prsData?.meta.total },
      { id: 'logs',     label: 'Logs' },
    ];
  });

  async function loadCycle(): Promise<void> {
    try {
      const res = await fetch(withWorkspace(`/api/v5/cycles/${id}`));
      if (res.ok) {
        cycle = (await res.json()) as Record<string, unknown>;
        error = null;
        return;
      }
      if (res.status === 404) {
        const body = await res.json().catch(() => null);
        if (body && typeof body === 'object' && 'cycleInProgress' in body) {
          cycle = body as Record<string, unknown>;
          error = null;
          return;
        }
      }
      error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function loadSprint(): Promise<void> {
    if (!id) return;
    sprintLoading = true;
    try {
      const res = await fetch(withWorkspace(`/api/v5/cycles/${id}/sprint`));
      if (res.ok) {
        const json = (await res.json()) as { sprint?: typeof sprint };
        sprint = (json.sprint ?? json) as typeof sprint;
        sprintError = null;
      } else if (res.status === 404) {
        sprint = null;
        sprintError = 'Sprint not generated yet — still in audit/plan phase';
      } else {
        sprintError = `HTTP ${res.status}`;
      }
    } catch (e) {
      sprintError = e instanceof Error ? e.message : String(e);
    } finally {
      sprintLoading = false;
    }
  }

  async function loadAgents(): Promise<void> {
    if (!id) return;
    agentsLoading = true;
    try {
      const res = await fetch(withWorkspace(`/api/v5/cycles/${id}/agents`));
      if (res.ok) agentsData = (await res.json()) as AgentsResponse;
    } catch { /* silent */ }
    finally { agentsLoading = false; }
  }

  async function loadScoring(): Promise<void> {
    try {
      const res = await fetch(withWorkspace(`/api/v5/cycles/${id}/scoring`));
      if (res.ok) scoring = (await res.json()) as ScoringResponse;
    } catch { /* silent */ }
  }

  async function loadPrs(force = false): Promise<void> {
    if (!id) return;
    const age = Date.now() - prsCacheAt;
    if (!force && prsData !== null && age < PRS_CACHE_MS) return;
    prsLoading = true;
    prsError = null;
    try {
      const res = await fetch(withWorkspace(`/api/v5/cycles/${id}/prs?ci=true`));
      if (res.ok) {
        prsData = (await res.json()) as PrsResponse;
        prsCacheAt = Date.now();
      } else if (res.status === 404) {
        prsData = { data: [], meta: { cycleId: id, total: 0, counts: { open: 0, merged: 0, closed: 0, pending: 0 }, timestamp: new Date().toISOString() } };
        prsCacheAt = Date.now();
      } else {
        prsError = `HTTP ${res.status}`;
      }
    } catch (e) {
      prsError = e instanceof Error ? e.message : String(e);
    } finally {
      prsLoading = false;
    }
  }

  function startPrsPoll(): void {
    stopPrsPoll();
    if (browser && document.visibilityState === 'hidden') return;
    prsPollTimer = setInterval(() => { void loadPrs(true); }, PRS_CACHE_MS);
  }

  function stopPrsPoll(): void {
    if (prsPollTimer) { clearInterval(prsPollTimer); prsPollTimer = null; }
  }

  function fmtAge(isoDate: string): string {
    const ms = Math.max(0, Date.now() - new Date(isoDate).getTime());
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function prStatusVariant(status: PrRow['status']): 'success' | 'danger' | 'muted' | 'warning' | 'purple' {
    if (status === 'merged') return 'success';
    if (status === 'closed') return 'danger';
    if (status === 'open') return 'purple';
    return 'muted';
  }

  function ciBucketColor(bucket: PrCiInfo['bucket']): string {
    if (bucket === 'pass') return 'var(--af-success)';
    if (bucket === 'fail') return 'var(--af-danger)';
    if (bucket === 'pending') return 'var(--af-warning)';
    return 'var(--af-dim)';
  }

  async function loadEvents(): Promise<void> {
    try {
      const res = await fetch(withWorkspace(`/api/v5/cycles/${id}/events?since=${eventsSince}`));
      if (!res.ok) return;
      const json = (await res.json()) as { events?: CycleEvent[]; total?: number };
      const list = json.events ?? [];
      if (list.length > 0) {
        events = [...list.slice().reverse(), ...events];
        eventsSince = json.total ?? (eventsSince + list.length);
      }
    } catch { /* silent */ }
  }

  function ensureSse(): void {
    if (eventSource || isTerminal) return;
    try {
      const es = new EventSource('/api/v5/stream');
      eventSource = es;
      es.onopen = () => { sseConnected = true; };
      es.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data) as { type?: string; data?: { cycleId?: string; payload?: CycleEvent } & CycleEvent };
          if (parsed?.type !== 'cycle_event') return;
          const data = parsed.data ?? {};
          if (data.cycleId !== id) return;
          events = [(data.payload ?? data) as CycleEvent, ...events];
          eventsSince += 1;
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        sseConnected = false;
        es.close();
        eventSource = null;
      };
    } catch { /* EventSource unavailable */ }
  }

  function teardownSse(): void {
    if (eventSource) { eventSource.close(); eventSource = null; }
    sseConnected = false;
  }

  async function loadFile(name: FileName): Promise<void> {
    activeFile = name;
    if (fileData[name] !== undefined) return;
    fileLoading[name] = true;
    fileError[name] = null;
    try {
      const res = await fetch(withWorkspace(`/api/v5/cycles/${id}/files/${name}`));
      if (res.status === 404) fileData[name] = null;
      else if (!res.ok) fileError[name] = `HTTP ${res.status}`;
      else fileData[name] = await res.json();
    } catch (e) {
      fileError[name] = e instanceof Error ? e.message : String(e);
    } finally {
      fileLoading[name] = false;
    }
  }

  async function loadLog(name: LogName): Promise<void> {
    activeLog = name;
    teardownLogStream();
    logStreamLines = [];
    logText[name] = null;
    logLoading[name] = true;
    logError[name] = null;
    try {
      const res = await fetch(withWorkspace(`/api/v5/cycles/${id}/logs/${name}`));
      if (res.ok) logText[name] = await res.text();
      else if (res.status === 404) logText[name] = null;
      else logError[name] = `HTTP ${res.status}`;
    } catch (e) {
      logError[name] = e instanceof Error ? e.message : String(e);
    } finally {
      logLoading[name] = false;
    }
    if (!isTerminal) startLogStream(name);
  }

  function startLogStream(name: LogName): void {
    teardownLogStream();
    try {
      const es = new EventSource(`/api/v5/cycles/${id}/logs/${name}/stream`);
      logStreamSource = es;
      es.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data as string) as { line?: string; done?: boolean };
          if (parsed.done) { teardownLogStream(); return; }
          if (typeof parsed.line === 'string') logStreamLines = [...logStreamLines, parsed.line];
        } catch { /* ignore */ }
      };
      es.onerror = () => { es.close(); logStreamSource = null; };
    } catch { /* EventSource unavailable */ }
  }

  function teardownLogStream(): void {
    if (logStreamSource) { logStreamSource.close(); logStreamSource = null; }
  }

  function manage(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      stopPrsPoll();
      return;
    }
    if (activeTab === 'prs' && !prsPollTimer) startPrsPoll();
    if (!isTerminal && !pollTimer) {
      pollTimer = setInterval(() => {
        void loadCycle();
        void loadSprint();
        void loadAgents();
        // Poll events too — pipeline tab phase status is driven by events
        // (phase.start/result/failure). Without this, the pipeline view
        // never updates between phase boundaries.
        void loadEvents();
      }, 3000);
    }
    if (!isTerminal && !elapsedTimer) {
      elapsedTimer = setInterval(() => { now = Date.now(); }, 1000);
    }
    if (isTerminal) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    }
  }

  function onVisibility(): void { manage(); }

  function selectTab(t: string): void {
    const prev = activeTab;
    activeTab = t as Tab;
    if (t === 'events' && events.length === 0) void loadEvents();
    if (t === 'logs' && logText[activeLog] === null && !logLoading[activeLog]) void loadLog(activeLog);
    if (t === 'files' && fileData[activeFile] === undefined) void loadFile(activeFile);
    if (t === 'prs') {
      void loadPrs();
      startPrsPoll();
    } else if (prev === 'prs') {
      stopPrsPoll();
    }
  }

  function stageBadgeVariant(s: string): 'success' | 'danger' | 'purple' | 'muted' {
    const l = s.toLowerCase();
    if (l === 'completed') return 'success';
    if (l === 'failed' || l === 'killed' || l === 'crashed') return 'danger';
    if (TERMINAL.has(l)) return 'muted';
    return 'purple';
  }

  let eventFilter = $state<string>('all');
  let eventSearch = $state<string>('');
  const eventTypeOptions = $derived.by<string[]>(() => {
    const set = new Set<string>();
    for (const e of events) {
      const t = String(e.type ?? '');
      if (t) set.add(t.split('.')[0]!);
    }
    return ['all', ...Array.from(set)];
  });
  const filteredEvents = $derived.by<CycleEvent[]>(() => {
    let list = events;
    if (eventFilter !== 'all') {
      list = list.filter((e) => String(e.type ?? '').startsWith(eventFilter));
    }
    if (eventSearch.trim()) {
      const q = eventSearch.toLowerCase();
      list = list.filter((e) => {
        const blob = `${e.type ?? ''} ${e.agent ?? ''} ${e.msg ?? ''}`.toLowerCase();
        return blob.includes(q);
      });
    }
    return list;
  });

  let selectedItem = $state<SprintItem | null>(null);

  onMount(() => {
    void loadCycle();
    void loadSprint();
    void loadAgents();
    void loadScoring();
    void loadEvents();
    ensureSse();
    manage();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
  });

  onDestroy(() => {
    teardownSse();
    teardownLogStream();
    if (pollTimer) clearInterval(pollTimer);
    if (elapsedTimer) clearInterval(elapsedTimer);
    stopPrsPoll();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  });

  $effect(() => {
    void stage;
    if (isTerminal) { teardownSse(); teardownLogStream(); }
    manage();
  });

  function pretty(value: unknown): string {
    if (value == null) return 'null';
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  const RADAR_SIZE = 260;
  function radarPoint(i: number, n: number, scale = 1): [number, number] {
    const cx = RADAR_SIZE / 2;
    const cy = RADAR_SIZE / 2;
    const r = (RADAR_SIZE / 2) - 28;
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [cx + r * scale * Math.cos(a), cy + r * scale * Math.sin(a)];
  }
</script>

<svelte:head><title>Cycle {id.slice(0, 8)} — AgentForge</title></svelte:head>

<div style="margin-bottom:6px">
  <a class="back-link" href="/cycles">← Cycles</a>
</div>

{#if loading && !cycle}
  <Card>
    <div class="skel" style="height:32px;width:240px"></div>
    <div class="skel" style="height:18px;width:360px;margin-top:8px"></div>
    <div class="skel" style="height:40px;margin-top:12px"></div>
  </Card>
{:else if error && !cycle}
  <Card style="border-color:color-mix(in srgb,var(--af-danger) 33%,transparent)">
    <div class="error-row">
      <span>Failed to load cycle: <code>{error}</code></span>
      <Btn size="sm" onclick={loadCycle}>Retry</Btn>
    </div>
  </Card>
{:else if cycle}
  <div class="cycle-head">
    <div>
      <div class="cycle-title-row">
        {#if !isTerminal}<PulseDot color="var(--af-purple)" size={7} />{/if}
        <h1 class="cycle-title">Cycle <span class="af2-mono cycle-id">{id.slice(0, 8)}</span></h1>
        <Badge variant={stageBadgeVariant(stage)}>{stage.toUpperCase()}</Badge>
        {#if isStalled}
          <Badge variant="danger">STALLED</Badge>
        {/if}
        {#if prUrl}
          <a class="pr-pill af2-mono" href={prUrl} target="_blank" rel="noopener">
            PR {prUrl.split('/').pop()} ↗
          </a>
        {/if}
      </div>
      <p class="cycle-meta">
        {#if sprintVersion}<span class="af2-mono">v{sprintVersion}</span> · {/if}
        {#if startedAt}started {relativeTime(startedAt)}{/if}
        {#if branch} · branch <span class="af2-mono muted">{branch}</span>{/if}
      </p>
    </div>
    <div class="cycle-actions">
      {#if !isTerminal}<Btn variant="danger" size="sm">Cancel</Btn>{/if}
      <Btn size="sm">Re-run</Btn>
    </div>
  </div>

  <Card noPad style="margin-bottom:14px">
    <div style="padding:16px 18px 22px">
      <StageRail stages={railStages} phases={railPhases} showAgent />
    </div>
    <div class="quad">
      {#each [
        { l: 'Elapsed', v: elapsedDisplay, s: 'wall clock',                                         mono: true, bar: null, bc: '' },
        { l: 'Cost',    v: `$${costUsd.toFixed(2)}`, s: `of $${budgetUsd.toFixed(0)} budget`,         mono: true, bar: budgetUsd > 0 ? Math.min(100, (costUsd / budgetUsd) * 100) : null, bc: 'var(--af-grad-h)' },
        { l: 'Items',   v: `${itemsByStatus.completed.length}/${effectiveItems.length}`,             s: itemsByStatus.inProgress.length > 0 ? `${itemsByStatus.inProgress.length} in flight` : (itemsByStatus.failed.length > 0 ? `${itemsByStatus.failed.length} failed` : 'all done'), mono: true, bar: effectiveItems.length ? itemsPct : null, bc: 'var(--af-success)' },
        { l: 'Tests',   v: testsTotal > 0 ? testsPassed.toLocaleString() : '—',                       s: testsTotal > 0 ? `of ${testsTotal.toLocaleString()} pass` : 'no tests yet', mono: true, bar: testsTotal > 0 ? (testsPassed / testsTotal) * 100 : null, bc: 'var(--af-success)' },
      ] as q (q.l)}
        <div class="quad-cell">
          <div class="quad-label">{q.l}</div>
          <div class="quad-val af2-mono">{q.v}</div>
          <div class="quad-sub">{q.s}</div>
          {#if q.bar != null}
            <div class="quad-bar"><div class="quad-bar-fill" style="width:{q.bar}%;background:{q.bc}"></div></div>
          {/if}
        </div>
      {/each}
    </div>
  </Card>

  <Tabs tabs={tabs} active={activeTab} onselect={selectTab} />

  {#if activeTab === 'overview'}
    <div class="overview-grid">
      <div class="col-left">
        <Card>
          <div class="section-title">SUMMARY</div>
          <div class="kv-grid">
            <div><div class="kv-label">Started</div><div class="kv-val">{startedAt ? relativeTime(startedAt) : '—'}</div></div>
            <div><div class="kv-label">Sprint</div><div class="kv-val af2-mono">v{sprintVersion ?? '—'}</div></div>
            <div><div class="kv-label">Stage</div><div class="kv-val"><Badge variant={stageBadgeVariant(stage)}>{stage.toUpperCase()}</Badge></div></div>
            <div><div class="kv-label">Branch</div><div class="kv-val af2-mono" style="color:var(--af-accent2)">{branch ?? '—'}</div></div>
            <div><div class="kv-label">Commit</div><div class="kv-val af2-mono">{commitSha ? commitSha.slice(0, 12) : '—'}</div></div>
            <div><div class="kv-label">PR</div><div class="kv-val af2-mono">{prUrl ? prUrl.split('/').pop() : '—'}</div></div>
            <div><div class="kv-label">Budget</div><div class="kv-val af2-mono">${costUsd.toFixed(2)} / ${budgetUsd.toFixed(0)}</div></div>
            <div><div class="kv-label">Items</div><div class="kv-val">{itemsByStatus.completed.length} done · {itemsByStatus.inProgress.length} active</div></div>
            <div><div class="kv-label">Tests</div><div class="kv-val af2-mono">{testsTotal > 0 ? `${testsPassed}/${testsTotal} (${((testsPassed / testsTotal) * 100).toFixed(1)}%)` : '—'}</div></div>
          </div>
        </Card>

        <Card>
          <div class="section-title-row">
            <span class="section-title">COST BREAKDOWN</span>
            <span class="af2-mono section-tag">by phase</span>
          </div>
          {#if costByPhase.length === 0}
            <div class="muted" style="font-size:12px;margin-top:8px">No phase cost data yet.</div>
          {:else}
            <div class="cost-rows">
              {#each costByPhase as p (p.name)}
                {@const pct = costUsd > 0 ? (p.costUsd / costUsd) * 100 : 0}
                <div class="cost-row">
                  <span class="af2-mono cost-row-name">{p.name}</span>
                  <div class="cost-row-bar"><div class="cost-row-fill" style="width:{pct}%"></div></div>
                  <span class="af2-mono cost-row-amount">${p.costUsd.toFixed(3)}</span>
                  <span class="af2-mono cost-row-pct">{pct.toFixed(0)}%</span>
                </div>
              {/each}
              <div class="cost-row-total">
                <span>Total spend</span>
                <span class="af2-mono" style="color:var(--af-text);font-weight:600">${costUsd.toFixed(2)}</span>
              </div>
            </div>
          {/if}
        </Card>
      </div>

      <div class="col-right">
        <Card>
          <div class="section-title">TESTS</div>
          <div class="tests-row">
            <Ring
              value={testsTotal > 0 ? (testsPassed / testsTotal) * 100 : 0}
              size={80}
              stroke={5}
              color="var(--af-success)"
              label={testsTotal > 0 ? `${((testsPassed / testsTotal) * 100).toFixed(1)}%` : '—'}
            />
            <div class="tests-stats">
              <div class="kv-row"><span class="kv-key">Passed</span><span class="af2-mono" style="color:var(--af-success)">{testsPassed.toLocaleString()}</span></div>
              <div class="kv-row"><span class="kv-key">Failed</span><span class="af2-mono" style="color:var(--af-danger)">{testsFailed}</span></div>
              <div class="kv-row"><span class="kv-key">Total</span><span class="af2-mono">{testsTotal.toLocaleString()}</span></div>
            </div>
          </div>
        </Card>

        {#if itemsByStatus.inProgress.length > 0}
          <Card>
            <div class="section-title-row">
              <span class="section-title">NOW EXECUTING</span>
              <PulseDot color="var(--af-purple)" size={5} />
            </div>
            {#each itemsByStatus.inProgress.slice(0, 1) as it (it.id)}
              <div style="margin-top:8px">
                <div class="exec-meta">
                  <span class="af2-mono dim">#{it.id.slice(0, 12)}</span>
                  {#if it.model}<ModelChip model={it.model} />{/if}
                  {#if it.assignee}<span class="af2-mono muted">{it.assignee}</span>{/if}
                </div>
                <div class="exec-title">{it.title}</div>
                <div class="exec-stats af2-mono">
                  {#if it.durationMs}{formatDuration(it.durationMs)}{/if}
                  {#if it.costUsd != null} · ${it.costUsd.toFixed(3)}{/if}
                </div>
                <div class="exec-bar"><div class="exec-bar-fill"></div></div>
              </div>
            {/each}
          </Card>
        {/if}

        <Card>
          <div class="section-title">HEALTH</div>
          <div class="health-rows">
            {#each [
              { l: 'Budget',     ok: budgetUsd > 0 ? costUsd / budgetUsd < 0.85 : true, msg: budgetUsd > 0 ? `${Math.round((costUsd / budgetUsd) * 100)}% used` : '—' },
              { l: 'Test pass',  ok: testsTotal > 0 ? testsPassed / testsTotal > 0.95 : true, msg: testsTotal > 0 ? `${((testsPassed / testsTotal) * 100).toFixed(1)}%` : '—' },
              { l: 'Stage',      ok: !isTerminal || stage === 'completed', msg: stage.toUpperCase() },
              { l: 'Killswitch', ok: true, msg: 'armed' },
            ] as h (h.l)}
              <div class="health-row">
                <span class="health-dot" style="background:{h.ok ? 'var(--af-success)' : 'var(--af-warning)'}"></span>
                <span class="health-label">{h.l}</span>
                <span class="af2-mono">{h.msg}</span>
              </div>
            {/each}
          </div>
        </Card>
      </div>
    </div>
  {/if}

  {#if activeTab === 'pipeline'}
    <Card noPad>
      <div class="section-head">
        <span class="section-title">PIPELINE PHASES</span>
        <span class="af2-mono section-tag">{pipelinePhases.length} phases</span>
      </div>
      {#if pipelinePhases.length === 0}
        <div class="empty">No phase data yet.</div>
      {:else}
        <div class="pipeline">
          {#each pipelinePhases as p, i (p.name)}
            {@const last = i === pipelinePhases.length - 1}
            <div class="pipe-row">
              <div class="pipe-rail">
                <div
                  class="pipe-node"
                  class:node-done={p.status === 'done'}
                  class:node-active={p.status === 'active'}
                  class:node-failed={p.status === 'failed'}
                >
                  {#if p.status === 'done'}✓
                  {:else if p.status === 'failed'}✗
                  {:else if p.status === 'active'}<span class="pipe-node-dot"></span>
                  {:else}<span class="pipe-node-num">{i + 1}</span>{/if}
                </div>
                {#if !last}
                  <div
                    class="pipe-conn"
                    class:conn-done={p.status === 'done'}
                    class:conn-active={p.status === 'active'}
                  >
                    {#if p.status === 'active'}<div class="conn-flow"></div>{/if}
                  </div>
                {/if}
              </div>

              <div class="pipe-body">
                <div class="pipe-name-row">
                  <span
                    class="pipe-name"
                    class:pipe-name-active={p.status === 'active'}
                    class:pipe-name-done={p.status === 'done'}
                    class:pipe-name-failed={p.status === 'failed'}
                  >{p.name}</span>
                  {#if p.status === 'active'}<Badge variant="purple">RUNNING</Badge>{/if}
                  {#if p.status === 'done'}<span class="ok-mark">✓ completed</span>{/if}
                  {#if p.status === 'failed'}<span class="fail-mark">✗ failed</span>{/if}
                </div>
                <div class="pipe-detail">{p.detail ?? ''}</div>
                {#if p.agent}
                  <div class="pipe-agent-row">
                    <span class="af2-mono pipe-agent">{p.agent}</span>
                    {#if p.model}<ModelChip model={p.model} />{/if}
                  </div>
                {/if}
              </div>

              <div class="pipe-meta">
                {#if p.durationMs != null}
                  <div class="af2-mono pipe-dur">{formatDuration(p.durationMs)}</div>
                {:else}
                  <div class="pipe-dur-pending">pending</div>
                {/if}
                {#if p.costUsd != null}
                  <div class="af2-mono pipe-cost">${p.costUsd.toFixed(3)}</div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </Card>
  {/if}

  {#if activeTab === 'items'}
    {#if sprintLoading && !sprint}
      <Card><div class="skel" style="height:120px"></div></Card>
    {:else if !sprint?.items || sprint.items.length === 0}
      <Card>
        <div class="empty">
          {#if sprintError}<p>{sprintError}</p>{:else}<p>No sprint items yet.</p>{/if}
        </div>
      </Card>
    {:else}
      <Card style="margin-bottom:14px">
        <div class="items-head">
          <div>
            <div class="af2-mono items-version">v{sprint.version ?? sprintVersion ?? '—'}</div>
            <div class="items-title">{sprint.title ?? 'Autonomous sprint'}</div>
            {#if sprint.versionDecision?.rationale}
              <div class="items-rationale af2-mono">{sprint.versionDecision.rationale}</div>
            {/if}
          </div>
          <div class="items-pct">
            <div class="af2-mono items-pct-num"><AnimNum value={itemsPct} decimals={0} suffix="%" mono={false} /></div>
            <div class="items-pct-sub">{itemsByStatus.completed.length}/{effectiveItems.length} items</div>
          </div>
        </div>
        <div class="items-bar"><div class="items-bar-fill" style="width:{itemsPct}%"></div></div>
      </Card>

      <div class="kanban">
        {#each [
          { title: 'PLANNED',     color: 'var(--af-dim)',     items: itemsByStatus.planned },
          { title: 'IN PROGRESS', color: 'var(--af-purple)',  items: itemsByStatus.inProgress },
          { title: 'COMPLETED',   color: 'var(--af-success)', items: itemsByStatus.completed },
          { title: 'FAILED',      color: 'var(--af-danger)',  items: itemsByStatus.failed },
        ].filter((c) => c.items.length > 0) as col (col.title)}
          <div class="kan-col">
            <div class="kan-head">
              <span style="color:{col.color}">{col.title}</span>
              <span class="kan-count af2-mono">{col.items.length}</span>
            </div>
            {#each col.items as it (it.id)}
              <button
                type="button"
                class="kan-card"
                style="border-left-color:{col.color}"
                onclick={() => (selectedItem = it)}
              >
                <div class="kan-card-head">
                  <span class="af2-mono dim">#{it.id.slice(0, 12)}</span>
                  {#if it.model}<ModelChip model={it.model} />{/if}
                </div>
                <div class="kan-title" class:line-through={it.status === 'completed'}>{it.title}</div>
                {#if it.assignee || it.durationMs || it.costUsd != null}
                  <div class="kan-meta af2-mono">
                    {#if it.assignee}{it.assignee}{/if}
                    {#if it.durationMs} · {formatDuration(it.durationMs)}{/if}
                    {#if it.costUsd != null} · ${it.costUsd.toFixed(3)}{/if}
                  </div>
                {/if}
                {#if it.error}<div class="kan-error af2-mono">{it.error}</div>{/if}
              </button>
            {/each}
          </div>
        {/each}
      </div>

      {#if selectedItem}
        <div class="drawer-overlay" role="dialog" aria-modal="true" onclick={() => (selectedItem = null)}>
          <div class="drawer" onclick={(e) => e.stopPropagation()}>
            <div class="drawer-head">
              <div>
                <div class="drawer-kicker af2-mono">ITEM · #{selectedItem.id.slice(0, 12)}</div>
                <div class="drawer-title">{selectedItem.title}</div>
              </div>
              <button class="drawer-close" type="button" onclick={() => (selectedItem = null)} aria-label="Close">×</button>
            </div>
            <div class="drawer-body">
              <div class="drawer-meta">
                {#if selectedItem.assignee}<span class="af2-mono">{selectedItem.assignee}</span>{/if}
                {#if selectedItem.durationMs} · <span class="af2-mono">{formatDuration(selectedItem.durationMs)}</span>{/if}
                {#if selectedItem.costUsd != null} · <span class="af2-mono">${selectedItem.costUsd.toFixed(3)}</span>{/if}
              </div>
              <div class="drawer-badges">
                <Badge variant={selectedItem.status === 'completed' ? 'success' : selectedItem.status === 'failed' ? 'danger' : 'purple'}>
                  {selectedItem.status.replace('_', ' ')}
                </Badge>
                {#if selectedItem.model}<ModelChip model={selectedItem.model} />{/if}
              </div>
              {#if selectedItem.error}
                <pre class="drawer-pre">{selectedItem.error}</pre>
              {:else}
                <p class="muted" style="font-size:12px">No additional output recorded for this item.</p>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    {/if}
  {/if}

  {#if activeTab === 'agents'}
    {#if agentsLoading && !agentsData}
      <Card><div class="skel" style="height:120px"></div></Card>
    {:else if !agentsData || agentSummaries.length === 0}
      <Card><div class="empty">No agent runs yet — cycle is still in early phases.</div></Card>
    {:else}
      <Card style="margin-bottom:14px">
        <div class="items-head">
          <div>
            <div class="items-title">{agentSummaries.length} agents · {agentsData.totalRuns} runs</div>
            {#if !isTerminal}<div class="dim" style="font-size:11px">Live — updates every 3s</div>{/if}
          </div>
          <div class="items-pct">
            <div class="af2-mono items-pct-num"><AnimNum value={agentsData.totalCostUsd} decimals={2} prefix="$" mono={false} /></div>
            <div class="items-pct-sub">total cost</div>
          </div>
        </div>
      </Card>

      <div class="agent-grid">
        {#each agentSummaries as ag (ag.agentId)}
          {@const pct = agentsData.totalCostUsd > 0 ? (ag.totalCostUsd / agentsData.totalCostUsd) * 100 : 0}
          <Card hover>
            <div class="ag-head">
              <span class="ag-name">{ag.agentId}</span>
              {#if ag.model}<ModelChip model={ag.model} />{/if}
            </div>
            <div class="ag-grid">
              <div><div class="ag-key">runs</div><div class="af2-mono ag-val">{ag.runs}</div></div>
              <div><div class="ag-key">duration</div><div class="af2-mono ag-val">{formatDuration(ag.totalDurationMs)}</div></div>
              <div><div class="ag-key">cost</div><div class="af2-mono ag-val">${ag.totalCostUsd.toFixed(3)}</div></div>
            </div>
            {#if ag.spark.length > 1}
              <Sparkline data={ag.spark} color="var(--af-purple)" w={240} h={24} gradient />
            {/if}
            <div class="ag-pct-track"><div class="ag-pct-fill" style="width:{pct}%"></div></div>
            <div class="af2-mono ag-pct-label">{pct.toFixed(1)}% of cycle</div>
            <div class="ag-phases">
              {#each ag.phases as ph (ph)}<span class="phase-chip">{ph}</span>{/each}
            </div>
          </Card>
        {/each}
      </div>
    {/if}
  {/if}

  {#if activeTab === 'scoring'}
    <div class="scoring-grid">
      <Card style="background:linear-gradient(135deg,var(--af-surface),var(--af-surface2));border-color:color-mix(in srgb,var(--af-purple) 33%,transparent);padding:20px">
        <div class="section-title">OVERALL SCORE</div>
        <div class="scoring-overall">
          <Ring value={radarOverall} size={120} stroke={8} color="var(--af-purple)" label={`${radarOverall}%`} sub="overall" />
          <div>
            <div class="scoring-hl">
              {radarOverall >= 80 ? 'Strong cycle.' : radarOverall >= 60 ? 'Acceptable cycle.' : 'Weak cycle.'}
            </div>
            <div class="scoring-summary">
              {#if scoring?.summary}
                {scoring.summary}
              {:else}
                Derived from {radarDims.length} client-side dimensions across velocity, quality, cost, autonomy, safety, and learning.
              {/if}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <div class="section-title">WARNINGS · {scoring?.warnings?.length ?? 0}</div>
        {#if scoring?.warnings && scoring.warnings.length > 0}
          <div class="warning-list">
            {#each scoring.warnings as w (w)}
              <div class="warning-card"><span class="warning-icon">⚠</span><span>{w}</span></div>
            {/each}
          </div>
        {:else}
          <div class="muted" style="font-size:12px;margin-top:8px">No warnings — all systems within target.</div>
        {/if}
      </Card>
    </div>

    <div class="scoring-grid" style="margin-top:14px">
      <Card>
        <div class="section-title">DIMENSIONS</div>
        <div style="margin-top:12px;display:flex;justify-content:center">
          <svg width={RADAR_SIZE} height={RADAR_SIZE} viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`} aria-label="Scoring radar chart">
            <defs>
              <linearGradient id="radar-fill" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0%" stop-color="var(--af-accent)" stop-opacity="0.4" />
                <stop offset="100%" stop-color="var(--af-purple)" stop-opacity="0.15" />
              </linearGradient>
            </defs>
            {#each [0.25, 0.5, 0.75, 1.0] as rr (rr)}
              <polygon
                points={radarDims.map((_, i) => radarPoint(i, radarDims.length, rr).join(',')).join(' ')}
                fill="none"
                stroke="var(--af-border)"
                stroke-width="1"
                opacity="0.5"
              />
            {/each}
            {#each radarDims as _d, i (i)}
              {@const p = radarPoint(i, radarDims.length, 1)}
              <line x1={RADAR_SIZE / 2} y1={RADAR_SIZE / 2} x2={p[0]} y2={p[1]} stroke="var(--af-border)" stroke-width="1" opacity="0.4" />
            {/each}
            <polygon
              points={radarDims.map((d, i) => radarPoint(i, radarDims.length, d.score / d.max).join(',')).join(' ')}
              fill="url(#radar-fill)"
              stroke="var(--af-purple)"
              stroke-width="1.5"
            />
            {#each radarDims as d, i (d.key)}
              {@const p = radarPoint(i, radarDims.length, d.score / d.max)}
              <circle cx={p[0]} cy={p[1]} r="3" fill={d.color} stroke="var(--af-bg)" stroke-width="1.5" />
            {/each}
            {#each radarDims as d, i (d.key)}
              {@const lp = radarPoint(i, radarDims.length, 1.18)}
              <text x={lp[0]} y={lp[1]} fill="var(--af-muted)" font-size="10" text-anchor="middle" dominant-baseline="middle" font-weight="600">{d.label.toUpperCase()}</text>
              <text x={lp[0]} y={lp[1] + 12} fill={d.color} font-size="10" text-anchor="middle" dominant-baseline="middle" font-family="JetBrains Mono, monospace">{d.score}</text>
            {/each}
          </svg>
        </div>
      </Card>

      <Card>
        <div class="section-title">BREAKDOWN</div>
        <div class="breakdown-list">
          {#each radarDims as d (d.key)}
            <div>
              <div class="breakdown-head">
                <div class="breakdown-label">
                  <span class="breakdown-sq" style="background:{d.color}"></span>
                  <span>{d.label}</span>
                </div>
                <span class="af2-mono breakdown-score">
                  <AnimNum value={d.score} decimals={0} mono={false} />
                  <span class="breakdown-max">/{d.max}</span>
                </span>
              </div>
              <div class="breakdown-bar"><div class="breakdown-fill" style="width:{(d.score / d.max) * 100}%;background:{d.color}"></div></div>
              <div class="breakdown-detail">{d.detail}</div>
            </div>
          {/each}
        </div>
      </Card>
    </div>

    {#if scoring?.items && scoring.items.length > 0}
      <Card noPad style="margin-top:14px">
        <div class="section-head">
          <span class="section-title">ITEM SCORING</span>
          <span class="af2-mono section-tag">ranked by score</span>
        </div>
        <table class="rank-table">
          <thead>
            <tr>
              <th>#</th><th>Item</th><th>Score</th><th>Confidence</th><th>Cost</th><th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            {#each [...scoring.items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) as it, idx (it.id ?? idx)}
              {@const s = it.score ?? 0}
              {@const itCost = it.cost ?? it.estimatedCost ?? 0}
              <tr>
                <td class="af2-mono dim">#{(it.id ?? `${idx + 1}`).toString().slice(0, 12)}</td>
                <td class="rank-title">{it.title ?? 'Untitled'}</td>
                <td class="rank-score-cell">
                  <span
                    class="af2-mono rank-score"
                    style="color:{s >= 80 ? 'var(--af-success)' : s >= 60 ? 'var(--af-warning)' : 'var(--af-danger)'}"
                  >{s}</span>
                  <div class="rank-bar">
                    <div class="rank-bar-fill" style="width:{s}%;background:{s >= 80 ? 'var(--af-success)' : s >= 60 ? 'var(--af-warning)' : 'var(--af-danger)'}"></div>
                  </div>
                </td>
                <td>
                  <Badge variant={it.confidence === 'high' ? 'success' : it.confidence === 'medium' ? 'warning' : 'danger'}>{it.confidence ?? '—'}</Badge>
                </td>
                <td class="af2-mono">${itCost.toFixed(3)}{#if it.withinBudget} <span class="ok-mark-small">✓</span>{/if}</td>
                <td class="rank-rationale">{it.rationale ?? '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </Card>
    {/if}
  {/if}

  {#if activeTab === 'events'}
    <div class="events-bar">
      {#each eventTypeOptions as t (t)}
        <button
          type="button"
          class="chip"
          class:chip-active={eventFilter === t}
          onclick={() => (eventFilter = t)}
        >{t}</button>
      {/each}
      <div style="flex:1"></div>
      <input type="text" bind:value={eventSearch} class="event-search" placeholder="search events…" />
      <span class="af2-mono dim">{filteredEvents.length} events</span>
      <Btn size="sm" onclick={loadEvents}>Refresh</Btn>
      {#if sseConnected}<PulseDot color="var(--af-success)" size={5} />{/if}
    </div>

    <Card noPad>
      {#if filteredEvents.length === 0}
        <div class="empty">No events match your filter.</div>
      {:else}
        <div class="event-list">
          {#each filteredEvents as e, i (i)}
            {@const cat = String(e.type ?? '').split('.')[0] ?? ''}
            {@const color = cat === 'agent' ? 'var(--af-purple)'
                          : cat === 'phase' ? 'var(--af-sonnet)'
                          : cat === 'tests' ? 'var(--af-warning)'
                          : cat === 'item' ? 'var(--af-success)'
                          : 'var(--af-dim)'}
            <div class="event-row">
              <span class="af2-mono event-time">{e.at ? relativeTime(e.at) : '—'}</span>
              <span class="af2-mono event-type" style="color:{color}">{e.type ?? '—'}</span>
              <span class="event-body">
                {#if e.agent}<span class="af2-mono event-agent">{e.agent}</span> {/if}
                {e.msg ?? ''}
              </span>
              <span class="event-dot" style="background:{color}"></span>
            </div>
          {/each}
        </div>
      {/if}
    </Card>
  {/if}

  {#if activeTab === 'files'}
    <div class="files-grid">
      <Card noPad>
        <div class="files-head">FILES</div>
        {#each ['tests', 'git', 'pr', 'approval-pending', 'approval-decision'] as f (f)}
          <button
            type="button"
            class="file-btn af2-mono"
            class:file-active={activeFile === f}
            onclick={() => loadFile(f as FileName)}
          >{f}.json</button>
        {/each}
      </Card>
      <Card noPad>
        <div class="file-content-head">
          <span class="af2-mono">{activeFile}.json</span>
        </div>
        {#if fileLoading[activeFile]}
          <div class="skel" style="height:120px;margin:14px"></div>
        {:else if fileError[activeFile]}
          <div class="error-row" style="margin:14px">
            <span>Failed: {fileError[activeFile]}</span>
            <Btn size="sm" onclick={() => loadFile(activeFile)}>Retry</Btn>
          </div>
        {:else if fileData[activeFile] === null || fileData[activeFile] === undefined}
          <div class="empty">No content (file empty or not present).</div>
        {:else}
          <pre class="file-pre af2-mono">{pretty(fileData[activeFile])}</pre>
        {/if}
      </Card>
    </div>
  {/if}

  {#if activeTab === 'prs'}
    <div class="prs-bar">
      <span class="section-title">PULL REQUESTS</span>
      <div style="flex:1"></div>
      <Btn size="sm" onclick={() => loadPrs(true)}>Refresh</Btn>
    </div>

    {#if prsLoading && !prsData}
      <Card>
        <div class="skel prs-skel"></div>
        <div class="skel prs-skel" style="width:70%;margin-top:8px"></div>
        <div class="skel prs-skel" style="width:85%;margin-top:8px"></div>
      </Card>
    {:else if prsError}
      <Card style="border-color:color-mix(in srgb,var(--af-danger) 33%,transparent)">
        <div class="error-row">
          <span>Failed to load PRs: <code>{prsError}</code></span>
          <Btn size="sm" onclick={() => loadPrs(true)}>Retry</Btn>
        </div>
      </Card>
    {:else if prsData}
      {#if prsData.data.length === 0}
        <Card>
          <div class="empty prs-empty">
            This cycle ran in single-PR mode — no per-agent PRs.
          </div>
        </Card>
      {:else}
        <div class="prs-stats-strip">
          {#each [
            { label: 'Open',    value: prsData.meta.counts.open,    color: 'var(--af-purple)' },
            { label: 'Merged',  value: prsData.meta.counts.merged,  color: 'var(--af-success)' },
            { label: 'Closed',  value: prsData.meta.counts.closed,  color: 'var(--af-danger)' },
            { label: 'Pending', value: prsData.meta.counts.pending, color: 'var(--af-warning)' },
          ] as stat (stat.label)}
            <div class="prs-stat-cell">
              <div class="prs-stat-val af2-mono" style="color:{stat.color}">{stat.value}</div>
              <div class="prs-stat-label">{stat.label}</div>
            </div>
          {/each}
        </div>

        <Card noPad>
          <table class="prs-table">
            <thead>
              <tr>
                <th>PR</th>
                <th>Agent</th>
                <th>Branch</th>
                <th>Items</th>
                <th>Status</th>
                <th>CI</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {#each prsData.data as pr (pr.prNumber)}
                <tr>
                  <td>
                    <a
                      class="pr-num-link af2-mono"
                      href={pr.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >#{pr.prNumber} ↗</a>
                  </td>
                  <td>
                    <Badge variant="muted">{pr.agentId}</Badge>
                  </td>
                  <td>
                    <span class="af2-mono prs-branch">{pr.branch}</span>
                  </td>
                  <td>
                    {#if pr.itemIds.length === 0}
                      <span class="af2-mono dim">—</span>
                    {:else}
                      <span
                        class="af2-mono prs-items-count"
                        title={pr.itemIds.join(', ')}
                      >{pr.itemIds.length} item{pr.itemIds.length !== 1 ? 's' : ''}</span>
                    {/if}
                  </td>
                  <td>
                    <Badge variant={prStatusVariant(pr.status)}>{pr.status}</Badge>
                  </td>
                  <td>
                    {#if pr.ci}
                      <span class="prs-ci-chip">
                        <span
                          class="prs-ci-dot"
                          style="background:{ciBucketColor(pr.ci.bucket)}"
                        ></span>
                        <span
                          class="af2-mono prs-ci-label"
                          style="color:{ciBucketColor(pr.ci.bucket)}"
                        >{pr.ci.bucket}</span>
                      </span>
                    {:else}
                      <span class="af2-mono dim">—</span>
                    {/if}
                  </td>
                  <td>
                    <span class="af2-mono prs-age">{fmtAge(pr.openedAt)}</span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </Card>
      {/if}
    {/if}
  {/if}

  {#if activeTab === 'logs'}
    <div class="logs-bar">
      {#each ['cli-stdout', 'tests-raw'] as l (l)}
        <button
          type="button"
          class="chip af2-mono"
          class:chip-active={activeLog === l}
          onclick={() => loadLog(l as LogName)}
        >{l}.log</button>
      {/each}
      <div style="flex:1"></div>
      {#if !isTerminal}
        <PulseDot color="var(--af-success)" size={5} />
        <span class="af2-mono dim">live · tail -f</span>
      {/if}
    </div>

    <Card noPad>
      {#if logLoading[activeLog]}
        <div class="skel" style="height:120px;margin:14px"></div>
      {:else if logError[activeLog]}
        <div class="error-row" style="margin:14px">
          <span>Failed: {logError[activeLog]}</span>
          <Btn size="sm" onclick={() => loadLog(activeLog)}>Retry</Btn>
        </div>
      {:else if logText[activeLog] === null && logStreamLines.length === 0}
        <div class="empty">No log content yet.</div>
      {:else}
        <pre class="log-pre af2-mono" id="log-raw-pre">{(logText[activeLog] ?? '') + (logStreamLines.length ? '\n' + logStreamLines.join('\n') : '')}</pre>
      {/if}
    </Card>
  {/if}
{/if}

<style>
  .back-link { color: var(--af-dim); font-size: 11px; text-decoration: none; }
  .back-link:hover { color: var(--af-muted); }
  .cycle-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 12px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .cycle-title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 4px;
    flex-wrap: wrap;
  }
  .cycle-title {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--af-text);
  }
  .cycle-id { font-weight: 500; }
  .cycle-meta { margin: 0; font-size: 12px; color: var(--af-dim); }
  .cycle-actions { display: flex; gap: 8px; }
  .pr-pill {
    font-size: 11px;
    color: var(--af-accent2);
    text-decoration: none;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    padding: 3px 8px;
    border-radius: 4px;
  }
  .quad {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: var(--af-border);
    border-top: 1px solid var(--af-border);
  }
  @media (max-width: 720px) { .quad { grid-template-columns: repeat(2, 1fr); } }
  .quad-cell { padding: 12px 18px; background: var(--af-surface); }
  .quad-label {
    font-size: 9px;
    color: var(--af-dim);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .quad-val {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--af-text);
    margin-bottom: 3px;
  }
  .quad-sub { font-size: 10px; color: var(--af-dim); }
  .quad-bar {
    margin-top: 6px;
    height: 2px;
    background: var(--af-border);
    border-radius: 1px;
    overflow: hidden;
  }
  .quad-bar-fill { height: 100%; transition: width 600ms ease; }

  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
  }
  .section-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 18px;
    border-bottom: 1px solid var(--af-border);
  }
  .section-tag { font-size: 10px; color: var(--af-dim); }

  .overview-grid {
    display: grid;
    grid-template-columns: 1.5fr 1fr;
    gap: 14px;
    margin-top: 6px;
  }
  @media (max-width: 960px) { .overview-grid { grid-template-columns: 1fr; } }
  .col-left, .col-right { display: flex; flex-direction: column; gap: 12px; }
  .kv-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin-top: 12px;
  }
  @media (max-width: 600px) { .kv-grid { grid-template-columns: 1fr 1fr; } }
  .kv-label {
    font-size: 10px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .kv-val { font-size: 12px; color: var(--af-text); }
  .cost-rows { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
  .cost-row {
    display: grid;
    grid-template-columns: 80px 1fr 80px 60px;
    align-items: center;
    gap: 10px;
  }
  .cost-row-name {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--af-muted);
  }
  .cost-row-bar {
    height: 8px;
    background: var(--af-border);
    border-radius: 4px;
    overflow: hidden;
  }
  .cost-row-fill {
    height: 100%;
    background: var(--af-accent);
    transition: width 600ms ease;
  }
  .cost-row-amount { font-size: 11px; color: var(--af-text); text-align: right; }
  .cost-row-pct { font-size: 10px; color: var(--af-dim); text-align: right; }
  .cost-row-total {
    margin-top: 4px;
    padding-top: 10px;
    border-top: 1px solid var(--af-border);
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--af-dim);
  }

  .tests-row {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 12px;
  }
  .tests-stats {
    flex: 1;
    display: grid;
    gap: 6px;
    font-size: 12px;
  }
  .kv-row { display: flex; justify-content: space-between; }
  .kv-key { color: var(--af-dim); }

  .exec-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .exec-title { font-size: 12px; color: var(--af-text); line-height: 1.5; }
  .exec-stats { margin-top: 10px; font-size: 11px; color: var(--af-dim); display: flex; gap: 12px; }
  .exec-bar {
    margin-top: 10px;
    height: 3px;
    background: var(--af-border);
    border-radius: 2px;
    overflow: hidden;
  }
  .exec-bar-fill {
    height: 100%;
    width: 73%;
    background: linear-gradient(90deg, var(--af-accent), var(--af-purple), var(--af-accent));
    background-size: 200% 100%;
    animation: af2flow 2.5s linear infinite;
  }
  @keyframes af2flow {
    0%   { background-position: 0% 0; }
    100% { background-position: 200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .exec-bar-fill { animation: none; }
  }

  .health-rows { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .health-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .health-dot { width: 6px; height: 6px; border-radius: 50%; }
  .health-label { color: var(--af-muted); flex: 1; }

  .pipeline { padding: 8px 0; }
  .pipe-row {
    display: grid;
    grid-template-columns: 70px 1fr auto;
    position: relative;
  }
  .pipe-rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 14px;
  }
  .pipe-node {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--af-surface);
    border: 1px solid var(--af-border3);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
  }
  .node-done {
    background: var(--af-grad, linear-gradient(135deg, var(--af-accent), var(--af-purple)));
    border: none;
  }
  .node-active {
    border: 2px solid var(--af-purple);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--af-purple) 13%, transparent);
  }
  .node-failed {
    background: color-mix(in srgb, var(--af-danger) 12%, transparent);
    border: 2px solid var(--af-danger);
    color: var(--af-danger);
  }
  .pipe-node-num { color: var(--af-faint); font-size: 10px; }
  .pipe-node-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--af-grad, linear-gradient(135deg, var(--af-accent), var(--af-purple)));
  }
  .pipe-conn {
    width: 2px;
    flex: 1;
    min-height: 36px;
    margin-top: 4px;
    background: var(--af-border);
    position: relative;
    overflow: hidden;
  }
  .conn-done { background: var(--af-grad-v, linear-gradient(180deg, var(--af-accent), var(--af-purple))); }
  .conn-active { background: var(--af-purple); }
  .conn-flow {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, var(--af-purple) 0%, transparent 100%);
    background-size: 100% 200%;
    animation: af2flow-v 2s linear infinite;
  }
  @keyframes af2flow-v {
    0%   { background-position: 0 0; }
    100% { background-position: 0 200%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .conn-flow { animation: none; background: var(--af-purple); }
  }
  .pipe-body { padding: 12px 0; }
  .pipe-name-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 3px;
    flex-wrap: wrap;
  }
  .pipe-name { font-size: 14px; font-weight: 600; color: var(--af-dim); }
  .pipe-name-active { color: var(--af-purple); }
  .pipe-name-done   { color: var(--af-text); }
  .pipe-name-failed { color: var(--af-danger); }
  .ok-mark   { font-size: 10px; color: var(--af-success); }
  .ok-mark-small { font-size: 9px; color: var(--af-success); }
  .fail-mark { font-size: 10px; color: var(--af-danger); }
  .pipe-detail { font-size: 12px; color: var(--af-dim); line-height: 1.5; }
  .pipe-agent-row {
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pipe-agent { font-size: 11px; color: var(--af-muted); }
  .pipe-meta {
    padding: 12px 18px 12px 4px;
    text-align: right;
    min-width: 110px;
  }
  .pipe-dur { font-size: 13px; font-weight: 500; color: var(--af-text); }
  .pipe-dur-pending { font-size: 11px; color: var(--af-faint); }
  .pipe-cost { font-size: 11px; color: var(--af-dim); margin-top: 2px; }

  .items-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .items-version { font-size: 18px; font-weight: 600; color: var(--af-text); }
  .items-title   { font-size: 13px; color: var(--af-muted); margin-top: 2px; }
  .items-rationale { font-size: 10px; color: var(--af-faint); margin-top: 4px; }
  .items-pct { text-align: right; }
  .items-pct-num { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; color: var(--af-text); }
  .items-pct-sub { font-size: 11px; color: var(--af-dim); }
  .items-bar {
    margin-top: 10px;
    height: 4px;
    background: var(--af-border);
    border-radius: 2px;
    overflow: hidden;
  }
  .items-bar-fill {
    height: 100%;
    background: var(--af-grad-h, linear-gradient(90deg, var(--af-accent), var(--af-purple)));
    transition: width 700ms ease;
  }
  .kanban {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
  .kan-col { display: flex; flex-direction: column; gap: 8px; }
  .kan-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }
  .kan-count {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    color: var(--af-dim);
  }
  .kan-card {
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    border-left: 3px solid var(--af-dim);
    border-radius: 6px;
    padding: 10px 12px;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 180ms ease, background 180ms ease;
    color: var(--af-text);
  }
  .kan-card:hover {
    border-color: var(--af-border3);
    background: var(--af-surface2);
  }
  .kan-card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .kan-title { font-size: 12px; color: var(--af-text); line-height: 1.5; }
  .line-through {
    color: var(--af-dim);
    text-decoration: line-through;
    text-decoration-color: var(--af-border3);
  }
  .kan-meta { margin-top: 8px; font-size: 10px; color: var(--af-dim); }
  .kan-error { margin-top: 6px; font-size: 10px; color: var(--af-danger); }

  .drawer-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    z-index: 100;
    display: flex;
    align-items: stretch;
    justify-content: flex-end;
  }
  .drawer {
    width: min(720px, 92vw);
    height: 100%;
    background: var(--af-bg);
    border-left: 1px solid var(--af-border);
    display: flex;
    flex-direction: column;
    box-shadow: -12px 0 60px rgba(0,0,0,0.6);
  }
  .drawer-head {
    padding: 16px 20px;
    border-bottom: 1px solid var(--af-border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .drawer-kicker { font-size: 10px; color: var(--af-dim); letter-spacing: 0.06em; }
  .drawer-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--af-text);
    margin-top: 2px;
  }
  .drawer-close {
    width: 30px;
    height: 30px;
    border-radius: 6px;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    color: var(--af-muted);
    cursor: pointer;
    font-size: 16px;
  }
  .drawer-body { padding: 16px 20px; overflow: auto; flex: 1; }
  .drawer-meta {
    font-size: 11px;
    color: var(--af-dim);
    margin-bottom: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .drawer-badges { display: flex; gap: 6px; margin-bottom: 12px; }
  .drawer-pre {
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 12px;
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-size: 11px;
    color: var(--af-text);
    overflow: auto;
    margin: 0;
    white-space: pre-wrap;
  }

  .agent-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 10px;
  }
  .ag-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .ag-name {
    flex: 1;
    font-weight: 600;
    font-size: 13px;
    color: var(--af-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ag-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    font-size: 11px;
    margin-bottom: 8px;
  }
  .ag-key { color: var(--af-dim); font-size: 10px; }
  .ag-val { color: var(--af-text); margin-top: 2px; }
  .ag-pct-track {
    margin-top: 8px;
    height: 2px;
    background: var(--af-border);
    border-radius: 1px;
    overflow: hidden;
  }
  .ag-pct-fill {
    height: 100%;
    background: var(--af-grad-h, linear-gradient(90deg, var(--af-accent), var(--af-purple)));
  }
  .ag-pct-label { font-size: 9px; color: var(--af-dim); margin-top: 3px; text-align: right; }
  .ag-phases {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .phase-chip {
    font-size: 9px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    color: var(--af-dim);
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
  }

  .scoring-grid {
    display: grid;
    grid-template-columns: 1fr 1.4fr;
    gap: 14px;
  }
  @media (max-width: 960px) { .scoring-grid { grid-template-columns: 1fr; } }
  .scoring-overall {
    display: flex;
    align-items: center;
    gap: 18px;
    margin-top: 14px;
  }
  .scoring-hl { font-size: 14px; color: var(--af-text); line-height: 1.55; font-weight: 500; }
  .scoring-summary { font-size: 12px; color: var(--af-dim); margin-top: 6px; line-height: 1.55; }
  .warning-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
  .warning-card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--af-warning) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-warning) 25%, transparent);
    border-radius: 6px;
    font-size: 12px;
    color: var(--af-text);
  }
  .warning-icon { color: var(--af-warning); font-size: 14px; }

  .breakdown-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 10px;
  }
  .breakdown-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 4px;
  }
  .breakdown-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--af-text);
  }
  .breakdown-sq { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .breakdown-score { font-size: 13px; font-weight: 600; color: var(--af-text); }
  .breakdown-max { color: var(--af-dim); font-size: 11px; }
  .breakdown-bar {
    height: 4px;
    background: var(--af-border);
    border-radius: 2px;
    overflow: hidden;
  }
  .breakdown-fill { height: 100%; transition: width 700ms cubic-bezier(.2,.7,.2,1); }
  .breakdown-detail { font-size: 10px; color: var(--af-dim); margin-top: 3px; }

  .rank-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .rank-table th {
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
    padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
  }
  .rank-table td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
    color: var(--af-text);
  }
  .rank-table td:last-child { color: var(--af-dim); font-size: 11px; max-width: 380px; line-height: 1.5; }
  .rank-title { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rank-score-cell { width: 140px; }
  .rank-score { font-size: 13px; font-weight: 600; margin-right: 8px; }
  .rank-bar {
    display: inline-block;
    width: 80px;
    height: 4px;
    background: var(--af-border);
    border-radius: 2px;
    overflow: hidden;
    vertical-align: middle;
  }
  .rank-bar-fill { height: 100%; transition: width 500ms ease; }

  .events-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .chip {
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 11px;
    background: transparent;
    border: 1px solid var(--af-border2);
    color: var(--af-dim);
    cursor: pointer;
    font-family: inherit;
    transition: all 150ms ease;
  }
  .chip:hover { color: var(--af-muted); }
  .chip-active {
    background: var(--af-surface2);
    border-color: var(--af-border3);
    color: var(--af-text);
  }
  .event-search {
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    color: var(--af-text);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 11px;
    font-family: inherit;
    height: 28px;
    width: 200px;
  }
  .event-search:focus { outline: none; border-color: var(--af-purple); }
  .event-list { padding: 4px 0; }
  .event-row {
    display: grid;
    grid-template-columns: 100px 160px 1fr auto;
    gap: 14px;
    align-items: center;
    padding: 8px 16px;
    border-bottom: 1px solid var(--af-border);
  }
  .event-row:last-child { border-bottom: none; }
  .event-time { font-size: 11px; color: var(--af-dim); }
  .event-type { font-size: 11px; font-weight: 600; }
  .event-body {
    font-size: 12px;
    color: var(--af-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .event-agent { color: var(--af-text); }
  .event-dot { width: 6px; height: 6px; border-radius: 50%; opacity: 0.5; }

  .files-grid {
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 12px;
  }
  @media (max-width: 720px) { .files-grid { grid-template-columns: 1fr; } }
  .files-head {
    padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
    font-size: 10px;
    font-weight: 700;
    color: var(--af-dim);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .file-btn {
    width: 100%;
    display: flex;
    align-items: center;
    padding: 8px 14px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: var(--af-text);
    cursor: pointer;
    font-size: 12px;
    text-align: left;
  }
  .file-btn:hover { background: var(--af-surface2); }
  .file-active {
    background: var(--af-surface2);
    border-left-color: var(--af-purple);
  }
  .file-content-head {
    padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
    font-size: 12px;
    font-weight: 600;
    color: var(--af-text);
  }
  .file-pre {
    margin: 0;
    padding: 14px 18px;
    font-size: 11px;
    color: var(--af-muted);
    line-height: 1.65;
    background: var(--af-surface);
    overflow: auto;
    max-height: 500px;
    white-space: pre-wrap;
  }

  .logs-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .log-pre {
    margin: 0;
    padding: 12px 16px;
    font-size: 11px;
    color: var(--af-muted);
    line-height: 1.6;
    background: var(--af-surface);
    overflow: auto;
    max-height: 540px;
    white-space: pre-wrap;
  }

  .empty {
    padding: 28px 16px;
    text-align: center;
    color: var(--af-muted);
    font-size: 12px;
  }
  .error-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--af-danger);
    font-size: 12px;
  }
  .error-row code {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    background: color-mix(in srgb, var(--af-danger) 12%, transparent);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .skel {
    background: linear-gradient(90deg, var(--af-surface) 0%, var(--af-surface2) 50%, var(--af-surface) 100%);
    background-size: 200% 100%;
    animation: skel 1.4s linear infinite;
    border-radius: 4px;
  }
  @keyframes skel {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .skel { animation: none; background: var(--af-surface2); }
  }
  .muted { color: var(--af-muted); }
  .dim { color: var(--af-dim); }
  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1, 'ss01' 1;
  }

  /* ── PRs tab ────────────────────────────────────────────────────────────── */
  .prs-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .prs-stats-strip {
    display: flex;
    gap: 0;
    margin-bottom: 12px;
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    border-radius: 8px;
    overflow: hidden;
  }
  .prs-stat-cell {
    flex: 1;
    padding: 14px 18px;
    text-align: center;
    border-right: 1px solid var(--af-border);
  }
  .prs-stat-cell:last-child { border-right: none; }
  .prs-stat-val { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
  .prs-stat-label { font-size: 11px; color: var(--af-dim); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.06em; }
  .prs-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .prs-table thead tr {
    background: var(--af-surface2);
    border-bottom: 1px solid var(--af-border);
  }
  .prs-table th {
    padding: 9px 14px;
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    color: var(--af-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }
  .prs-table td {
    padding: 10px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--af-border) 50%, transparent);
    vertical-align: middle;
  }
  .prs-table tbody tr:last-child td { border-bottom: none; }
  .prs-table tbody tr:hover { background: color-mix(in srgb, var(--af-surface2) 60%, transparent); }
  .pr-num-link {
    color: var(--af-purple);
    text-decoration: none;
    font-size: 12px;
    white-space: nowrap;
  }
  .pr-num-link:hover { text-decoration: underline; }
  .prs-branch {
    font-size: 11px;
    color: var(--af-accent2);
    max-width: 200px;
    display: inline-block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }
  .prs-items-count {
    font-size: 12px;
    cursor: help;
    border-bottom: 1px dashed var(--af-dim);
  }
  .prs-ci-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .prs-ci-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .prs-ci-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .prs-age { font-size: 12px; color: var(--af-muted); }
  .prs-empty { font-size: 13px; color: var(--af-muted); text-align: center; padding: 24px 0; }
  .prs-skel { height: 32px; width: 100%; }
</style>
