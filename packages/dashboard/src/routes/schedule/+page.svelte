<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import type { PageData } from './$types';
  import { Card, Btn, KpiTile } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  interface Schedule {
    id: string;
    name: string;
    cronExpression: string;
    cycleConfig: Record<string, unknown>;
    enabled: boolean;
    lastRunAt: string | null;
    nextRunAt: string | null;
    createdAt: string;
  }

  interface SchedulesResponse {
    data: Schedule[];
    meta: { total: number; timestamp: string };
  }

  let schedules: Schedule[] = $state((data.data ?? []) as Schedule[]);
  let loading = $state(schedules.length === 0);
  let error: string | null = $state(null);
  let saving = $state(false);
  let deleteId: string | null = $state(null);
  let formName = $state('');
  let formCron = $state('0 */6 * * *');
  let formEnabled = $state(true);
  let formConfig = $state('{}');
  let formError: string | null = $state(null);

  const cronValid = $derived(isValidCron(formCron));
  const nextRuns = $derived(cronValid ? computeNextRuns(formCron, 5) : []);

  let interval: ReturnType<typeof setInterval> | null = null;

  function humanizeCron(expr: string): string {
    const presets: Record<string, string> = {
      '0 * * * *': 'Every hour', '0 */2 * * *': 'Every 2 hours',
      '0 */6 * * *': 'Every 6 hours', '0 */12 * * *': 'Every 12 hours',
      '0 0 * * *': 'Daily at midnight', '0 9 * * *': 'Daily at 9am',
      '0 0 * * 1': 'Weekly on Monday', '0 0 1 * *': 'Monthly on 1st',
      '*/15 * * * *': 'Every 15 minutes', '*/30 * * * *': 'Every 30 minutes',
    };
    return presets[expr.trim()] ?? expr;
  }

  function isValidCron(expr: string): boolean {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    return fields.every(f => /^(\*|(\d+(-\d+)?)(,(\d+(-\d+)?))*)(\/\d+)?$/.test(f));
  }

  function computeNextRuns(expr: string, count: number): string[] {
    const results: string[] = [];
    if (!isValidCron(expr)) return results;
    let d = new Date(); d.setSeconds(0, 0);
    let attempts = 0;
    while (results.length < count && attempts < 10000) {
      d = new Date(d.getTime() + 60_000);
      if (cronMatches(expr, d)) results.push(d.toLocaleString());
      attempts++;
    }
    return results;
  }

  function cronMatches(expr: string, d: Date): boolean {
    const [min, hr, dom, mon, dow] = expr.trim().split(/\s+/);
    return fieldMatches(min, d.getMinutes()) && fieldMatches(hr, d.getHours()) &&
      fieldMatches(dom, d.getDate()) && fieldMatches(mon, d.getMonth() + 1) && fieldMatches(dow, d.getDay());
  }

  function fieldMatches(field: string, value: number): boolean {
    if (field === '*') return true;
    if (field.includes('/')) {
      const [base, step] = field.split('/');
      const stepN = parseInt(step, 10);
      if (base === '*') return value % stepN === 0;
      return (value - parseInt(base, 10)) % stepN === 0 && value >= parseInt(base, 10);
    }
    if (field.includes(',')) return field.split(',').some(f => fieldMatches(f, value));
    if (field.includes('-')) { const [lo, hi] = field.split('-').map(Number); return value >= lo && value <= hi; }
    return parseInt(field, 10) === value;
  }

  async function fetchSchedules() {
    if (browser && document.visibilityState === 'hidden') return;
    try {
      const res = await fetch('/api/v5/schedules');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as SchedulesResponse;
      schedules = body.data as Schedule[];
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load schedules';
    } finally { loading = false; }
  }

  async function toggleEnabled(s: Schedule) {
    try {
      await fetch(`/api/v5/schedules/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) });
      await fetchSchedules();
    } catch { /* silent */ }
  }

  async function deleteSchedule(id: string) {
    deleteId = id;
    try { await fetch(`/api/v5/schedules/${id}`, { method: 'DELETE' }); await fetchSchedules(); }
    catch { /* silent */ } finally { deleteId = null; }
  }

  async function createSchedule() {
    formError = null;
    if (!formName.trim()) { formError = 'Name is required'; return; }
    if (!cronValid) { formError = 'Enter a valid 5-field cron expression'; return; }
    let cycleConfig: Record<string, unknown> = {};
    try { cycleConfig = JSON.parse(formConfig); } catch { formError = 'Cycle config must be valid JSON'; return; }
    saving = true;
    try {
      const res = await fetch('/api/v5/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: formName.trim(), cronExpression: formCron.trim(), cycleConfig, enabled: formEnabled }) });
      if (!res.ok) { const body = await res.json() as { error?: string }; formError = body.error ?? 'Failed'; return; }
      formName = ''; formCron = '0 */6 * * *'; formEnabled = true; formConfig = '{}';
      await fetchSchedules();
    } catch (e) { formError = e instanceof Error ? e.message : 'Failed'; } finally { saving = false; }
  }

  function fmtRel(iso: string | null): string {
    if (!iso) return '—';
    try {
      const diff = Date.now() - new Date(iso).getTime();
      const s = Math.floor(diff / 1000);
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
      return new Date(iso).toLocaleDateString();
    } catch { return iso; }
  }

  function fmtAbs(iso: string | null): string {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  const activeCount = $derived(schedules.filter(s => s.enabled).length);

  onMount(() => {
    if (schedules.length === 0) fetchSchedules();
    interval = setInterval(fetchSchedules, 30_000);
    if (browser) document.addEventListener('visibilitychange', fetchSchedules);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
    if (browser) document.removeEventListener('visibilitychange', fetchSchedules);
  });
</script>

<div class="page">
  <div class="page-header">
    <div>
      <div class="crumbs">Workspace / Schedule</div>
      <h1 class="page-title">Scheduled cycles</h1>
      <p class="page-sub"><span class="font-mono">{activeCount}</span> active · <span class="font-mono">{schedules.length}</span> total</p>
    </div>
  </div>

  <div class="kpi-row">
    <KpiTile label="Total" value={schedules.length} color="var(--af-text)" />
    <KpiTile label="Active" value={activeCount} color="var(--af-success)" live={activeCount > 0} />
    <KpiTile label="Paused" value={schedules.length - activeCount} color="var(--af-dim)" />
  </div>

  <div class="two-col">
    <div>
      {#if loading}
        <Card><div class="state-center"><div class="spinner"></div><span style="font-size:12px;color:var(--af-dim);margin-top:8px">Loading...</span></div></Card>
      {:else if error}
        <Card><div class="state-center"><span style="font-size:22px;color:var(--af-danger)">&#9888;</span><span style="font-size:12px;color:var(--af-danger);margin-top:6px">{error}</span></div></Card>
      {:else if schedules.length === 0}
        <Card>
          <div class="state-center">
            <span style="font-size:28px;color:var(--af-faint)">&#128197;</span>
            <div style="font-size:13px;color:var(--af-text);font-weight:600;margin-top:8px">No schedules yet.</div>
            <div style="font-size:11px;color:var(--af-dim);margin-top:4px">Create a schedule using the form on the right.</div>
          </div>
        </Card>
      {:else}
        <Card noPad>
          <div class="table-header"><span class="section-title">SCHEDULES</span></div>
          {#each schedules as s (s.id)}
            <div class="schedule-row" style="opacity:{s.enabled ? 1 : 0.55}">
              <div class="schedule-main">
                <div class="schedule-name">{s.name}</div>
                <div class="schedule-meta font-mono">
                  <span class="cron-chip">{s.cronExpression}</span>
                  <span style="font-size:11px;color:var(--af-dim)">{humanizeCron(s.cronExpression)}</span>
                </div>
                <div class="font-mono" style="font-size:10px;color:var(--af-dim)">
                  last: <span style="color:var(--af-muted)">{fmtRel(s.lastRunAt)}</span>
                  &nbsp;·&nbsp; next: <span style="color:{s.enabled && s.nextRunAt ? 'var(--af-purple)' : 'var(--af-faint)'}">{fmtAbs(s.nextRunAt)}</span>
                </div>
              </div>
              <div class="schedule-actions">
                <button class="toggle-btn" class:toggle-on={s.enabled} onclick={() => toggleEnabled(s)} title={s.enabled ? 'Disable' : 'Enable'} aria-label={s.enabled ? 'Disable' : 'Enable'}>
                  <span class="toggle-track"><span class="toggle-thumb" class:thumb-on={s.enabled}></span></span>
                </button>
                <Btn size="sm" variant="danger" onclick={() => deleteSchedule(s.id)} disabled={deleteId === s.id}>
                  {deleteId === s.id ? '...' : 'Delete'}
                </Btn>
              </div>
            </div>
          {/each}
        </Card>
      {/if}
    </div>

    <div>
      <Card>
        <div class="section-title" style="margin-bottom:14px">NEW SCHEDULE</div>
        <div class="form-field">
          <label class="form-label" for="sched-name">Name</label>
          <input id="sched-name" class="form-input" type="text" placeholder="Nightly build" bind:value={formName} />
        </div>
        <div class="form-field">
          <label class="form-label" for="sched-cron">
            Cron expression
            <span class="cron-valid-badge" class:valid={cronValid} class:invalid={formCron && !cronValid}>
              {cronValid ? '✓ valid' : formCron ? '✗ invalid' : ''}
            </span>
          </label>
          <input id="sched-cron" class="form-input font-mono" type="text" placeholder="0 */6 * * *" bind:value={formCron} />
          {#if cronValid && nextRuns.length > 0}
            <div class="next-runs">
              <div style="font-size:10px;color:var(--af-dim);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:4px">Next {nextRuns.length} runs</div>
              {#each nextRuns as run, i}
                <div class="font-mono" style="font-size:10px;color:var(--af-muted);line-height:1.8">{i + 1}. {run}</div>
              {/each}
            </div>
          {/if}
        </div>
        <div class="form-field">
          <label class="form-label" for="sched-config">Cycle config (JSON)</label>
          <textarea id="sched-config" class="form-textarea font-mono" placeholder="{'{'+'}'}" bind:value={formConfig}></textarea>
        </div>
        <div class="form-field" style="flex-direction:row;align-items:center;gap:10px">
          <label class="form-label" for="sched-enabled">Enabled</label>
          <input id="sched-enabled" type="checkbox" bind:checked={formEnabled} />
        </div>
        {#if formError}
          <div class="form-error">{formError}</div>
        {/if}
        <div style="margin-top:16px">
          <Btn variant="primary" size="md" onclick={createSchedule} disabled={saving}>
            {saving ? 'Creating...' : '+ Create schedule'}
          </Btn>
        </div>
      </Card>
    </div>
  </div>
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 14px; padding: 20px 24px; max-width: 1200px; }
  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 2px; }
  .crumbs { font-size: 10px; color: var(--af-faint); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 4px; }
  .page-title { margin: 0; font-size: 20px; font-weight: 700; color: var(--af-text); }
  .page-sub { margin: 4px 0 0; font-size: 12px; color: var(--af-dim); }
  .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .two-col { display: grid; grid-template-columns: 1fr 380px; gap: 14px; align-items: start; }
  .table-header { padding: 12px 16px; border-bottom: 1px solid var(--af-border); }
  .section-title { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--af-dim); }
  .schedule-row { display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-bottom: 1px solid var(--af-border); transition: background 120ms ease; }
  .schedule-row:hover { background: var(--af-surface); }
  .schedule-main { flex: 1; min-width: 0; }
  .schedule-name { font-size: 13px; font-weight: 600; color: var(--af-text); margin-bottom: 4px; }
  .schedule-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
  .cron-chip { font-size: 11px; color: var(--af-purple); background: color-mix(in srgb, var(--af-purple) 10%, transparent); border: 1px solid color-mix(in srgb, var(--af-purple) 25%, transparent); padding: 1px 6px; border-radius: 4px; }
  .schedule-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .toggle-btn { background: none; border: none; cursor: pointer; padding: 0; display: flex; align-items: center; }
  .toggle-track { display: block; width: 32px; height: 18px; border-radius: 999px; background: var(--af-border3); border: 1px solid var(--af-border2); position: relative; transition: background 200ms ease; }
  .toggle-on .toggle-track { background: var(--af-success); border-color: var(--af-success); }
  .toggle-thumb { display: block; position: absolute; width: 12px; height: 12px; border-radius: 50%; background: var(--af-dim); top: 2px; left: 2px; transition: left 200ms ease, background 200ms ease; }
  .thumb-on { left: 16px; background: #fff; }
  .form-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
  .form-label { font-size: 10px; color: var(--af-dim); letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .cron-valid-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; letter-spacing: 0; text-transform: none; }
  .cron-valid-badge.valid { color: var(--af-success); background: color-mix(in srgb, var(--af-success) 12%, transparent); }
  .cron-valid-badge.invalid { color: var(--af-danger); background: color-mix(in srgb, var(--af-danger) 12%, transparent); }
  .form-input { height: 32px; background: var(--af-surface); border: 1px solid var(--af-border2); border-radius: 5px; padding: 0 10px; font-size: 12px; color: var(--af-text); outline: none; font-family: inherit; }
  .form-input:focus { border-color: var(--af-border3); box-shadow: 0 0 0 2px color-mix(in srgb, var(--af-purple) 20%, transparent); }
  .form-textarea { background: var(--af-surface); border: 1px solid var(--af-border2); border-radius: 5px; padding: 8px 10px; font-size: 11px; color: var(--af-text); min-height: 80px; resize: vertical; outline: none; font-family: var(--af-font-mono); }
  .form-textarea:focus { border-color: var(--af-border3); box-shadow: 0 0 0 2px color-mix(in srgb, var(--af-purple) 20%, transparent); }
  .next-runs { margin-top: 6px; padding: 8px 10px; background: var(--af-surface2); border: 1px solid var(--af-border2); border-radius: 5px; }
  .form-error { font-size: 11px; color: var(--af-danger); padding: 6px 10px; background: color-mix(in srgb, var(--af-danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--af-danger) 25%, transparent); border-radius: 5px; margin-bottom: 8px; }
  .state-center { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; text-align: center; }
  .spinner { width: 24px; height: 24px; border: 2px solid var(--af-border2); border-top-color: var(--af-purple); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .font-mono { font-family: var(--af-font-mono); font-feature-settings: 'tnum' 1; }
  @media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }
</style>
