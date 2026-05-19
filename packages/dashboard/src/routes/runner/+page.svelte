<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Btn, Badge, Card, PulseDot } from '$lib/components/v2';
  import type { PageData } from './$types';

  // MODEL_TIER_META maps persisted tier keys to Codex-facing display metadata.
  const MODEL_TIER_META: Record<string, { label: string; range: string; color: string }> = {
    opus:   { label: 'xhigh profile',  range: '$0.015–$0.075',  color: 'var(--af-opus)' },
    sonnet: { label: 'high profile',   range: '$0.003–$0.015',  color: 'var(--af-sonnet)' },
    haiku:  { label: 'medium profile', range: '$0.0003–$0.002', color: 'var(--af-haiku)' },
  };

  const SONNET_TIER = { label: 'high profile', range: '$0.003–$0.015', color: 'var(--af-sonnet)' };

  interface AgentEntry {
    agentId: string;
    name: string;
    model: 'opus' | 'sonnet' | 'haiku';
  }

  interface RunHistory {
    id: string;
    agentId: string;
    task: string;
    status: 'completed' | 'failed' | 'running';
    costUsd?: number;
    startedAt: string;
    output?: string;
    sessionId?: string;
    providerKind?: string;
    runtimeModeResolved?: string;
    model?: string;
  }

  interface StreamEnvelope {
    type?: string;
    category?: string;
    message?: string;
    data?: Record<string, unknown>;
    timestamp?: string;
  }

  // Server-loaded data: agents are pre-fetched from .agentforge/agents/*.yaml
  // at SSR time so the agent selector is populated on first render without
  // waiting for the external backend API.
  let { data }: { data: PageData } = $props();

  // Compute all initial values from server data before the first $state() call
  // so Svelte's linter doesn't warn about "only captures initial value of data".
  // These are plain JS constants — no reactivity needed for the seed step.
  const _ssrAgents: AgentEntry[] = (data as { agents?: AgentEntry[] }).agents ?? [];
  const _defaultAgent: string =
    _ssrAgents.find(a => a.agentId === 'coder')?.agentId ??
    _ssrAgents[0]?.agentId ??
    'coder';

  let agentEntries: AgentEntry[] = $state(_ssrAgents);
  // Only show the loading spinner if the SSR pass produced no agents.
  let agentsLoading = $state(_ssrAgents.length === 0);
  let agentsLoadError: string | null = $state(null);
  // Prefer 'coder' if available in the SSR list; otherwise use the first agent.
  let selectedAgent = $state(_defaultAgent);
  let agentSearch = $state('');
  let taskInput = $state('');
  let running = $state(false);
  let runAccepted = $state(false);
  let runError: string | null = $state(null);
  // FALLBACK_AGENTS error state — preserved from Wave 2C
  let apiUnavailable = $state(false);

  let output = $state('');
  let outputAgentName = $state('');
  let outputModel = $state('');
  let outputProviderKind = $state('');
  let outputRuntimeMode = $state('');
  let outputTimestamp = $state('');
  let firstTokenLatencyMs: number | null = $state(null);
  let streamConnected = $state(false);
  let streamWarning: string | null = $state(null);
  let outputAutoscrollPaused = $state(false);
  let copyStatus: string | null = $state(null);
  let currentSessionId: string | null = $state(null);

  let history: RunHistory[] = $state([]);
  let selectedHistoryRun: RunHistory | null = $state(null);

  let eventSource: EventSource | null = null;
  let outputEl: HTMLPreElement | null = $state(null);
  let runStartedAtMs: number | null = null;
  let currentRunOutput = '';
  let copyStatusTimer: ReturnType<typeof setTimeout> | null = null;

  function requestedAgentFromQuery(): string | null {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('agentId') ?? params.get('agent');
  }

  function applyRequestedAgent(): void {
    const requested = requestedAgentFromQuery();
    if (requested && agentEntries.some((a) => a.agentId === requested)) {
      selectedAgent = requested;
      agentSearch = '';
    }
  }

  function getAgentModel(id: string): 'opus' | 'sonnet' | 'haiku' {
    const entry = agentEntries.find((a) => a.agentId === id);
    return entry?.model ?? 'sonnet';
  }

  function agentTierLabel(tier: 'opus' | 'sonnet' | 'haiku'): string {
    if (tier === 'opus') return 'XHIGH';
    if (tier === 'haiku') return 'MED';
    return 'HIGH';
  }

  let modelTier = $derived(MODEL_TIER_META[getAgentModel(selectedAgent)] ?? SONNET_TIER);

  let filteredAgents = $derived.by(() => {
    const q = agentSearch.toLowerCase().trim();
    const filtered = q
      ? agentEntries.filter((a) => a.agentId.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      : agentEntries;
    const tierOrder: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2 };
    return [...filtered].sort(
      (a, b) => (tierOrder[a.model] ?? 1) - (tierOrder[b.model] ?? 1) || a.agentId.localeCompare(b.agentId),
    );
  });

  let runStatusLabel = $derived.by(() => {
    if (!running) return '';
    if (streamWarning) return 'Stream reconnecting';
    if (!streamConnected) return 'Opening stream';
    if (runAccepted && firstTokenLatencyMs === null) return 'Run accepted';
    if (firstTokenLatencyMs !== null) return 'Streaming output';
    return 'Starting run';
  });

  let agentCountByTier = $derived({
    opus:   agentEntries.filter((a) => a.model === 'opus').length,
    sonnet: agentEntries.filter((a) => a.model === 'sonnet').length,
    haiku:  agentEntries.filter((a) => a.model === 'haiku').length,
  });

  async function loadAgents() {
    // Only show the loading spinner when there are no agents from SSR.
    // If SSR already populated agentEntries, this is a background refresh.
    if (agentEntries.length === 0) agentsLoading = true;
    agentsLoadError = null;
    try {
      const res = await fetch('/api/v5/agents');
      if (!res.ok) {
        // Only surface an error if we have no agents to show (SSR fallback covers the rest).
        if (agentEntries.length === 0) {
          agentsLoadError = `Unable to load agents — server returned ${res.status}`;
        }
        return;
      }
      const json = await res.json();
      const list = json.data ?? json.agents ?? json ?? [];
      const loaded: AgentEntry[] = (list as Record<string, unknown>[])
        .map((a) => ({
          agentId: (a.agentId ?? a.id ?? '') as string,
          name:    (a.name ?? a.agentId ?? a.id ?? '') as string,
          model:   (a.model ?? 'sonnet') as 'opus' | 'sonnet' | 'haiku',
        }))
        .filter((a) => a.agentId);
      if (loaded.length === 0) {
        if (agentEntries.length === 0) {
          agentsLoadError = 'No agents found — check that .agentforge/agents/ contains YAML files';
        }
        // Keep existing SSR-loaded agents rather than replacing with empty list.
      } else {
        agentEntries = loaded;
        const requestedAgent = requestedAgentFromQuery();
        // Keep the selected agent if it still exists in the refreshed list;
        // otherwise, fall back to 'coder' or the first available agent.
        if (requestedAgent && agentEntries.find(a => a.agentId === requestedAgent)) {
          selectedAgent = requestedAgent;
        } else if (!agentEntries.find(a => a.agentId === selectedAgent)) {
          selectedAgent =
            agentEntries.find(a => a.agentId === 'coder')?.agentId ??
            agentEntries[0]?.agentId ??
            selectedAgent;
        }
      }
    } catch {
      if (agentEntries.length === 0) {
        agentsLoadError = 'Unable to load agents — retry';
      }
    } finally {
      agentsLoading = false;
    }
  }

  function wireSSE(es: EventSource, sessionId: string) {
    es.onopen = () => { streamConnected = true; streamWarning = null; };
    es.onmessage = (e) => {
      const envelope = parseStreamMessage(e.data);
      if (envelope) processStreamEnvelope(envelope, sessionId, es);
    };
    es.onerror = () => {
      streamConnected = false;
      streamWarning = running ? 'Live stream interrupted; reconnecting automatically.' : 'Live stream interrupted.';
    };
  }

  function parseStreamMessage(raw: string): StreamEnvelope | null {
    try { return JSON.parse(raw) as StreamEnvelope; } catch { return null; }
  }

  function processStreamEnvelope(envelope: StreamEnvelope, sessionId: string, es?: EventSource) {
    const payload = envelope.data ?? {};
    if (payload['sessionId'] !== sessionId) return;
    updateRunMetadata(payload);

    if (envelope.type === 'agent_activity') {
      const chunk: string =
        (payload['content'] as string | undefined) ??
        (payload['chunk'] as string | undefined) ??
        '';
      appendOutputChunk(chunk);
      return;
    }

    if (envelope.type !== 'workflow_event') return;
    const status = payload['status'] as string | undefined;
    if (status !== 'completed' && status !== 'failed') return;

    running = false;
    runAccepted = false;
    streamWarning = null;
    syncHistoryStatus(sessionId, status, payload['costUsd'] as number | undefined, payload['providerKind'] as string | undefined, payload['runtimeModeResolved'] as string | undefined);

    if (status === 'failed' && typeof payload['error'] === 'string') { runError = payload['error']; }
    es?.close();
    if (eventSource === es) eventSource = null;
    streamConnected = false;
  }

  function updateRunMetadata(payload: Record<string, unknown>) {
    if (typeof payload['model'] === 'string') outputModel = modelIdToTierLabel(payload['model'], outputAgentName || selectedAgent);
    if (typeof payload['providerKind'] === 'string') outputProviderKind = formatProviderKind(payload['providerKind']);
    if (typeof payload['runtimeModeResolved'] === 'string') outputRuntimeMode = formatRuntimeMode(payload['runtimeModeResolved']);
  }

  function appendOutputChunk(chunk: string) {
    if (!chunk) return;
    if (firstTokenLatencyMs === null && runStartedAtMs !== null) {
      firstTokenLatencyMs = Math.max(0, Date.now() - runStartedAtMs);
    }
    currentRunOutput += chunk;
    if (selectedHistoryRun) return;
    output += chunk;
    if (!outputAutoscrollPaused) requestAnimationFrame(scrollOutput);
  }

  function scrollOutput() { if (outputEl) outputEl.scrollTop = outputEl.scrollHeight; }

  function handleOutputScroll() {
    if (!outputEl) return;
    const atBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 48;
    outputAutoscrollPaused = !atBottom;
  }

  function resumeOutputAutoscroll() { outputAutoscrollPaused = false; requestAnimationFrame(scrollOutput); }

  function syncHistoryStatus(sessionId: string, status: 'completed' | 'failed', cost?: number, providerKind?: string, runtimeModeResolved?: string) {
    history = history.map((r) => {
      if (r.sessionId !== sessionId) return r;
      return {
        ...r,
        status,
        ...(cost !== undefined ? { costUsd: cost } : {}),
        ...(providerKind ? { providerKind } : {}),
        ...(runtimeModeResolved ? { runtimeModeResolved } : {}),
        output: currentRunOutput || output,
      };
    });
  }

  async function handleRun() {
    if (!taskInput.trim() || running) return;
    runError = null;
    apiUnavailable = false;
    running = true;
    runAccepted = false;
    output = '';
    currentRunOutput = '';
    outputAgentName = selectedAgent;
    outputProviderKind = '';
    outputRuntimeMode = '';
    outputTimestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    firstTokenLatencyMs = null;
    streamConnected = false;
    streamWarning = null;
    outputAutoscrollPaused = false;
    copyStatus = null;
    runStartedAtMs = Date.now();
    selectedHistoryRun = null;

    if (eventSource) { eventSource.close(); eventSource = null; }
    const es = new EventSource('/api/v5/stream');
    eventSource = es;

    const earlyBuffer: StreamEnvelope[] = [];
    let resolvedSessionId: string | null = null;

    es.onopen = () => { streamConnected = true; streamWarning = null; };
    es.onmessage = (e) => {
      const envelope = parseStreamMessage(e.data);
      if (!envelope) return;
      if (resolvedSessionId === null) { earlyBuffer.push(envelope); return; }
      processStreamEnvelope(envelope, resolvedSessionId, es);
    };
    es.onerror = () => {
      streamConnected = false;
      streamWarning = 'Live stream interrupted; reconnecting automatically. Run may still be active.';
    };

    try {
      const res = await fetch('/api/v5/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgent, task: taskInput, runtimeMode: 'codex-cli' }),
      });

      if (res.status === 404) {
        // FALLBACK_AGENTS error state — Wave 2C preserved behavior
        apiUnavailable = true;
        running = false;
        es.close();
        eventSource = null;
        return;
      }

      if (!res.ok) {
        const err = await res.text().catch(() => `HTTP ${res.status}`);
        runError = err || `HTTP ${res.status}`;
        running = false;
        es.close();
        eventSource = null;
        return;
      }

      const envelope = await res.json();
      const json = envelope.data ?? envelope;
      const sessionId: string = json.sessionId ?? json.id ?? `local-${Date.now()}`;
      runAccepted = res.status === 202 || json.status === 'accepted' || json.status === 'running';
      outputModel = json.model ? modelIdToTierLabel(json.model as string, selectedAgent) : (MODEL_TIER_META[getAgentModel(selectedAgent)]?.label ?? 'high profile');
      outputProviderKind = formatProviderKind(json.providerKind as string | undefined);
      outputRuntimeMode  = formatRuntimeMode(json.runtimeModeResolved as string | undefined);
      currentSessionId = sessionId;

      const historyEntry: RunHistory = {
        id: sessionId,
        agentId: selectedAgent,
        task: taskInput,
        status: 'running',
        startedAt: new Date().toISOString(),
        sessionId,
        ...(typeof json.model === 'string' ? { model: json.model } : {}),
        ...(typeof json.providerKind === 'string' ? { providerKind: json.providerKind } : {}),
        ...(typeof json.runtimeModeResolved === 'string' ? { runtimeModeResolved: json.runtimeModeResolved } : {}),
      };
      history = [historyEntry, ...history].slice(0, 5);

      resolvedSessionId = sessionId;
      for (const buffered of earlyBuffer) { processStreamEnvelope(buffered, sessionId, es); }
      if (output) requestAnimationFrame(scrollOutput);

      wireSSE(es, sessionId);

      const syncOutput = json.response ?? json.output;
      if (syncOutput) {
        output = syncOutput;
        currentRunOutput = syncOutput;
        if (firstTokenLatencyMs === null && runStartedAtMs !== null) firstTokenLatencyMs = Math.max(0, Date.now() - runStartedAtMs);
        running = false;
        runAccepted = false;
        syncHistoryStatus(sessionId, json.status === 'failed' ? 'failed' : 'completed', json.costUsd, json.providerKind as string | undefined, json.runtimeModeResolved as string | undefined);
        es.close();
        eventSource = null;
        streamConnected = false;
      }
    } catch (e) {
      runError = String(e);
      running = false;
      runAccepted = false;
      es.close();
      eventSource = null;
      streamConnected = false;
    }
  }

  function showHistoryRun(run: RunHistory) {
    selectedHistoryRun = run;
    currentRunOutput = '';
    output = run.output || '(No output captured)';
    outputAgentName = run.agentId;
    outputTimestamp = new Date(run.startedAt).toLocaleTimeString('en-US', { hour12: false });
    outputModel = run.model ? modelIdToTierLabel(run.model, run.agentId) : (MODEL_TIER_META[getAgentModel(run.agentId)]?.label ?? '—');
    outputProviderKind = formatProviderKind(run.providerKind);
    outputRuntimeMode  = formatRuntimeMode(run.runtimeModeResolved);
    currentSessionId = run.sessionId ?? null;
  }

  function modelIdToTierLabel(modelId: string, agentId?: string): string {
    const lower = modelId.toLowerCase();
    if (lower.includes('codex')) return MODEL_TIER_META[getAgentModel(agentId ?? selectedAgent)]?.label ?? 'high profile';
    if (lower.includes('opus'))  return 'xhigh profile';
    if (lower.includes('haiku')) return 'medium profile';
    return 'high profile';
  }

  function formatCost(cost?: number): string {
    if (cost == null) return '—';
    return `$${cost.toFixed(4)}`;
  }

  function formatProviderKind(providerKind?: string): string {
    if (!providerKind) return '';
    if (providerKind === 'codex-cli') return 'Codex CLI';
    if (providerKind === 'openai-sdk') return 'OpenAI SDK';
    if (providerKind === 'anthropic-sdk') return 'Anthropic SDK';
    if (providerKind === 'claude-code-compat') return 'Claude CLI compat';
    return providerKind;
  }

  function formatRuntimeMode(runtimeMode?: string): string {
    if (!runtimeMode) return '';
    if (runtimeMode === 'codex-cli') return 'Codex CLI';
    if (runtimeMode === 'openai-sdk') return 'OpenAI SDK';
    if (runtimeMode === 'anthropic-sdk') return 'Anthropic SDK';
    if (runtimeMode === 'claude-code-compat') return 'Claude CLI compat';
    return runtimeMode.toUpperCase();
  }

  function formatTime(iso: string): string {
    try { return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  }

  function formatLatency(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  }

  async function copyOutput() {
    if (!output) return;
    try { await navigator.clipboard.writeText(output); copyStatus = 'Copied'; }
    catch { copyStatus = 'Copy failed'; }
    if (copyStatusTimer) clearTimeout(copyStatusTimer);
    copyStatusTimer = setTimeout(() => { copyStatus = null; copyStatusTimer = null; }, 1600);
  }

  function clearOutput() {
    output = '';
    selectedHistoryRun = null;
    outputAutoscrollPaused = false;
    copyStatus = null;
    if (!running) {
      currentRunOutput = '';
      outputAgentName = '';
      outputModel = '';
      outputProviderKind = '';
      outputRuntimeMode = '';
      outputTimestamp = '';
      currentSessionId = null;
      firstTokenLatencyMs = null;
      runAccepted = false;
      streamWarning = null;
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/v5/run/history');
      if (!res.ok) return;
      const json = await res.json();
      const runs: RunHistory[] = (json.data ?? []).map((r: Record<string, unknown>) => ({
        id:        (r.sessionId ?? r.id ?? '') as string,
        agentId:   (r.agentId ?? '') as string,
        task:      (r.task ?? '') as string,
        status:    (r.status ?? 'completed') as RunHistory['status'],
        costUsd:   typeof r.costUsd === 'number' ? r.costUsd : undefined,
        startedAt: (r.startedAt ?? new Date().toISOString()) as string,
        output:    typeof r.response === 'string' && r.response ? r.response
                 : typeof r.output === 'string' && r.output ? r.output
                 : undefined,
        sessionId: (r.sessionId ?? r.id ?? '') as string,
        model:     typeof r.model === 'string' ? r.model : undefined,
        providerKind:        typeof r.providerKind === 'string' ? r.providerKind : undefined,
        runtimeModeResolved: typeof r.runtimeModeResolved === 'string' ? r.runtimeModeResolved : undefined,
      })).filter((r: RunHistory) => r.id && r.agentId);
      history = runs.slice(0, 5);
    } catch { /* non-fatal */ }
  }

  onMount(() => {
    // Load from the API when the SSR pass had no agents (e.g., agents dir
    // missing at server start) or to refresh a stale list after navigation.
    // When SSR already populated agentEntries, skip the blocking API call and
    // just load the run history.
    applyRequestedAgent();
    if (agentEntries.length === 0) loadAgents();
    loadHistory();
  });

  onDestroy(() => {
    if (eventSource) eventSource.close();
    if (copyStatusTimer) clearTimeout(copyStatusTimer);
  });

  function historyBadgeVariant(status: string): 'success' | 'danger' | 'warning' {
    if (status === 'completed') return 'success';
    if (status === 'failed')    return 'danger';
    return 'warning';
  }
</script>

<svelte:head><title>Agent Runner — AgentForge</title></svelte:head>

<!-- ── Page header ──────────────────────────────────────────────────────── -->
<div class="page-header">
  <div>
    <h1 class="page-title">Agent Runner</h1>
    <p class="page-sub">Trigger Codex CLI agent runs and observe real-time output</p>
  </div>
  {#if running}
    <div class="running-pill running-indicator">
      <PulseDot color="var(--af-purple)" size={6} />
      <span class="af2-mono" style="font-size:11px;color:var(--af-purple)">
        {outputAgentName} · {runStatusLabel}
      </span>
    </div>
  {/if}
</div>

<!-- ── Two-column layout ─────────────────────────────────────────────────── -->
<div class="runner-layout">

  <!-- ── Left panel ──────────────────────────────────────────────────────── -->
  <div class="left-col">

    <!-- Run config card -->
    <Card>
      <div class="section-title">RUN CONFIGURATION</div>

      <!-- Agent selector -->
      <div class="field" style="margin-top:12px">
        <label class="field-label" for="agent-select">
          Agent ({agentEntries.length} available)
        </label>
        {#if agentsLoading}
          <div class="skeleton" style="height:32px;border-radius:6px;"></div>
        {:else if agentsLoadError}
          <div class="error-callout">
            <span class="error-msg">{agentsLoadError}</span>
            <Btn size="sm" onClick={loadAgents} disabled={running}>Retry</Btn>
          </div>
        {:else}
          <input
            type="search"
            class="field-search af2-mono"
            placeholder="Filter agents…"
            bind:value={agentSearch}
            disabled={running}
          />
          <select
            id="agent-select"
            class="field-select af2-mono"
            bind:value={selectedAgent}
            disabled={running}
            size={Math.min(Math.max(filteredAgents.length, 1), 8)}
          >
            {#each filteredAgents as agent (agent.agentId)}
              <option value={agent.agentId}>
                [{agentTierLabel(agent.model)}] {agent.agentId}
              </option>
            {/each}
          </select>
          <div class="tier-row">
            <span class="tier-chip opus af2-mono">{agentCountByTier.opus} xhigh</span>
            <span class="tier-chip sonnet af2-mono">{agentCountByTier.sonnet} high</span>
            <span class="tier-chip haiku af2-mono">{agentCountByTier.haiku} medium</span>
          </div>
        {/if}
      </div>

      <!-- Cost preview callout -->
      {#if agentEntries.length > 0 && !agentsLoadError}
        <div class="cost-callout" style="--tier-clr:{modelTier.color}">
          <span class="profile-chip af2-mono">{modelTier.label}</span>
          <span class="af2-mono cost-range">est. {modelTier.range} per run</span>
        </div>
      {/if}

      <!-- Task textarea -->
      <div class="field" style="margin-top:14px">
        <label class="field-label" for="task-input">Task</label>
        <textarea
          id="task-input"
          class="field-textarea"
          rows={4}
          placeholder="Describe what you want the agent to do… (Ctrl+Enter to run)"
          bind:value={taskInput}
          disabled={running}
          onkeydown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleRun();
            }
          }}
        ></textarea>
      </div>

      <!-- Error / unavailable banners -->
      {#if runError}
        <div class="banner banner--danger" style="margin-bottom:10px">{runError}</div>
      {/if}

      {#if apiUnavailable}
        <div class="banner banner--warn" style="margin-bottom:10px">
          Execution API not available — <code>/api/v5/run</code> returned 404.
          The server may not have this endpoint deployed yet.
        </div>
      {/if}

      <!-- Run button -->
      <Btn
        variant="purple"
        size="lg"
        disabled={running || !taskInput.trim() || !!agentsLoadError || agentEntries.length === 0}
        onClick={handleRun}
        class="run-btn"
      >
        {#if running}
          <span class="spinner"></span>
          Running…
        {:else}
          ▶ Run Agent
        {/if}
      </Btn>
    </Card>

    <!-- Recent runs card -->
    <Card>
      <div class="card-header-row">
        <span class="section-title">RECENT RUNS</span>
        <span class="af2-mono" style="font-size:10px;color:var(--af-faint)">{history.length}</span>
      </div>

      {#if history.length === 0}
        <div class="empty-inline">No runs yet this session</div>
      {:else}
        <div class="history-list">
          {#each history as run (run.id)}
            <button
              class="history-item"
              class:history-item--active={selectedHistoryRun?.id === run.id}
              onclick={() => showHistoryRun(run)}
            >
              <div class="history-item-top">
                <span class="af2-mono history-agent">{run.agentId}</span>
                <Badge variant={historyBadgeVariant(run.status)}>{run.status}</Badge>
              </div>
              <div class="history-task">{run.task.slice(0, 60)}{run.task.length > 60 ? '…' : ''}</div>
              <div class="history-meta af2-mono">
                <span>{formatTime(run.startedAt)}</span>
                <span>{formatCost(run.costUsd)}</span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </Card>
  </div>

  <!-- ── Right panel: live output ────────────────────────────────────────── -->
  <div class="right-col">
    <Card noPad style="display:flex;flex-direction:column;min-height:calc(100vh - 180px)">
      <!-- Output card header -->
      <div class="output-header">
        <div class="output-header-left">
          <div class="output-title-row">
            <span class="section-title">LIVE OUTPUT</span>
            {#if runAccepted}
              <Badge variant="warning">Accepted</Badge>
            {/if}
          </div>
          {#if outputAgentName}
            <div class="output-meta">
              <span class="af2-mono" style="font-size:11px;color:var(--af-muted)">{outputAgentName}</span>
              {#if outputModel}
                <span class="profile-chip af2-mono">{outputModel}</span>
              {/if}
              {#if outputProviderKind}
                <Badge variant="muted">{outputProviderKind}</Badge>
              {:else if running}
                <Badge variant="muted">Provider pending</Badge>
              {/if}
              {#if outputRuntimeMode}
                <Badge variant="muted">{outputRuntimeMode}</Badge>
              {:else if running}
                <Badge variant="muted">Runtime pending</Badge>
              {/if}
              {#if outputTimestamp}
                <span class="af2-mono" style="font-size:10px;color:var(--af-faint)">{outputTimestamp}</span>
              {/if}
            </div>
          {/if}
        </div>
        <div class="output-header-right output-actions">
          {#if firstTokenLatencyMs !== null}
            <span class="latency-pill af2-mono">First token {formatLatency(firstTokenLatencyMs)}</span>
          {:else if running}
            <span class="latency-pill latency-pill--pending af2-mono">Waiting for first token</span>
          {/if}
          <Btn size="sm" disabled={!output} onClick={copyOutput}>{copyStatus ?? 'Copy'}</Btn>
          <Btn size="sm" disabled={!output && !runError} onClick={clearOutput}>Clear</Btn>
        </div>
      </div>

      <!-- Stream warning -->
      {#if streamWarning}
        <div class="banner banner--warn stream-warning" style="margin:0 16px 12px">
          {streamWarning}
        </div>
      {/if}

      <!-- Autoscroll paused -->
      {#if outputAutoscrollPaused && running}
        <button class="resume-scroll" onclick={resumeOutputAutoscroll}>
          Autoscroll paused · Jump to latest
        </button>
      {/if}

      <!-- Output content -->
      {#if !output && running}
        <div class="output-empty" style="flex:1">
          <span class="empty-icon">…</span>
          <p>{runAccepted ? 'Run accepted by server.' : 'Starting run.'}</p>
          <p class="empty-sub">Waiting for the first streamed token via SSE.</p>
        </div>
      {:else if !output && !running}
        <div class="output-empty" style="flex:1">
          <span class="empty-icon">▶</span>
          <p>Configure an agent and task, then click <strong>Run Agent</strong>.</p>
          <p class="empty-sub">Output streams here in real time via SSE.</p>
        </div>
      {:else}
        <pre
          class="output-pre af2-mono"
          bind:this={outputEl}
          onscroll={handleOutputScroll}
        >{output}{#if running}<span class="cursor">▊</span>{/if}</pre>
      {/if}
    </Card>
  </div>
</div>

<style>
  /* ── Page header ──────────────────────────────────────────────────────── */
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
    gap: 16px;
  }

  .page-title {
    font-size: 20px;
    font-weight: 600;
    color: var(--af-text);
    margin: 0 0 4px;
  }

  .page-sub {
    font-size: 12px;
    color: var(--af-dim);
    margin: 0;
  }

  .running-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    background: color-mix(in srgb, var(--af-purple) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-purple) 25%, transparent);
    border-radius: 99px;
    padding: 6px 12px;
  }

  /* ── Layout ───────────────────────────────────────────────────────────── */
  .runner-layout {
    display: grid;
    grid-template-columns: 360px 1fr;
    gap: 14px;
    align-items: start;
  }

  .left-col {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* ── Section title ────────────────────────────────────────────────────── */
  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
  }

  .card-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  /* ── Form fields ──────────────────────────────────────────────────────── */
  .field {
    margin-bottom: 14px;
  }

  .field-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  .field-search,
  .field-select,
  .field-textarea {
    width: 100%;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    padding: 6px 10px;
    font-size: 12px;
    box-sizing: border-box;
    outline: none;
    transition: border-color 150ms;
  }

  .field-search:focus,
  .field-select:focus,
  .field-textarea:focus { border-color: var(--af-purple); }

  .field-search:disabled,
  .field-select:disabled,
  .field-textarea:disabled { opacity: 0.5; cursor: not-allowed; }

  .field-search {
    margin-bottom: 6px;
    font-family: var(--af-font-mono, monospace);
  }

  .field-search::placeholder,
  .field-textarea::placeholder { color: var(--af-faint); }

  .field-textarea {
    resize: vertical;
    min-height: 96px;
    line-height: 1.5;
  }

  .field-select {
    cursor: pointer;
    font-family: var(--af-font-mono, monospace);
  }

  /* ── Tier chips ───────────────────────────────────────────────────────── */
  .tier-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }

  .tier-chip {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 99px;
    border: 1px solid;
  }

  .tier-chip.opus   { color: var(--af-opus);   border-color: color-mix(in srgb,var(--af-opus) 35%,transparent);   background: color-mix(in srgb,var(--af-opus) 8%,transparent); }
  .tier-chip.sonnet { color: var(--af-sonnet); border-color: color-mix(in srgb,var(--af-sonnet) 35%,transparent); background: color-mix(in srgb,var(--af-sonnet) 8%,transparent); }
  .tier-chip.haiku  { color: var(--af-haiku);  border-color: color-mix(in srgb,var(--af-haiku) 35%,transparent);  background: color-mix(in srgb,var(--af-haiku) 8%,transparent); }

  .profile-chip {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 7px;
    border-radius: 99px;
    border: 1px solid color-mix(in srgb, var(--tier-clr, var(--af-purple)) 35%, transparent);
    background: color-mix(in srgb, var(--tier-clr, var(--af-purple)) 8%, transparent);
    color: var(--tier-clr, var(--af-purple));
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
  }

  /* ── Cost callout ─────────────────────────────────────────────────────── */
  .cost-callout {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--tier-clr) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--tier-clr) 25%, transparent);
    border-radius: 6px;
    margin-bottom: 14px;
  }

  .cost-range {
    font-size: 11px;
    color: var(--af-dim);
  }

  /* ── Run button ───────────────────────────────────────────────────────── */
  :global(.run-btn) {
    width: 100% !important;
    justify-content: center !important;
  }

  /* ── Error callout ────────────────────────────────────────────────────── */
  .error-callout {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 25%, transparent);
    border-radius: 6px;
    font-size: 12px;
    margin-bottom: 8px;
  }

  .error-msg { flex: 1; color: var(--af-danger); }

  /* ── Banners ──────────────────────────────────────────────────────────── */
  .banner {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    border: 1px solid;
    line-height: 1.5;
  }

  .banner--danger {
    color: var(--af-danger);
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border-color: color-mix(in srgb, var(--af-danger) 25%, transparent);
  }

  .banner--warn {
    color: var(--af-warning);
    background: color-mix(in srgb, var(--af-warning) 8%, transparent);
    border-color: color-mix(in srgb, var(--af-warning) 25%, transparent);
  }

  .banner--warn code {
    font-family: var(--af-font-mono, monospace);
    background: color-mix(in srgb, var(--af-warning) 15%, transparent);
    padding: 1px 4px;
    border-radius: 3px;
  }

  /* ── History list ─────────────────────────────────────────────────────── */
  .empty-inline {
    font-size: 12px;
    color: var(--af-faint);
    padding: 16px 0;
    text-align: center;
  }

  .history-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
  }

  .history-item {
    width: 100%;
    text-align: left;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 10px;
    cursor: pointer;
    transition: border-color 150ms, background 150ms;
    color: var(--af-text);
  }

  .history-item:hover { border-color: var(--af-border3); }

  .history-item--active {
    border-color: var(--af-purple);
    background: color-mix(in srgb, var(--af-purple) 6%, transparent);
  }

  .history-item-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .history-agent { font-size: 11px; font-weight: 700; }

  .history-task {
    font-size: 11px;
    color: var(--af-muted);
    line-height: 1.4;
    margin-bottom: 4px;
  }

  .history-meta {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--af-faint);
  }

  /* ── Output card ──────────────────────────────────────────────────────── */
  .output-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--af-border);
  }

  .output-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .output-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .output-header-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .latency-pill {
    font-size: 10px;
    color: var(--af-success);
    border: 1px solid color-mix(in srgb, var(--af-success) 30%, transparent);
    background: color-mix(in srgb, var(--af-success) 8%, transparent);
    border-radius: 99px;
    padding: 2px 8px;
    white-space: nowrap;
  }

  .latency-pill--pending {
    color: var(--af-dim);
    border-color: var(--af-border2);
    background: transparent;
  }

  .resume-scroll {
    position: absolute;
    right: 24px;
    bottom: 24px;
    z-index: 2;
    background: var(--af-purple);
    color: #fff;
    border: none;
    border-radius: 99px;
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }

  /* ── Output content ───────────────────────────────────────────────────── */
  .output-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    color: var(--af-dim);
  }

  .empty-icon { font-size: 28px; opacity: 0.2; }

  .output-empty p { margin: 0; font-size: 12px; text-align: center; }

  .empty-sub { font-size: 11px; color: var(--af-faint); }

  .output-pre {
    flex: 1;
    margin: 0;
    padding: 14px 18px;
    font-size: 12px;
    color: var(--af-muted);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-y: auto;
    max-height: calc(100vh - 260px);
    line-height: 1.7;
  }

  .cursor {
    display: inline-block;
    animation: blink 1s step-end infinite;
    color: var(--af-purple);
  }

  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

  /* ── Spinner ──────────────────────────────────────────────────────────── */
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .skeleton {
    background: var(--af-surface2);
    animation: shimmer 1.4s infinite;
  }

  @keyframes shimmer {
    0%   { opacity: 0.5; }
    50%  { opacity: 0.8; }
    100% { opacity: 0.5; }
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }

  @media (max-width: 900px) {
    .runner-layout { grid-template-columns: 1fr; }
  }
</style>
