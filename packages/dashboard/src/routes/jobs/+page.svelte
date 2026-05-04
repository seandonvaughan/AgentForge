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

  let selectedJob = $derived(
    jobs.find((job) => job.jobId === selectedJobId) ?? jobs[0] ?? null
  );

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
        return typeof data.content === 'string'
          ? data.content
          : typeof data.text === 'string'
            ? data.text
            : '';
      })
      .filter(Boolean);

    const output = chunks.join('');
    return output.length > 5000 ? output.slice(-5000) : output;
  });

  let shouldPollEvents = $derived(selectedJob ? !isTerminalJobStatus(selectedJob.status) : false);

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
    if (!jobId) {
      events = [];
      return;
    }

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
    try {
      const body = await res.json();
      return body?.error ?? body?.message ?? `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}`;
    }
  }

  function selectJob(jobId: string) {
    if (selectedJobId === jobId) return;
    selectedJobId = jobId;
    events = [];
    void loadEvents(jobId);
  }

  async function refresh() {
    await loadJobs();
    await loadEvents();
  }

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
      const res = await fetch(`/api/v5/jobs/${encodeURIComponent(job.jobId)}/cancel`, {
        method: 'POST',
      });
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
    if (!value) return '-';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }

  function formatCost(cost: number | null | undefined): string {
    return typeof cost === 'number' ? `$${cost.toFixed(4)}` : '-';
  }

  function formatNumber(value: number | null | undefined): string {
    return typeof value === 'number' ? value.toLocaleString() : '-';
  }

  onMount(() => {
    void loadJobs().then(() => loadEvents());
    jobsPoll = setInterval(() => void loadJobs(true), 5000);
    eventsPoll = setInterval(() => {
      if (shouldPollEvents) void loadEvents();
    }, 2500);
  });

  onDestroy(() => {
    if (jobsPoll) clearInterval(jobsPoll);
    if (eventsPoll) clearInterval(eventsPoll);
  });
</script>

