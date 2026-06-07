<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { withWorkspace } from '$lib/stores/workspace';
  import { Badge, Btn, Card } from '$lib/components/v2';
  import { onMount } from 'svelte';

  interface ObjectiveCycleRequest {
    objective: string;
    budgetUsd: number;
  }

  interface ObjectiveCycleResponse {
    cycleId: string;
  }

  interface BudgetBand {
    spendableUsd: number;
    lowerUsd: number;
    upperUsd: number;
  }

  let objective = $state('');
  let budgetUsd = $state(150);
  let submitting = $state(false);
  let error = $state<string | null>(null);

  const trimmedObjective = $derived(objective.trim());
  const budgetBand = $derived(computeBudgetBand(budgetUsd));
  const canSubmit = $derived(trimmedObjective.length > 0 && budgetUsd > 0 && !submitting);
  const budgetBandText = $derived(
    `Planner child estimates should total ${formatUsd(budgetBand.lowerUsd)}-${formatUsd(budgetBand.upperUsd)} ` +
      `(spendable ${formatUsd(budgetBand.spendableUsd)} after $6 judgment overhead and 20% fix-up reserve).`,
  );

  function computeBudgetBand(value: number): BudgetBand {
    const spendableUsd = Math.max(0, (Number.isFinite(value) ? value - 6 : 0) / 1.2);
    return {
      spendableUsd,
      lowerUsd: spendableUsd * 0.7,
      upperUsd: spendableUsd,
    };
  }

  function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  function validate(): string | null {
    if (trimmedObjective.length === 0) return 'Enter an objective before launching a cycle.';
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return 'Budget must be a positive USD amount.';
    return null;
  }

  async function createObjectiveCycle(input: ObjectiveCycleRequest): Promise<ObjectiveCycleResponse> {
    const res = await fetch(withWorkspace('/api/v5/cycles'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: input.objective,
        budgetUsd: input.budgetUsd,
        tags: ['objective'],
        fastMode: true,
        fallbackEnabled: true,
      }),
    });

    if (res.status !== 202 && !res.ok) {
      const text = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(text || `HTTP ${res.status}`);
    }

    const json = (await res.json()) as { cycleId?: string; id?: string };
    const cycleId = json.cycleId ?? json.id;
    if (!cycleId) throw new Error('Server did not return a cycleId');
    return { cycleId };
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    error = validate();
    if (error) return;

    submitting = true;
    try {
      const created = await createObjectiveCycle({
        objective: trimmedObjective,
        budgetUsd,
      });
      await goto(`/cycles/${created.cycleId}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      submitting = false;
    }
  }

  onMount(() => {
    if (!browser) return;
    document.getElementById('objective')?.focus();
  });
</script>

<svelte:head><title>Objective Cycle - AgentForge</title></svelte:head>

<div class="page-head">
  <div>
    <div class="crumbs af2-mono">Workspace / Objective</div>
    <h1 class="page-title">Launch objective cycle</h1>
    <p class="page-sub">Describe the outcome; AgentForge decomposes it into a budget-aware epic cycle.</p>
  </div>
  <Btn size="sm" href="/cycles">Cycles</Btn>
</div>

<div class="objective-grid">
  <Card>
    <form class="objective-form" onsubmit={handleSubmit}>
      <div class="section-head">
        <div>
          <div class="section-title">OBJECTIVE</div>
          <p class="hint">This launches an objective-driven autonomous cycle.</p>
        </div>
        <Badge variant="info">Epic</Badge>
      </div>

      <div class="field">
        <label class="field-label" for="objective">Objective</label>
        <textarea
          id="objective"
          bind:value={objective}
          rows={8}
          class="textarea"
          placeholder="Build the smallest end-to-end improvement that..."
          disabled={submitting}
          aria-invalid={error?.includes('objective') ? 'true' : undefined}
        ></textarea>
      </div>

      <div class="field">
        <label class="field-label" for="budgetUsd">Budget (USD)</label>
        <input
          id="budgetUsd"
          type="number"
          min="1"
          step="1"
          bind:value={budgetUsd}
          class="budget-input af2-mono"
          disabled={submitting}
          aria-describedby="budget-band"
          aria-invalid={error?.includes('Budget') ? 'true' : undefined}
        />
        <p id="budget-band" class="budget-help">{budgetBandText}</p>
      </div>

      {#if error}
        <div class="error-row" role="alert">
          <span>{error}</span>
          <Btn size="sm" onClick={() => (error = null)}>Dismiss</Btn>
        </div>
      {/if}

      <div class="actions">
        <span class="hint">POST /api/v5/cycles receives the objective and budget.</span>
        <Btn type="submit" size="lg" variant="purple" disabled={!canSubmit}>
          {submitting ? 'Launching...' : 'Launch Objective Cycle'}
        </Btn>
      </div>
    </form>
  </Card>

  <Card>
    <div class="section-title">BUDGET BAND</div>
    <div class="band-stack">
      <div class="band-row">
        <span>Spendable</span>
        <strong class="af2-mono">{formatUsd(budgetBand.spendableUsd)}</strong>
      </div>
      <div class="band-row">
        <span>Minimum planned work</span>
        <strong class="af2-mono">{formatUsd(budgetBand.lowerUsd)}</strong>
      </div>
      <div class="band-row">
        <span>Maximum planned work</span>
        <strong class="af2-mono">{formatUsd(budgetBand.upperUsd)}</strong>
      </div>
    </div>
    <p class="hint band-note">
      The decomposer should fill 70%-100% of spendable funds with child work estimates.
    </p>
  </Card>
</div>

<style>
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
  }

  .crumbs {
    color: var(--af-dim);
    font-size: 11px;
    margin-bottom: 6px;
  }

  .page-title {
    margin: 0;
    color: var(--af-text);
    font-size: 28px;
    font-weight: 600;
    letter-spacing: 0;
  }

  .page-sub {
    margin: 8px 0 0;
    color: var(--af-muted);
    font-size: 14px;
    line-height: 1.5;
  }

  .objective-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 16px;
    align-items: start;
  }

  .objective-form,
  .field,
  .band-stack {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .objective-form {
    gap: 16px;
  }

  .section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .section-title {
    color: var(--af-dim);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .field-label {
    color: var(--af-muted);
    font-size: 12px;
    font-weight: 600;
  }

  .textarea,
  .budget-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--af-border2);
    border-radius: 8px;
    background: var(--af-surface2);
    color: var(--af-text);
    font: inherit;
    outline: none;
  }

  .textarea {
    min-height: 220px;
    resize: vertical;
    padding: 12px;
    line-height: 1.45;
  }

  .budget-input {
    max-width: 180px;
    padding: 9px 10px;
  }

  .textarea:focus,
  .budget-input:focus {
    border-color: var(--af-accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--af-accent) 14%, transparent);
  }

  .hint,
  .budget-help {
    margin: 0;
    color: var(--af-dim);
    font-size: 12px;
    line-height: 1.45;
  }

  .budget-help {
    max-width: 660px;
  }

  .error-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 1px solid color-mix(in srgb, var(--af-danger) 30%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    color: var(--af-danger);
    padding: 10px 12px;
    font-size: 13px;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .band-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--af-border);
    color: var(--af-muted);
    font-size: 13px;
    padding: 10px 0;
  }

  .band-row strong {
    color: var(--af-text);
    font-size: 13px;
  }

  .band-note {
    margin-top: 14px;
  }

  @media (max-width: 860px) {
    .page-head,
    .actions {
      flex-direction: column;
      align-items: stretch;
    }

    .objective-grid {
      grid-template-columns: 1fr;
    }

    .budget-input {
      max-width: none;
    }
  }
</style>
