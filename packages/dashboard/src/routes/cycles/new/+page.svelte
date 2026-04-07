<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';

  // ── Form state ────────────────────────────────────────────────────────────
  let budgetUsd = $state(25);
  let maxItems = $state(3);
  let dryRun = $state(false);
  let branchPrefix = $state('autonomous/');
  let comment = $state('');

  // ── Launch state ──────────────────────────────────────────────────────────
  let launching = $state(false);
  let launchError: string | null = $state(null);
  let cycleId: string | null = $state(null);
  let startedAt: number | null = $state(null);

  // ── Progress state ────────────────────────────────────────────────────────
  const STAGES = ['PLAN', 'STAGE', 'RUN', 'VERIFY', 'COMMIT', 'REVIEW'] as const;
  type Stage = typeof STAGES[number];
  type StageState = 'pending' | 'active' | 'complete';

  let stageStates = $state<Record<Stage, StageState>>({
    PLAN: 'pending', STAGE: 'pending', RUN: 'pending',
    VERIFY: 'pending', COMMIT: 'pending', REVIEW: 'pending',
  });

  let currentCost = $state(0);
  let elapsedSec = $state(0);
  let lastEventSeq = $state(0);
  let terminal = $state(false);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  // Derived elapsed display
  let elapsedDisplay = $derived(() => {
    const m = Math.floor(elapsedSec / 60).toString().padStart(2, '0');
    const s = (elapsedSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  });

  let burnPct = $derived(() => {
    if (!budgetUsd || budgetUsd <= 0) return 0;
    return Math.min(100, (currentCost / budgetUsd) * 100);
  });

  function setStage(stage: Stage, state: StageState) {
    stageStates[stage] = state;
  }

  function advanceTo(stage: Stage) {
    const idx = STAGES.indexOf(stage);
    if (idx < 0) return;
    for (let i = 0; i < STAGES.length; i++) {
      if (i < idx) stageStates[(STAGES[i] as Stage)] = 'complete';
      else if (i === idx) stageStates[(STAGES[i] as Stage)] = 'active';
      else stageStates[(STAGES[i] as Stage)] = 'pending';
    }
  }

  function completeAll() {
    for (const s of STAGES) stageStates[s] = 'complete';
  }

  function applyEvent(ev: any) {
    if (!ev || typeof ev !== 'object') return;
    const type: string = (ev.type ?? ev.event ?? '').toString().toLowerCase();
    const stage: string | undefined = (ev.stage ?? ev.phase ?? '').toString().toUpperCase();

    if (typeof ev.costUsd === 'number') currentCost = ev.costUsd;
    else if (typeof ev.totalCost === 'number') currentCost = ev.totalCost;
    else if (typeof ev.cost === 'number') currentCost = ev.cost;

    if (stage && (STAGES as readonly string[]).includes(stage)) {
      if (type.includes('complete') || type.includes('end') || type.includes('finish')) {
        setStage(stage as Stage, 'complete');
      } else if (type.includes('start') || type.includes('begin') || type.includes('enter')) {
        advanceTo(stage as Stage);
      } else {
        // generic stage event — make it at least active
        if (stageStates[stage as Stage] === 'pending') advanceTo(stage as Stage);
      }
    }

    if (type.includes('cycle_complete') || type.includes('done') || type === 'complete' || type === 'terminal') {
      completeAll();
      terminal = true;
    }
    if (type.includes('cycle_failed') || type.includes('failed') || type.includes('error')) {
      terminal = true;
    }
  }

  async function pollEvents() {
    if (!cycleId) return;
    try {
      const res = await fetch(`/api/v5/cycles/${cycleId}/events?since=${lastEventSeq}`);
      if (!res.ok) return;
      const body = await res.json();
      const events: any[] = Array.isArray(body) ? body : (body.events ?? body.data ?? []);
      for (const ev of events) {
        applyEvent(ev);
        if (typeof ev.seq === 'number') lastEventSeq = Math.max(lastEventSeq, ev.seq + 1);
        else lastEventSeq += 1;
      }
      // Also fetch the cycle for cost/stage if available
      const r2 = await fetch(`/api/v5/cycles/${cycleId}`);
      if (r2.ok) {
        const cy = await r2.json();
        const stage = (cy.stage ?? cy.currentStage ?? '').toString().toUpperCase();
        if (stage && (STAGES as readonly string[]).includes(stage)) advanceTo(stage as Stage);
        if (typeof cy.costUsd === 'number') currentCost = cy.costUsd;
        else if (typeof cy.totalCost === 'number') currentCost = cy.totalCost;
        const status = (cy.status ?? '').toString().toLowerCase();
        if (status === 'complete' || status === 'completed' || status === 'success') {
          completeAll();
          terminal = true;
        }
        if (status === 'failed' || status === 'error') terminal = true;
      }
    } catch {
      // silent — keep polling
    }

    if (terminal && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function handleLaunch() {
    if (launching) return;
    launchError = null;
    launching = true;

    try {
      const res = await fetch('/api/v5/cycles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          budgetUsd,
          maxItems,
          dryRun,
          branchPrefix,
          comment,
        }),
      });

      if (res.status !== 202 && !res.ok) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        launchError = text || `HTTP ${res.status}`;
        launching = false;
        return;
      }

      const body = await res.json();
      cycleId = body.cycleId ?? body.id ?? null;
      startedAt = body.startedAt ? new Date(body.startedAt).getTime() : Date.now();

      if (!cycleId) {
        launchError = 'Server did not return a cycleId';
        launching = false;
        return;
      }

      // Begin polling
      advanceTo('PLAN');
      pollTimer = setInterval(pollEvents, 1000);
      tickTimer = setInterval(() => {
        if (startedAt) elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      }, 1000);
      // Kick first poll immediately
      pollEvents();
    } catch (e) {
      launchError = String(e);
      launching = false;
    }
  }

  function viewDetails() {
    if (cycleId) goto(`/cycles/${cycleId}`);
  }

  function shortId(id: string): string {
    return id.length > 12 ? id.slice(0, 12) : id;
  }

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
  });
