<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    compactId,
    eventSummary,
    formatJobDuration,
    isCancellableJobStatus,
    isTerminalJobStatus,
    jobStatusBadgeClass,
    type RuntimeJobStatus,
  } from '$lib/util/job-format.js';
  import { relativeTime } from '$lib/util/relative-time.js';
  import { Btn, Badge, Card, KpiTile, Ring, PulseDot } from '$lib/components/v2';

  type StatusFilter = 'all' | RuntimeJobStatus;

  interface RuntimeJob {
    jobId: string;
    sessionId: string;
    traceId?: string;
    agentId: string;
    task: string;
    status: RuntimeJobStatus | string;
    model?: string;
    runtimeMode?: string;
    providerKind?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: number | null;
    error?: string | null;
    result?: unknown;
    cancelRequested?: boolean;
    startedAt?: string | null;
    completedAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }

  interface RuntimeEvent {
    id: string;
    sequence: number;
    jobId: string;
    sessionId: string;
    traceId?: string;
    agentId: string;
    type: string;
    category?: string;
    message?: string;
    payload?: Record<string, unknown>;
    data?: Record<string, unknown>;
    timestamp: string;
  }

  const STATUS_FILTERS: StatusFilter[] = ['all', 'queued', 'running', 'completed', 'failed', 'cancelled'];

  let jobs: RuntimeJob[] = $state([]);
  let events: RuntimeEvent[] = $state([]);
  let jobsLoading = $state(true);
  let eventsLoading = $state(false);
  let jobsError: string | null = $state(null);
  let eventsError: string | null = $state(null);
  let cancelError: string | null = $state(null);
  let statusFilter: StatusFilter = $state('all');
  let selectedJobId: string | null = $state(null);
  let cancellingJobId: string | null = $state(null);
  let lastLoadedAt = $state('');

  let jobsPoll: ReturnType<typeof setInterval> | null = null;
  let eventsPoll: ReturnType<typeof setInterval> | null = null;

  let selectedJob = $derived(jobs.find((job) => job.jobId === selectedJobId) ?? jobs[0] ?? null);

  let jobStats = $derived.by(() => {
    const stats = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const job of jobs) {
      if (job.status in stats) stats[job.status as RuntimeJobStatus] += 1;
    }
    return stats;
  });

  let latestEvent = $derived(events[events.length - 1] ?? null);

  let outputPreview = $derived.by(() => {
    const chunks = events
      .map((event) => {
        const data = event.payload ?? event.data ?? {};
        return typeof data.content === 'string' ? data.content : typeof data.text === 'string' ? data.text : '';
      })
      .filter(Boolean);
    const output = chunks.join('');
    return output.length > 5000 ? output.slice(-5000) : output;
  });

  let shouldPollEvents = $derived(selectedJob ? !isTerminalJobStatus(selectedJob.status) : false);

  // Progress ring value for running jobs
  function jobProgress(job: RuntimeJob): number {
    if (job.status === 'completed') return 100;
    if (job.status === 'failed' || job.status === 'cancelled') return 100;
    if (job.status !== 'running' || !job.startedAt) return 0;
    const elapsed = Date.now() - new Date(job.startedAt).getTime();
    // Cap at 90% until completion
    return Math.min(90, Math.round((elapsed / 60000) * 30));
  }

  function buildJobsUrl(): string {
    const params = new URLSearchParams({ limit: '50' });
    if (statusFilter !== 'all') params.set('status', statusFilter);
    return `/api/v5/jobs?${params.toString()}`;
  }

  async function loadJobs(background = false) {
    if (!background) jobsLoading = true;
    jobsError = null;
    try {
      const res = await fetch(buildJobsUrl());
      if (!res.ok) throw new Error(await responseError(res));
      const body = await res.json();
      const nextJobs = (body.data ?? []) as RuntimeJob[];
      jobs = nextJobs;
      lastLoadedAt = new Date().toLocaleTimeString('en-US', { hour12: false });
      if (!selectedJobId || !nextJobs.some((job) => job.jobId === selectedJobId)) {
        selectedJobId = nextJobs[0]?.jobId ?? null;
      }
    } catch (error) {
      jobsError = error instanceof Error ? error.message : 'Failed to load jobs';
    } finally {
      jobsLoading = false;
    }
  }

  async function loadEvents(jobId = selectedJobId) {
    if (!jobId) { events = []; return; }
    eventsLoading = events.length === 0;
    eventsError = null;
    try {
      const res = await fetch(`/api/v5/jobs/${encodeURIComponent(jobId)}/events?limit=100`);
      if (!res.ok) throw new Error(await responseError(res));
      const body = await res.json();
      events = (body.data ?? []) as RuntimeEvent[];
    } catch (error) {
      eventsError = error instanceof Error ? error.message : 'Failed to load job events';
    } finally {
      eventsLoading = false;
    }
  }

  async function responseError(res: Response): Promise<string> {
    try { const body = await res.json(); return body?.error ?? body?.message ?? `HTTP ${res.status}`; }
    catch { return `HTTP ${res.status}`; }
  }

  function selectJob(jobId: string) {
    if (selectedJobId === jobId) return;
    selectedJobId = jobId;
    events = [];
    void loadEvents(jobId);
  }

  async function refresh() { await loadJobs(); await loadEvents(); }

  async function applyStatusFilter(next: StatusFilter) {
    statusFilter = next;
    selectedJobId = null;
    events = [];
    await loadJobs();
    await loadEvents();
  }

  async function cancelJob(job: RuntimeJob) {
    if (!isCancellableJobStatus(job.status) || cancellingJobId) return;
    cancellingJobId = job.jobId;
    cancelError = null;
    try {
      const res = await fetch(`/api/v5/jobs/${encodeURIComponent(job.jobId)}/cancel`, { method: 'POST' });
      if (!res.ok) throw new Error(await responseError(res));
      const body = await res.json();
      const updated = body.data as RuntimeJob;
      jobs = jobs.map((item) => item.jobId === updated.jobId ? updated : item);
      await loadEvents(updated.jobId);
    } catch (error) {
      cancelError = error instanceof Error ? error.message : 'Failed to cancel job';
    } finally {
      cancellingJobId = null;
    }
  }

  function formatDateTime(value: string | null | undefined): string {
    if (!value) return '—';
    try { return new Date(value).toLocaleString(); } catch { return value; }
  }

  function formatCost(cost: number | null | undefined): string {
    return typeof cost === 'number' ? `$${cost.toFixed(4)}` : '—';
  }

  function formatNumber(value: number | null | undefined): string {
    return typeof value === 'number' ? value.toLocaleString() : '—';
  }

  function statusBadgeVariant(status: string): 'success' | 'danger' | 'warning' | 'purple' | 'muted' {
    if (status === 'completed') return 'success';
    if (status === 'failed')    return 'danger';
    if (status === 'running')   return 'purple';
    if (status === 'queued')    return 'warning';
    return 'muted';
  }

  // Dot color per status
  function statusDotColor(status: string): string {
    if (status === 'running')   return 'var(--af-purple)';
    if (status === 'completed') return 'var(--af-success)';
    if (status === 'failed')    return 'var(--af-danger)';
    if (status === 'queued')    return 'var(--af-warning)';
    return 'var(--af-faint)';
  }

  onMount(() => {
    void loadJobs().then(() => loadEvents());
    jobsPoll = setInterval(() => void loadJobs(true), 5000);
    eventsPoll = setInterval(() => { if (shouldPollEvents) void loadEvents(); }, 2500);
  });

  onDestroy(() => {
    if (jobsPoll) clearInterval(jobsPoll);
    if (eventsPoll) clearInterval(eventsPoll);
  });