<svelte:head><title>Runtime Jobs - AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Runtime Jobs</h1>
    <p class="page-subtitle">Durable operator view for queued, running, and completed agent jobs</p>
  </div>
  <div class="header-actions">
    {#if lastLoadedAt}
      <span class="loaded-at">Updated {lastLoadedAt}</span>
    {/if}
    <a class="btn btn-ghost btn-sm" href="/live">Live Feed</a>
    <button class="btn btn-ghost btn-sm" onclick={refresh} disabled={jobsLoading || eventsLoading}>
      {jobsLoading || eventsLoading ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>
</div>

<div class="ops-strip">
  <div class="ops-card active">
    <span class="ops-value">{jobStats.queued + jobStats.running}</span>
    <span class="ops-label">Active Queue</span>
  </div>
  <div class="ops-card">
    <span class="ops-value">{jobStats.queued}</span>
    <span class="ops-label">Queued</span>
  </div>
  <div class="ops-card">
    <span class="ops-value">{jobStats.running}</span>
    <span class="ops-label">Running</span>
  </div>
  <div class="ops-card danger">
    <span class="ops-value">{jobStats.failed}</span>
    <span class="ops-label">Failed</span>
  </div>
  <div class="ops-card">
    <span class="ops-value">{jobStats.completed}</span>
    <span class="ops-label">Completed</span>
  </div>
</div>

<div class="filter-row">
  <span class="filter-label">Status</span>
  {#each STATUS_FILTERS as filter}
    <button
      class="filter-chip"
      class:active={statusFilter === filter}
      onclick={() => applyStatusFilter(filter)}
    >
      {filter}
    </button>
  {/each}
</div>

{#if jobsError}
  <div class="empty-state error-state">
    <strong>Unable to load runtime jobs.</strong>
    <span>{jobsError}</span>
    <button class="btn btn-ghost btn-sm" onclick={refresh}>Retry</button>
  </div>
{:else}
  <div class="jobs-layout">
    <section class="jobs-panel card">
      <div class="card-header">
        <span class="card-title">Recent Jobs</span>
        <span class="panel-count">{jobs.length}</span>
      </div>

      {#if jobsLoading && jobs.length === 0}
        {#each Array(8) as _}
          <div class="skeleton job-skeleton"></div>
        {/each}
      {:else if jobs.length === 0}
        <div class="empty-list">
          <span>No jobs match this filter.</span>
          <a href="/runner">Start a run -&gt;</a>
        </div>
      {:else}
        <div class="job-list">
          {#each jobs as job (job.jobId)}
            <button
              class="job-row"
              class:selected={selectedJob?.jobId === job.jobId}
              onclick={() => selectJob(job.jobId)}
            >
              <span class="status-rail {jobStatusBadgeClass(job.status)}"></span>
              <span class="job-main">
                <span class="job-title">
                  <span class="job-agent">{job.agentId}</span>
                  <span class="badge {jobStatusBadgeClass(job.status)}">{job.status}</span>
                </span>
                <span class="job-task">{job.task || 'No task recorded'}</span>
                <span class="job-meta">
                  <span title={job.jobId}>job {compactId(job.jobId)}</span>
                  <span title={job.sessionId}>session {compactId(job.sessionId)}</span>
                  <span>{relativeTime(job.updatedAt ?? job.createdAt)}</span>
                </span>
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <section class="detail-panel">
      {#if selectedJob}
        <div class="detail-card card">
          <div class="detail-header">
            <div>
              <div class="detail-eyebrow">Selected Job</div>
              <h2>{selectedJob.agentId} - {compactId(selectedJob.jobId, 12, 6)}</h2>
            </div>
            <div class="detail-actions">
              <span class="badge {jobStatusBadgeClass(selectedJob.status)}">{selectedJob.status}</span>
              <button
                class="btn btn-ghost btn-sm danger-action"
                disabled={!isCancellableJobStatus(selectedJob.status) || cancellingJobId === selectedJob.jobId}
                onclick={() => cancelJob(selectedJob)}
                title={isCancellableJobStatus(selectedJob.status) ? 'Request cancellation for this job' : 'Only queued or running jobs can be cancelled'}
              >
                {cancellingJobId === selectedJob.jobId ? 'Cancelling...' : 'Cancel Job'}
              </button>
            </div>
          </div>

          {#if cancelError}
            <div class="inline-error">{cancelError}</div>
          {/if}

          <div class="detail-grid">
            <div>
              <span class="field-label">Job ID</span>
              <code>{selectedJob.jobId}</code>
            </div>
            <div>
              <span class="field-label">Session ID</span>
              <code>{selectedJob.sessionId}</code>
            </div>
            <div>
              <span class="field-label">Trace ID</span>
              <code>{selectedJob.traceId ?? '-'}</code>
            </div>
            <div>
              <span class="field-label">Model</span>
              <span>{selectedJob.model ?? '-'}</span>
            </div>
            <div>
              <span class="field-label">Runtime</span>
              <span>{selectedJob.runtimeMode ?? '-'}</span>
            </div>
            <div>
              <span class="field-label">Provider</span>
              <span>{selectedJob.providerKind ?? '-'}</span>
            </div>
            <div>
              <span class="field-label">Duration</span>
              <span>{formatJobDuration(selectedJob.startedAt ?? selectedJob.createdAt, selectedJob.completedAt)}</span>
            </div>
            <div>
              <span class="field-label">Created</span>
              <span>{formatDateTime(selectedJob.createdAt)}</span>
            </div>
            <div>
              <span class="field-label">Started</span>
              <span>{formatDateTime(selectedJob.startedAt)}</span>
            </div>
            <div>
              <span class="field-label">Completed</span>
              <span>{formatDateTime(selectedJob.completedAt)}</span>
            </div>
            <div>
              <span class="field-label">Cost</span>
              <span>{formatCost(selectedJob.costUsd)}</span>
            </div>
            <div>
              <span class="field-label">Tokens</span>
              <span>{formatNumber((selectedJob.inputTokens ?? 0) + (selectedJob.outputTokens ?? 0))}</span>
            </div>
            <div>
              <span class="field-label">Cancel Requested</span>
              <span>{selectedJob.cancelRequested ? 'yes' : 'no'}</span>
            </div>
          </div>

          <div class="task-box">
            <span class="field-label">Task</span>
            <p>{selectedJob.task || 'No task recorded.'}</p>
          </div>

          {#if selectedJob.error}
            <div class="error-box">
              <span class="field-label">Error</span>
              <p>{selectedJob.error}</p>
            </div>
          {/if}
        </div>

        <div class="live-card card">
          <div class="card-header">
            <span class="card-title">Events & Output</span>
            <span class="stream-affordance {shouldPollEvents ? 'live' : ''}">
              {shouldPollEvents ? 'Polling live events' : 'Event replay'}
            </span>
          </div>

          {#if latestEvent}
            <div class="latest-event">
              <span class="latest-label">Latest</span>
              <span>{eventSummary(latestEvent.type, latestEvent.message)}</span>
              <span class="latest-time">{relativeTime(latestEvent.timestamp)}</span>
            </div>
          {/if}

          {#if outputPreview}
            <pre class="output-preview">{outputPreview}</pre>
          {:else}
            <div class="output-empty">No streamed output chunks captured for this job yet.</div>
          {/if}

          <div class="event-list">
            {#if eventsLoading}
              <div class="event-empty">Loading persisted events...</div>
            {:else if eventsError}
              <div class="event-empty error-text">{eventsError}</div>
            {:else if events.length === 0}
              <div class="event-empty">No persisted events for this job.</div>
            {:else}
              {#each events as event (event.id)}
                <div class="event-row">
                  <span class="event-sequence">#{event.sequence}</span>
                  <span class="event-type">{event.type}</span>
                  <span class="event-message">{eventSummary(event.type, event.message)}</span>
                  <span class="event-time">{relativeTime(event.timestamp)}</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      {:else}
        <div class="empty-state">
          No runtime job selected.
          <a href="/runner" class="btn btn-primary btn-sm">Start a run</a>
        </div>
      {/if}
    </section>
  </div>
{/if}

<style>
  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .loaded-at,
  .panel-count {
    color: var(--color-text-faint);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .ops-strip {
    display: grid;
    grid-template-columns: repeat(5, minmax(120px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .ops-card {
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
  }

  .ops-card.active {
    border-color: rgba(74,158,255,0.35);
    background: linear-gradient(135deg, rgba(74,158,255,0.12), rgba(74,158,255,0.03));
  }

  .ops-card.danger {
    border-color: rgba(224,90,90,0.28);
  }

  .ops-value {
    display: block;
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--text-2xl);
    font-weight: 700;
    line-height: 1;
  }

  .ops-label {
    display: block;
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    letter-spacing: 0.06em;
    margin-top: var(--space-2);
    text-transform: uppercase;
  }

  .filter-row {
    align-items: center;
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
    padding: var(--space-3);
  }

  .filter-label {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    margin-right: var(--space-2);
    text-transform: uppercase;
  }

  .filter-chip {
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-3);
    text-transform: capitalize;
  }

  .filter-chip:hover,
  .filter-chip.active {
    border-color: var(--color-brand);
    color: var(--color-brand);
  }

  .jobs-layout {
    display: grid;
    grid-template-columns: minmax(320px, 430px) minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
  }

  .jobs-panel {
    padding: var(--space-4);
  }

  .job-skeleton {
    height: 72px;
    margin-bottom: var(--space-2);
  }

  .job-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .job-row {
    align-items: stretch;
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: inherit;
    cursor: pointer;
    display: grid;
    grid-template-columns: 4px minmax(0, 1fr);
    overflow: hidden;
    padding: 0;
    text-align: left;
    transition: border-color var(--duration-fast), background var(--duration-fast);
  }

  .job-row:hover,
  .job-row.selected {
    background: var(--color-surface-2);
    border-color: var(--color-border-strong);
  }

  .status-rail {
    background: var(--color-text-muted);
  }

  .status-rail.success { background: var(--color-success); }
  .status-rail.danger { background: var(--color-danger); }
  .status-rail.warning { background: var(--color-warning); }
  .status-rail.sonnet { background: var(--color-sonnet); }

  .job-main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: var(--space-3);
  }

  .job-title,
  .job-meta {
    align-items: center;
    display: flex;
    gap: var(--space-2);
    min-width: 0;
  }

  .job-agent {
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 700;
  }

  .job-task {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .job-meta {
    color: var(--color-text-faint);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    flex-wrap: wrap;
  }

  .detail-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  .detail-card,
  .live-card {
    min-width: 0;
  }

  .detail-header {
    align-items: flex-start;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
    padding-bottom: var(--space-3);
  }

  .detail-eyebrow {
    color: var(--color-text-faint);
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .detail-header h2 {
    color: var(--color-text);
    font-size: var(--text-lg);
    margin: var(--space-1) 0 0;
  }

  .detail-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .danger-action:not(:disabled) {
    border-color: rgba(224,90,90,0.45);
    color: var(--color-danger);
  }

  .danger-action:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .detail-grid > div,
  .task-box,
  .error-box,
  .latest-event {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }

  .field-label {
    color: var(--color-text-faint);
    display: block;
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.06em;
    margin-bottom: var(--space-1);
    text-transform: uppercase;
  }

  code {
    color: var(--color-text);
    display: block;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .task-box p,
  .error-box p {
    color: var(--color-text-muted);
    margin: 0;
    white-space: pre-wrap;
  }

  .error-box,
  .inline-error {
    border-color: rgba(224,90,90,0.3);
    background: rgba(224,90,90,0.08);
  }

  .inline-error {
    border: 1px solid rgba(224,90,90,0.3);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-xs);
    margin-bottom: var(--space-3);
    padding: var(--space-2) var(--space-3);
  }

  .stream-affordance {
    color: var(--color-text-faint);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .stream-affordance.live {
    color: var(--color-success);
  }

  .stream-affordance.live::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: var(--space-2);
    border-radius: var(--radius-full);
    background: var(--color-success);
    box-shadow: 0 0 8px var(--color-success);
  }

  .latest-event {
    align-items: center;
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .latest-label {
    color: var(--color-brand);
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .latest-time {
    color: var(--color-text-faint);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    margin-left: auto;
  }

  .output-preview {
    background: #09090b;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.6;
    margin: 0 0 var(--space-4);
    max-height: 280px;
    overflow: auto;
    padding: var(--space-4);
    white-space: pre-wrap;
  }

  .output-empty,
  .event-empty,
  .empty-list {
    color: var(--color-text-faint);
    font-size: var(--text-sm);
    padding: var(--space-5);
    text-align: center;
  }

  .empty-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .empty-list a {
    color: var(--color-brand);
    text-decoration: none;
  }

  .event-list {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    max-height: 360px;
    overflow: auto;
  }

  .event-row {
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    display: grid;
    grid-template-columns: 64px 140px minmax(0, 1fr) 80px;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
  }

  .event-row:last-child {
    border-bottom: 0;
  }

  .event-sequence,
  .event-time {
    color: var(--color-text-faint);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .event-type {
    color: var(--color-brand);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .event-message {
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error-state {
    gap: var(--space-3);
  }

  .error-text {
    color: var(--color-danger);
  }

  @media (max-width: 1100px) {
    .ops-strip {
      grid-template-columns: repeat(2, minmax(120px, 1fr));
    }

    .jobs-layout {
      grid-template-columns: 1fr;
    }

    .detail-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .page-header,
    .detail-header {
      align-items: stretch;
      flex-direction: column;
    }

    .header-actions,
    .detail-actions {
      justify-content: flex-start;
    }

    .filter-row {
      overflow-x: auto;
    }

    .detail-grid {
      grid-template-columns: 1fr;
    }

    .event-row {
      grid-template-columns: 48px 1fr;
    }

    .event-message,
    .event-time {
      grid-column: 2;
    }
  }
</style>
