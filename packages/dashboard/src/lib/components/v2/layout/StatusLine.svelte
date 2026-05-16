<script lang="ts">
  // ── Types ──────────────────────────────────────────────────────────────
  type ServiceStatus = 'up' | 'degraded' | 'down';

  interface ServicesResponse {
    services?: {
      api?: ServiceStatus;
      ws?: ServiceStatus;
      sse?: ServiceStatus;
    };
    api?: ServiceStatus;
    ws?: ServiceStatus;
    sse?: ServiceStatus;
  }

  interface Counters {
    agents: number;
    agentsActive: number;
    cyclesDay: number;
    cyclesWeek: number;
    cyclesMonth: number;
    openBranches: number;
    pendingApprovals: number;
    runningCycles?: number;
    todaySpend: number;
    /** Endpoint returns `'idle' | 'busy' | 'overloaded'`; legacy fallback used [] */
    load: 'idle' | 'busy' | 'overloaded' | '';
  }

  // ── State ──────────────────────────────────────────────────────────────
  let apiStatus: ServiceStatus = $state('down');
  let wsStatus: ServiceStatus = $state('down');
  let sseStatus: ServiceStatus = $state('down');
  let counters: Counters | null = $state(null);
  let clockStr = $state('');

  // ── Clock ──────────────────────────────────────────────────────────────
  function formatClock(): string {
    const now = new Date();
    return now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  // ── Polling ────────────────────────────────────────────────────────────
  async function fetchHealth(): Promise<void> {
    if (document.visibilityState === 'hidden') return;
    try {
      const res = await fetch('/api/v5/health/services');
      if (!res.ok) {
        apiStatus = 'degraded';
        return;
      }
      const json: ServicesResponse = await res.json() as ServicesResponse;
      const svcs = json.services ?? json;
      apiStatus = svcs.api ?? 'up';
      wsStatus = svcs.ws ?? 'up';
      sseStatus = svcs.sse ?? 'up';
    } catch {
      apiStatus = 'down';
    }
  }

  async function fetchCounters(): Promise<void> {
    if (document.visibilityState === 'hidden') return;
    // NOTE: /api/v5/counters endpoint may not exist yet (flagged in PR).
    // Fallback: derive basic counts from /api/v5/cycles.
    try {
      const res = await fetch('/api/v5/counters');
      if (res.ok) {
        // Normalize the endpoint's shape (todaySpendUsd, no cyclesDay/Week/Month,
        // agents not provided) into the Counters shape StatusLine renders.
        const raw = await res.json() as Record<string, unknown>;
        counters = {
          agents: typeof raw['agentsActive'] === 'number' ? raw['agentsActive'] as number : 0,
          agentsActive: typeof raw['agentsActive'] === 'number' ? raw['agentsActive'] as number : 0,
          cyclesDay: 0,
          cyclesWeek: 0,
          cyclesMonth: 0,
          openBranches: typeof raw['openBranches'] === 'number' ? raw['openBranches'] as number : 0,
          pendingApprovals: typeof raw['pendingApprovals'] === 'number' ? raw['pendingApprovals'] as number : 0,
          runningCycles: typeof raw['runningCycles'] === 'number' ? raw['runningCycles'] as number : 0,
          todaySpend: typeof raw['todaySpendUsd'] === 'number' ? raw['todaySpendUsd'] as number : 0,
          load: (raw['load'] === 'idle' || raw['load'] === 'busy' || raw['load'] === 'overloaded') ? raw['load'] : '',
        };
        return;
      }
    } catch { /* fall through to derived path */ }

    // Fallback: build partial counters from /api/v5/cycles + /api/v5/agents
    try {
      const [cyclesRes, agentsRes] = await Promise.allSettled([
        fetch('/api/v5/cycles?limit=100'),
        fetch('/api/v5/agents'),
      ]);

      let cyclesDay = 0, cyclesWeek = 0, cyclesMonth = 0;
      if (cyclesRes.status === 'fulfilled' && cyclesRes.value.ok) {
        type CycleItem = { createdAt?: string };
        const body = await cyclesRes.value.json() as { data?: CycleItem[] };
        const items = body.data ?? [];
        const now = Date.now();
        const DAY = 86_400_000, WEEK = 7 * DAY, MONTH = 30 * DAY;
        for (const c of items) {
          const t = c.createdAt ? new Date(c.createdAt).getTime() : 0;
          const age = now - t;
          if (age < DAY) cyclesDay++;
          if (age < WEEK) cyclesWeek++;
          if (age < MONTH) cyclesMonth++;
        }
      }

      let agentCount = 0, agentsActive = 0;
      if (agentsRes.status === 'fulfilled' && agentsRes.value.ok) {
        type AgentItem = { status?: string };
        const body = await agentsRes.value.json() as { data?: AgentItem[]; meta?: { total: number } };
        agentCount = body.meta?.total ?? body.data?.length ?? 0;
        agentsActive = body.data?.filter((a) => a.status === 'active').length ?? 0;
      }

      counters = {
        agents: agentCount,
        agentsActive,
        cyclesDay,
        cyclesWeek,
        cyclesMonth,
        openBranches: 0,
        pendingApprovals: 0,
        todaySpend: 0,
        runningCycles: 0,
        load: '',
      };
    } catch {
      // Leave counters as null — render gracefully
    }
  }

  $effect(() => {
    clockStr = formatClock();
    const clockTimer = setInterval(() => { clockStr = formatClock(); }, 1000);

    void fetchHealth();
    void fetchCounters();

    const healthTimer = setInterval(() => void fetchHealth(), 7500);
    const countersTimer = setInterval(() => void fetchCounters(), 10_000);

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void fetchHealth();
        void fetchCounters();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(clockTimer);
      clearInterval(healthTimer);
      clearInterval(countersTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  // ── Colour helpers ─────────────────────────────────────────────────────
  function dotColor(s: ServiceStatus): string {
    if (s === 'up') return 'var(--af-success)';
    if (s === 'degraded') return 'var(--af-warning)';
    return 'var(--af-danger)';
  }
</script>

<div class="status-line font-mono" role="status" aria-label="System status">
  <div class="status-inner">
    <!-- Service dots -->
    <span class="svc-dot">
      <span class="dot" style="color:{dotColor(apiStatus)};" aria-hidden="true">●</span>
      <span class="svc-name">api</span>
    </span>
    <span class="svc-dot">
      <span class="dot" style="color:{dotColor(wsStatus)};" aria-hidden="true">●</span>
      <span class="svc-name">ws</span>
    </span>
    <span class="svc-dot">
      <span class="dot" style="color:{dotColor(sseStatus)};" aria-hidden="true">●</span>
      <span class="svc-name">sse</span>
    </span>

    <span class="divider" aria-hidden="true">│</span>

    {#if counters !== null}
      {@const k = counters}
      <span class="counter">
        <span class="counter-label">agents</span>
        <span class="counter-value">{k.agents}</span>
        <span class="counter-label">/</span>
        <span style="color:var(--af-purple);">{k.agentsActive}</span>
      </span>

      <span class="counter">
        <span class="counter-label">cycles</span>
        <span class="counter-value">{k.cyclesDay}</span><span class="counter-label">d</span>
        <span class="counter-value">{k.cyclesWeek}</span><span class="counter-label">w</span>
        <span class="counter-value">{k.cyclesMonth}</span><span class="counter-label">m</span>
      </span>

      {#if k.openBranches > 0}
        <span class="counter">
          <span class="counter-label">branches</span>
          <span class="counter-value">{k.openBranches}</span>
        </span>
      {/if}

      {#if k.pendingApprovals > 0}
        <span class="counter">
          <span class="counter-label">approvals</span>
          <span style="color:var(--af-warning);">{k.pendingApprovals}</span>
        </span>
      {/if}

      {#if k.todaySpend > 0}
        <span class="counter">
          <span class="counter-label">today</span>
          <span class="counter-value">${k.todaySpend.toFixed(2)}</span>
        </span>
      {/if}

      {#if k.load}
        <span class="counter">
          <span class="counter-label">load</span>
          <span class="counter-value" style="color:{k.load === 'overloaded' ? 'var(--af-danger)' : k.load === 'busy' ? 'var(--af-warning)' : 'var(--af-muted)'};">{k.load}</span>
        </span>
      {/if}
    {/if}

    <span class="spacer"></span>

    <!-- Clock -->
    <time class="clock" datetime={clockStr} aria-label="Local time">
      {clockStr}
    </time>
  </div>
</div>

<style>
  .status-line {
    grid-column: 1 / -1;
    grid-row: 2 / 3;
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--af-border);
    background: var(--af-surface);
    height: 22px;
    font-size: 10px;
    color: var(--af-muted);
    z-index: 19;
  }

  .status-inner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .svc-dot {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .dot {
    font-size: 8px;
    line-height: 1;
  }

  .svc-name {
    color: var(--af-muted);
  }

  .divider {
    color: var(--af-border3);
    flex-shrink: 0;
  }

  .counter {
    display: flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .counter-label {
    color: var(--af-dim);
  }

  .counter-value {
    color: var(--af-text);
  }

  .spacer {
    flex: 1;
  }

  .clock {
    color: var(--af-faint);
    letter-spacing: 0.02em;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .font-mono {
    font-family: 'JetBrains Mono', monospace;
    font-feature-settings: 'tnum' 1;
    font-variant-numeric: tabular-nums;
  }
</style>