</script>

<svelte:head><title>Runtime Jobs — AgentForge</title></svelte:head>

<!-- ── Page header ──────────────────────────────────────────────────────── -->
<div class="page-header">
  <div>
    <h1 class="page-title">Runtime Jobs</h1>
    <p class="page-sub">Cycles running RIGHT NOW plus paginated history</p>
  </div>
  <div class="page-actions">
    {#if lastLoadedAt}
      <span class="af2-mono" style="font-size:10px;color:var(--af-faint)">Updated {lastLoadedAt}</span>
    {/if}
    <Btn size="sm" href="/live">Live Feed</Btn>
    <Btn size="sm" onclick={refresh} disabled={jobsLoading || eventsLoading}>
      {jobsLoading || eventsLoading ? 'Refreshing…' : 'Refresh'}
    </Btn>
  </div>
</div>

<!-- ── KPI strip ─────────────────────────────────────────────────────────── -->
<div class="kpi-strip">
  <KpiTile
    label="Running"
    value={jobStats.running}
    color="var(--af-purple)"
    live={jobStats.running > 0}
  />
  <KpiTile label="Queued"    value={jobStats.queued}    color="var(--af-warning)" />
  <KpiTile label="Completed" value={jobStats.completed} color="var(--af-success)" />
  <KpiTile label="Failed"    value={jobStats.failed}    color="var(--af-danger)" />
  <KpiTile label="Cancelled" value={jobStats.cancelled} color="var(--af-faint)" />
</div>

<!-- ── Filter row ────────────────────────────────────────────────────────── -->
<Card style="margin-bottom:12px;padding:10px 14px">
  <div class="filter-row">
    <span class="filter-label">STATUS</span>
    {#each STATUS_FILTERS as filter}
      <button
        class="chip"
        class:chip--active={statusFilter === filter}
        onclick={() => applyStatusFilter(filter)}
      >{filter}</button>
    {/each}
  </div>
</Card>

<!-- ── Error state ───────────────────────────────────────────────────────── -->
{#if jobsError}
  <div class="error-state">
    <strong>Unable to load runtime jobs.</strong>
    <span>{jobsError}</span>
    <Btn size="sm" onclick={refresh}>Retry</Btn>
  </div>
{:else}
  <!-- ── Two-column jobs layout ──────────────────────────────────────────── -->
  <div class="jobs-layout">

    <!-- ── Left: job list ─────────────────────────────────────────────────── -->
    <Card noPad>
      <div class="panel-header">
        <span class="section-title">JOBS</span>
        <span class="af2-mono" style="font-size:10px;color:var(--af-faint)">{jobs.length}</span>
      </div>

      {#if jobsLoading && jobs.length === 0}
        {#each Array(6) as _}
          <div class="skeleton job-skeleton"></div>
        {/each}
      {:else if jobs.length === 0}
        <div class="empty-list">
          <span>No jobs match this filter.</span>
          <a href="/runner">Start a run →</a>
        </div>
      {:else}
        <div class="job-list">
          {#each jobs as job (job.jobId)}
            <button
              class="job-row"
              class:job-row--selected={selectedJob?.jobId === job.jobId}
              onclick={() => selectJob(job.jobId)}
            >
              <!-- status rail -->
              <span class="status-rail" style="background:{statusDotColor(job.status)}"></span>

              <!-- content -->
              <div class="job-content">
                <div class="job-top">
                  <span class="af2-mono job-agent">{job.agentId}</span>
                  <div class="job-top-right">
                    {#if job.status === 'running'}
                      <Ring
                        value={jobProgress(job)}
                        max={100}
                        size={22}
                        stroke={2}
                        color="var(--af-purple)"
                        label=""
                      />
                    {/if}
                    <Badge variant={statusBadgeVariant(job.status)}>{job.status}</Badge>
                  </div>
                </div>
                <div class="job-task">{job.task || 'No task recorded'}</div>
                <div class="af2-mono job-meta">
                  <span title={job.jobId}>job {compactId(job.jobId)}</span>
                  <span>{relativeTime(job.updatedAt ?? job.createdAt)}</span>
                  {#if job.costUsd != null}
                    <span>${job.costUsd.toFixed(4)}</span>
                  {/if}
                </div>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </Card>

    <!-- ── Right: detail panel ────────────────────────────────────────────── -->
    <div class="detail-col">
      {#if selectedJob}
        <!-- Job detail card -->
        <Card>
          <!-- Detail header -->
          <div class="detail-header">
            <div>
              <div class="section-title" style="margin-bottom:4px">Selected Job</div>
              <div style="display:flex;align-items:center;gap:8px">
                {#if selectedJob.status === 'running'}
                  <PulseDot color="var(--af-purple)" size={6} />
                {/if}
                <span class="af2-mono detail-id">{compactId(selectedJob.jobId, 12, 6)}</span>
                <Badge variant={statusBadgeVariant(selectedJob.status)}>{selectedJob.status}</Badge>
              </div>
            </div>
            <div class="detail-actions">
              {#if cancelError}
                <span style="font-size:11px;color:var(--af-danger)">{cancelError}</span>
              {/if}
              <Btn
                variant="danger"
                size="sm"
                disabled={!isCancellableJobStatus(selectedJob.status) || cancellingJobId === selectedJob.jobId}
                onclick={() => cancelJob(selectedJob!)}
              >
                {cancellingJobId === selectedJob.jobId ? 'Cancelling…' : 'Cancel'}
              </Btn>
            </div>
          </div>

          <!-- Detail grid -->
          <div class="detail-grid">
            <div class="detail-field">
              <span class="field-label">Agent</span>
              <code class="af2-mono">{selectedJob.agentId}</code>
            </div>
            <div class="detail-field">
              <span class="field-label">Model</span>
              <span>{selectedJob.model ?? '—'}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Runtime</span>
              <span>{selectedJob.runtimeMode ?? '—'}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Provider</span>
              <span>{selectedJob.providerKind ?? '—'}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Duration</span>
              <code class="af2-mono">{formatJobDuration(selectedJob.startedAt ?? selectedJob.createdAt, selectedJob.completedAt)}</code>
            </div>
            <div class="detail-field">
              <span class="field-label">Cost</span>
              <code class="af2-mono">{formatCost(selectedJob.costUsd)}</code>
            </div>
            <div class="detail-field">
              <span class="field-label">Tokens</span>
              <code class="af2-mono">{formatNumber((selectedJob.inputTokens ?? 0) + (selectedJob.outputTokens ?? 0))}</code>
            </div>
            <div class="detail-field">
              <span class="field-label">Started</span>
              <span>{formatDateTime(selectedJob.startedAt)}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Completed</span>
              <span>{formatDateTime(selectedJob.completedAt)}</span>
            </div>
          </div>

          <!-- Task -->
          <div class="task-box">
            <span class="field-label">Task</span>
            <p>{selectedJob.task || 'No task recorded.'}</p>
          </div>

          <!-- Error -->
          {#if selectedJob.error}
            <div class="error-box">
              <span class="field-label">Error</span>
              <p>{selectedJob.error}</p>
            </div>
          {/if}
        </Card>

        <!-- Events & output card -->
        <Card>
          <div class="card-header-row">
            <span class="section-title">EVENTS & OUTPUT</span>
            <span
              class="stream-status af2-mono"
              class:stream-status--live={shouldPollEvents}
            >
              {shouldPollEvents ? 'Polling live events' : 'Event replay'}
            </span>
          </div>

          {#if latestEvent}
            <div class="latest-event">
              <span class="latest-label">Latest</span>
              <span style="font-size:12px;color:var(--af-muted)">{eventSummary(latestEvent.type, latestEvent.message)}</span>
              <span class="af2-mono" style="font-size:10px;color:var(--af-faint);margin-left:auto">{relativeTime(latestEvent.timestamp)}</span>
            </div>
          {/if}

          {#if outputPreview}
            <pre class="output-preview af2-mono">{outputPreview}</pre>
          {:else}
            <div class="empty-inline">No streamed output chunks for this job yet.</div>
          {/if}

          <!-- Event list -->
          <div class="event-list">
            {#if eventsLoading}
              <div class="empty-inline">Loading persisted events…</div>
            {:else if eventsError}
              <div class="empty-inline" style="color:var(--af-danger)">{eventsError}</div>
            {:else if events.length === 0}
              <div class="empty-inline">No persisted events for this job.</div>
            {:else}
              {#each events as event (event.id)}
                <div class="event-row">
                  <span class="af2-mono event-seq">#{event.sequence}</span>
                  <span class="af2-mono event-type">{event.type}</span>
                  <span class="event-msg">{eventSummary(event.type, event.message)}</span>
                  <span class="af2-mono event-time">{relativeTime(event.timestamp)}</span>
                </div>
              {/each}
            {/if}
          </div>
        </Card>

      {:else}
        <div class="empty-state">
          <span style="font-size:12px;color:var(--af-faint)">No job selected.</span>
          <Btn size="sm" href="/runner">Start a run</Btn>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ── Page header ──────────────────────────────────────────────────────── */
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 14px;
    gap: 16px;
  }

  .page-title {
    font-size: 20px;
    font-weight: 600;
    color: var(--af-text);
    margin: 0 0 4px;
  }

  .page-sub { font-size: 12px; color: var(--af-dim); margin: 0; }

  .page-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  /* ── KPI strip ────────────────────────────────────────────────────────── */
  .kpi-strip {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }

  /* ── Filter row ───────────────────────────────────────────────────────── */
  .filter-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .filter-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    margin-right: 4px;
    white-space: nowrap;
  }

  .chip {
    background: transparent;
    border: 1px solid var(--af-border2);
    border-radius: 99px;
    padding: 3px 10px;
    font-size: 11px;
    color: var(--af-muted);
    cursor: pointer;
    transition: border-color 150ms, color 150ms;
    text-transform: capitalize;
  }

  .chip:hover { border-color: var(--af-border3); color: var(--af-text); }

  .chip--active {
    border-color: var(--af-purple);
    color: var(--af-purple);
    background: color-mix(in srgb, var(--af-purple) 8%, transparent);
  }

  /* ── Error state ──────────────────────────────────────────────────────── */
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 48px;
    text-align: center;
    font-size: 12px;
    color: var(--af-muted);
  }

  /* ── Jobs layout ──────────────────────────────────────────────────────── */
  .jobs-layout {
    display: grid;
    grid-template-columns: minmax(300px, 400px) minmax(0, 1fr);
    gap: 14px;
    align-items: start;
  }

  /* ── Panel header ─────────────────────────────────────────────────────── */
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--af-border);
  }

  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
  }

  /* ── Job list ─────────────────────────────────────────────────────────── */
  .job-list { display: flex; flex-direction: column; }

  .job-row {
    display: grid;
    grid-template-columns: 3px 1fr;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-bottom: 1px solid color-mix(in srgb, var(--af-border) 60%, transparent);
    color: var(--af-text);
    cursor: pointer;
    padding: 0;
    overflow: hidden;
    transition: background 120ms;
  }

  .job-row:hover { background: var(--af-surface2); }

  .job-row--selected {
    background: color-mix(in srgb, var(--af-purple) 6%, transparent);
    border-left: 2px solid var(--af-purple) !important;
  }

  .job-row:last-child { border-bottom: none; }

  .status-rail {
    width: 3px;
    background: var(--af-faint);
    flex-shrink: 0;
  }

  .job-content {
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .job-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .job-top-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .job-agent {
    font-size: 11px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .job-task {
    font-size: 12px;
    color: var(--af-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .job-meta {
    font-size: 10px;
    color: var(--af-faint);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  /* ── Skeletons ────────────────────────────────────────────────────────── */
  .skeleton {
    background: var(--af-surface2);
    animation: shimmer 1.4s ease infinite;
  }

  .job-skeleton { height: 68px; margin: 1px 0; }

  @keyframes shimmer {
    0%, 100% { opacity: 0.5; }
    50%  { opacity: 0.9; }
  }

  /* ── Empty states ─────────────────────────────────────────────────────── */
  .empty-list {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 40px 24px;
    font-size: 12px;
    color: var(--af-faint);
  }

  .empty-list a { color: var(--af-purple); text-decoration: none; }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 64px 24px;
  }

  /* ── Detail column ────────────────────────────────────────────────────── */
  .detail-col {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  .detail-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--af-border);
    margin-bottom: 14px;
  }

  .detail-id {
    font-size: 13px;
    font-weight: 600;
    color: var(--af-text);
  }

  .detail-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  /* ── Detail grid ──────────────────────────────────────────────────────── */
  .detail-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin-bottom: 12px;
  }

  .detail-field {
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 10px;
  }

  .field-label {
    display: block;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--af-faint);
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .detail-field code {
    font-size: 11px;
    color: var(--af-text);
    overflow-wrap: anywhere;
  }

  .detail-field span { font-size: 12px; color: var(--af-muted); }

  /* ── Task / error boxes ───────────────────────────────────────────────── */
  .task-box,
  .error-box {
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 10px;
  }

  .task-box p,
  .error-box p {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--af-muted);
    white-space: pre-wrap;
  }

  .error-box { border-color: color-mix(in srgb, var(--af-danger) 30%, transparent); }

  /* ── Card header row ──────────────────────────────────────────────────── */
  .card-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  /* ── Stream status ────────────────────────────────────────────────────── */
  .stream-status {
    font-size: 10px;
    color: var(--af-faint);
  }

  .stream-status--live {
    color: var(--af-success);
  }

  .stream-status--live::before {
    content: '';
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--af-success);
    box-shadow: 0 0 6px var(--af-success);
    margin-right: 5px;
    vertical-align: middle;
  }

  /* ── Latest event ─────────────────────────────────────────────────────── */
  .latest-event {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 8px 12px;
    margin-bottom: 10px;
  }

  .latest-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--af-purple);
    text-transform: uppercase;
    white-space: nowrap;
  }

  /* ── Output preview ───────────────────────────────────────────────────── */
  .output-preview {
    background: var(--af-bg);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-muted);
    font-size: 11px;
    line-height: 1.6;
    margin: 0 0 12px;
    max-height: 240px;
    overflow: auto;
    padding: 12px 14px;
    white-space: pre-wrap;
  }

  /* ── Empty inline ─────────────────────────────────────────────────────── */
  .empty-inline {
    font-size: 12px;
    color: var(--af-faint);
    padding: 20px;
    text-align: center;
  }

  /* ── Event list ───────────────────────────────────────────────────────── */
  .event-list {
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    max-height: 320px;
    overflow: auto;
  }

  .event-row {
    display: grid;
    grid-template-columns: 54px 130px 1fr 72px;
    gap: 8px;
    align-items: center;
    padding: 7px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--af-border) 60%, transparent);
  }

  .event-row:last-child { border-bottom: none; }

  .event-seq,
  .event-time {
    font-size: 10px;
    color: var(--af-faint);
  }

  .event-type {
    font-size: 10px;
    color: var(--af-purple);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .event-msg {
    font-size: 11px;
    color: var(--af-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }

  @media (max-width: 1100px) {
    .kpi-strip { grid-template-columns: repeat(3, 1fr); }
    .jobs-layout { grid-template-columns: 1fr; }
    .detail-grid { grid-template-columns: repeat(2, 1fr); }
  }

  @media (max-width: 720px) {
    .detail-grid { grid-template-columns: 1fr; }
    .event-row { grid-template-columns: 48px 1fr; }
    .event-msg, .event-time { grid-column: 2; }
  }
</style>
