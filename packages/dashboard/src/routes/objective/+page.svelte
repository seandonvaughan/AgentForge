<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { withWorkspace } from '$lib/stores/workspace';
  import { Btn, Card } from '$lib/components/v2';

  let objective = $state('');
  let budgetUsd = $state<number>(200);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let validationError = $state<string | null>(null);

  function validate(): boolean {
    validationError = null;
    if (!objective.trim()) {
      validationError = 'Objective is required.';
      return false;
    }
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      validationError = 'Budget must be greater than 0.';
      return false;
    }
    return true;
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    error = null;
    if (!validate() || !browser) return;

    submitting = true;
    try {
      const res = await fetch(withWorkspace('/api/v5/cycles'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objective: objective.trim(),
          budgetUsd,
        }),
      });

      if (res.status !== 202 && !res.ok) {
        error = await res.text().catch(() => `HTTP ${res.status}`);
        submitting = false;
        return;
      }

      const json = (await res.json()) as { cycleId?: string; id?: string };
      const cycleId = json.cycleId ?? json.id;
      if (!cycleId) {
        error = 'Server did not return a cycleId.';
        submitting = false;
        return;
      }

      await goto(`/cycles/${cycleId}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      submitting = false;
    }
  }
</script>

<svelte:head><title>Objective — AgentForge</title></svelte:head>

<div class="page-head">
  <div>
    <div class="crumbs af2-mono">Workspace · Objective</div>
    <h1 class="page-title">Launch objective cycle</h1>
    <p class="page-sub">Describe the outcome and budget for an autonomous cycle.</p>
  </div>
  <div class="head-actions">
    <Btn size="sm" href="/cycles">Cycles</Btn>
  </div>
</div>

<div class="objective-shell">
  <Card accent>
    <form aria-label="Launch objective cycle" class="objective-form" onsubmit={handleSubmit}>
      <div>
        <div class="section-title">OBJECTIVE</div>
        <label class="field-label" for="objective">Objective</label>
        <textarea
          id="objective"
          bind:value={objective}
          class:error={validationError != null}
          rows="7"
          placeholder="Launch an autonomous cycle that improves..."
          disabled={submitting}
          aria-describedby={validationError ? 'objective-validation' : undefined}
          oninput={() => (validationError = null)}
        ></textarea>
        {#if validationError}
          <div id="objective-validation" class="form-error" role="alert">{validationError}</div>
        {/if}
      </div>

      <div class="budget-row">
        <div>
          <label class="field-label" for="budgetUsd">Budget USD</label>
          <input
            id="budgetUsd"
            type="number"
            min="1"
            step="1"
            bind:value={budgetUsd}
            disabled={submitting}
          />
        </div>
        <div class="budget-note">
          <span class="af2-mono">POST</span>
          <span>/api/v5/cycles</span>
        </div>
      </div>

      {#if error}
        <div class="form-error" role="alert">{error}</div>
      {/if}

      <div class="actions">
        <Btn type="submit" variant="primary" disabled={submitting}>
          {submitting ? 'Launching...' : 'Launch cycle'}
        </Btn>
      </div>
    </form>
  </Card>
</div>

<style>
  .page-head {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 20px;
  }

  .crumbs {
    color: var(--af-muted);
    font-size: 11px;
    margin-bottom: 8px;
  }

  .page-title {
    margin: 0;
    font-size: 28px;
    line-height: 1.15;
    color: var(--af-text);
  }

  .page-sub {
    margin: 8px 0 0;
    color: var(--af-muted);
    font-size: 14px;
  }

  .head-actions {
    display: flex;
    gap: 8px;
  }

  .objective-shell {
    max-width: 760px;
  }

  .objective-form {
    display: grid;
    gap: 18px;
  }

  .section-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0;
    color: var(--af-muted);
    margin-bottom: 12px;
  }

  .field-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--af-text);
    margin-bottom: 6px;
  }

  textarea,
  input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--af-border2);
    border-radius: 8px;
    background: var(--af-surface2);
    color: var(--af-text);
    font: inherit;
  }

  textarea {
    min-height: 180px;
    padding: 12px;
    resize: vertical;
  }

  input {
    height: 38px;
    padding: 0 10px;
  }

  textarea:focus,
  input:focus {
    outline: none;
    border-color: var(--af-accent);
  }

  textarea.error {
    border-color: var(--af-danger);
  }

  .budget-row {
    display: grid;
    grid-template-columns: minmax(160px, 220px) 1fr;
    gap: 16px;
    align-items: end;
  }

  .budget-note {
    min-height: 38px;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--af-muted);
    font-size: 12px;
  }

  .form-error {
    color: var(--af-danger);
    font-size: 12px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  @media (max-width: 720px) {
    .page-head {
      flex-direction: column;
    }

    .budget-row {
      grid-template-columns: 1fr;
    }

    .actions {
      justify-content: stretch;
    }
  }
</style>
