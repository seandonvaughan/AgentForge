<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { Btn, Card, Badge } from '$lib/components/v2';
  import { createObjectiveCycle } from '$lib/api/epic.js';

  // ── Form state ────────────────────────────────────────────────────────────────
  let objective = $state('');
  let budgetUsd = $state<number>(50);

  // ── Validation state ──────────────────────────────────────────────────────────
  let objectiveTouched = $state(false);
  let budgetTouched = $state(false);

  let objectiveError = $derived.by(() => {
    if (!objectiveTouched) return null;
    if (!objective.trim()) return 'Objective is required.';
    return null;
  });

  let budgetError = $derived.by(() => {
    if (!budgetTouched) return null;
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return 'Budget must be a positive number.';
    return null;
  });

  let formValid = $derived(
    objective.trim().length > 0 &&
    Number.isFinite(budgetUsd) &&
    budgetUsd > 0,
  );

  // ── Submission state ──────────────────────────────────────────────────────────
  let submitting = $state(false);
  let submitError: string | null = $state(null);

  async function handleSubmit(): Promise<void> {
    // Mark all fields as touched to surface any remaining errors.
    objectiveTouched = true;
    budgetTouched = true;

    if (!formValid || submitting) return;

    submitting = true;
    submitError = null;

    try {
      const created = await createObjectiveCycle({
        objective: objective.trim(),
        budgetUsd,
      });
      if (browser) {
        await goto(`/cycles/${created.id}`);
      }
    } catch (e) {
      submitError = e instanceof Error ? e.message : String(e);
      submitting = false;
    }
  }
</script>

<svelte:head><title>Launch Objective Cycle — AgentForge</title></svelte:head>

<!-- ── Page header ──────────────────────────────────────────────────────────── -->
<div class="page-header">
  <div>
    <div class="crumbs af2-mono">Workspace · Cycles · Objective</div>
    <h1 class="page-title">Launch objective cycle</h1>
    <p class="page-sub">
      Describe a high-level objective and budget — AgentForge will decompose and execute it autonomously.
    </p>
  </div>
  <div class="head-actions">
    <Btn size="sm" href="/cycles">← Back to Cycles</Btn>
  </div>
</div>

