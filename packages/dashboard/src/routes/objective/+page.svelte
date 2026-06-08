<script lang="ts">
  import { goto } from '$app/navigation';
  import { browser } from '$app/environment';
  import { Btn, Badge, Card } from '$lib/components/v2';
  import { withWorkspace } from '$lib/stores/workspace';

  // ── State ─────────────────────────────────────────────────────────────────
  let objective = $state('');
  let budgetUsd = $state<number>(50);
  let launching = $state(false);
  let launchError = $state<string | null>(null);
  let validationError = $state<string | null>(null);

  // ── Validation ────────────────────────────────────────────────────────────
  const objectiveTrimmed = $derived(objective.trim());
  const canLaunch = $derived(
    !launching &&
    objectiveTrimmed.length > 0 &&
    budgetUsd > 0,
  );

  function validate(): string | null {
    if (objectiveTrimmed.length === 0) return 'Objective must not be empty.';
    if (budgetUsd <= 0 || !Number.isFinite(budgetUsd)) return 'Budget must be a positive number.';
    return null;
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleLaunch(): Promise<void> {
    if (launching) return;
    validationError = null;
    launchError = null;

    const clientErr = validate();
    if (clientErr) { validationError = clientErr; return; }

    launching = true;
    try {
      const res = await fetch(withWorkspace('/api/v5/cycles'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: objectiveTrimmed, budgetUsd }),
      });

      if (res.status !== 202 && !res.ok) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        let msg = text || `HTTP ${res.status}`;
        // Try to extract a structured error message from JSON
        try {
          const json = JSON.parse(text) as { error?: string; message?: string };
          msg = json.error ?? json.message ?? msg;
        } catch {
          // raw text is fine
        }
        launchError = msg;
        launching = false;
        return;
      }

      const json = (await res.json()) as { cycleId?: string; id?: string };
      const newId = json.cycleId ?? json.id;
      if (!newId) {
        launchError = 'Server did not return a cycleId.';
        launching = false;
        return;
      }

      if (browser) {
        await goto(`/cycles/${newId}`);
      }
    } catch (e) {
      launchError = e instanceof Error ? e.message : String(e);
      launching = false;
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleLaunch();
    }
  }
</script>

<svelte:head><title>Launch Objective — AgentForge</title></svelte:head>

<!-- ── Page header ──────────────────────────────────────────────────────── -->
<div class="page-head">
  <div>
    <div class="crumbs af2-mono">Workspace · Objective</div>
    <h1 class="page-title">Launch objective cycle</h1>
    <p class="page-sub">
      Describe what you want built. AgentForge plans and executes it autonomously.
    </p>
  </div>
  <div class="head-actions">
    <Btn size="sm" href="/cycles">← Cancel</Btn>
  </div>
</div>

