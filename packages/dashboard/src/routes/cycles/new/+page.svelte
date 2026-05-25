<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { withWorkspace } from '$lib/stores/workspace';
  import { relativeTime } from '$lib/util/relative-time';
  import { codexProfileLabel } from '$lib/modelProfiles';
  import CodexReadinessPanel from '$lib/components/CodexReadinessPanel.svelte';
  import {
    Btn, Card, Badge, StageDots,
  } from '$lib/components/v2';

  type LaunchMode = 'cycle' | 'research';
  type ModelCap = 'default' | 'opus' | 'sonnet' | 'haiku';
  type EffortCap = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  type ResearchMode = 'operator-seeded' | 'autonomous';
  type ResearchIdeaStatus = 'proposed' | 'approved' | 'rejected' | 'planned' | 'executed';

  interface ResearchIdea {
    ideaId: string;
    title: string;
    problem: string;
    hypothesis: string;
    expectedImpact: string;
    risk: 'low' | 'medium' | 'high';
    suggestedAgents: string[];
    touchedAreas: string[];
    acceptanceChecks: string[];
    status: ResearchIdeaStatus;
  }

  interface ResearchRun {
    runId: string;
    prompt: string;
    mode: ResearchMode;
    status: string;
    ideas: ResearchIdea[];
    plannedCycle?: {
      title: string;
      ideaIds: string[];
      cycleRequest: Record<string, unknown>;
    };
  }

  let launchMode = $state<LaunchMode>('cycle');
  let fastMode = $state<boolean>(true);
  let budgetUsd = $state<number>(200);
  let maxItems = $state<number>(10);
  let maxAgents = $state<number>(10);
  let branchPrefix = $state<string>('codex/');
  let baseBranch = $state<string>('codex/codex-version');
  let modelCap = $state<ModelCap>('default');
  let effortCap = $state<EffortCap>('high');
  let dryRun = $state<boolean>(false);
  let fallbackEnabled = $state<boolean>(true);
  let comment = $state<string>('');
  let tagsInput = $state<string>('');
  let researchPrompt = $state<string>('Plan the next AgentForge product improvements that improve Codex-backed cycle reliability and self-improvement.');
  let researchMode = $state<ResearchMode>('operator-seeded');
  let researchMaxIdeas = $state<number>(3);
  let researchRun = $state<ResearchRun | null>(null);
  let researchBusy = $state<boolean>(false);
  let researchError = $state<string | null>(null);

  const tags = $derived.by<string[]>(() => {
    const raw = tagsInput.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    return Array.from(new Set(raw));
  });

  let launching = $state(false);
  let clientReady = $state(false);
  let launchError = $state<string | null>(null);
  const formDisabled = $derived(launching || researchBusy || !clientReady);
  const approvedIdeaCount = $derived<number>(
    researchRun?.ideas.filter((idea) => idea.status === 'approved' || idea.status === 'planned').length ?? 0,
  );

  interface RecentCycle {
    cycleId: string;
    sprintVersion: string | null;
    stage: string;
    startedAt: string;
    costUsd: number;
    budgetUsd: number;
    durationMs: number | null;
  }
  let recent = $state<RecentCycle[]>([]);
  let recentLoading = $state(true);
  let recentError = $state<string | null>(null);

  async function loadRecent(): Promise<void> {
    try {
      const res = await fetch(withWorkspace('/api/v5/cycles?limit=12'));
      if (!res.ok) { recentError = `HTTP ${res.status}`; return; }
      const json = (await res.json()) as { cycles?: RecentCycle[] };
      recent = (json.cycles ?? []).slice();
      recentError = null;
    } catch (e) {
      recentError = e instanceof Error ? e.message : String(e);
    } finally {
      recentLoading = false;
    }
  }

  type StageBrick = 'pending' | 'active' | 'done' | 'failed';
  function bricksFor(c: RecentCycle): StageBrick[] {
    const stage = (c.stage ?? '').toLowerCase();
    if (stage === 'completed') return Array.from({ length: 6 }, () => 'done' as StageBrick);
    if (stage === 'failed' || stage === 'killed' || stage === 'crashed') {
      const out: StageBrick[] = Array.from({ length: 6 }, () => 'pending');
      out[0] = 'done'; out[1] = 'failed';
      return out;
    }
    return Array.from({ length: 6 }, () => 'pending');
  }

  const avgCostPerItem = $derived.by<number>(() => {
    const completed = recent.filter((c) => c.stage === 'completed' && c.costUsd > 0);
    if (completed.length === 0) return 1.2;
    const sum = completed.reduce((s, c) => s + c.costUsd, 0);
    return sum / completed.length / 3;
  });

  const modelMultiplier = $derived.by<number>(() => {
    switch (modelCap) {
      case 'opus':   return 4;
      case 'sonnet': return 1;
      case 'haiku':  return 0.25;
      default:       return 1.2;
    }
  });

  const effortMultiplier = $derived.by<number>(() => {
    switch (effortCap) {
      case 'low':    return 0.5;
      case 'medium': return 0.8;
      case 'high':   return 1.0;
      case 'xhigh':  return 1.6;
      case 'max':    return 2.2;
      default:       return 1.0;
    }
  });

  const estimate = $derived<number>(maxItems * avgCostPerItem * modelMultiplier * effortMultiplier);
  const estimatePct = $derived<number>(budgetUsd > 0 ? Math.min(100, (estimate / budgetUsd) * 100) : 0);
  const estimateOverBudget = $derived<boolean>(estimate > budgetUsd);

  const avgDurationMin = $derived.by<number>(() => {
    const completed = recent.filter((c) => c.stage === 'completed' && c.durationMs != null && c.durationMs > 0);
    if (completed.length === 0) return 0;
    const ms = completed.reduce((s, c) => s + (c.durationMs ?? 0), 0) / completed.length;
    return Math.round(ms / 60000);
  });

  const likelyProfile = $derived<string>(profileLabel(modelCap === 'default' ? 'sonnet' : modelCap));

  const xhighWarning = $derived<string | null>(
    effortCap === 'xhigh' && modelCap !== 'opus' && modelCap !== 'default'
      ? `xhigh effort is limited to ${profileLabel('opus')}; ${profileLabel(modelCap)} runs will auto-downgrade to max.`
      : null,
  );

  function profileLabel(cap: ModelCap): string {
    if (cap === 'default') return 'per-agent profile';
    return codexProfileLabel(cap);
  }

  async function handleLaunch(): Promise<void> {
    if (launching || !clientReady) return;
    launchError = null;
    launching = true;
    try {
      const body = {
        budgetUsd,
        maxItems,
        maxAgents,
        dryRun,
        branchPrefix,
        baseBranch,
        comment: comment.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
        modelCap: modelCap !== 'default' ? modelCap : undefined,
        effortCap: effortCap !== 'default' ? effortCap : undefined,
        fastMode,
        fallbackEnabled,
      };
      const res = await fetch(withWorkspace('/api/v5/cycles'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status !== 202 && !res.ok) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        launchError = text || `HTTP ${res.status}`;
        launching = false;
        return;
      }
      const json = (await res.json()) as { cycleId?: string; id?: string };
      const newId = json.cycleId ?? json.id;
      if (!newId) {
        launchError = 'Server did not return a cycleId';
        launching = false;
        return;
      }
      await goto(`/cycles/${newId}`);
    } catch (e) {
      launchError = e instanceof Error ? e.message : String(e);
      launching = false;
    }
  }

  async function createResearchRun(): Promise<void> {
    if (researchBusy || !clientReady) return;
    researchBusy = true;
    researchError = null;
    launchError = null;
    try {
      const res = await fetch(withWorkspace('/api/v5/research-runs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: researchPrompt.trim() || undefined,
          mode: researchMode,
          maxIdeas: researchMaxIdeas,
          tags: tags.length > 0 ? tags : ['launch'],
        }),
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const json = (await res.json()) as { data?: ResearchRun };
      researchRun = json.data ?? null;
    } catch (e) {
      researchError = e instanceof Error ? e.message : String(e);
    } finally {
      researchBusy = false;
    }
  }

  async function decideResearchIdea(ideaId: string, decision: 'approve' | 'reject'): Promise<void> {
    if (!researchRun || researchBusy) return;
    researchBusy = true;
    researchError = null;
    try {
      const res = await fetch(withWorkspace(`/api/v5/research-runs/${researchRun.runId}/ideas/${ideaId}/${decision}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: `${decision}d from Launch UI` }),
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const json = (await res.json()) as { data?: ResearchRun };
      researchRun = json.data ?? researchRun;
    } catch (e) {
      researchError = e instanceof Error ? e.message : String(e);
    } finally {
      researchBusy = false;
    }
  }

  async function planResearchRun(): Promise<ResearchRun | null> {
    if (!researchRun || researchBusy) return null;
    researchBusy = true;
    researchError = null;
    try {
      const res = await fetch(withWorkspace(`/api/v5/research-runs/${researchRun.runId}/plan`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          budgetUsd,
          maxItems,
          maxAgents,
          dryRun,
          branchPrefix,
          baseBranch,
          modelCap: modelCap !== 'default' ? modelCap : undefined,
          effortCap: effortCap !== 'default' ? effortCap : undefined,
          fastMode,
          fallbackEnabled,
        }),
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const json = (await res.json()) as { data?: ResearchRun };
      researchRun = json.data ?? researchRun;
      return researchRun;
    } catch (e) {
      researchError = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      researchBusy = false;
    }
  }

  async function launchResearchPlan(): Promise<void> {
    if (!researchRun || launching || researchBusy) return;
    launchError = null;
    const plannedRun = researchRun.plannedCycle ? researchRun : await planResearchRun();
    const cycleRequest = plannedRun?.plannedCycle?.cycleRequest;
    if (!cycleRequest) return;
    launching = true;
    try {
      const res = await fetch(withWorkspace('/api/v5/cycles'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cycleRequest),
      });
      if (res.status !== 202 && !res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const json = (await res.json()) as { cycleId?: string; id?: string };
      const newId = json.cycleId ?? json.id;
      if (!newId) throw new Error('Server did not return a cycleId');
      await goto(`/cycles/${newId}`);
    } catch (e) {
      launchError = e instanceof Error ? e.message : String(e);
      launching = false;
    }
  }

  function ideaVariant(status: ResearchIdeaStatus): 'success' | 'warning' | 'danger' | 'muted' {
    if (status === 'approved' || status === 'planned' || status === 'executed') return 'success';
    if (status === 'rejected') return 'danger';
    return 'muted';
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  function manage(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      return;
    }
    if (!pollTimer) pollTimer = setInterval(loadRecent, 30000);
  }
  function onVisibility(): void { manage(); }

  onMount(() => {
    clientReady = true;
    void loadRecent();
    manage();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  });
</script>

<svelte:head><title>Launch Cycle — AgentForge</title></svelte:head>

<div class="page-head">
  <div>
    <div class="crumbs af2-mono">Workspace · Cycles · Launch</div>
    <h1 class="page-title">Launch autonomous cycle</h1>
    <p class="page-sub">
      Plan → Stage → Run → Verify → Commit → Review via a detached Codex CLI session
    </p>
  </div>
  <div class="head-actions">
    <Btn size="sm" href="/cycles">← Cancel</Btn>
  </div>
</div>

<div class="mode-tabs" aria-label="Launch mode">
  <button type="button" class:active={launchMode === 'cycle'} onclick={() => (launchMode = 'cycle')}>
    Cycle
  </button>
  <button type="button" class:active={launchMode === 'research'} onclick={() => (launchMode = 'research')}>
    R&D
  </button>
</div>

<div class="launch-grid">
  <Card>
    <div class="section-title">{launchMode === 'cycle' ? 'CYCLE CONFIGURATION' : 'R&D WORKFLOW'}</div>

    {#if launchMode === 'cycle'}
    <div class="form-row">
      <div class="field">
        <label class="field-label" for="budgetUsd">Budget (USD)</label>
        <div class="slider-row">
          <input id="budgetUsd" type="range" min="5" max="500" step="1" bind:value={budgetUsd} class="slider" disabled={formDisabled} />
          <input type="number" min="0" step="0.5" bind:value={budgetUsd} class="num" disabled={formDisabled} aria-label="Budget in USD" />
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="maxItems">Max items / sprint</label>
        <div class="slider-row">
          <input id="maxItems" type="range" min="1" max="50" step="1" bind:value={maxItems} class="slider" disabled={formDisabled} />
          <input type="number" min="1" max="50" step="1" bind:value={maxItems} class="num" disabled={formDisabled} aria-label="Max items per sprint" />
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="maxAgents">Max agents</label>
        <div class="slider-row">
          <input id="maxAgents" type="range" min="1" max="10" step="1" bind:value={maxAgents} class="slider" disabled={formDisabled} />
          <input type="number" min="1" max="10" step="1" bind:value={maxAgents} class="num" disabled={formDisabled} aria-label="Max agents" />
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="branchPrefix">Branch prefix</label>
        <input id="branchPrefix" type="text" bind:value={branchPrefix} class="text-input af2-mono" disabled={formDisabled} />
      </div>

      <div class="field">
        <label class="field-label" for="baseBranch">Base branch</label>
        <input id="baseBranch" type="text" bind:value={baseBranch} class="text-input af2-mono" disabled={formDisabled} />
      </div>
    </div>

    <div class="form-row">
      <div class="field">
        <label class="field-label" for="modelCap">Codex profile cap</label>
        <select id="modelCap" bind:value={modelCap} class="select" disabled={formDisabled}>
          <option value="default">Default (per agent)</option>
          <option value="opus">{profileLabel('opus')} — most capable</option>
          <option value="sonnet">{profileLabel('sonnet')} — balanced</option>
          <option value="haiku">{profileLabel('haiku')} — maximum savings</option>
        </select>
      </div>

      <div class="field">
        <label class="field-label" for="effortCap">Effort cap</label>
        <select id="effortCap" bind:value={effortCap} class="select" disabled={formDisabled}>
          <option value="default">Default (per agent)</option>
          <option value="low">Low — fast, mechanical</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">xhigh — gpt-5.5 only</option>
          <option value="max">Max — deepest reasoning</option>
        </select>
      </div>

      <div class="field toggle-field">
        <span class="field-label">Options</span>
        <label class="toggle">
          <input type="checkbox" bind:checked={fastMode} disabled={formDisabled} />
          <span class="toggle-track" class:on={fastMode}><span class="toggle-knob"></span></span>
          <span class="toggle-label">Fast mode <span class="hint">(parallel high effort)</span></span>
        </label>
        <label class="toggle">
          <input type="checkbox" bind:checked={dryRun} disabled={formDisabled} />
          <span class="toggle-track" class:on={dryRun}><span class="toggle-knob"></span></span>
          <span class="toggle-label">Dry run <span class="hint">(skip PR creation)</span></span>
        </label>
        <label class="toggle">
          <input type="checkbox" bind:checked={fallbackEnabled} disabled={formDisabled} />
          <span class="toggle-track" class:on={fallbackEnabled}><span class="toggle-knob"></span></span>
          <span class="toggle-label">Profile fallback <span class="hint">(gpt-5.5 → gpt-5.3-codex → gpt-5.4-mini)</span></span>
        </label>
      </div>
    </div>

    {#if xhighWarning}
      <div class="warning-row">
        <span class="warning-icon">⚠</span>
        <span>{xhighWarning}</span>
      </div>
    {/if}

    <div class="field" style="margin-top:14px">
      <label class="field-label" for="tagsInput">Tags (optional)</label>
      <input
        id="tagsInput"
        type="text"
        bind:value={tagsInput}
        class="text-input af2-mono"
        placeholder="comma- or space-separated, e.g. ui, dashboard, v6"
        disabled={formDisabled}
      />
      {#if tags.length > 0}
        <div class="tag-row">
          {#each tags as t (t)}<span class="tag-chip af2-mono">#{t}</span>{/each}
        </div>
      {/if}
    </div>

    <div class="field" style="margin-top:14px">
      <label class="field-label" for="comment">Cycle comment (optional)</label>
      <textarea
        id="comment"
        bind:value={comment}
        rows={3}
        placeholder="Why are you running this cycle? e.g. 'ship v14.1 dashboard refresh'"
        class="textarea"
        disabled={formDisabled}
      ></textarea>
    </div>

    {#if launchError}
      <div class="error-row">
        <span>Failed to launch: {launchError}</span>
        <Btn size="sm" onClick={() => (launchError = null)}>Dismiss</Btn>
      </div>
    {/if}

    <div class="launch-row">
      <span class="hint" style="flex:1">
        Advanced overrides (per-agent budgets, capability tier pinning) are future work.
      </span>
      <Btn size="lg" variant="purple" onClick={handleLaunch} disabled={formDisabled}>
        {launching ? 'Launching…' : '▶ Run Cycle'}
      </Btn>
    </div>
    {:else}
      <div class="field">
        <label class="field-label" for="researchPrompt">Research prompt</label>
        <textarea
          id="researchPrompt"
          bind:value={researchPrompt}
          rows={4}
          class="textarea"
          disabled={formDisabled}
        ></textarea>
      </div>

      <div class="form-row rd-controls">
        <div class="field">
          <label class="field-label" for="researchMode">Mode</label>
          <select id="researchMode" bind:value={researchMode} class="select" disabled={formDisabled}>
            <option value="operator-seeded">Operator seeded</option>
            <option value="autonomous">Autonomous</option>
          </select>
        </div>

        <div class="field">
          <label class="field-label" for="researchMaxIdeas">Ideas</label>
          <div class="slider-row">
            <input id="researchMaxIdeas" type="range" min="1" max="6" step="1" bind:value={researchMaxIdeas} class="slider" disabled={formDisabled} />
            <input type="number" min="1" max="6" step="1" bind:value={researchMaxIdeas} class="num" disabled={formDisabled} aria-label="R&D idea count" />
          </div>
        </div>

        <div class="field">
          <label class="field-label" for="rdBudgetUsd">Cycle budget</label>
          <div class="slider-row">
            <input id="rdBudgetUsd" type="range" min="5" max="500" step="1" bind:value={budgetUsd} class="slider" disabled={formDisabled} />
            <input type="number" min="0" step="0.5" bind:value={budgetUsd} class="num" disabled={formDisabled} aria-label="R&D cycle budget" />
          </div>
        </div>

        <div class="field">
          <label class="field-label" for="rdMaxAgents">Max agents</label>
          <div class="slider-row">
            <input id="rdMaxAgents" type="range" min="1" max="10" step="1" bind:value={maxAgents} class="slider" disabled={formDisabled} />
            <input type="number" min="1" max="10" step="1" bind:value={maxAgents} class="num" disabled={formDisabled} aria-label="R&D max agents" />
          </div>
        </div>
      </div>

      <div class="form-row">
        <div class="field toggle-field">
          <span class="field-label">Execution</span>
          <label class="toggle">
            <input type="checkbox" bind:checked={fastMode} disabled={formDisabled} />
            <span class="toggle-track" class:on={fastMode}><span class="toggle-knob"></span></span>
            <span class="toggle-label">Fast mode <span class="hint">(parallel high effort)</span></span>
          </label>
          <label class="toggle">
            <input type="checkbox" bind:checked={fallbackEnabled} disabled={formDisabled} />
            <span class="toggle-track" class:on={fallbackEnabled}><span class="toggle-knob"></span></span>
            <span class="toggle-label">Profile fallback</span>
          </label>
        </div>

        <div class="field">
          <label class="field-label" for="rdModelCap">Codex profile cap</label>
          <select id="rdModelCap" bind:value={modelCap} class="select" disabled={formDisabled}>
            <option value="default">Default (per agent)</option>
            <option value="opus">{profileLabel('opus')}</option>
            <option value="sonnet">{profileLabel('sonnet')}</option>
            <option value="haiku">{profileLabel('haiku')}</option>
          </select>
        </div>

        <div class="field">
          <label class="field-label" for="rdEffortCap">Effort cap</label>
          <select id="rdEffortCap" bind:value={effortCap} class="select" disabled={formDisabled}>
            <option value="default">Default (per agent)</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">xhigh</option>
            <option value="max">Max</option>
          </select>
        </div>

        <div class="field">
          <label class="field-label" for="rdBranchPrefix">Branch prefix</label>
          <input id="rdBranchPrefix" type="text" bind:value={branchPrefix} class="text-input af2-mono" disabled={formDisabled} />
        </div>

        <div class="field">
          <label class="field-label" for="rdBaseBranch">Base branch</label>
          <input id="rdBaseBranch" type="text" bind:value={baseBranch} class="text-input af2-mono" disabled={formDisabled} />
        </div>
      </div>

      {#if researchError}
        <div class="error-row">
          <span>R&D error: {researchError}</span>
          <Btn size="sm" onClick={() => (researchError = null)}>Dismiss</Btn>
        </div>
      {/if}

      {#if launchError}
        <div class="error-row">
          <span>Failed to launch: {launchError}</span>
          <Btn size="sm" onClick={() => (launchError = null)}>Dismiss</Btn>
        </div>
      {/if}

      <div class="launch-row">
        <span class="hint" style="flex:1">
          Ideas are saved under .agentforge/research-runs and can be approved individually.
        </span>
        <Btn size="lg" variant="purple" onClick={createResearchRun} disabled={formDisabled}>
          {researchBusy && !researchRun ? 'Researching…' : 'Run R&D'}
        </Btn>
      </div>

      {#if researchRun}
        <div class="rd-run-head">
          <div>
            <div class="field-label">Research run</div>
            <div class="af2-mono rd-run-id">{researchRun.runId}</div>
          </div>
          <Badge variant={researchRun.status === 'planned' ? 'success' : 'info'}>{researchRun.status}</Badge>
          <Badge variant="purple">{approvedIdeaCount} approved</Badge>
        </div>

        <div class="idea-list">
          {#each researchRun.ideas as idea (idea.ideaId)}
            <div class="idea-card">
              <div class="idea-top">
                <div>
                  <div class="idea-title">{idea.title}</div>
                  <div class="idea-meta af2-mono">{idea.ideaId} · risk {idea.risk}</div>
                </div>
                <Badge variant={ideaVariant(idea.status)}>{idea.status}</Badge>
              </div>
              <p class="idea-text">{idea.problem}</p>
              <p class="idea-text muted">{idea.expectedImpact}</p>
              <div class="tag-row">
                {#each idea.suggestedAgents.slice(0, 4) as agent (agent)}
                  <span class="tag-chip af2-mono">{agent}</span>
                {/each}
              </div>
              <div class="idea-actions">
                <Btn size="sm" onClick={() => void decideResearchIdea(idea.ideaId, 'approve')} disabled={formDisabled || idea.status === 'approved' || idea.status === 'planned'}>
                  Approve
                </Btn>
                <Btn size="sm" onClick={() => void decideResearchIdea(idea.ideaId, 'reject')} disabled={formDisabled || idea.status === 'rejected' || idea.status === 'planned'}>
                  Reject
                </Btn>
              </div>
            </div>
          {/each}
        </div>

        <div class="launch-row">
          <span class="hint" style="flex:1">
            {researchRun.plannedCycle ? researchRun.plannedCycle.title : 'Approve at least one idea, then create a cycle request.'}
          </span>
          <Btn size="lg" onClick={() => void planResearchRun()} disabled={formDisabled || approvedIdeaCount === 0}>
            {researchRun.plannedCycle ? 'Replan' : 'Plan Approved'}
          </Btn>
          <Btn size="lg" variant="purple" onClick={launchResearchPlan} disabled={formDisabled || approvedIdeaCount === 0}>
            {launching ? 'Launching…' : 'Run Planned Cycle'}
          </Btn>
        </div>
      {/if}
    {/if}
  </Card>

  <div class="side-col">
    <CodexReadinessPanel compact title="CODEX READINESS" />

    <Card>
      <div class="section-title">ESTIMATE</div>
      <div class="est-head">
        <span class="est-amount af2-mono">${estimate.toFixed(2)}</span>
        <span class="est-tag af2-mono">est.</span>
        <span style="flex:1"></span>
        {#if estimateOverBudget}
          <span class="est-flag over af2-mono">over budget by ${Math.max(0, estimate - budgetUsd).toFixed(2)}</span>
        {:else}
          <span class="est-flag under af2-mono">{Math.round((1 - estimate / Math.max(0.01, budgetUsd)) * 100)}% under budget</span>
        {/if}
      </div>
      <div class="est-bar-track">
        <div class="est-bar-fill" style="width:{estimatePct}%"></div>
      </div>
      <div class="est-bar-meta af2-mono">
        <span>$0</span>
        <span>budget ${budgetUsd.toFixed(0)}</span>
      </div>

      <div class="est-grid">
        <div>
          <div class="est-key">Items</div>
          <div class="af2-mono est-val">~{maxItems}</div>
        </div>
        <div>
          <div class="est-key">Avg duration</div>
          <div class="af2-mono est-val">{avgDurationMin > 0 ? `~${avgDurationMin}m` : '—'}</div>
        </div>
        <div>
          <div class="est-key">Likely profile</div>
          <div class="af2-mono est-val">{likelyProfile}</div>
        </div>
        <div>
          <div class="est-key">Base branch</div>
          <div class="af2-mono est-val">{baseBranch}</div>
        </div>
        <div>
          <div class="est-key">Branch</div>
          <div class="af2-mono est-val">{branchPrefix}vX.Y.Z</div>
        </div>
        <div>
          <div class="est-key">Max agents</div>
          <div class="af2-mono est-val">{maxAgents}{fastMode ? ' fast' : ''}</div>
        </div>
        <div>
          <div class="est-key">Effort</div>
          <div class="af2-mono est-val">{effortCap === 'default' ? 'per-agent' : effortCap}</div>
        </div>
      </div>
    </Card>

    <Card>
      <div class="section-title">SIMILAR PAST CYCLES</div>
      {#if recentLoading}
        <div class="muted" style="font-size:12px">Loading recent cycles…</div>
      {:else if recentError}
        <div class="warning-row" style="margin:0">
          <span class="warning-icon">⚠</span>
          <span>Could not load recent cycles: {recentError}</span>
        </div>
      {:else if recent.length === 0}
        <div class="muted" style="font-size:12px">No past cycles yet.</div>
      {:else}
        <div class="recent-list">
          {#each recent.filter((c) => c.stage === 'completed').slice(0, 5) as c (c.cycleId)}
            <a class="recent-row" href={`/cycles/${c.cycleId}`}>
              <StageDots stages={bricksFor(c)} />
              <span class="af2-mono recent-id">{c.cycleId.slice(0, 8)}</span>
              <span class="af2-mono recent-sprint">v{c.sprintVersion ?? '—'}</span>
              <span class="af2-mono recent-cost">${c.costUsd.toFixed(2)}</span>
              <span class="recent-when">{relativeTime(c.startedAt)}</span>
            </a>
          {:else}
            <div class="muted" style="font-size:12px">No completed cycles yet.</div>
          {/each}
        </div>
      {/if}
    </Card>

    <Card>
      <div class="section-title">SAFEGUARDS</div>
      <ul class="safeguards">
        <li><Badge variant="success">on</Badge> Budget approval and live spend tracking</li>
        <li><Badge variant="success">on</Badge> Per-phase timeout</li>
        <li><Badge variant={fallbackEnabled ? 'success' : 'muted'}>{fallbackEnabled ? 'on' : 'off'}</Badge> Profile fallback on overload</li>
        <li><Badge variant={dryRun ? 'warning' : 'muted'}>{dryRun ? 'on' : 'off'}</Badge> Dry run (no PR)</li>
      </ul>
    </Card>
  </div>
</div>

<style>
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 14px;
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
  .page-sub { font-size: 12px; color: var(--af-dim); margin: 4px 0 0; }
  .head-actions { display: flex; gap: 8px; }
  .mode-tabs {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    background: var(--af-surface2);
    margin-bottom: 14px;
  }
  .mode-tabs button {
    height: 28px;
    min-width: 72px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--af-muted);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }
  .mode-tabs button.active {
    background: var(--af-surface);
    color: var(--af-text);
    box-shadow: inset 0 0 0 1px var(--af-border2);
  }
  .launch-grid {
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
  @media (max-width: 960px) {
    .launch-grid { grid-template-columns: 1fr; }
    .side-col { position: static; }
  }
  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 12px;
  }
  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 14px;
    margin-bottom: 14px;
  }
  .form-row.rd-controls { margin-top: 14px; }
  .form-row + .form-row { margin-top: 4px; }
  @media (max-width: 720px) {
    .form-row { grid-template-columns: 1fr 1fr; }
  }
  .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .field-label {
    font-size: 10px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .slider-row {
    display: grid;
    grid-template-columns: 1fr 60px;
    gap: 8px;
    align-items: center;
  }
  .slider { width: 100%; accent-color: var(--af-purple); }
  .num,
  .text-input,
  .select {
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 6px 10px;
    color: var(--af-text);
    font-size: 12px;
    font-family: inherit;
    height: 32px;
    width: 100%;
    box-sizing: border-box;
  }
  .num:focus,
  .text-input:focus,
  .select:focus {
    outline: none;
    border-color: var(--af-purple);
  }
  .num { font-family: var(--af-font-mono, 'JetBrains Mono', monospace); text-align: right; }
  .textarea {
    width: 100%;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 10px 12px;
    color: var(--af-text);
    font-size: 12px;
    font-family: inherit;
    min-height: 70px;
    resize: vertical;
    box-sizing: border-box;
  }
  .textarea:focus { outline: none; border-color: var(--af-purple); }
  .toggle-field { gap: 8px; }
  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--af-text);
    cursor: pointer;
  }
  .toggle input { display: none; }
  .toggle-track {
    width: 28px;
    height: 16px;
    border-radius: 999px;
    background: var(--af-border3);
    position: relative;
    transition: background 200ms ease;
    flex-shrink: 0;
  }
  .toggle-track.on { background: var(--af-accent); }
  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    background: #fff;
    border-radius: 50%;
    transition: left 200ms ease;
    box-shadow: 0 1px 2px rgba(0,0,0,0.3);
  }
  .toggle-track.on .toggle-knob { left: 14px; }
  .toggle-label .hint { color: var(--af-dim); font-size: 11px; }
  .hint { color: var(--af-dim); font-size: 11px; }
  .warning-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--af-warning) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-warning) 25%, transparent);
    border-radius: 6px;
    font-size: 12px;
    color: var(--af-text);
    margin-top: 8px;
  }
  .warning-icon { color: var(--af-warning); font-size: 14px; }
  .error-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    margin-top: 12px;
    background: color-mix(in srgb, var(--af-danger) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 25%, transparent);
    border-radius: 6px;
    font-size: 12px;
    color: var(--af-danger);
  }
  .tag-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .tag-chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    color: var(--af-text);
  }
  .launch-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--af-border);
  }
  .rd-run-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--af-border);
  }
  .rd-run-id {
    font-size: 12px;
    color: var(--af-text);
    margin-top: 2px;
  }
  .idea-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 12px;
  }
  @media (max-width: 820px) {
    .idea-list { grid-template-columns: 1fr; }
  }
  .idea-card {
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    background: var(--af-surface2);
    padding: 12px;
    min-width: 0;
  }
  .idea-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }
  .idea-title {
    color: var(--af-text);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.25;
  }
  .idea-meta {
    color: var(--af-dim);
    font-size: 10px;
    margin-top: 3px;
  }
  .idea-text {
    color: var(--af-muted);
    font-size: 12px;
    line-height: 1.45;
    margin: 9px 0 0;
  }
  .idea-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
  .est-head { display: flex; align-items: baseline; gap: 6px; }
  .est-amount {
    font-size: 32px;
    font-weight: 600;
    color: var(--af-text);
    letter-spacing: -0.02em;
  }
  .est-tag { font-size: 11px; color: var(--af-dim); }
  .est-flag {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .est-flag.under {
    color: var(--af-success);
    background: color-mix(in srgb, var(--af-success) 12%, transparent);
  }
  .est-flag.over {
    color: var(--af-danger);
    background: color-mix(in srgb, var(--af-danger) 12%, transparent);
  }
  .est-bar-track {
    margin-top: 12px;
    height: 6px;
    background: var(--af-border);
    border-radius: 3px;
    overflow: hidden;
  }
  .est-bar-fill {
    height: 100%;
    background: var(--af-grad-h, linear-gradient(90deg, var(--af-accent), var(--af-purple)));
    transition: width 400ms ease;
  }
  .est-bar-meta {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    font-size: 10px;
    color: var(--af-dim);
  }
  .est-grid {
    margin-top: 16px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    font-size: 11px;
  }
  .est-key { color: var(--af-dim); }
  .est-val { color: var(--af-text); font-weight: 600; margin-top: 2px; }
  .recent-list { display: flex; flex-direction: column; }
  .recent-row {
    display: grid;
    grid-template-columns: auto auto 1fr auto auto;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
    border-bottom: 1px solid var(--af-border);
    color: var(--af-text);
    text-decoration: none;
  }
  .recent-row:last-child { border-bottom: none; }
  .recent-row:hover { background: var(--af-surface2); }
  .recent-id { font-size: 11px; color: var(--af-text); }
  .recent-sprint { font-size: 10px; color: var(--af-dim); }
  .recent-cost { font-size: 10px; color: var(--af-muted); }
  .recent-when { font-size: 10px; color: var(--af-dim); }
  .safeguards {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--af-text);
  }
  .safeguards li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .muted { color: var(--af-muted); }
  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1, 'ss01' 1;
  }
</style>
