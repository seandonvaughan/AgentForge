<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  const FALLBACK_AGENTS = [
    'ceo', 'cto', 'architect', 'coder', 'debugger',
    'api-specialist', 'researcher', 'project-manager',
  ];

  const MODEL_TIER_META: Record<string, { label: string; range: string; color: string }> = {
    opus:   { label: 'Opus',   range: '$0.015-$0.075',  color: 'var(--color-opus)' },
    sonnet: { label: 'Sonnet', range: '$0.003-$0.015',  color: 'var(--color-sonnet)' },
    haiku:  { label: 'Haiku',  range: '$0.0003-$0.002', color: 'var(--color-haiku)' },
  };

  // A guaranteed-non-undefined fallback for MODEL_TIER_META lookups
  const SONNET_TIER = { label: 'Sonnet', range: '$0.003-$0.015', color: 'var(--color-sonnet)' };

  interface AgentEntry {
    agentId: string;
    name: string;
    model: 'opus' | 'sonnet' | 'haiku';
  }

  /** Fallback AgentEntry list when the server is unreachable or returns nothing. */
  const FALLBACK_ENTRIES: AgentEntry[] = FALLBACK_AGENTS.map(id => ({
    agentId: id,
    name: id,
    model: 'sonnet' as const,
  }));

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
  }

  let agentEntries: AgentEntry[] = $state([]);
  let agentsLoading = $state(true);
  let selectedAgent = $state('coder');
  let agentSearch = $state('');
  let taskInput = $state('');
  let running = $state(false);
  let runError: string | null = $state(null);
  let apiUnavailable = $state(false);

  let output = $state('');
  let outputAgentName = $state('');
  let outputModel = $state('');
  let outputProviderKind = $state('');
  let outputRuntimeMode = $state('');
  let outputTimestamp = $state('');
  let currentSessionId: string | null = $state(null);

  let history: RunHistory[] = $state([]);
  let selectedHistoryRun: RunHistory | null = $state(null);

  let eventSource: EventSource | null = null;
  let outputEl: HTMLPreElement | null = $state(null);

  // Derived: look up model tier from the full agent roster
  function getAgentModel(id: string): 'opus' | 'sonnet' | 'haiku' {
    const entry = agentEntries.find(a => a.agentId === id);
    return entry?.model ?? 'sonnet';
  }

  // Use a concrete fallback so TypeScript knows modelTier is always defined
  let modelTier = $derived(MODEL_TIER_META[getAgentModel(selectedAgent)] ?? SONNET_TIER);

  // Derived: agents filtered by search, grouped by model tier
  let filteredAgents = $derived.by(() => {
    const q = agentSearch.toLowerCase().trim();
    const filtered = q
      ? agentEntries.filter(a => a.agentId.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      : agentEntries;

    // Group by model tier: opus first, then sonnet, then haiku
    const tierOrder: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2 };
    return [...filtered].sort((a, b) =>
      (tierOrder[a.model] ?? 1) - (tierOrder[b.model] ?? 1) || a.agentId.localeCompare(b.agentId)
    );
  });

  let agentCountByTier = $derived({
    opus: agentEntries.filter(a => a.model === 'opus').length,
    sonnet: agentEntries.filter(a => a.model === 'sonnet').length,
    haiku: agentEntries.filter(a => a.model === 'haiku').length,
  });

  async function loadAgents() {
    agentsLoading = true;
    try {
      const res = await fetch('/api/v5/agents');
      if (res.ok) {
        const json = await res.json();
        const list = (json.data ?? json.agents ?? json ?? []);
        // Build rich agent entries
        const loaded: AgentEntry[] = (list as Record<string, unknown>[])
          .map((a) => ({
            agentId: (a.agentId ?? a.id ?? '') as string,
            name: (a.name ?? a.agentId ?? a.id ?? '') as string,
            model: (a.model ?? 'sonnet') as 'opus' | 'sonnet' | 'haiku',
          }))
          .filter((a) => a.agentId);

        // Fall back to static list if server returned nothing
        agentEntries = loaded.length > 0 ? loaded : FALLBACK_ENTRIES;
      } else {
        // Non-2xx: server up but no data — use static fallback
        agentEntries = FALLBACK_ENTRIES;
      }
    } catch {
      // Network error or JSON parse failure
      agentEntries = FALLBACK_ENTRIES;
    } finally {
      agentsLoading = false;
    }
  }

  /**
   * Wire a resolved EventSource (already open) to filter by sessionId.
   * Called after we learn the sessionId from the POST response so that
   * completion/failure workflow_events are still captured for long runs.
   *
   * The server sends plain unnamed SSE events (`data: {...}\n\n`) — no
   * `event:` directive — so only `onmessage` fires. The envelope has shape:
   *   { id, type, category, message, data: { sessionId, content, ... }, timestamp }
   * We discriminate on `envelope.type` and read payload fields from `envelope.data`.
   */
  function wireSSE(es: EventSource, sessionId: string) {
    es.onmessage = (e) => {
      try {
        const envelope = JSON.parse(e.data) as Record<string, unknown>;
        const payload = (envelope['data'] as Record<string, unknown> | undefined) ?? {};

        if (envelope['type'] === 'agent_activity') {
          if (payload['sessionId'] !== sessionId) return;
          const chunk: string =
            (payload['content'] as string | undefined) ??
            (payload['chunk'] as string | undefined) ?? '';
          if (chunk) {
            output += chunk;
            requestAnimationFrame(scrollOutput);
          }
        } else if (envelope['type'] === 'workflow_event') {
          if (payload['sessionId'] !== sessionId) return;
          const status = payload['status'] as string | undefined;
          if (status === 'completed' || status === 'failed') {
            running = false;
            syncHistoryStatus(
              sessionId,
              status as 'completed' | 'failed',
              payload['costUsd'] as number | undefined,
              payload['providerKind'] as string | undefined,
              payload['runtimeModeResolved'] as string | undefined,
            );
            es.close();
            eventSource = null;
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      // Don't set running = false on SSE error — the run may still be going
    };
  }

  function scrollOutput() {
    if (outputEl) {
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  }

  function syncHistoryStatus(
    sessionId: string,
    status: 'completed' | 'failed',
    cost?: number,
    providerKind?: string,
    runtimeModeResolved?: string,
  ) {
    history = history.map((r) => {
      if (r.sessionId === sessionId) {
        return {
          ...r,
          status,
          ...(cost !== undefined ? { costUsd: cost } : {}),
          ...(providerKind ? { providerKind } : {}),
          ...(runtimeModeResolved ? { runtimeModeResolved } : {}),
          output,
        };
      }
      return r;
    });
  }

  async function handleRun() {
    if (!taskInput.trim() || running) return;
    runError = null;
    apiUnavailable = false;
    running = true;
    output = '';
    outputAgentName = selectedAgent;
    outputProviderKind = '';
    outputRuntimeMode = '';
    outputTimestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    selectedHistoryRun = null;

    // ── Open SSE BEFORE the POST ────────────────────────────────────────────
    // The server holds the POST connection open while the agent runs
    // (runStreaming is awaited in-handler). SSE chunks emitted during that
    // window arrive at zero listeners if we only connect after the response.
    // By opening early and buffering, we capture every chunk regardless of
    // when the POST returns.
    if (eventSource) { eventSource.close(); eventSource = null; }
    // SSE endpoint is /api/v5/stream — the server sends plain unnamed events
    // (`data: {...}\n\n`) so only `onmessage` fires, not named addEventListener.
    const es = new EventSource('/api/v5/stream');
    eventSource = es;

    // Buffer agent_activity chunks arriving before the POST returns the sessionId.
    // Envelope shape: { type, data: { sessionId, content, ... }, ... }
    const earlyBuffer: Array<{ sessionId: string; content: string }> = [];
    let resolvedSessionId: string | null = null;

    es.onmessage = (e) => {
      try {
        const envelope = JSON.parse(e.data) as Record<string, unknown>;
        if (envelope['type'] !== 'agent_activity') return;
        const payload = (envelope['data'] as Record<string, unknown> | undefined) ?? {};
        const content: string =
          (payload['content'] as string | undefined) ??
          (payload['chunk'] as string | undefined) ?? '';
        const sid: string = (payload['sessionId'] as string | undefined) ?? '';
        if (!content || !sid) return;
        if (resolvedSessionId === null) {
          // Still awaiting POST response — buffer for replay
          earlyBuffer.push({ sessionId: sid, content });
        } else if (sid === resolvedSessionId) {
          output += content;
          requestAnimationFrame(scrollOutput);
        }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => { /* SSE errors don't abort the run */ };
    // ─────────────────────────────────────────────────────────────────────────

    try {
      const res = await fetch('/api/v5/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgent, task: taskInput }),
      });

      if (res.status === 404) {
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
      // Server wraps the result in { data: { ...result, sessionId } }
      const json = envelope.data ?? envelope;
      const sessionId: string = json.sessionId ?? json.id ?? `local-${Date.now()}`;
      // Prefer the actual model ID returned by the server; convert to a tier
      // label ('Opus' | 'Sonnet' | 'Haiku') so the badge class matches CSS.
      outputModel = json.model
        ? modelIdToTierLabel(json.model as string)
        : (MODEL_TIER_META[getAgentModel(selectedAgent)]?.label ?? 'Sonnet');
      outputProviderKind = formatProviderKind(json.providerKind as string | undefined);
      outputRuntimeMode = formatRuntimeMode(json.runtimeModeResolved as string | undefined);
      currentSessionId = sessionId;

      // Add to history immediately as "running"
      const historyEntry: RunHistory = {
        id: sessionId,
        agentId: selectedAgent,
        task: taskInput,
        status: 'running',
        startedAt: new Date().toISOString(),
        sessionId,
        ...(typeof json.providerKind === 'string' ? { providerKind: json.providerKind } : {}),
        ...(typeof json.runtimeModeResolved === 'string' ? { runtimeModeResolved: json.runtimeModeResolved } : {}),
      };
      history = [historyEntry, ...history].slice(0, 5);

      // Unlock the SSE handler and replay buffered chunks for this session
      resolvedSessionId = sessionId;
      for (const { sessionId: sid, content } of earlyBuffer) {
        if (sid === sessionId) output += content;
      }
      if (output) requestAnimationFrame(scrollOutput);

      // Wire the already-open EventSource for completion signals
      wireSSE(es, sessionId);

      // Synchronous fallback: server includes full response in the HTTP reply
      // when the run completes inline. Use it as the authoritative output.
      // The field is `response` in RunResult (not `output`).
      const syncOutput = json.response ?? json.output;
      if (syncOutput) {
        output = syncOutput;
        running = false;
        syncHistoryStatus(
          sessionId,
          json.status === 'failed' ? 'failed' : 'completed',
          json.costUsd,
          json.providerKind as string | undefined,
          json.runtimeModeResolved as string | undefined,
        );
        es.close();
        eventSource = null;
      }

    } catch (e) {
      runError = String(e);
      running = false;
      es.close();
      eventSource = null;
    }
  }

  function showHistoryRun(run: RunHistory) {
    selectedHistoryRun = run;
    output = run.output ?? '(No output captured)';
    outputAgentName = run.agentId;
    outputTimestamp = new Date(run.startedAt).toLocaleTimeString('en-US', { hour12: false });
    outputModel = MODEL_TIER_META[getAgentModel(run.agentId)]?.label ?? '—';
    outputProviderKind = formatProviderKind(run.providerKind);
    outputRuntimeMode = formatRuntimeMode(run.runtimeModeResolved);
    currentSessionId = run.sessionId ?? null;
  }

  /** Map a raw Claude model ID (e.g. "claude-sonnet-4-5") to a tier label for display. */
  function modelIdToTierLabel(modelId: string): string {
    const lower = modelId.toLowerCase();
    if (lower.includes('opus'))  return 'Opus';
    if (lower.includes('haiku')) return 'Haiku';
    return 'Sonnet';
  }

  function formatCost(cost?: number): string {
    if (cost == null) return '—';
    return `$${cost.toFixed(4)}`;
  }

  function formatProviderKind(providerKind?: string): string {
    if (!providerKind) return '';
    if (providerKind === 'anthropic-sdk') return 'Anthropic SDK';
    if (providerKind === 'claude-code-compat') return 'Claude Code';
    return providerKind;
  }

  function formatRuntimeMode(runtimeMode?: string): string {
    if (!runtimeMode) return '';
    if (runtimeMode === 'claude-code-compat') return 'Claude Compat';
    return runtimeMode.toUpperCase();
  }

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/v5/run/history');
      if (!res.ok) return;
      const json = await res.json();
      const runs: RunHistory[] = (json.data ?? []).map((r: Record<string, unknown>) => ({
        id: (r.sessionId ?? r.id ?? '') as string,
        agentId: (r.agentId ?? '') as string,
        task: (r.task ?? '') as string,
        status: (r.status ?? 'completed') as RunHistory['status'],
        costUsd: typeof r.costUsd === 'number' ? r.costUsd : undefined,
        startedAt: (r.startedAt ?? new Date().toISOString()) as string,
        output: typeof r.response === 'string' ? r.response : (typeof r.output === 'string' ? r.output : undefined),
        sessionId: (r.sessionId ?? r.id ?? '') as string,
        providerKind: typeof r.providerKind === 'string' ? r.providerKind : undefined,
        runtimeModeResolved: typeof r.runtimeModeResolved === 'string' ? r.runtimeModeResolved : undefined,
      })).filter((r: RunHistory) => r.id && r.agentId);
      history = runs.slice(0, 5);
    } catch {
      // history stays empty — non-fatal
    }
  }

  onMount(() => {
    loadAgents();
    loadHistory();
  });

  onDestroy(() => {
    if (eventSource) eventSource.close();
  });
</script>

<svelte:head><title>Agent Runner — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Agent Runner</h1>
    <p class="page-subtitle">Trigger agent runs and observe real-time output</p>
  </div>
  {#if running}
    <div class="running-indicator">
      <span class="spinner"></span>
      <span class="running-label">Running {outputAgentName}…</span>
    </div>
  {/if}
</div>

<div class="runner-layout">
  <!-- Left: config + history -->
  <div class="left-panel">
    <div class="card">
      <div class="card-header">
        <span class="card-title">Run Configuration</span>
      </div>

      <div class="form-group">
        <label class="form-label" for="agent-select">Agent ({agentEntries.length} available)</label>
        {#if agentsLoading}
          <div class="skeleton" style="height:32px;border-radius:var(--radius-sm);"></div>
        {:else}
          <input
            type="search"
            class="form-search"
            placeholder="Filter agents..."
            bind:value={agentSearch}
            disabled={running}
          />
          <select id="agent-select" class="form-select" bind:value={selectedAgent} disabled={running} size={Math.min(filteredAgents.length, 8)}>
            {#each filteredAgents as agent (agent.agentId)}
              <option value={agent.agentId}>
                [{agent.model.charAt(0).toUpperCase()}] {agent.agentId}
              </option>
            {/each}
          </select>
          <div class="tier-counts">
            <span class="tier-tag opus">{agentCountByTier.opus} Opus</span>
            <span class="tier-tag sonnet">{agentCountByTier.sonnet} Sonnet</span>
            <span class="tier-tag haiku">{agentCountByTier.haiku} Haiku</span>
          </div>
        {/if}
      </div>

      <div class="cost-callout" style="--tier-color: {modelTier.color}">
        <span class="cost-tier" style="color: {modelTier.color}">{modelTier.label}</span>
        <span class="cost-range">est. {modelTier.range} per run</span>
      </div>

      <div class="form-group">
        <label class="form-label" for="task-input">Task</label>
        <textarea
          id="task-input"
          class="form-textarea"
          rows={4}
          placeholder="Describe what you want the agent to do…"
          bind:value={taskInput}
          disabled={running}
        ></textarea>
      </div>

      {#if runError}
        <div class="error-msg">{runError}</div>
      {/if}

      {#if apiUnavailable}
        <div class="unavailable-banner">
          Execution API not available — <code>/api/v5/run</code> returned 404.
          The server may not have this endpoint deployed yet.
        </div>
      {/if}

      <button
        class="btn btn-primary run-btn"
        disabled={running || !taskInput.trim()}
        onclick={handleRun}
      >
        {#if running}
          <span class="spinner spinner-sm"></span>
          Running…
        {:else}
          Run Agent
        {/if}
      </button>
    </div>

    <!-- Run History -->
    <div class="card history-card">
      <div class="card-header">
        <span class="card-title">Recent Runs</span>
        <span class="history-count">{history.length}</span>
      </div>

      {#if history.length === 0}
        <div class="history-empty">No runs yet this session</div>
      {:else}
        <div class="history-list">
          {#each history as run (run.id)}
            <button
              class="history-item"
              class:active={selectedHistoryRun?.id === run.id}
              onclick={() => showHistoryRun(run)}
            >
              <div class="history-item-header">
                <span class="history-agent">{run.agentId}</span>
                <span class="badge {run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : 'warning'}">
                  {run.status}
                </span>
              </div>
              <div class="history-task">{run.task.slice(0, 60)}{run.task.length > 60 ? '…' : ''}</div>
              <div class="history-meta">
                <span>{formatTime(run.startedAt)}</span>
                <span>{formatCost(run.costUsd)}</span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Right: live output -->
  <div class="right-panel">
    <div class="output-card card">
      <div class="output-header">
        <span class="card-title">Live Output</span>
        {#if outputAgentName}
          <div class="output-meta">
            <span class="output-agent">{outputAgentName}</span>
            {#if outputModel}
              <span class="badge {outputModel.toLowerCase()}">{outputModel}</span>
            {/if}
            {#if outputProviderKind}
              <span class="badge">{outputProviderKind}</span>
            {/if}
            {#if outputRuntimeMode}
              <span class="badge">{outputRuntimeMode}</span>
            {/if}
            {#if outputTimestamp}
              <span class="output-ts">{outputTimestamp}</span>
            {/if}
          </div>
        {/if}
      </div>

      {#if !output && !running}
        <div class="output-empty">
          <span class="empty-icon">▶</span>
          <p>Configure an agent and task, then click <strong>Run Agent</strong>.</p>
          <p class="muted">Output will stream here in real time via SSE.</p>
        </div>
      {:else}
        <pre class="output-pre" bind:this={outputEl}>{output}{#if running}<span class="cursor">▊</span>{/if}</pre>
      {/if}
    </div>
  </div>
</div>

<style>
  .runner-layout {
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: var(--space-4);
    align-items: start;
  }

  .left-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .right-panel {
    min-height: 0;
  }

  /* Form elements */
  .form-group {
    margin-bottom: var(--space-4);
  }

  .form-label {
    display: block;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text-muted);
    margin-bottom: var(--space-2);
  }

  .form-select {
    width: 100%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: border-color var(--duration-fast);
  }

  .form-select:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }

  .form-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .form-textarea {
    width: 100%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    padding: var(--space-3);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    resize: vertical;
    min-height: 96px;
    transition: border-color var(--duration-fast);
    box-sizing: border-box;
  }

  .form-textarea:hover:not(:disabled) {
    border-color: var(--color-border-strong);
  }

  .form-textarea:focus {
    outline: none;
    border-color: var(--color-brand);
  }

  .form-textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .form-textarea::placeholder {
    color: var(--color-text-faint);
  }

  /* Agent search */
  .form-search {
    width: 100%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    outline: none;
    margin-bottom: var(--space-2);
    box-sizing: border-box;
    transition: border-color var(--duration-fast);
  }

  .form-search:focus {
    border-color: var(--color-brand);
  }

  .form-search:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .form-search::placeholder {
    color: var(--color-text-faint);
  }

  .tier-counts {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .tier-tag {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    letter-spacing: 0.03em;
  }

  .tier-tag.opus {
    color: var(--color-opus);
    background: rgba(245,200,66,0.1);
    border: 1px solid rgba(245,200,66,0.3);
  }

  .tier-tag.sonnet {
    color: var(--color-sonnet);
    background: rgba(74,158,255,0.1);
    border: 1px solid rgba(74,158,255,0.3);
  }

  .tier-tag.haiku {
    color: var(--color-haiku);
    background: rgba(76,175,130,0.1);
    border: 1px solid rgba(76,175,130,0.3);
  }

  /* Cost callout */
  .cost-callout {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: color-mix(in srgb, var(--tier-color) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--tier-color) 25%, transparent);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-4);
    font-size: var(--text-xs);
  }

  .cost-tier {
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 10px;
  }

  .cost-range {
    color: var(--color-text-muted);
  }

  /* Run button */
  .run-btn {
    width: 100%;
    justify-content: center;
    padding: var(--space-3) var(--space-4);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .run-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Spinner */
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  .spinner-sm {
    width: 12px;
    height: 12px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Running indicator in header */
  .running-indicator {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: rgba(91,138,245,0.1);
    border: 1px solid rgba(91,138,245,0.3);
    border-radius: var(--radius-full);
    padding: var(--space-2) var(--space-3);
  }

  .running-label {
    font-size: var(--text-sm);
    color: var(--color-brand);
    font-weight: 500;
  }

  /* Error / unavailable */
  .error-msg {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-xs);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
  }

  .unavailable-banner {
    background: rgba(245,166,35,0.1);
    border: 1px solid rgba(245,166,35,0.3);
    border-radius: var(--radius-md);
    color: var(--color-warning);
    font-size: var(--text-xs);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
    line-height: 1.6;
  }

  .unavailable-banner code {
    font-family: var(--font-mono);
    background: rgba(245,166,35,0.15);
    padding: 1px 4px;
    border-radius: 3px;
  }

  /* History */
  .history-card .card-header {
    margin-bottom: var(--space-3);
  }

  .history-count {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-family: var(--font-mono);
  }

  .history-empty {
    font-size: var(--text-sm);
    color: var(--color-text-faint);
    padding: var(--space-4) 0;
    text-align: center;
  }

  .history-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .history-item {
    width: 100%;
    text-align: left;
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    cursor: pointer;
    transition: border-color var(--duration-fast), background var(--duration-fast);
  }

  .history-item:hover {
    border-color: var(--color-border-strong);
    background: var(--color-surface-2);
  }

  .history-item.active {
    border-color: var(--color-brand);
    background: rgba(91,138,245,0.06);
  }

  .history-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-1);
  }

  .history-agent {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--color-text);
    font-family: var(--font-mono);
  }

  .history-task {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-bottom: var(--space-1);
    line-height: 1.4;
  }

  .history-meta {
    display: flex;
    justify-content: space-between;
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-family: var(--font-mono);
  }

  /* Output panel */
  .output-card {
    display: flex;
    flex-direction: column;
    min-height: calc(100vh - 180px);
  }

  .output-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .output-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .output-agent {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-muted);
  }

  .output-ts {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-family: var(--font-mono);
  }

  .output-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    color: var(--color-text-muted);
    padding: var(--space-12) var(--space-6);
  }

  .output-empty .empty-icon {
    font-size: 28px;
    opacity: 0.2;
  }

  .output-empty p {
    margin: 0;
    font-size: var(--text-sm);
    text-align: center;
  }

  .output-empty .muted {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  .output-pre {
    flex: 1;
    margin: 0;
    padding: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-y: auto;
    max-height: calc(100vh - 260px);
    line-height: 1.6;
  }

  .cursor {
    display: inline-block;
    animation: blink 1s step-end infinite;
    color: var(--color-brand);
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  @media (max-width: 900px) {
    .runner-layout {
      grid-template-columns: 1fr;
    }

    .output-card {
      min-height: 400px;
    }
  }
</style>