</script>

<svelte:head><title>Launch Cycle — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Launch Autonomous Cycle</h1>
    <p class="page-subtitle">
      Plan → Stage → Run → Verify → Commit → Review via a detached Claude Code session
    </p>
  </div>
</div>

{#if !cycleId}
  <!-- ── Config Form ──────────────────────────────────────────────────────── -->
  <div class="card form-card">
    <div class="card-header">
      <span class="card-title">Cycle Configuration</span>
    </div>

    <div class="form-grid">
      <div class="form-group">
        <label class="form-label" for="budget">Budget (USD)</label>
        <input id="budget" type="number" class="form-input" min="0" step="0.5" bind:value={budgetUsd} disabled={launching} />
      </div>

      <div class="form-group">
        <label class="form-label" for="maxItems">Max items / sprint</label>
        <input id="maxItems" type="number" class="form-input" min="1" step="1" bind:value={maxItems} disabled={launching} />
      </div>

      <div class="form-group">
        <label class="form-label" for="branchPrefix">Branch prefix</label>
        <input id="branchPrefix" type="text" class="form-input" bind:value={branchPrefix} disabled={launching} />
      </div>

      <div class="form-group toggle-group">
        <label class="checkbox-label" title="Skip PR creation">
          <input type="checkbox" bind:checked={dryRun} disabled={launching} />
          <span>Dry run</span>
          <span class="hint">(skip PR creation)</span>
        </label>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="comment">Cycle comment / purpose (optional)</label>
      <textarea
        id="comment"
        class="form-textarea"
        rows={3}
        placeholder="Why are you running this cycle? (e.g. ‘ship v6.5 dashboard refresh’)"
        bind:value={comment}
        disabled={launching}
      ></textarea>
    </div>

    <p class="future-note">
      Note: advanced overrides (per-agent budgets, model pinning, custom workflow) are future work.
    </p>

    {#if launchError}
      <div class="error-msg">
        Failed to launch: {launchError}
        <button class="btn btn-ghost btn-sm retry-btn" onclick={() => (launchError = null)}>Dismiss</button>
      </div>
    {/if}

    <button class="btn btn-primary launch-btn" onclick={handleLaunch} disabled={launching}>
      {#if launching}Launching…{:else}Run Cycle{/if}
    </button>
  </div>
{:else}
  <!-- ── Live Progress ────────────────────────────────────────────────────── -->
  <div class="card progress-card">
    <div class="card-header">
      <span class="card-title">Cycle {shortId(cycleId)} — Live</span>
      <span class="elapsed-clock">{elapsedDisplay()}</span>
    </div>

    <div class="stage-row">
      {#each STAGES as stage, i}
        <div class="stage-pill {stageStates[stage]}">
          <span class="stage-num">{i + 1}</span>
          <span class="stage-name">{stage}</span>
          {#if stageStates[stage] === 'complete'}
            <span class="stage-check">✓</span>
          {/if}
        </div>
        {#if i < STAGES.length - 1}
          <div class="stage-connector {stageStates[(STAGES[i] as Stage)] === 'complete' ? 'done' : ''}"></div>
        {/if}
      {/each}
    </div>

    <div class="burn-section">
      <div class="burn-label">
        <span>Budget burn</span>
        <span class="burn-amount">${currentCost.toFixed(2)} / ${budgetUsd.toFixed(2)}</span>
      </div>
      <div class="burn-bar">
        <div class="burn-fill" style="width: {burnPct()}%"></div>
      </div>
    </div>

    {#if launchError}
      <div class="error-msg">{launchError}</div>
    {/if}

    <div class="progress-actions">
      {#if terminal}
        <button class="btn btn-primary" onclick={viewDetails}>View details →</button>
      {:else}
        <button class="btn btn-ghost" onclick={viewDetails}>Open detail view</button>
        <span class="polling-hint">Polling every 1s…</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .form-card, .progress-card {
    max-width: 820px;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }

  .form-group { margin-bottom: var(--space-4); }
  .toggle-group { display: flex; align-items: flex-end; }

  .form-label {
    display: block;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text-muted);
    margin-bottom: var(--space-2);
  }

  .form-input, .form-textarea {
    width: 100%;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    box-sizing: border-box;
    transition: border-color var(--duration-fast);
  }
  .form-input:focus, .form-textarea:focus { outline: none; border-color: var(--color-brand); }
  .form-textarea { resize: vertical; min-height: 72px; }

  .checkbox-label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--color-text);
    cursor: pointer;
  }
  .checkbox-label .hint {
    color: var(--color-text-faint);
    font-size: var(--text-xs);
  }

  .future-note {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    margin: 0 0 var(--space-3) 0;
    font-style: italic;
  }

  .launch-btn {
    width: 100%;
    justify-content: center;
    padding: var(--space-3) var(--space-4);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .error-msg {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-xs);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .retry-btn { margin-left: auto; }

  /* ── Stage row ──────────────────────────────────────────────────────────── */
  .stage-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-5) 0 var(--space-5) 0;
    flex-wrap: wrap;
  }

  .stage-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-full);
    border: 1px solid var(--color-border);
    background: var(--color-surface-1);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    transition: all var(--duration-fast);
  }
  .stage-pill .stage-num {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--color-surface-3);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-family: var(--font-mono);
  }

  .stage-pill.active {
    color: var(--color-info);
    border-color: rgba(74,158,255,0.5);
    background: rgba(74,158,255,0.08);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .stage-pill.active .stage-num {
    background: var(--color-info);
    color: white;
  }

  .stage-pill.complete {
    color: var(--color-success);
    border-color: rgba(76,175,130,0.5);
    background: rgba(76,175,130,0.08);
  }
  .stage-pill.complete .stage-num {
    background: var(--color-success);
    color: white;
  }
  .stage-check {
    color: var(--color-success);
    font-weight: 700;
  }

  .stage-connector {
    flex: 0 0 16px;
    height: 2px;
    background: var(--color-border);
    border-radius: 1px;
  }
  .stage-connector.done { background: var(--color-success); }

  /* ── Burn bar ───────────────────────────────────────────────────────────── */
  .burn-section { margin: var(--space-4) 0; }
  .burn-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-bottom: var(--space-2);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .burn-amount {
    color: var(--color-text);
    font-family: var(--font-mono);
    text-transform: none;
    letter-spacing: 0;
  }
  .burn-bar {
    width: 100%;
    height: 8px;
    background: var(--color-surface-2);
    border-radius: var(--radius-full);
    overflow: hidden;
    border: 1px solid var(--color-border);
  }
  .burn-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--color-success), var(--color-info));
    transition: width var(--duration-normal) var(--easing-default);
  }

  .elapsed-clock {
    font-family: var(--font-mono);
    font-size: var(--text-md);
    color: var(--color-brand);
    font-weight: 600;
  }

  .progress-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }
  .polling-hint {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-style: italic;
  }
</style>
