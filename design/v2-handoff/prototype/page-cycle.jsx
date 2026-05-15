// ── V2 Cycle Detail Page (all tabs) ───────────────────────────────────────────
const { useState: useS2, useMemo: useM2, useEffect: useE2 } = React;

function CycleDetail({ navigate, cycleId }) {
  const a = window.AF2;
  const c = cycleId === a.cycle.short || cycleId.startsWith(a.cycle.short)
    ? a.cycle
    : makeMock(cycleId);
  const [tab, setTab] = useS2('overview');

  function makeMock(id) {
    const r = a.cycles.find(x => x.id === id) || a.cycles[1];
    return {
      ...a.cycle,
      short: id, id, sprintVersion: r.v, stage: r.stage,
      stages: r.stages,
      elapsedDisplay: r.elapsed, costUsd: r.cost, budgetUsd: r.budget,
      testsPassed: r.tests ? parseInt(r.tests.split('/')[0]) : 0,
      testsTotal: r.tests ? parseInt(r.tests.split('/')[1]) : 0,
      branch: `autonomous/v${r.v}`,
      prUrl: r.pr ? `https://github.com/agentforge/repo/pull/${r.pr.replace('#','')}` : null,
    };
  }

  const tabs = [
    { id:'overview',   label:'Overview' },
    { id:'pipeline',   label:'Pipeline' },
    { id:'items',      label:'Items',    count:`${a.items.filter(i=>i.status==='completed').length}/${a.items.length}` },
    { id:'agents',     label:'Agents',   count:a.agentsLive.length },
    { id:'scoring',    label:'Scoring',  count: a.scoring.overall + '%' },
    { id:'events',     label:'Events',   count:a.events.length },
    { id:'files',      label:'Files' },
    { id:'logs',       label:'Logs' },
  ];

  return (
    <div>
      {/* Back link */}
      <div style={{ marginBottom: 8 }}>
        <button onClick={() => navigate('/cycles')} style={{
          background: 'none', border: 'none', color: T.dim, fontSize: 11, cursor: 'pointer', padding: 0,
        }}>← Cycles</button>
      </div>

      {/* Cycle header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            {c.stage === 'active' && <PulseDot color={T.purple} size={7} />}
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: T.text }}>
              Cycle <span className="af2-mono" style={{ fontWeight: 500 }}>{c.short}</span>
            </h1>
            <Badge variant={c.stage === 'completed' ? 'success' : c.stage === 'failed' ? 'danger' : 'purple'}>
              {c.stage.toUpperCase()}
            </Badge>
            {c.prUrl && (
              <a href={c.prUrl} target="_blank" rel="noopener" style={{
                fontSize: 11, color: T.accent2, textDecoration: 'none',
                background: T.surface, border: `1px solid ${T.border2}`, padding: '3px 8px', borderRadius: 4,
              }}>PR {c.prUrl.split('/').pop()} ↗</a>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: T.dim }}>
            <span className="af2-mono">v{c.sprintVersion}</span>
            {' · started '}<span>{fmtRel(a.cycle.startedAt || new Date(Date.now() - c.elapsedSec * 1000).toISOString())}</span>
            {c.branch && <> · branch <span className="af2-mono" style={{ color: T.muted }}>{c.branch}</span></>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {c.stage === 'active' && <Btn variant="danger" size="sm">Cancel</Btn>}
          <Btn size="sm">Re-run</Btn>
          <Btn size="sm" variant="purple">Approve</Btn>
        </div>
      </div>

      {/* Big stage rail (cycle pipeline) */}
      <Card noPad style={{ marginBottom: 14 }}>
        <div style={{ padding: '16px 18px 12px' }}>
          <StageRail stages={c.stages} phases={c.phases} showAgent />
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1,
          background: T.border, borderTop: `1px solid ${T.border}`,
        }}>
          {[
            { l: 'Elapsed', v: c.elapsedDisplay, s: 'wall clock', mono:true },
            { l: 'Cost', v: fmtDollar(c.costUsd), s: `of ${fmtDollar(c.budgetUsd)} budget`, bar: c.costUsd/c.budgetUsd, bc: 'var(--af-grad-h)', mono:true },
            { l: 'Items', v: `${c.itemsDone || 4}/${c.itemsTotal || 5}`, s: `${c.itemsActive || 1} in flight`, bar: (c.itemsDone||4)/(c.itemsTotal||5), bc: T.success, mono:true },
            { l: 'Tests', v: c.testsTotal ? `${c.testsPassed.toLocaleString()}` : '—', s: c.testsTotal ? `of ${c.testsTotal.toLocaleString()} pass` : 'no tests yet', bar: c.testsTotal ? c.testsPassed/c.testsTotal : null, bc: T.success, mono:true },
          ].map(s => (
            <div key={s.l} style={{ padding: '12px 18px', background: T.surface }}>
              <div style={{ fontSize: 9, color: T.dim, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>{s.l}</div>
              <div className={s.mono ? 'af2-mono' : ''} style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em', color: T.text, marginBottom: 3 }}>{s.v}</div>
              <div style={{ fontSize: 10, color: T.dim }}>{s.s}</div>
              {s.bar != null && (
                <div style={{ marginTop: 6, height: 2, background: T.border, borderRadius: 1, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, s.bar * 100)}%`, background: s.bc, transition: 'width 600ms ease' }} />
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Tabs */}
      <Tabs tabs={tabs} active={tab} onSelect={setTab} />

      {tab === 'overview' && <OverviewTab c={c} />}
      {tab === 'pipeline' && <PipelineTab c={c} />}
      {tab === 'items'    && <ItemsTab c={c} />}
      {tab === 'agents'   && <AgentsTab c={c} />}
      {tab === 'events'   && <EventsTab c={c} />}
      {tab === 'scoring'  && <ScoringTab c={c} />}
      {tab === 'files'    && <FilesTab c={c} />}
      {tab === 'logs'     && <LogsTab c={c} />}
    </div>
  );
}

// ── Overview Tab ───────────────────────────────────────────────────────────────
function OverviewTab({ c }) {
  const a = window.AF2;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Quick stats grid (more details) */}
        <Card>
          <SectionTitle>SUMMARY</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginTop: 12 }}>
            <DefRow label="Started"   value={fmtRel(a.cycle.startedAt || new Date(Date.now() - c.elapsedSec * 1000).toISOString())} />
            <DefRow label="Workspace" value={a.workspace.name} mono />
            <DefRow label="Triggered by" value="sean.vaughan@allworth.com" />
            <DefRow label="Branch"    value={c.branch} mono color={T.accent2} />
            <DefRow label="Commit"    value={c.commitSha || '—'} mono />
            <DefRow label="PR"        value={c.prUrl ? c.prUrl.split('/').pop() : '—'} mono />
            <DefRow label="Budget"    value={`${fmtDollar(c.costUsd)} / ${fmtDollar(c.budgetUsd)}`} mono />
            <DefRow label="Items"     value={`${c.itemsDone || 4} done · ${c.itemsActive || 1} active · ${(c.itemsTotal||5) - (c.itemsDone||4) - (c.itemsActive||1)} planned`} />
            <DefRow label="Tests"     value={c.testsTotal ? `${c.testsPassed}/${c.testsTotal} (${((c.testsPassed/c.testsTotal)*100).toFixed(1)}%)` : '—'} mono />
          </div>
        </Card>

        {/* Cost breakdown */}
        <Card>
          <SectionTitle right={<span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>by phase</span>}>COST BREAKDOWN</SectionTitle>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {a.cycle.phases.filter(p => p.costUsd != null).map(p => {
              const pct = (p.costUsd / a.cycle.costUsd) * 100;
              return (
                <div key={p.name} style={{
                  display: 'grid', gridTemplateColumns: '60px 1fr 80px 60px', alignItems: 'center', gap: 10,
                }}>
                  <span className="af2-mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: T.muted }}>{p.name}</span>
                  <div style={{ height: 8, background: T.border, borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
                    <div style={{
                      height: '100%', width: `${pct}%`,
                      background: p.status === 'active' ? 'var(--af-grad-h)' : T.accent,
                      transition: 'width 600ms ease',
                    }} />
                  </div>
                  <span className="af2-mono" style={{ fontSize: 11, color: T.text, textAlign: 'right' }}>${p.costUsd.toFixed(3)}</span>
                  <span className="af2-mono" style={{ fontSize: 10, color: T.dim, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.dim }}>
            <span>Total spend</span>
            <span className="af2-mono" style={{ color: T.text, fontWeight: 600 }}>${a.cycle.costUsd.toFixed(2)}</span>
          </div>
        </Card>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Tests result */}
        <Card>
          <SectionTitle>TESTS</SectionTitle>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
            <Ring value={c.testsTotal ? (c.testsPassed/c.testsTotal)*100 : 0} size={80} stroke={5} color={T.success} label={c.testsTotal ? `${((c.testsPassed/c.testsTotal)*100).toFixed(1)}%` : '—'} />
            <div style={{ flex: 1, display: 'grid', gap: 6, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: T.dim }}>Passed</span><span className="af2-mono" style={{ color: T.success }}>{c.testsPassed?.toLocaleString() || '—'}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: T.dim }}>Failed</span><span className="af2-mono" style={{ color: T.danger }}>{c.testsTotal ? c.testsTotal - c.testsPassed : 0}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: T.dim }}>Total</span><span className="af2-mono" style={{ color: T.text }}>{c.testsTotal?.toLocaleString() || '—'}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: T.dim }}>Duration</span><span className="af2-mono" style={{ color: T.text }}>32.4s</span></div>
            </div>
          </div>
        </Card>

        {/* Active item */}
        <Card>
          <SectionTitle right={<PulseDot color={T.purple} size={5} />}>NOW EXECUTING</SectionTitle>
          {a.items.filter(i => i.status === 'in_progress').slice(0,1).map(it => (
            <div key={it.id} style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>#{it.id}</span>
                <ModelChip model={it.model} />
                <span className="af2-mono" style={{ fontSize: 10, color: T.muted }}>{it.assignee}</span>
              </div>
              <div style={{ fontSize: 12, color: T.text, lineHeight: 1.5 }}>{it.title}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, fontSize: 11, color: T.dim }}>
                <span className="af2-mono">{it.dur}</span>
                <span className="af2-mono">${it.cost.toFixed(3)}</span>
                <span className="af2-mono">{it.files} files</span>
                <span style={{ flex: 1 }} />
                <Btn size="sm">View logs</Btn>
              </div>
              <div style={{ marginTop: 10, height: 3, background: T.border, borderRadius: 2, overflow: 'hidden' }}>
                <div className="af2-flow" style={{ height: '100%', width: '73%' }} />
              </div>
            </div>
          ))}
        </Card>

        {/* Killswitch / status */}
        <Card>
          <SectionTitle>HEALTH</SectionTitle>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { l: 'Budget',     ok: c.costUsd / c.budgetUsd < 0.5, msg: `${Math.round(c.costUsd/c.budgetUsd*100)}% used` },
              { l: 'Test pass',  ok: c.testsPassed / c.testsTotal > 0.95, msg: c.testsTotal ? `${((c.testsPassed/c.testsTotal)*100).toFixed(1)}%` : '—' },
              { l: 'Approval',   ok: true, msg: 'none required' },
              { l: 'Killswitch', ok: true, msg: 'armed' },
            ].map(h => (
              <div key={h.l} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: h.ok ? T.success : T.warning }} />
                <span style={{ color: T.muted, flex: 1 }}>{h.l}</span>
                <span className="af2-mono" style={{ color: T.text }}>{h.msg}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function DefRow({ label, value, mono, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: T.dim, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div className={mono ? 'af2-mono' : ''} style={{ fontSize: 12, color: color || T.text }}>{value}</div>
    </div>
  );
}

// ── Pipeline Tab (Vercel-style vertical timeline) ──────────────────────────────
function PipelineTab({ c }) {
  const a = window.AF2;
  return (
    <Card noPad>
      <div style={{
        padding: '12px 18px', borderBottom: `1px solid ${T.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <SectionTitle>PIPELINE PHASES</SectionTitle>
        <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>{a.cycle.phases.length} phases</span>
      </div>
      <div style={{ padding: '8px 0' }}>
        {a.cycle.phases.map((p, i) => (
          <PipelineRow key={p.name} p={p} idx={i} last={i === a.cycle.phases.length - 1} />
        ))}
      </div>
    </Card>
  );
}

function PipelineRow({ p, idx, last }) {
  const [open, setOpen] = useS2(p.status === 'active');
  const isActive = p.status === 'active', isDone = p.status === 'done', isFailed = p.status === 'failed';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr auto', position: 'relative' }}>
      {/* Left rail */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14 }}>
        <div style={{
          width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
          background: isDone ? 'var(--af-grad)'
                    : isActive ? T.surface
                    : isFailed ? `${T.danger}15`
                    : T.surface,
          border: isActive ? `2px solid ${T.purple}` : isFailed ? `2px solid ${T.danger}` : isDone ? 'none' : `1px solid ${T.border3}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 11, fontWeight: 700,
          ...(isActive ? { boxShadow: `0 0 0 4px ${T.purple}22` } : {}),
        }}>
          {isDone ? '✓' : isFailed ? '✗' : isActive ? (
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--af-grad)' }} />
          ) : <span style={{ fontSize: 10, color: T.faint }}>{idx + 1}</span>}
        </div>
        {!last && (
          <div style={{
            width: 2, flex: 1, minHeight: 36, marginTop: 4,
            background: isDone ? 'var(--af-grad-v)' : isActive ? T.purple : T.border,
            position: 'relative', overflow: 'hidden',
          }}>
            {isActive && (
              <div style={{
                position: 'absolute', inset: 0,
                background: `linear-gradient(180deg, ${T.purple} 0%, transparent 100%)`,
                backgroundSize: '100% 200%', animation: 'af2flow 2s linear infinite',
              }} />
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: '12px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
          <button onClick={() => setOpen(o => !o)} style={{
            background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: isActive ? T.purple : isFailed ? T.danger : isDone ? T.text : T.dim }}>{p.name}</span>
            {isActive && <Badge variant="purple">RUNNING</Badge>}
            {isDone && <span style={{ fontSize: 10, color: T.success }}>✓ completed</span>}
            {isFailed && <span style={{ fontSize: 10, color: T.danger }}>✗ failed</span>}
            <span style={{ color: T.faint, fontSize: 11 }}>{open ? '▴' : '▾'}</span>
          </button>
        </div>
        <div style={{ fontSize: 12, color: T.dim, lineHeight: 1.5 }}>{p.detail}</div>
        {p.agent && (isActive || isDone) && (
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="af2-mono" style={{ fontSize: 11, color: T.muted }}>{p.agent}</span>
            <ModelChip model={p.model} />
          </div>
        )}
        {open && (isActive || isDone) && (
          <div style={{
            marginTop: 10, padding: '10px 12px',
            background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 6,
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, fontSize: 11 }}>
              <div><span style={{ color: T.dim }}>Started</span><div className="af2-mono" style={{ color: T.text, marginTop: 2 }}>2h 3m ago</div></div>
              <div><span style={{ color: T.dim }}>Agent runs</span><div className="af2-mono" style={{ color: T.text, marginTop: 2 }}>{p.name === 'RUN' ? '5' : '1'}</div></div>
              <div><span style={{ color: T.dim }}>Files touched</span><div className="af2-mono" style={{ color: T.text, marginTop: 2 }}>{p.name === 'RUN' ? '12' : '0'}</div></div>
            </div>
          </div>
        )}
      </div>

      {/* Right meta */}
      <div style={{ padding: '12px 18px 12px 4px', textAlign: 'right', minWidth: 110 }}>
        {p.durMs != null ? (
          <div className="af2-mono" style={{ fontSize: 13, fontWeight: 500, color: T.text }}>{fmtDuration(p.durMs)}</div>
        ) : (
          <div style={{ fontSize: 11, color: T.faint }}>pending</div>
        )}
        {p.costUsd != null && (
          <div className="af2-mono" style={{ fontSize: 11, color: T.dim, marginTop: 2 }}>${p.costUsd.toFixed(3)}</div>
        )}
      </div>
    </div>
  );
}

// ── Items Tab ────────────────────────────────────────────────────────────
function ItemsTab({ c }) {
  const a = window.AF2;
  const items = a.items;
  const completed = items.filter(i => i.status === 'completed');
  const active = items.filter(i => i.status === 'in_progress');
  const planned = items.filter(i => i.status === 'planned');
  const failed = items.filter(i => i.status === 'failed');
  const pct = items.length > 0 ? (completed.length / items.length) * 100 : 0;
  const [selected, setSelected] = useS2(null);

  return (
    <div>
      {/* Summary */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="af2-mono" style={{ fontSize: 18, fontWeight: 600, color: T.text }}>v{c.sprintVersion}</div>
            <div style={{ fontSize: 11, color: T.dim, marginTop: 2 }}>AgentForge v{c.sprintVersion} — Autonomous Cycle</div>
            <div className="af2-mono" style={{ fontSize: 10, color: T.faint, marginTop: 4 }}>14.0.0 → {c.sprintVersion} (minor — feature/capability tags)</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="af2-mono" style={{ fontSize: 26, fontWeight: 600, color: T.text, letterSpacing: '-0.02em' }}>
              <AnimNum value={pct} decimals={0} suffix="%" mono={false} />
            </div>
            <div style={{ fontSize: 11, color: T.dim }}>{completed.length}/{items.length} items</div>
          </div>
        </div>
        <div style={{ marginTop: 10, height: 4, background: T.border, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--af-grad-h)', transition: 'width 700ms ease' }} />
        </div>
      </Card>

      {/* Kanban columns */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${[planned, active, completed, failed].filter(c => c.length > 0).length}, 1fr)`, gap: 12 }}>
        {planned.length > 0 && <KanbanCol title="PLANNED" color={T.dim} items={planned} onSelect={setSelected} />}
        {active.length > 0 && <KanbanCol title="IN PROGRESS" color={T.purple} items={active} onSelect={setSelected} />}
        {completed.length > 0 && <KanbanCol title="COMPLETED" color={T.success} items={completed} onSelect={setSelected} />}
        {failed.length > 0 && <KanbanCol title="FAILED" color={T.danger} items={failed} onSelect={setSelected} />}
      </div>

      <ItemDetailDrawer item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function KanbanCol({ title, color, items, onSelect }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em' }}>
        <span style={{ color }}>{title}</span>
        <span className="af2-mono" style={{
          fontSize: 10, padding: '1px 6px', borderRadius: 999, background: T.surface2, border: `1px solid ${T.border2}`, color: T.dim,
        }}>{items.length}</span>
      </div>
      {items.map(it => <KanbanCard key={it.id} it={it} color={color} onSelect={onSelect} />)}
    </div>
  );
}

function KanbanCard({ it, color, onSelect }) {
  const clickable = it.output != null;
  return (
    <div
      onClick={clickable ? () => onSelect(it) : undefined}
      className={clickable ? 'af2-hover-card' : ''}
      style={{
        background: T.surface, border: `1px solid ${T.border2}`, borderLeft: `3px solid ${color}`,
        borderRadius: 6, padding: '10px 12px', marginBottom: 8,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'border-color 180ms ease, background 180ms ease',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>#{it.id}</span>
        {it.model && <ModelChip model={it.model} />}
        {clickable && <span style={{ marginLeft: 'auto', fontSize: 11, color: T.faint }}>›</span>}
      </div>
      <div style={{
        fontSize: 12, color: it.status === 'completed' ? T.dim : T.text,
        textDecoration: it.status === 'completed' ? 'line-through' : 'none',
        textDecorationColor: T.border3,
        lineHeight: 1.5,
      }}>{it.title}</div>
      {(it.assignee || it.dur || it.cost) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 10, color: T.dim }}>
          {it.assignee && <span className="af2-mono">{it.assignee}</span>}
          {it.dur && <span className="af2-mono">· {it.dur}</span>}
          {it.cost != null && <span className="af2-mono">· ${it.cost.toFixed(3)}</span>}
          {it.status === 'in_progress' && <PulseDot color={T.purple} size={5} />}
        </div>
      )}
      {it.error && <div style={{ fontSize: 10, color: T.danger, marginTop: 6, fontFamily: 'JetBrains Mono, monospace' }}>{it.error}</div>}
    </div>
  );
}

function ItemDetailDrawer({ item, onClose }) {
  if (!item) return null;
  const statusVariant = item.status === 'completed' ? 'success' : item.status === 'in_progress' ? 'purple' : item.status === 'failed' ? 'danger' : 'muted';
  return (
    <DetailDrawer
      open={!!item} onClose={onClose}
      kicker={`ITEM · #${item.id}`}
      title={item.title}
      subtitle={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {item.assignee && <span className="af2-mono">{item.assignee}</span>}
          {item.dur && <span className="af2-mono">· {item.dur}</span>}
          {item.cost != null && <span className="af2-mono">· ${item.cost.toFixed(3)}</span>}
          {item.files > 0 && <span className="af2-mono">· {item.files} files</span>}
        </span>
      }
      badge={<>
        <Badge variant={statusVariant}>{item.status.replace('_', ' ')}</Badge>
        {item.model && <ModelChip model={item.model} />}
      </>}
      actions={<><Btn size="sm">Copy</Btn><Btn size="sm">Open diff</Btn></>}
    >
      <MarkdownView source={item.output} />
    </DetailDrawer>
  );
}

// ── Agents Tab ─────────────────────────────────────────────────────────────────
function AgentsTab({ c }) {
  const a = window.AF2;
  const sorted = [...a.agentsLive].sort((x, y) => y.cost - x.cost);
  const [selected, setSelected] = useS2(null);
  const totalCost = a.agentsLive.reduce((s,x) => s + x.cost, 0);
  return (
    <div>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: T.text }}>{a.agentsLive.length} agents · {a.agentsLive.reduce((s,x) => s + (x.dur === 'queued' ? 0 : 1), 0)} runs</div>
            <div style={{ fontSize: 11, color: T.dim, marginTop: 2 }}>Live — updates every 3s</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="af2-mono" style={{ fontSize: 26, fontWeight: 600, color: T.text }}><AnimNum value={totalCost} decimals={2} prefix="$" mono={false} /></div>
            <div style={{ fontSize: 11, color: T.dim }}>total cost</div>
          </div>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {sorted.map(ag => <AgentRunCard key={ag.id} ag={ag} totalCost={totalCost} onSelect={setSelected} />)}
      </div>

      <AgentRunDetailDrawer agent={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function AgentRunCard({ ag, totalCost, onSelect }) {
  const pct = (ag.cost / totalCost) * 100;
  const clickable = ag.output != null;
  return (
    <Card hover style={{ padding: '12px 14px', cursor: clickable ? 'pointer' : 'default' }} onClick={clickable ? () => onSelect(ag) : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: ag.state === 'running' ? T.purple : ag.state === 'done' ? T.success : T.border3,
          ...(ag.state === 'running' ? { boxShadow: `0 0 6px ${T.purple}` } : {}),
        }} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{ag.id}</span>
        <ModelChip model={ag.model} />
        {clickable && <span style={{ fontSize: 11, color: T.faint }}>›</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: 11, marginBottom: 8 }}>
        <div><div style={{ color: T.dim, fontSize: 10 }}>phase</div><div className="af2-mono" style={{ color: T.text, marginTop: 2 }}>{ag.phase}</div></div>
        <div><div style={{ color: T.dim, fontSize: 10 }}>duration</div><div className="af2-mono" style={{ color: T.text, marginTop: 2 }}>{ag.dur}</div></div>
        <div><div style={{ color: T.dim, fontSize: 10 }}>cost</div><div className="af2-mono" style={{ color: T.text, marginTop: 2 }}>${ag.cost.toFixed(3)}</div></div>
      </div>
      <Sparkline data={ag.spark} color={ag.state === 'running' ? T.purple : T.dim} w={250} h={24} gradient />
      <div style={{ marginTop: 8, height: 2, background: T.border, borderRadius: 1, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--af-grad-h)' }} />
      </div>
      <div style={{ fontSize: 9, color: T.dim, marginTop: 3, textAlign: 'right' }} className="af2-mono">{pct.toFixed(1)}% of cycle</div>
    </Card>
  );
}

function AgentRunDetailDrawer({ agent, onClose }) {
  if (!agent) return null;
  const stateVariant = agent.state === 'running' ? 'purple' : agent.state === 'done' ? 'success' : 'muted';
  return (
    <DetailDrawer
      open={!!agent} onClose={onClose}
      kicker={`AGENT RUN · ${agent.phase.toUpperCase()} PHASE`}
      title={agent.id}
      subtitle={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="af2-mono">{agent.phase}</span>
          {agent.dur !== 'queued' && <span className="af2-mono">· {agent.dur}</span>}
          <span className="af2-mono">· ${agent.cost.toFixed(3)}</span>
        </span>
      }
      badge={<>
        <Badge variant={stateVariant}>{agent.state}</Badge>
        <ModelChip model={agent.model} />
      </>}
      actions={<><Btn size="sm">Copy</Btn><Btn size="sm">Open agent</Btn></>}
    >
      <MarkdownView source={agent.output} />
    </DetailDrawer>
  );
}

// ── Events Tab ─────────────────────────────────────────────────────────────────
function EventsTab({ c }) {
  const a = window.AF2;
  const [typeFilter, setTypeFilter] = useS2('all');
  const types = ['all', ...new Set(a.events.map(e => e.type.split('.')[0]))];

  const filtered = typeFilter === 'all' ? a.events : a.events.filter(e => e.type.startsWith(typeFilter));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {types.map(t => (
          <button key={t} onClick={() => setTypeFilter(t)} style={{
            padding: '4px 12px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
            background: typeFilter === t ? T.surface2 : 'transparent',
            border: `1px solid ${typeFilter === t ? T.border3 : T.border2}`,
            color: typeFilter === t ? T.text : T.dim, fontWeight: 500,
          }}>{t}</button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: T.dim }}>{filtered.length} events</span>
        <Btn size="sm">Refresh</Btn>
      </div>

      <Card noPad>
        <div style={{ padding: '4px 0' }}>
          {filtered.map((e, i) => {
            const cat = e.type.split('.')[0];
            const color = cat === 'agent' ? T.purple : cat === 'phase' ? T.sonnet : cat === 'tests' ? T.warning : cat === 'item' ? T.success : cat === 'file' ? T.dim : T.dim;
            return (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '100px 140px 1fr auto', gap: 14, alignItems: 'center',
                padding: '8px 16px', borderBottom: `1px solid ${T.border}`,
              }}>
                <span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>{fmtRel(e.t)}</span>
                <span className="af2-mono" style={{ fontSize: 11, color, fontWeight: 600 }}>{e.type}</span>
                <span style={{ fontSize: 12, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.agent && <span className="af2-mono" style={{ color: T.text }}>{e.agent}</span>}
                  {e.agent && ' '}{e.msg}
                </span>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, opacity: 0.5 }} />
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

// ── Files Tab ──────────────────────────────────────────────────────────────────
function FilesTab({ c }) {
  const FILES = [
    { name: 'tests.json',           size: '12.4 KB', updated: '13m ago' },
    { name: 'git.json',             size: '0.8 KB',  updated: '13m ago' },
    { name: 'pr.json',              size: 'empty',   updated: '—' },
    { name: 'approval-pending.json', size: 'empty',  updated: '—' },
    { name: 'approval-decision.json',size: '0.3 KB', updated: '17m ago' },
    { name: 'sprint.json',          size: '4.1 KB',  updated: '1h 30m ago' },
    { name: 'plan.json',            size: '2.7 KB',  updated: '1h 32m ago' },
  ];
  const [active, setActive] = useS2('tests.json');
  const sample = {
    'tests.json': `{
  "passed": 4832,
  "failed": 5,
  "skipped": 0,
  "total": 4837,
  "passRate": 0.99897,
  "durationMs": 32411,
  "failedTests": [
    {
      "file": "/tests/integration/full-cycle.test.ts",
      "name": "runs end-to-end with mocked runtime",
      "error": "AssertionError: expected false to be true"
    },
    {
      "file": "/tests/unit/execute-phase.test.ts",
      "name": "writes phase JSON to cycle dir when cycleId is set",
      "error": "Error: failed to read sprint file at /tmp/agentforge-..."
    }
  ]
}`,
    'git.json': `{
  "branch": "autonomous/v14.1.0",
  "baseBranch": "main",
  "sha": null,
  "pushed": false,
  "commitCount": 0
}`,
    'pr.json': 'null',
    'approval-pending.json': 'null',
    'approval-decision.json': `{
  "approved": true,
  "approvedAt": "2026-05-15T05:00:42.691Z",
  "approver": "auto-gate"
}`,
    'sprint.json': `{
  "version": "14.1.0",
  "items": 5,
  "status": "in_progress",
  "itemsCompleted": 3
}`,
    'plan.json': '{ "rationale": "minor bump — feature/capability tags found" }',
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 12 }}>
      <Card noPad>
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${T.border}`, fontSize: 10, fontWeight: 600, color: T.dim, letterSpacing: '0.08em', textTransform: 'uppercase' }}>FILES</div>
        {FILES.map(f => (
          <button key={f.name} onClick={() => setActive(f.name)} style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 14px', background: active === f.name ? T.surface2 : 'transparent',
            border: 'none', borderLeft: active === f.name ? `2px solid ${T.purple}` : '2px solid transparent',
            color: T.text, cursor: 'pointer', fontSize: 12, textAlign: 'left',
          }} className="af2-mono">
            <span style={{ flex: 1, color: f.size === 'empty' ? T.faint : T.text }}>{f.name}</span>
            <span style={{ fontSize: 10, color: T.dim }}>{f.size}</span>
          </button>
        ))}
      </Card>
      <Card noPad>
        <div style={{
          padding: '10px 14px', borderBottom: `1px solid ${T.border}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span className="af2-mono" style={{ fontSize: 12, fontWeight: 600 }}>{active}</span>
          <Btn size="sm">Copy</Btn>
        </div>
        <pre className="af2-mono" style={{
          margin: 0, padding: '14px 18px', fontSize: 11, color: T.muted, lineHeight: 1.65,
          background: T.surface, overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap',
        }}>{sample[active]}</pre>
      </Card>
    </div>
  );
}

// ── Logs Tab ───────────────────────────────────────────────────────────────────
function LogsTab({ c }) {
  const LOGS = ['cli-stdout.log', 'tests-raw.log', 'agent-coder.log'];
  const [active, setActive] = useS2(LOGS[0]);
  const [mode, setMode] = useS2('structured');
  const text = `[cycle] budget override: $200
[cycle] maxItems override: 8
[cycle] modelCap override: sonnet
[cycle] effortCap override: max
[cycle] cycleId=b555cca4-5697-46ae-9b4d-49b97e871124
[cycle] logDir=.agentforge/cycles/b555cca4-5697-46ae-9b4d-49b97e871124
[cycle] phase: audit ▶
[audit] researcher · loaded 5 candidate items
[audit] researcher · approved 5/5
[audit] phase complete · 3m 17s · $0.412
[cycle] phase: plan ▶
[plan] cto · sprint v14.1.0 planned
[plan] phase complete · 59s · $0.106
[cycle] phase: execute ▶ (running)
[execute] coder · starting item 1
[execute] coder · item 1 done · 18m 22s · $1.420
[execute] coder · starting item 2
[execute] coder · item 2 done · 9m 41s · $0.892
[execute] coder · starting item 3
[execute] coder · item 3 done · 5m 03s · $0.461
[execute] coder · starting item 4
WARN [execute] coder · file conflict on src/lib/stores/costs.ts — auto-resolved
[execute] coder · item 4 73% complete
[livestream] tail follows…`;
  const lines = text.split('\n');

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        {LOGS.map(l => (
          <button key={l} onClick={() => setActive(l)} style={{
            padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
            background: active === l ? T.surface2 : 'transparent',
            border: `1px solid ${active === l ? T.border3 : T.border2}`,
            color: active === l ? T.text : T.dim,
          }} className="af2-mono">{l}</button>
        ))}
        <span style={{ flex: 1 }} />
        <PulseDot color={T.success} size={5} />
        <span style={{ fontSize: 10, color: T.dim }} className="af2-mono">live · tail -f</span>
        <span style={{ width: 1, height: 14, background: T.border, margin: '0 4px' }} />
        {['structured', 'raw'].map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
            background: mode === m ? T.surface2 : 'transparent',
            border: `1px solid ${mode === m ? T.border3 : T.border2}`,
            color: mode === m ? T.text : T.dim,
          }}>{m[0].toUpperCase() + m.slice(1)}</button>
        ))}
      </div>
      <Card noPad>
        <div style={{ maxHeight: 480, overflow: 'auto', padding: '8px 0' }} className="af2-mono">
          {lines.map((line, i) => {
            const isErr = /ERROR|FAIL/.test(line);
            const isWarn = /WARN/.test(line);
            const isPhase = /phase: \w+ ▶/.test(line);
            const isLivestream = line.startsWith('[livestream]');
            return (
              <div key={i} style={{
                display: mode === 'structured' ? 'grid' : 'block',
                gridTemplateColumns: 'auto auto 1fr',
                gap: 12, alignItems: 'baseline',
                padding: '2px 16px', fontSize: 11,
                color: isErr ? T.danger : isWarn ? T.warning : isPhase ? T.purple : isLivestream ? T.success : T.muted,
                background: isPhase ? `${T.purple}06` : 'transparent',
              }}>
                {mode === 'structured' && <span style={{ color: T.faint, minWidth: 50 }}>{String(i).padStart(4, '0')}</span>}
                {mode === 'structured' && <span style={{ color: T.dim }}>{new Date(Date.now() - (lines.length - i) * 5000).toLocaleTimeString('en-US', { hour12: false })}</span>}
                <span style={{ whiteSpace: 'pre-wrap' }}>{line}</span>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

// ── Scoring Tab ────────────────────────────────────────────────────────────────
function ScoringTab({ c }) {
  const a = window.AF2;
  const sc = a.scoring;
  return (
    <div>
      {/* Overall + warnings */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 14, marginBottom: 14 }}>
        <Card style={{ background: `linear-gradient(135deg, ${T.surface}, ${T.surface2})`, border: `1px solid ${T.purple}33`, padding: 20 }}>
          <SectionTitle right={
            <span className="af2-mono" style={{ fontSize: 10, color: T.success, padding: '2px 6px', background: `${T.success}15`, borderRadius: 3 }}>{sc.delta}</span>
          }>OVERALL SCORE</SectionTitle>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 14 }}>
            <Ring value={sc.overall} size={120} stroke={8} color={T.purple} label={sc.overall + '%'} sub="overall" />
            <div>
              <div style={{ fontSize: 14, color: T.text, lineHeight: 1.55, fontWeight: 500 }}>
                {sc.overall >= 80 ? 'Strong cycle.' : sc.overall >= 60 ? 'Acceptable cycle.' : 'Weak cycle.'}
              </div>
              <div style={{ fontSize: 12, color: T.dim, marginTop: 6, lineHeight: 1.55 }}>{sc.summary}</div>
            </div>
          </div>
        </Card>
        <Card>
          <SectionTitle>WARNINGS · {sc.warnings.length}</SectionTitle>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sc.warnings.length === 0 && <div style={{ fontSize: 12, color: T.dim }}>No warnings — all systems within target.</div>}
            {sc.warnings.map((w, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px',
                background: `${T.warning}08`, border: `1px solid ${T.warning}30`, borderRadius: 6,
              }}>
                <span style={{ color: T.warning, fontSize: 14 }}>⚠</span>
                <span style={{ fontSize: 12, color: T.text }}>{w}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Radar chart + dimensions table */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 14, marginBottom: 14 }}>
        <Card>
          <SectionTitle>DIMENSIONS</SectionTitle>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
            <ScoringRadar dimensions={sc.dimensions} />
          </div>
        </Card>
        <Card>
          <SectionTitle>BREAKDOWN</SectionTitle>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sc.dimensions.map(d => (
              <div key={d.key}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: d.color }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: T.text, letterSpacing: '0.01em' }}>{d.label}</span>
                  </div>
                  <span className="af2-mono" style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
                    <AnimNum value={d.score} decimals={0} mono={false} />
                    <span style={{ color: T.dim, fontSize: 11 }}>/{d.max}</span>
                  </span>
                </div>
                <div style={{ height: 4, background: T.border, borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(d.score / d.max) * 100}%`, background: d.color, transition: 'width 700ms cubic-bezier(.2,.7,.2,1)' }} />
                </div>
                <div style={{ fontSize: 10, color: T.dim, marginTop: 3 }}>{d.detail}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Per-item ranking */}
      <Card noPad>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}` }}>
          <SectionTitle right={<span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>ranked by score</span>}>ITEM SCORING</SectionTitle>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['#', 'Item', 'Score', 'Confidence', 'Cost', 'Rationale'].map(h => (
                <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.dim, padding: '10px 14px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...sc.items].sort((x, y) => y.score - x.score).map((it, idx) => (
              <tr key={it.id} style={{ borderBottom: `1px solid ${T.border}` }} className="af2-hover-row">
                <td style={{ padding: '10px 14px' }}>
                  <span className="af2-mono" style={{ fontSize: 11, color: T.faint }}>#{it.id}</span>
                </td>
                <td style={{ padding: '10px 14px', maxWidth: 280 }}>
                  <div style={{ fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</div>
                </td>
                <td style={{ padding: '10px 14px', width: 140 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="af2-mono" style={{ fontSize: 13, fontWeight: 600, color: it.score >= 80 ? T.success : it.score >= 60 ? T.warning : T.danger }}>
                      {it.score}
                    </span>
                    <div style={{ flex: 1, height: 4, background: T.border, borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${it.score}%`, background: it.score >= 80 ? T.success : it.score >= 60 ? T.warning : T.danger, transition: 'width 500ms ease' }} />
                    </div>
                  </div>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <Badge variant={it.confidence === 'high' ? 'success' : it.confidence === 'medium' ? 'warning' : 'danger'}>{it.confidence}</Badge>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="af2-mono" style={{ fontSize: 11, color: T.text }}>${it.cost.toFixed(3)}</span>
                    {it.withinBudget && <span style={{ fontSize: 9, color: T.success }}>✓</span>}
                  </div>
                </td>
                <td style={{ padding: '10px 14px', color: T.dim, fontSize: 11, maxWidth: 380, lineHeight: 1.5 }}>{it.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ── Scoring Radar (SVG hexagon) ────────────────────────────────────────────────
function ScoringRadar({ dimensions, size = 260 }) {
  const cx = size / 2, cy = size / 2;
  const r = (size / 2) - 28;
  const n = dimensions.length;
  function point(i, scale = 1) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [cx + r * scale * Math.cos(a), cy + r * scale * Math.sin(a)];
  }
  // grid rings
  const rings = [0.25, 0.5, 0.75, 1.0];
  const polyAxes = dimensions.map((_, i) => point(i, 1));
  const dataPts = dimensions.map((d, i) => point(i, d.score / d.max));
  const polyData = dataPts.map(p => p.join(',')).join(' ');

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <defs>
        <linearGradient id="radar-fill" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%"  stopColor={T.accent}  stopOpacity="0.4" />
          <stop offset="100%" stopColor={T.purple} stopOpacity="0.15" />
        </linearGradient>
      </defs>
      {/* Rings */}
      {rings.map(rr => (
        <polygon key={rr}
          points={dimensions.map((_, i) => point(i, rr).join(',')).join(' ')}
          fill="none" stroke={T.border} strokeWidth="1" opacity="0.5" />
      ))}
      {/* Axes */}
      {polyAxes.map((p, i) => (
        <line key={i} x1={cx} y1={cy} x2={p[0]} y2={p[1]} stroke={T.border} strokeWidth="1" opacity="0.4" />
      ))}
      {/* Data */}
      <polygon points={polyData} fill="url(#radar-fill)" stroke={T.purple} strokeWidth="1.5"
        style={{ transition: 'all 700ms cubic-bezier(.2,.7,.2,1)' }} />
      {/* Data points */}
      {dataPts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="3" fill={dimensions[i].color} stroke={T.bg} strokeWidth="1.5" />
      ))}
      {/* Labels */}
      {dimensions.map((d, i) => {
        const [lx, ly] = point(i, 1.18);
        return (
          <g key={d.key}>
            <text x={lx} y={ly} fill={T.muted} fontSize="10" fontFamily="Inter" textAnchor="middle" dominantBaseline="middle" fontWeight="600" letterSpacing="0.04em" style={{ textTransform: 'uppercase' }}>
              {d.label}
            </text>
            <text x={lx} y={ly + 12} fill={d.color} fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle" dominantBaseline="middle">
              {d.score}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

Object.assign(window, { CycleDetail });