<!-- ── Form card ─────────────────────────────────────────────────────────── -->
<div class="launch-layout">
  <Card>
    <div class="section-title">OBJECTIVE</div>

    <!-- Objective textarea -->
    <div class="field" style="margin-top:12px">
      <label class="field-label" for="objective-input">
        What should AgentForge build or fix?
      </label>
      <textarea
        id="objective-input"
        class="field-textarea"
        rows={6}
        placeholder="e.g. Add OAuth2 login with Google, implement rate limiting on the /api/v5 routes, or fix all failing tests in packages/server…"
        bind:value={objective}
        disabled={launching}
        onkeydown={handleKeydown}
      ></textarea>
      <div class="char-count af2-mono">{objectiveTrimmed.length} chars</div>
    </div>

    <!-- Budget input -->
    <div class="field">
      <label class="field-label" for="budget-input">Budget (USD)</label>
      <div class="budget-row">
        <input
          id="budget-slider"
          type="range"
          min="5"
          max="500"
          step="5"
          bind:value={budgetUsd}
          class="slider"
          disabled={launching}
          aria-label="Budget slider"
        />
        <input
          id="budget-input"
          type="number"
          min="1"
          step="1"
          bind:value={budgetUsd}
          class="budget-num af2-mono"
          disabled={launching}
          aria-label="Budget in USD"
        />
      </div>
      <div class="budget-hint af2-mono">
        Maximum spend for this cycle. Execution stops when the cap is reached.
      </div>
    </div>

    <!-- Validation / launch error banners -->
    {#if validationError}
      <div class="banner banner--danger" role="alert">{validationError}</div>
    {/if}

    {#if launchError}
      <div class="banner banner--danger" role="alert">
        <span>Failed to launch: {launchError}</span>
        <Btn size="sm" onClick={() => (launchError = null)}>Dismiss</Btn>
      </div>
    {/if}

    <!-- Submit -->
    <div class="launch-row">
      <span class="hint">
        Ctrl+Enter to submit · creates a cycle and navigates to its detail page.
      </span>
      <Btn
        variant="purple"
        size="lg"
        disabled={!canLaunch}
        onClick={() => void handleLaunch()}
      >
        {#if launching}
          <span class="spinner"></span>
          Launching…
        {:else}
          ▶ Launch Objective
        {/if}
      </Btn>
    </div>
  </Card>

  <!-- ── Side info ─────────────────────────────────────────────────────── -->
  <div class="side-col">
    <Card>
      <div class="section-title">HOW IT WORKS</div>
      <ol class="steps">
        <li>
          <Badge variant="info">1</Badge>
          <span>
            AgentForge decomposes your objective into a backlog of actionable items.
          </span>
        </li>
        <li>
          <Badge variant="info">2</Badge>
          <span>
            Specialist agents implement each item concurrently in isolated worktrees.
          </span>
        </li>
        <li>
          <Badge variant="info">3</Badge>
          <span>
            A quality gate reviews tests and diffs; passing work is merged into a PR.
          </span>
        </li>
        <li>
          <Badge variant="info">4</Badge>
          <span>
            Learnings feed back into the team so each cycle improves on the last.
          </span>
        </li>
      </ol>
    </Card>

    <Card>
      <div class="section-title">SAFEGUARDS</div>
      <ul class="safeguards">
        <li>
          <Badge variant="success">on</Badge>
          Hard budget cap — stops at ${budgetUsd.toFixed(0)}
        </li>
        <li><Badge variant="success">on</Badge> Per-phase timeout</li>
        <li><Badge variant="success">on</Badge> Quality gate before PR creation</li>
        <li><Badge variant="success">on</Badge> Isolated agent worktrees</li>
      </ul>
    </Card>
  </div>
</div>

<style>
  /* ── Page header ──────────────────────────────────────────────────────── */
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 16px;
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

  .head-actions { display: flex; gap: 8px; }

  /* ── Layout ───────────────────────────────────────────────────────────── */
  .launch-layout {
    display: grid;
    grid-template-columns: 1.6fr 1fr;
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

  @media (max-width: 900px) {
    .launch-layout { grid-template-columns: 1fr; }
    .side-col { position: static; }
  }

  /* ── Section title ────────────────────────────────────────────────────── */
  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 12px;
  }

  /* ── Form fields ──────────────────────────────────────────────────────── */
  .field { margin-bottom: 16px; }

  .field-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 6px;
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
    line-height: 1.6;
    resize: vertical;
    min-height: 120px;
    box-sizing: border-box;
    outline: none;
    transition: border-color 150ms;
  }

  .field-textarea:focus { border-color: var(--af-purple); }
  .field-textarea:disabled { opacity: 0.5; cursor: not-allowed; }
  .field-textarea::placeholder { color: var(--af-faint); }

  .char-count {
    font-size: 10px;
    color: var(--af-faint);
    text-align: right;
    margin-top: 4px;
  }

  /* ── Budget row ───────────────────────────────────────────────────────── */
  .budget-row {
    display: grid;
    grid-template-columns: 1fr 80px;
    gap: 10px;
    align-items: center;
  }

  .slider {
    width: 100%;
    accent-color: var(--af-purple);
  }

  .budget-num {
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    padding: 6px 10px;
    font-size: 13px;
    text-align: right;
    height: 34px;
    box-sizing: border-box;
    outline: none;
    width: 100%;
    transition: border-color 150ms;
  }

  .budget-num:focus { border-color: var(--af-purple); }
  .budget-num:disabled { opacity: 0.5; cursor: not-allowed; }

  .budget-hint {
    font-size: 10px;
    color: var(--af-faint);
    margin-top: 6px;
  }

  /* ── Banners ──────────────────────────────────────────────────────────── */
  .banner {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    border: 1px solid;
    line-height: 1.5;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .banner--danger {
    color: var(--af-danger);
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border-color: color-mix(in srgb, var(--af-danger) 25%, transparent);
  }

  /* ── Launch row ───────────────────────────────────────────────────────── */
  .launch-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 14px;
    border-top: 1px solid var(--af-border);
  }

  .hint {
    flex: 1;
    font-size: 11px;
    color: var(--af-dim);
  }

  /* ── Spinner ──────────────────────────────────────────────────────────── */
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Steps list ───────────────────────────────────────────────────────── */
  .steps {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .steps li {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 12px;
    color: var(--af-text);
    line-height: 1.5;
  }

  /* ── Safeguards ───────────────────────────────────────────────────────── */
  .safeguards {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: var(--af-text);
  }

  .safeguards li {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }
</style>