<!-- ── Form card ─────────────────────────────────────────────────────────────── -->
<div class="form-layout">
  <Card>
    <div class="section-title">OBJECTIVE CONFIGURATION</div>

    <!-- Objective textarea -->
    <div class="field" style="margin-top:14px">
      <label class="field-label" for="objective-input">
        Objective
        <span class="field-required" aria-hidden="true">*</span>
      </label>
      <textarea
        id="objective-input"
        class="field-textarea"
        class:field-textarea--error={!!objectiveError}
        rows={5}
        placeholder="Describe what you want the cycle to accomplish, e.g. 'Add OAuth2 SSO login with GitHub and Google to the dashboard'"
        bind:value={objective}
        disabled={submitting}
        onblur={() => (objectiveTouched = true)}
        onkeydown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
      ></textarea>
      {#if objectiveError}
        <div class="field-error" role="alert">{objectiveError}</div>
      {/if}
    </div>

    <!-- Budget number input -->
    <div class="field">
      <label class="field-label" for="budget-input">
        Budget (USD)
        <span class="field-required" aria-hidden="true">*</span>
      </label>
      <div class="budget-row">
        <span class="budget-prefix af2-mono">$</span>
        <input
          id="budget-input"
          class="field-number af2-mono"
          class:field-number--error={!!budgetError}
          type="number"
          min="0.01"
          step="0.01"
          bind:value={budgetUsd}
          disabled={submitting}
          onblur={() => (budgetTouched = true)}
          aria-label="Budget in USD"
        />
      </div>
      {#if budgetError}
        <div class="field-error" role="alert">{budgetError}</div>
      {/if}
      <p class="field-hint">
        The cycle will stop automatically when this budget is reached.
      </p>
    </div>

    <!-- Error banner -->
    {#if submitError}
      <div class="banner banner--danger" role="alert" style="margin-bottom:14px">
        <strong>Launch failed:</strong> {submitError}
      </div>
    {/if}

    <!-- Submit button -->
    <div class="submit-row">
      <span class="submit-hint">
        Press <kbd>Ctrl+Enter</kbd> to launch
      </span>
      <Btn
        variant="purple"
        size="lg"
        disabled={submitting}
        onClick={() => void handleSubmit()}
      >
        {#if submitting}
          <span class="spinner"></span>
          Launching…
        {:else}
          ▶ Launch Objective Cycle
        {/if}
      </Btn>
    </div>
  </Card>

  <!-- ── Info sidebar ──────────────────────────────────────────────────────── -->
  <div class="side-col">
    <Card>
      <div class="section-title">HOW IT WORKS</div>
      <ol class="how-list">
        <li>
          <Badge variant="info">1</Badge>
          <span>Your objective is decomposed into sprint items by the planning phase.</span>
        </li>
        <li>
          <Badge variant="info">2</Badge>
          <span>Specialist agents execute each item in parallel within the budget.</span>
        </li>
        <li>
          <Badge variant="info">3</Badge>
          <span>A gate review validates the result and creates a PR on success.</span>
        </li>
      </ol>
    </Card>

    <Card>
      <div class="section-title">TIPS</div>
      <ul class="tips-list">
        <li>Be specific — include file paths, interfaces, or acceptance criteria when you can.</li>
        <li>Budget $30–$100 is typical for a medium-sized objective (5–15 items).</li>
        <li>The cycle halts if the budget is exhausted before all items complete.</li>
      </ul>
    </Card>
  </div>
</div>

<style>
  /* ── Page header ────────────────────────────────────────────────────────── */
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 20px;
    gap: 16px;
    flex-wrap: wrap;
  }

  .crumbs {
    font-size: 11px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    margin-bottom: 4px;
  }

  .page-title {
    font-size: 22px;
    font-weight: 700;
    margin: 0;
    letter-spacing: -0.02em;
    color: var(--af-text);
  }

  .page-sub {
    font-size: 12px;
    color: var(--af-dim);
    margin: 4px 0 0;
  }

  .head-actions {
    display: flex;
    gap: 8px;
  }

  /* ── Layout ─────────────────────────────────────────────────────────────── */
  .form-layout {
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: 14px;
    align-items: start;
  }

  .side-col {
    display: flex;
    flex-direction: column;
    gap: 12px;
    position: sticky;
    top: 0;
  }

  @media (max-width: 860px) {
    .form-layout { grid-template-columns: 1fr; }
    .side-col { position: static; }
  }

  /* ── Section title ──────────────────────────────────────────────────────── */
  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  /* ── Form fields ────────────────────────────────────────────────────────── */
  .field {
    margin-bottom: 18px;
  }

  .field-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 7px;
  }

  .field-required {
    color: var(--af-danger);
    margin-left: 2px;
  }

  .field-textarea {
    width: 100%;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    padding: 10px 12px;
    font-size: 13px;
    font-family: inherit;
    line-height: 1.55;
    resize: vertical;
    min-height: 120px;
    box-sizing: border-box;
    outline: none;
    transition: border-color 150ms;
  }

  .field-textarea:focus { border-color: var(--af-purple); }

  .field-textarea:disabled { opacity: 0.55; cursor: not-allowed; }

  .field-textarea::placeholder { color: var(--af-faint); }

  .field-textarea--error { border-color: var(--af-danger); }

  .budget-row {
    display: flex;
    align-items: center;
    gap: 0;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    overflow: hidden;
    transition: border-color 150ms;
    width: 180px;
  }

  .budget-row:focus-within { border-color: var(--af-purple); }

  .budget-prefix {
    padding: 7px 10px;
    font-size: 13px;
    color: var(--af-muted);
    background: var(--af-surface);
    border-right: 1px solid var(--af-border2);
    flex-shrink: 0;
  }

  .field-number {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--af-text);
    padding: 7px 10px;
    font-size: 13px;
    outline: none;
    min-width: 0;
  }

  .field-number:disabled { opacity: 0.55; cursor: not-allowed; }

  .field-number--error + .budget-prefix,
  .budget-row:has(.field-number--error) { border-color: var(--af-danger); }

  .field-error {
    margin-top: 5px;
    font-size: 11px;
    color: var(--af-danger);
  }

  .field-hint {
    margin: 5px 0 0;
    font-size: 11px;
    color: var(--af-faint);
  }

  /* ── Banners ────────────────────────────────────────────────────────────── */
  .banner {
    padding: 10px 14px;
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

  /* ── Submit row ─────────────────────────────────────────────────────────── */
  .submit-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--af-border);
  }

  .submit-hint {
    font-size: 11px;
    color: var(--af-faint);
  }

  kbd {
    display: inline-block;
    padding: 1px 5px;
    font-family: var(--af-font-mono, monospace);
    font-size: 10px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 3px;
    color: var(--af-dim);
  }

  /* ── Spinner ────────────────────────────────────────────────────────────── */
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: middle;
    margin-right: 4px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Info sidebar ───────────────────────────────────────────────────────── */
  .how-list {
    list-style: none;
    padding: 0;
    margin: 12px 0 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .how-list li {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 12px;
    color: var(--af-muted);
    line-height: 1.5;
  }

  .tips-list {
    list-style: disc;
    padding-left: 18px;
    margin: 12px 0 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: var(--af-muted);
    line-height: 1.5;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }
</style>
