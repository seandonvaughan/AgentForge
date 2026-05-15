// ── V2 Pages: built out fully ────────────────────────────────────────────────
const { useState: useS4, useMemo: useM4, useEffect: useE4 } = React;
const A4 = () => window.AF2;

// ═══════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════════════════════
function SessionsPage() {
  const a = A4();
  const [search, setSearch] = useS4('');
  const [statusF, setStatusF] = useS4('all');
  const [modelF, setModelF] = useS4('all');
  const [selected, setSelected] = useS4(null);

  const filtered = useM4(() => a.sessions.filter(s => {
    if (search && !s.agent.toLowerCase().includes(search.toLowerCase()) && !s.task.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusF !== 'all' && s.status !== statusF) return false;
    if (modelF !== 'all' && !s.model.includes(modelF)) return false;
    return true;
  }), [a.sessions, search, statusF, modelF]);

  const stats = useM4(() => ({
    total: a.sessions.length,
    running: a.sessions.filter(s => s.status === 'running').length,
    completed: a.sessions.filter(s => s.status === 'completed').length,
    totalSpend: a.sessions.reduce((s, x) => s + x.cost, 0),
    avgCost: a.sessions.length ? a.sessions.reduce((s, x) => s + x.cost, 0) / a.sessions.length : 0,
  }), [a.sessions]);

  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Sessions']}
        title="Sessions"
        subtitle={<span><span className="af2-mono">{stats.total}</span> sessions · <span className="af2-mono">{stats.running}</span> running · total <span className="af2-mono">${stats.totalSpend.toFixed(4)}</span></span>}
        actions={<Btn size="sm">Export CSV</Btn>}
      />

      {/* Stats strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 12 }}>
        <KpiTile label="Total" value={stats.total} color={T.text} />
        <KpiTile label="Running" value={stats.running} color={T.purple} live={stats.running > 0} />
        <KpiTile label="Completed" value={stats.completed} color={T.success} />
        <KpiTile label="Avg cost" value={'$' + stats.avgCost.toFixed(4)} color={T.warning} />
        <KpiTile label="Total spend" value={'$' + stats.totalSpend.toFixed(4)} color={T.accent2} />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Input value={search} onChange={setSearch} placeholder="Search agent or task…" prefix="⌕" style={{ width: 360 }} />
        <span style={{ fontSize: 11, color: T.dim, marginLeft: 6 }}>STATUS</span>
        {['all', 'running', 'completed'].map(s => <ChipBtn key={s} active={statusF === s} onClick={() => setStatusF(s)}>{s}</ChipBtn>)}
        <span style={{ width: 1, height: 18, background: T.border, margin: '0 4px' }} />
        <span style={{ fontSize: 11, color: T.dim }}>MODEL</span>
        {['all', 'opus', 'sonnet', 'haiku'].map(m => <ChipBtn key={m} active={modelF === m} onClick={() => setModelF(m)} color={m === 'opus' ? T.opus : m === 'sonnet' ? T.sonnet : m === 'haiku' ? T.haiku : null}>{m}</ChipBtn>)}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: T.dim }}>{filtered.length} of {stats.total}</span>
      </div>

      <Card noPad>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['Agent', 'Task', 'Model', 'Status', 'Duration', 'Cost', 'Started'].map(h => (
                <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.dim, padding: '10px 14px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((s, i) => (
              <tr key={i} className="af2-hover-row" onClick={() => setSelected(s)} style={{ borderBottom: `1px solid ${T.border}`, cursor: 'pointer', background: selected === s ? `${T.purple}10` : 'transparent' }}>
                <td style={{ padding: '8px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {s.status === 'running' && <PulseDot color={T.purple} size={5} />}
                    <span className="af2-mono" style={{ fontSize: 11, background: T.surface2, border: `1px solid ${T.border2}`, padding: '2px 8px', borderRadius: 4 }}>{s.agent}</span>
                  </div>
                </td>
                <td style={{ padding: '8px 14px', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.text }}>{s.task}</td>
                <td style={{ padding: '8px 14px' }}><ModelChip model={s.model.includes('opus') ? 'opus' : s.model.includes('sonnet') ? 'sonnet' : 'haiku'} /></td>
                <td style={{ padding: '8px 14px' }}>
                  <Badge variant={s.status === 'running' ? 'purple' : s.status === 'completed' ? 'success' : 'danger'}>{s.status}</Badge>
                </td>
                <td style={{ padding: '8px 14px' }}><span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>{s.dur || '—'}</span></td>
                <td style={{ padding: '8px 14px' }}><span className="af2-mono" style={{ fontSize: 11, color: T.text }}>${s.cost.toFixed(4)}</span></td>
                <td style={{ padding: '8px 14px', color: T.dim, fontSize: 11 }}>{fmtRel(s.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {selected && <SessionDetailDrawer session={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function SessionDetailDrawer({ session, onClose }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', justifyContent: 'flex-end', animation: 'af2fade 200ms' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(640px, 92vw)', height: '100%', background: T.bg, borderLeft: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', boxShadow: '-12px 0 60px rgba(0,0,0,0.6)' }}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              {session.status === 'running' && <PulseDot color={T.purple} size={6} />}
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }} className="af2-mono">{session.agent}</h3>
              <Badge variant={session.status === 'running' ? 'purple' : 'success'}>{session.status}</Badge>
            </div>
            <p style={{ margin: 0, fontSize: 11, color: T.dim }}>started {fmtRel(session.at)}</p>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 6, background: T.surface, border: `1px solid ${T.border2}`, color: T.muted, cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          <Card style={{ marginBottom: 12 }}>
            <SectionTitle>TASK</SectionTitle>
            <div style={{ marginTop: 10, fontSize: 13, color: T.text, lineHeight: 1.6 }}>{session.task}</div>
          </Card>
          <Card style={{ marginBottom: 12 }}>
            <SectionTitle>METRICS</SectionTitle>
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              <DefMetric label="Model"    value={<ModelChip model={session.model.includes('opus') ? 'opus' : session.model.includes('sonnet') ? 'sonnet' : 'haiku'} />} />
              <DefMetric label="Duration" value={session.dur || '—'} mono />
              <DefMetric label="Cost"     value={'$' + session.cost.toFixed(4)} mono />
              <DefMetric label="Tokens"   value="≈ 4,200" mono />
            </div>
          </Card>
          <Card>
            <SectionTitle>OUTPUT</SectionTitle>
            <pre className="af2-mono" style={{ margin: '10px 0 0', padding: '12px 14px', background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 6, fontSize: 11, color: T.muted, lineHeight: 1.7, overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap' }}>
{`▶ Analyzing task requirements…
▶ Loading agent configuration: ${session.agent}
▶ Model: ${session.model}
▶ Executing task…

Task ${session.status === 'running' ? 'in progress' : 'completed'}.

Files touched:
  src/lib/components/MarkdownRenderer.svelte (+127 −8)
  src/routes/cycles/[id]/+page.svelte (+42 −15)
  src/lib/util/phase-render.ts (+89 −4)

${session.status === 'running' ? '⏳ streaming…' : '✓ done — ' + session.dur}`}
            </pre>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COST ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════
function CostPage() {
  const a = A4();
  const [range, setRange] = useS4('7d');

  const byModel = [
    { model: 'opus',   cost: 0.92, sessions: 5,  color: T.opus },
    { model: 'sonnet', cost: 1.53, sessions: 10, color: T.sonnet },
    { model: 'haiku',  cost: 0.12, sessions: 6,  color: T.haiku },
  ];
  const total = byModel.reduce((s, x) => s + x.cost, 0);

  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Cost']}
        title="Cost analytics"
        subtitle="Token spend by agent, model, and cycle"
        actions={
          <>
            <div style={{ display: 'flex', gap: 0, background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 6, padding: 2 }}>
              {['24h', '7d', '30d', '90d'].map(r => (
                <button key={r} onClick={() => setRange(r)} style={{
                  padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 500, cursor: 'pointer',
                  background: range === r ? T.surface2 : 'transparent', border: 'none',
                  color: range === r ? T.text : T.dim,
                }}>{r}</button>
              ))}
            </div>
            <Btn size="sm">Export</Btn>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        <KpiTile label="Total spend" value={'$' + a.counters.totalSpend.toFixed(4)} delta="+12%" color={T.purple} />
        <KpiTile label="Avg / cycle" value="$12.40" delta="-18%" color={T.success} />
        <KpiTile label="Most expensive" value="$5.89" sub="b555cca4" color={T.warning} />
        <KpiTile label="Top model" value="sonnet" sub={`${byModel[1].sessions} sessions`} color={T.sonnet} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
        <Card>
          <SectionTitle right={<span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>14 cycles</span>}>SPEND OVER TIME</SectionTitle>
          <div style={{ marginTop: 14, position: 'relative', height: 200 }}>
            <Sparkline data={a.kpis.costPerCycle.spark} color={T.purple} w={760} h={200} gradient strokeWidth={2} />
            <div style={{ position: 'absolute', top: 0, right: 0, fontSize: 10, color: T.dim, padding: '2px 6px', background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 4 }} className="af2-mono">avg $12.40</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10, color: T.faint }} className="af2-mono">
            <span>14 cycles ago</span><span>now</span>
          </div>
        </Card>

        <Card>
          <SectionTitle>BY MODEL TIER</SectionTitle>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {byModel.map(m => {
              const pct = (m.cost / total) * 100;
              return (
                <div key={m.model}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: m.color }} />
                      <span className="af2-mono" style={{ textTransform: 'uppercase', color: T.text }}>{m.model}</span>
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="af2-mono" style={{ fontSize: 11, color: T.text }}>${m.cost.toFixed(2)}</span>
                      <span className="af2-mono" style={{ fontSize: 10, color: T.dim, minWidth: 36, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
                    </div>
                  </div>
                  <div style={{ height: 6, background: T.border, borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: m.color, transition: 'width 500ms ease' }} />
                  </div>
                  <div style={{ fontSize: 10, color: T.dim, marginTop: 3 }}>{m.sessions} sessions</div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <Card style={{ marginTop: 14 }} noPad>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <SectionTitle right={null}>PER-AGENT SPEND</SectionTitle>
          <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>sorted by total</span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['Agent', 'Model', 'Sessions', 'Total spend', 'Avg / session', 'Trend'].map(h => (
                <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.dim, padding: '8px 14px', borderBottom: `1px solid ${T.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...a.agents].sort((x, y) => y.spend - x.spend).slice(0, 12).map((ag, i) => (
              <tr key={ag.id} className="af2-hover-row" style={{ borderBottom: `1px solid ${T.border}` }}>
                <td style={{ padding: '8px 14px' }} className="af2-mono">{ag.id}</td>
                <td style={{ padding: '8px 14px' }}><ModelChip model={ag.model} /></td>
                <td style={{ padding: '8px 14px' }} className="af2-mono">{(i % 5) + 1}</td>
                <td style={{ padding: '8px 14px' }} className="af2-mono">${ag.spend.toFixed(3)}</td>
                <td style={{ padding: '8px 14px', color: T.dim }} className="af2-mono">${(ag.spend / 3).toFixed(4)}</td>
                <td style={{ padding: '8px 14px' }}><Sparkline data={window.AF2.spark(14, ag.spend, ag.spend * 0.3)} color={T.purple} w={100} h={20} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════════════════════
function HealthPage() {
  const a = A4();
  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Health']}
        title="System health"
        subtitle="Real-time service health and circuit breaker status"
        actions={<><span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>auto-refresh 10s</span><Btn size="sm">Refresh</Btn></>}
      />
      <Card style={{ background: `${T.success}08`, border: `1px solid ${T.success}33`, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <PulseDot color={T.success} size={9} />
            <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>System HEALTHY · {a.services.length} healthy · 0 degraded</span>
          </div>
          <span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>agentforge v{a.version} · workspace {a.workspace.id}</span>
        </div>
      </Card>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10, marginBottom: 14 }}>
        {a.services.map(s => (
          <Card key={s.service} hover>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span className="af2-mono" style={{ fontWeight: 600, fontSize: 13 }}>{s.service}</span>
              <Badge variant={s.successRate === 1 ? 'success' : 'warning'}>{s.successRate === 1 ? 'Healthy' : 'Degraded'}</Badge>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <Ring value={s.successRate * 100} size={48} stroke={3} color={T.success} label={`${(s.successRate * 100).toFixed(1)}%`} />
              <div style={{ flex: 1, fontSize: 11 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: T.dim }}><span>p99</span><span className="af2-mono" style={{ color: T.text }}>{s.p99}ms</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: T.dim, marginTop: 3 }}><span>calls</span><span className="af2-mono" style={{ color: T.text }}>{s.totalCalls.toLocaleString()}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: T.dim, marginTop: 3 }}><span>failures</span><span className="af2-mono" style={{ color: s.failureCount > 0 ? T.warning : T.text }}>{s.failureCount}</span></div>
              </div>
            </div>
            <Sparkline data={s.spark} color={T.success} w={250} h={26} gradient />
          </Card>
        ))}
      </div>

      {/* Incidents log */}
      <Card noPad>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}` }}>
          <SectionTitle right={<span className="af2-mono" style={{ fontSize: 10, color: T.success }}>0 active</span>}>RECENT INCIDENTS</SectionTitle>
        </div>
        <div style={{ padding: '24px 16px', textAlign: 'center', color: T.dim }}>
          <span style={{ fontSize: 28, color: T.success }}>✓</span>
          <div style={{ fontSize: 12, marginTop: 8, color: T.text, fontWeight: 600 }}>No incidents in the last 30 days.</div>
          <div style={{ fontSize: 11, marginTop: 4 }}>Last incident: <span className="af2-mono">embeddings circuit-breaker tripped</span> · 32 days ago · resolved in 4m</div>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FLYWHEEL
// ═══════════════════════════════════════════════════════════════════════════
function FlywheelPage() {
  const a = A4();
  const fw = a.flywheel;
  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Flywheel']}
        title="Flywheel"
        subtitle={<span>Autonomous loop health · computed from <span className="af2-mono">{fw.loop.cyclesRun}</span> cycles, <span className="af2-mono">{fw.loop.sprintIter}</span> sprints, <span className="af2-mono">{fw.loop.agents}</span> agents</span>}
        actions={<><span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>next in 25s</span><Btn size="sm">↺ Refresh</Btn></>}
      />

      <Card style={{ marginBottom: 14, background: `linear-gradient(135deg, ${T.surface}, ${T.surface2})`, border: `1px solid ${T.purple}33`, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 10, color: T.purple, letterSpacing: '0.08em', fontWeight: 700, marginBottom: 6 }}>OVERALL HEALTH</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span className="af2-mono" style={{ fontSize: 52, fontWeight: 700, color: T.text, letterSpacing: '-0.03em' }}>
                <AnimNum value={fw.overall} decimals={0} mono={false} />
              </span>
              <span className="af2-mono" style={{ fontSize: 18, color: T.dim }}>%</span>
              <span className="af2-mono" style={{ fontSize: 11, color: T.success, padding: '2px 8px', background: `${T.success}15`, borderRadius: 999, marginLeft: 8 }}>+3 w/w</span>
            </div>
            <div style={{ fontSize: 12, color: T.dim, marginTop: 6 }}>4 of 4 metrics within target · learning is compounding</div>
          </div>
          <Ring value={fw.overall} size={160} stroke={10} color={T.purple} label={`${fw.overall}%`} sub="overall" />
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        {fw.metrics.map(m => (
          <Card key={m.key} hover style={{ textAlign: 'center', padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
              <Ring value={m.score} size={100} stroke={6} color={m.color} label={`${m.score}%`} />
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: m.color, marginBottom: 6 }}>{m.label}</div>
            <div style={{ fontSize: 11, color: T.dim, lineHeight: 1.5 }}>{m.detail}</div>
            <Sparkline data={window.AF2.trend(14, m.score - 8, m.score, 3)} color={m.color} w={200} h={26} gradient />
          </Card>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 }}>
        <Card>
          <SectionTitle>LOOP DATA</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 14 }}>
            <DefRow label="Cycles run" value={<><span className="af2-mono" style={{ fontSize: 22, fontWeight: 600, color: T.text }}>{fw.loop.cyclesRun}</span><div style={{ fontSize: 10, color: T.dim, marginTop: 3 }}><span className="af2-mono">{fw.loop.completed}</span> completed · <span className="af2-mono">{fw.loop.meaningful}</span> meaningful</div></>} />
            <DefRow label="Sprint iterations" value={<span className="af2-mono" style={{ fontSize: 22, fontWeight: 600, color: T.text }}>{fw.loop.sprintIter}</span>} />
            <DefRow label="Agents on team" value={<span className="af2-mono" style={{ fontSize: 22, fontWeight: 600, color: T.text }}>{fw.loop.agents}</span>} />
            <DefRow label="Sprint items" value={<><span className="af2-mono" style={{ fontSize: 22, fontWeight: 600, color: T.text }}>{fw.loop.itemsDone}<span style={{ color: T.dim }}> / {fw.loop.itemsTotal}</span></span><div style={{ fontSize: 10, color: T.success, marginTop: 3 }} className="af2-mono">{Math.round(fw.loop.itemsDone/fw.loop.itemsTotal*100)}% done</div></>} />
          </div>
        </Card>
        <Card style={{ background: `${T.purple}08`, border: `1px solid ${T.purple}33` }}>
          <SectionTitle right={<Badge variant="success">ACTIVE</Badge>}>MEMORY LOOP</SectionTitle>
          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Total entries</div>
              <div className="af2-mono" style={{ fontSize: 22, fontWeight: 600 }}>{fw.memory.entries}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Hit rate</div>
              <div className="af2-mono" style={{ fontSize: 22, fontWeight: 600, color: T.success }}>{fw.memory.hitRate}%</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: T.dim, marginTop: 12 }}>✓ learning is compounding · <span className="af2-mono">{fw.memory.learningCycles}/{fw.memory.totalCycles}</span> cycles</div>
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE FEED
// ═══════════════════════════════════════════════════════════════════════════
function LiveFeedPage() {
  const a = A4();
  const [filter, setFilter] = useS4('all');
  const filtered = a.events.filter(e => filter === 'all' ? true : e.type.startsWith(filter));
  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Live Feed']}
        title="Live activity feed"
        subtitle="Real-time event stream from all autonomous agents and cycles"
        actions={
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.dim }}>
              <PulseDot color={T.success} size={6} /> live · SSE
            </span>
            <Btn size="sm">Pause</Btn>
            <Btn size="sm">Clear</Btn>
          </>
        }
      />

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: T.dim }}>FILTER</span>
        {['all', 'agent', 'phase', 'tests', 'item', 'file'].map(t => (
          <ChipBtn key={t} active={filter === t} onClick={() => setFilter(t)}>{t}</ChipBtn>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: T.dim }}><span className="af2-mono">{filtered.length}</span> events</span>
      </div>

      <Card noPad>
        {filtered.map((e, i) => {
          const cat = e.type.split('.')[0];
          const color = cat === 'agent' ? T.purple : cat === 'phase' ? T.sonnet : cat === 'tests' ? T.warning : cat === 'item' ? T.success : cat === 'file' ? T.dim : T.dim;
          return (
            <div key={i} className="af2-hover-row" style={{
              display: 'grid', gridTemplateColumns: 'auto 100px 140px 1fr auto', gap: 14, alignItems: 'center',
              padding: '10px 16px', borderBottom: `1px solid ${T.border}`, cursor: 'pointer',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, ...(i < 3 ? { boxShadow: `0 0 6px ${color}` } : {}) }} />
              <span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>{fmtRel(e.t)}</span>
              <span className="af2-mono" style={{ fontSize: 11, color, fontWeight: 600 }}>{e.type}</span>
              <span style={{ fontSize: 12, color: T.muted }}>
                {e.agent && <span className="af2-mono" style={{ color: T.text }}>{e.agent}</span>}
                {e.agent && ' '}{e.msg}
              </span>
              <span style={{ fontSize: 11, color: T.faint, cursor: 'pointer' }}>›</span>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════════════
function RunnerPage() {
  const a = A4();
  const [agentSel, setAgentSel] = useS4('coder');
  const [task, setTask] = useS4('');
  const [output, setOutput] = useS4('');
  const [running, setRunning] = useS4(false);

  function handleRun() {
    if (!task.trim() || running) return;
    setRunning(true); setOutput('');
    const lines = [`▶ Starting agent: ${agentSel}`, `▶ Task: ${task}`, `▶ Model: claude-sonnet-4-6`, '', '⏵ Analyzing task requirements…', '⏵ Loading agent configuration…', '⏵ Executing task…', '', '✓ Task completed successfully.'];
    let i = 0;
    const iv = setInterval(() => {
      if (i >= lines.length) { clearInterval(iv); setRunning(false); return; }
      setOutput(o => o + lines[i] + '\n'); i++;
    }, 250);
  }

  const sel = a.agents.find(x => x.id === agentSel);
  const SAVED = [
    { name: 'Audit current sprint', task: 'Review the current sprint plan and call out risks, missing acceptance criteria, and dependencies between items.' },
    { name: 'Cost analysis', task: 'Analyze the last 14 cycles and report which agents are over- and under-utilized relative to spend.' },
    { name: 'Generate changelog', task: 'Read the last 5 merged PRs and produce a user-facing changelog entry.' },
    { name: 'Find flaky tests', task: 'Examine the last 20 test runs and identify tests that pass/fail inconsistently.' },
  ];

  return (
    <div>
      <PageHeader crumbs={['Workspace', a.workspace.name, 'Runner']} title="Agent runner" subtitle="Trigger an agent run and observe real-time output" />
      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 14, alignItems: 'start' }}>
        <Card>
          <SectionTitle>RUN CONFIGURATION</SectionTitle>
          <Field label="Agent" style={{ marginTop: 12 }}>
            <Select value={agentSel} onChange={setAgentSel} options={a.agents.map(x => ({ value: x.id, label: x.id }))} style={{ width: '100%' }} />
          </Field>
          {sel && (
            <div style={{ marginTop: 8, padding: '8px 10px', background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <ModelChip model={sel.model} />
              <span style={{ fontSize: 11, color: T.dim, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sel.desc}</span>
            </div>
          )}
          <Field label="Task" style={{ marginTop: 14 }}>
            <textarea value={task} onChange={e => setTask(e.target.value)} placeholder="Describe what you want the agent to do… (Ctrl+Enter to run)"
              style={{ width: '100%', background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 6, padding: '10px 12px', fontSize: 12, color: T.text, minHeight: 100, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} />
          </Field>
          <div style={{ marginTop: 14 }}>
            <Btn variant="purple" size="lg" onClick={handleRun} disabled={running || !task.trim()} style={{ width: '100%', justifyContent: 'center' }}>
              {running ? 'Running…' : '▶ Run agent'}
            </Btn>
          </div>

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
            <SectionTitle right={<button style={{ background: 'none', border: 'none', color: T.dim, fontSize: 11, cursor: 'pointer' }}>+ Save</button>}>SAVED PROMPTS</SectionTitle>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {SAVED.map(s => (
                <button key={s.name} onClick={() => setTask(s.task)} style={{
                  textAlign: 'left', background: T.surface2, border: `1px solid ${T.border2}`, borderRadius: 6,
                  padding: '8px 10px', cursor: 'pointer', color: T.text, fontSize: 12,
                }} className="af2-hover-card">
                  <div style={{ fontWeight: 500, marginBottom: 2 }}>{s.name}</div>
                  <div style={{ fontSize: 10, color: T.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.task}</div>
                </button>
              ))}
            </div>
          </div>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card noPad>
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <SectionTitle>LIVE OUTPUT</SectionTitle>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {running && <PulseDot color={T.purple} size={6} />}
                <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>{running ? 'streaming…' : 'idle'}</span>
                <Btn size="sm">Copy</Btn>
                <Btn size="sm" onClick={() => setOutput('')}>Clear</Btn>
              </div>
            </div>
            {output ? (
              <pre className="af2-mono" style={{ margin: 0, padding: '14px 18px', fontSize: 11, color: T.muted, lineHeight: 1.7, minHeight: 360, whiteSpace: 'pre-wrap' }}>{output}</pre>
            ) : (
              <div style={{ minHeight: 360, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: T.faint, padding: 24 }}>
                <span style={{ fontSize: 26, marginBottom: 8 }}>▶</span>
                <div style={{ fontSize: 12 }}>Configure an agent and task, then click <span style={{ color: T.text, fontWeight: 600 }}>Run agent</span>.</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Output streams here in real time via SSE.</div>
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle right={<span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>last 5</span>}>RECENT RUNS</SectionTitle>
            <div style={{ marginTop: 10 }}>
              {a.sessions.slice(0, 5).map((s, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${T.border}` }}>
                  <Badge variant={s.status === 'running' ? 'purple' : 'success'}>{s.status}</Badge>
                  <div style={{ minWidth: 0 }}>
                    <div className="af2-mono" style={{ fontSize: 11, fontWeight: 600, color: T.text }}>{s.agent}</div>
                    <div style={{ fontSize: 10, color: T.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.task.substring(0, 60)}…</div>
                  </div>
                  <span className="af2-mono" style={{ fontSize: 11, color: T.muted }}>${s.cost.toFixed(4)}</span>
                  <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>{fmtRel(s.at)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BRANCHES
// ═══════════════════════════════════════════════════════════════════════════
function BranchesPage({ navigate }) {
  const a = A4();
  const [filter, setFilter] = useS4('all');
  const filtered = a.branches.filter(b => filter === 'all' ? true : b.state === filter);
  const stats = {
    all: a.branches.length,
    building: a.branches.filter(b => b.state === 'building').length,
    merged: a.branches.filter(b => b.state === 'merged').length,
    stale: a.branches.filter(b => b.state === 'stale').length,
  };
  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Branches']}
        title="Autonomous branches"
        subtitle={<>Git hygiene for <span className="af2-mono" style={{ background: T.surface2, padding: '1px 6px', borderRadius: 3, fontSize: 10 }}>autonomous/*</span> cycles · branches without an open PR become stale after 3 days</>}
        actions={
          <>
            <Btn size="sm">Sweep stale</Btn>
            <Btn size="sm">Refresh</Btn>
          </>
        }
      />

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          { id: 'all',      label: 'All',       count: stats.all,      c: T.muted },
          { id: 'building', label: 'Building',  count: stats.building, c: T.purple },
          { id: 'merged',   label: 'Merged',    count: stats.merged,   c: T.success },
          { id: 'stale',    label: 'Stale',     count: stats.stale,    c: T.warning },
        ].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
            background: filter === f.id ? T.surface2 : 'transparent',
            border: `1px solid ${filter === f.id ? T.border3 : T.border2}`,
            color: filter === f.id ? T.text : T.dim, fontWeight: 500,
          }}>
            <span className="af2-mono" style={{ fontSize: 10, color: filter === f.id ? f.c : T.faint, fontWeight: 700 }}>{f.count}</span>
            {f.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <Input placeholder="Search branch or cycle…" prefix="⌕" style={{ width: 280, height: 30 }} />
      </div>

      <Card noPad>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>{['Branch', 'Cycle', 'State', 'Author', 'Ahead / Behind', 'Conflicts', 'Age', 'PR', ''].map(h => (
              <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.dim, padding: '10px 14px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {filtered.map(b => (
              <tr key={b.name} className="af2-hover-row" style={{ borderBottom: `1px solid ${T.border}`, cursor: 'pointer' }}>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 4, height: 16, background: b.state === 'building' ? T.purple : b.state === 'merged' ? T.success : T.warning, borderRadius: 2 }} />
                    <span className="af2-mono" style={{ color: T.text }}>{b.name}</span>
                  </span>
                </td>
                <td style={{ padding: '10px 14px' }} onClick={e => { e.stopPropagation(); navigate(`/cycles/${b.cycle}`); }}>
                  <span className="af2-mono" style={{ color: T.accent2, cursor: 'pointer' }}>{b.cycle}</span>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <Badge variant={b.state === 'building' ? 'purple' : b.state === 'merged' ? 'success' : 'warning'}>{b.state}</Badge>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className="af2-mono" style={{ fontSize: 11, color: T.muted }}>@{b.author}</span>
                    <ModelChip model={b.model} />
                  </span>
                </td>
                <td style={{ padding: '10px 14px' }} className="af2-mono">
                  <span style={{ color: b.ahead > 0 ? T.success : T.dim }}>↑{b.ahead}</span>
                  <span style={{ color: T.faint, margin: '0 4px' }}>/</span>
                  <span style={{ color: b.behind > 0 ? T.warning : T.dim }}>↓{b.behind}</span>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  {b.conflicts > 0 ? <Badge variant="danger">{b.conflicts}</Badge> : <span style={{ color: T.success, fontSize: 11 }}>—</span>}
                </td>
                <td style={{ padding: '10px 14px', color: T.dim }} className="af2-mono">{b.age}</td>
                <td style={{ padding: '10px 14px' }}>
                  {b.pr ? <a href="#" style={{ color: T.accent2, fontSize: 11 }} onClick={e => e.stopPropagation()}>{b.pr} ↗</a> : <span style={{ color: T.faint }}>—</span>}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <Btn size="sm">⋯</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// APPROVALS
// ═══════════════════════════════════════════════════════════════════════════
function ApprovalsPage({ navigate }) {
  const a = A4();
  const [decided, setDecided] = useS4({});
  const pending = a.approvals.filter(ap => !decided[ap.id]);

  function decide(id, action) {
    setDecided(d => ({ ...d, [id]: action }));
  }

  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Approvals']}
        title="Approvals queue"
        subtitle={<><span className="af2-mono">{pending.length}</span> pending · human-in-the-loop review for autonomous actions</>}
        actions={
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.dim }}>
              <PulseDot color={T.success} size={5} /> auto-refresh 5s
            </span>
          </>
        }
      />

      <div style={{ display: 'flex', gap: 14, padding: '14px 18px', background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, marginBottom: 14, alignItems: 'center' }}>
        {[[pending.length, 'PENDING', T.warning], [Object.values(decided).filter(d => d === 'approved').length, 'APPROVED', T.success], [Object.values(decided).filter(d => d === 'denied').length, 'DENIED', T.danger]].map(([n, l, c]) => (
          <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="af2-mono" style={{ fontSize: 28, fontWeight: 700, color: c }}>{n}</span>
            <span style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{l}</span>
          </div>
        ))}
      </div>

      {pending.length === 0 ? (
        <Card>
          <div style={{ textAlign: 'center', padding: '60px 20px', color: T.dim }}>
            <div style={{ fontSize: 32, color: T.success, marginBottom: 12 }}>✓</div>
            <div style={{ fontSize: 13, color: T.text, fontWeight: 600, marginBottom: 4 }}>No pending approvals — all clear.</div>
            <div style={{ fontSize: 11 }}>The autonomous team is operating within approved boundaries.</div>
          </div>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {pending.map(ap => <ApprovalCard key={ap.id} ap={ap} onDecide={decide} navigate={navigate} />)}
        </div>
      )}

      {Object.keys(decided).length > 0 && (
        <Card style={{ marginTop: 16 }}>
          <SectionTitle>RECENT DECISIONS</SectionTitle>
          <div style={{ marginTop: 8 }}>
            {Object.entries(decided).map(([id, action]) => {
              const ap = a.approvals.find(x => x.id === id);
              if (!ap) return null;
              return (
                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: `1px solid ${T.border}` }}>
                  <Badge variant={action === 'approved' ? 'success' : 'danger'}>{action}</Badge>
                  <span style={{ fontSize: 11, color: T.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ap.summary}</span>
                  <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>just now</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

function ApprovalCard({ ap, onDecide, navigate }) {
  const kindColor = ap.kind === 'budget' ? T.warning : ap.kind === 'model' ? T.opus : T.purple;
  const kindIcon = ap.kind === 'budget' ? '$' : ap.kind === 'model' ? '◈' : '⎇';
  return (
    <Card style={{ borderLeft: `3px solid ${kindColor}`, padding: 0 }}>
      <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: `${kindColor}15`, border: `1px solid ${kindColor}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: kindColor, fontSize: 16, fontWeight: 700 }}>{kindIcon}</div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Badge variant="muted">{ap.kind}</Badge>
            <span style={{ fontSize: 11, color: T.dim }}>from</span>
            <span className="af2-mono" style={{ fontSize: 11, color: T.text }}>{ap.requestedBy}</span>
            <ModelChip model={ap.model} />
            {ap.priority === 'high' && <Badge variant="warning">HIGH PRIORITY</Badge>}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: T.dim }} className="af2-mono">{fmtRel(ap.requestedAt)}</span>
          </div>
          <div style={{ fontSize: 13, color: T.text, lineHeight: 1.55, marginBottom: 8 }}>{ap.summary}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: T.dim }}>
            <span>Cycle <a href="#" onClick={e => { e.preventDefault(); navigate(`/cycles/${ap.cycle}`); }} style={{ color: T.accent2 }} className="af2-mono">{ap.cycle}</a></span>
            {ap.filesChanged > 0 && (
              <>
                <span className="af2-mono">{ap.filesChanged} files</span>
                <span className="af2-mono"><span style={{ color: T.success }}>+{ap.linesAdded}</span> <span style={{ color: T.danger }}>−{ap.linesRemoved}</span></span>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Btn variant="danger" size="sm" onClick={() => onDecide(ap.id, 'denied')}>Deny</Btn>
          <Btn variant="purple" size="sm" onClick={() => onDecide(ap.id, 'approved')}>Approve</Btn>
        </div>
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKSPACES
// ═══════════════════════════════════════════════════════════════════════════
function WorkspacesPage() {
  const a = A4();
  const [name, setName] = useS4(''); const [path, setPath] = useS4('');
  return (
    <div>
      <PageHeader crumbs={['Workspace', a.workspace.name, 'Workspaces']} title="Workspaces" subtitle="Manage the global ~/.agentforge/workspaces.json registry" />
      <Card style={{ marginBottom: 14 }}>
        <SectionTitle>ADD WORKSPACE</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 10, marginTop: 12, alignItems: 'end' }}>
          <Field label="Name"><Input value={name} onChange={setName} placeholder="My app" /></Field>
          <Field label="Path"><Input value={path} onChange={setPath} placeholder="/Users/me/Projects/my-app" mono /></Field>
          <Btn variant="purple">Add</Btn>
        </div>
      </Card>
      <Card noPad>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>{['Default', 'ID', 'Name', 'Path', 'Added', '', ''].map(h => (
              <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.dim, padding: '10px 14px', borderBottom: `1px solid ${T.border}` }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
              <td style={{ padding: '10px 14px' }}><Badge variant="purple">default</Badge></td>
              <td style={{ padding: '10px 14px' }} className="af2-mono">{a.workspace.id}</td>
              <td style={{ padding: '10px 14px', fontWeight: 600 }}>{a.workspace.name}</td>
              <td style={{ padding: '10px 14px' }} className="af2-mono">{a.workspace.path}</td>
              <td style={{ padding: '10px 14px', color: T.dim }}>—</td>
              <td style={{ padding: '10px 14px' }}><Btn size="sm">select</Btn></td>
              <td style={{ padding: '10px 14px' }}><Btn size="sm" variant="danger">remove</Btn></td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// JOBS (runtime queue)
// ═══════════════════════════════════════════════════════════════════════════
function JobsPage({ navigate }) {
  const a = A4();
  const [statusF, setStatusF] = useS4('all');
  const [selected, setSelected] = useS4(a.jobs[0]);

  const filtered = a.jobs.filter(j => statusF === 'all' ? true : j.status === statusF);
  const counts = {
    all: a.jobs.length,
    queued: a.jobs.filter(j => j.status === 'queued').length,
    running: a.jobs.filter(j => j.status === 'running').length,
    completed: a.jobs.filter(j => j.status === 'completed').length,
    failed: a.jobs.filter(j => j.status === 'failed').length,
  };

  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Jobs']}
        title="Runtime jobs"
        subtitle="Durable queue for cycles, agent runs, benchmarks"
        actions={<><Btn size="sm">Live Feed</Btn><Btn size="sm">Refresh</Btn></>}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 14 }}>
        <KpiTile label="Queue" value={counts.all} color={T.text} />
        <KpiTile label="Queued" value={counts.queued} color={T.dim} />
        <KpiTile label="Running" value={counts.running} color={T.purple} live={counts.running > 0} />
        <KpiTile label="Failed" value={counts.failed} color={T.danger} />
        <KpiTile label="Completed" value={counts.completed} color={T.success} />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: T.dim }}>STATUS</span>
        {['all', 'queued', 'running', 'completed', 'failed'].map(s => (
          <ChipBtn key={s} active={statusF === s} onClick={() => setStatusF(s)}>{s}</ChipBtn>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 14, alignItems: 'start' }}>
        <Card noPad>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${T.border}` }}>
            <SectionTitle>JOBS · {filtered.length}</SectionTitle>
          </div>
          <div>
            {filtered.map(j => (
              <button key={j.id} onClick={() => setSelected(j)} className="af2-hover-row" style={{
                width: '100%', display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center',
                padding: '10px 14px', background: selected?.id === j.id ? T.surface2 : 'transparent',
                border: 'none', borderLeft: selected?.id === j.id ? `2px solid ${T.purple}` : '2px solid transparent',
                borderBottom: `1px solid ${T.border}`, cursor: 'pointer', textAlign: 'left', color: T.text,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: j.status === 'running' ? T.purple : j.status === 'completed' ? T.success : j.status === 'failed' ? T.danger : T.dim,
                  ...(j.status === 'running' ? { boxShadow: `0 0 6px ${T.purple}` } : {}),
                }} />
                <div style={{ minWidth: 0 }}>
                  <div className="af2-mono" style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.id}</div>
                  <div style={{ fontSize: 10, color: T.dim, marginTop: 2 }}>
                    <span>{j.kind}</span><span> · </span><span>{j.queue}</span><span> · </span><span>p{j.priority}</span>
                  </div>
                </div>
                <Badge variant={j.status === 'running' ? 'purple' : j.status === 'completed' ? 'success' : j.status === 'failed' ? 'danger' : 'muted'}>{j.status}</Badge>
              </button>
            ))}
          </div>
        </Card>

        {selected && (
          <Card noPad>
            <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                {selected.status === 'running' && <PulseDot color={T.purple} size={6} />}
                <span className="af2-mono" style={{ fontSize: 14, fontWeight: 600 }}>{selected.id}</span>
                <Badge variant={selected.status === 'running' ? 'purple' : selected.status === 'completed' ? 'success' : selected.status === 'failed' ? 'danger' : 'muted'}>{selected.status}</Badge>
              </div>
              <div style={{ fontSize: 11, color: T.dim }}>queue <span className="af2-mono">{selected.queue}</span> · priority <span className="af2-mono">p{selected.priority}</span> · attempts <span className="af2-mono">{selected.attempts}</span></div>
            </div>
            <div style={{ padding: '14px 16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
                <DefMetric label="Kind" value={selected.kind} mono />
                <DefMetric label="Duration" value={selected.dur || '—'} mono />
                <DefMetric label="Cost" value={selected.cost > 0 ? '$' + selected.cost.toFixed(4) : '—'} mono />
              </div>
              {selected.startedAt && (
                <div style={{ fontSize: 11, color: T.dim, marginBottom: 14 }}>Started {fmtRel(selected.startedAt)}</div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                {selected.kind === 'cycle' && <Btn variant="purple" size="sm" onClick={() => navigate(`/cycles/${selected.id.replace('job-cycle-', '')}`)}>Open cycle →</Btn>}
                {selected.status === 'running' && <Btn variant="danger" size="sm">Cancel</Btn>}
                {selected.status === 'failed' && <Btn size="sm">Retry</Btn>}
                <Btn size="sm">View logs</Btn>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════
function SettingsPage() {
  const a = A4();
  const [section, setSection] = useS4('workspace');
  const SECTIONS = [
    { id: 'workspace', label: 'Workspace' },
    { id: 'autonomous', label: 'Autonomous' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'security', label: 'Security' },
    { id: 'team', label: 'Team' },
    { id: 'billing', label: 'Billing' },
  ];

  return (
    <div>
      <PageHeader crumbs={['Workspace', a.workspace.name, 'Settings']} title="Settings" />
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {SECTIONS.map(s => (
            <button key={s.id} onClick={() => setSection(s.id)} style={{
              padding: '7px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', textAlign: 'left',
              background: section === s.id ? T.surface2 : 'transparent',
              border: section === s.id ? `1px solid ${T.border3}` : '1px solid transparent',
              color: section === s.id ? T.purple : T.muted, fontWeight: 500,
              position: 'relative',
            }}>
              {s.label}
              {section === s.id && <span style={{ position: 'absolute', left: -8, top: 6, width: 2, height: 20, borderRadius: 2, background: `linear-gradient(180deg, ${T.accent}, ${T.purple})` }} />}
            </button>
          ))}
        </div>
        <div>
          {section === 'workspace' && <SettingsWorkspace />}
          {section === 'autonomous' && <SettingsAutonomous />}
          {section === 'notifications' && <SettingsNotifications />}
          {section === 'security' && <SettingsSecurity />}
          {section === 'team' && <SettingsTeam />}
          {section === 'billing' && <SettingsBilling />}
        </div>
      </div>
    </div>
  );
}

function SettingsWorkspace() {
  const [wsName, setWsName] = useS4('AgentForge');
  const [defModel, setDefModel] = useS4('opus');
  const [maxConc, setMaxConc] = useS4('25');
  return (
    <Card style={{ maxWidth: 640 }}>
      <SectionTitle>WORKSPACE</SectionTitle>
      <div style={{ marginTop: 12, display: 'grid', gap: 14 }}>
        <Field label="Workspace name"><Input value={wsName} onChange={setWsName} /></Field>
        <Field label="Default model">
          <Select value={defModel} onChange={setDefModel} options={[{value:'opus',label:'Opus — Most capable'},{value:'sonnet',label:'Sonnet — Balanced'},{value:'haiku',label:'Haiku — Fast'}]} style={{ width: '100%' }} />
        </Field>
        <Field label="Max concurrent agents"><Input value={maxConc} onChange={setMaxConc} type="number" mono /></Field>
      </div>
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${T.border}`, display: 'flex', justifyContent: 'flex-end' }}>
        <Btn variant="purple">Save</Btn>
      </div>
    </Card>
  );
}

function SettingsAutonomous() {
  return (
    <Card style={{ maxWidth: 640 }}>
      <SectionTitle>AUTONOMOUS RETRY</SectionTitle>
      <div style={{ marginTop: 12, display: 'grid', gap: 14 }}>
        <Field label="Max auto-retries"><Input value="1" onChange={() => {}} type="number" mono /></Field>
        <Field label="Require approval after"><Input value="1" onChange={() => {}} type="number" mono /></Field>
        <Field label="Default budget"><Input value="200" onChange={() => {}} type="number" mono prefix="$" /></Field>
      </div>
    </Card>
  );
}

function SettingsNotifications() {
  const [email, setEmail] = useS4(true);
  const [slack, setSlack] = useS4(false);
  return (
    <Card style={{ maxWidth: 640 }}>
      <SectionTitle>NOTIFICATIONS</SectionTitle>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Toggle checked={email} onChange={setEmail} label="Email notifications" sub="cycle complete, approval requested, cost threshold" />
        <Toggle checked={slack} onChange={setSlack} label="Slack notifications" sub="connect Slack to receive cycle events" />
        <Toggle checked={true} onChange={() => {}} label="In-app notifications" sub="bell icon in topbar" />
      </div>
    </Card>
  );
}

function SettingsSecurity() {
  const a = A4();
  return (
    <Card style={{ maxWidth: 720 }} noPad>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <SectionTitle>API KEYS</SectionTitle>
        <Btn variant="purple" size="sm">+ New API key</Btn>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>{['Name', 'Prefix', 'Created', 'Last used', 'Scopes', ''].map(h => (
            <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.dim, padding: '8px 14px', borderBottom: `1px solid ${T.border}` }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {a.apiKeys.map(k => (
            <tr key={k.id} style={{ borderBottom: `1px solid ${T.border}` }}>
              <td style={{ padding: '8px 14px', fontWeight: 600 }}>{k.name}</td>
              <td style={{ padding: '8px 14px' }} className="af2-mono">{k.prefix}…</td>
              <td style={{ padding: '8px 14px', color: T.dim }}>{fmtRel(k.created)}</td>
              <td style={{ padding: '8px 14px', color: T.dim }}>{fmtRel(k.lastUsed)}</td>
              <td style={{ padding: '8px 14px' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{k.scopes.map(s => <Badge key={s} variant="muted">{s}</Badge>)}</div>
              </td>
              <td style={{ padding: '8px 14px' }}><Btn variant="danger" size="sm">revoke</Btn></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function SettingsTeam() {
  const members = [
    { name: 'Sean Vaughan', email: 'sean.vaughan@allworth.com', role: 'Owner', avatar: 'SV', joined: '2026-01-12' },
    { name: 'Engineering bot', email: 'eng-bot@allworth.com', role: 'Service account', avatar: 'EB', joined: '2026-02-04' },
  ];
  return (
    <Card style={{ maxWidth: 720 }} noPad>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <SectionTitle>TEAM MEMBERS</SectionTitle>
        <Btn variant="purple" size="sm">+ Invite</Btn>
      </div>
      <div>
        {members.map(m => (
          <div key={m.email} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 12, alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${T.border}` }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: `linear-gradient(135deg, ${T.accent2}, ${T.purple})`, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 11 }}>{m.avatar}</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{m.name}</div>
              <div style={{ fontSize: 11, color: T.dim }}>{m.email}</div>
            </div>
            <Badge variant={m.role === 'Owner' ? 'purple' : 'muted'}>{m.role}</Badge>
            <Btn size="sm">⋯</Btn>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SettingsBilling() {
  return (
    <Card style={{ maxWidth: 720 }}>
      <SectionTitle>BILLING</SectionTitle>
      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        <DefMetric label="Plan" value="Pro · $99/mo" />
        <DefMetric label="This month" value="$87.42" mono />
        <DefMetric label="Renews" value="Jun 1, 2026" />
      </div>
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
        <Btn size="sm">View invoices</Btn>
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW PAGES
// ═══════════════════════════════════════════════════════════════════════════

// ── Memory ──────────────────────────────────────────────────────────────────
function MemoryPage() {
  const a = A4();
  const [search, setSearch] = useS4('');
  const [kindF, setKindF] = useS4('all');

  const filtered = a.memory.filter(m => {
    if (search && !m.text.toLowerCase().includes(search.toLowerCase())) return false;
    if (kindF !== 'all' && m.kind !== kindF) return false;
    return true;
  });
  const counts = {
    all: a.memory.length,
    pattern: a.memory.filter(m => m.kind === 'pattern').length,
    failure: a.memory.filter(m => m.kind === 'failure').length,
    decision: a.memory.filter(m => m.kind === 'decision').length,
    metric: a.memory.filter(m => m.kind === 'metric').length,
  };
  const kindColor = { pattern: T.purple, failure: T.danger, decision: T.sonnet, metric: T.warning };

  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Memory']}
        title="Memory"
        subtitle={<span>Learned patterns, failure modes, and decisions across <span className="af2-mono">{a.flywheel.loop.cyclesRun}</span> cycles</span>}
        actions={<Btn variant="purple" size="sm">+ Add entry</Btn>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 12 }}>
        <KpiTile label="Total" value={counts.all} color={T.text} />
        <KpiTile label="Patterns" value={counts.pattern} color={T.purple} />
        <KpiTile label="Failures" value={counts.failure} color={T.danger} />
        <KpiTile label="Decisions" value={counts.decision} color={T.sonnet} />
        <KpiTile label="Hit rate" value={a.flywheel.memory.hitRate + '%'} color={T.success} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Input value={search} onChange={setSearch} placeholder="Search memory…" prefix="⌕" style={{ width: 360 }} />
        <span style={{ fontSize: 11, color: T.dim }}>KIND</span>
        {['all', 'pattern', 'failure', 'decision', 'metric'].map(k => (
          <ChipBtn key={k} active={kindF === k} onClick={() => setKindF(k)} color={kindColor[k]}>{k}</ChipBtn>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: T.dim }}>{filtered.length} of {counts.all}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.map(m => (
          <Card key={m.id} hover style={{ borderLeft: `3px solid ${kindColor[m.kind]}`, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Badge variant={m.kind === 'failure' ? 'danger' : m.kind === 'decision' ? 'info' : m.kind === 'metric' ? 'warning' : 'purple'}>{m.kind}</Badge>
              <span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>from {m.source}</span>
              <span style={{ fontSize: 11, color: T.faint }}>·</span>
              <span className="af2-mono" style={{ fontSize: 11, color: T.muted }}>@{m.agent}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontSize: 10, color: T.dim }}>
                <span><span className="af2-mono" style={{ color: T.success }}>{m.hits}</span> hits</span>
                <span className="af2-mono">{fmtRel(m.createdAt)}</span>
              </span>
            </div>
            <div style={{ fontSize: 13, color: T.text, lineHeight: 1.55 }}>{m.text}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Audit log ───────────────────────────────────────────────────────────────
function AuditPage() {
  const a = A4();
  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Audit log']}
        title="Audit log"
        subtitle="Complete trail of every administrative and autonomous action"
        actions={<><Btn size="sm">Filter</Btn><Btn size="sm">Export</Btn></>}
      />
      <Card noPad>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['Time', 'Actor', 'Action', 'Target', 'IP'].map(h => (
                <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.dim, padding: '10px 14px', borderBottom: `1px solid ${T.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.auditLog.map((e, i) => {
              const action = e.action.split('.')[0];
              const c = action === 'approval' ? T.success : action === 'cycle' ? T.purple : action === 'workspace' ? T.sonnet : action === 'agent' ? T.warning : action === 'settings' ? T.dim : action === 'memory' ? T.purple : T.dim;
              return (
                <tr key={i} className="af2-hover-row" style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ padding: '8px 14px', color: T.dim, fontSize: 11 }}>{fmtRel(e.t)}</td>
                  <td style={{ padding: '8px 14px' }} className="af2-mono">{e.actor}</td>
                  <td style={{ padding: '8px 14px' }}>
                    <span className="af2-mono" style={{ fontSize: 11, color: c, fontWeight: 600 }}>{e.action}</span>
                  </td>
                  <td style={{ padding: '8px 14px', color: T.muted, fontSize: 11 }}>{e.target}</td>
                  <td style={{ padding: '8px 14px', color: T.dim, fontSize: 10 }} className="af2-mono">{e.ip}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ── Insights / Reports ──────────────────────────────────────────────────────
function InsightsPage() {
  const a = A4();
  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Insights']}
        title="Insights"
        subtitle="Auto-generated observations from your cycle data"
        actions={<><Btn size="sm">Generate report</Btn><Btn size="sm">Subscribe</Btn></>}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        {a.insights.map(i => {
          const kindBg = i.kind === 'win' ? T.success : i.kind === 'risk' ? T.warning : T.sonnet;
          const kindLabel = i.kind === 'win' ? 'WIN' : i.kind === 'risk' ? 'WATCH' : 'SHIFT';
          return (
            <Card key={i.id} hover style={{ borderLeft: `3px solid ${kindBg}`, padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <Badge variant={i.kind === 'win' ? 'success' : i.kind === 'risk' ? 'warning' : 'info'}>{kindLabel}</Badge>
                <span style={{ flex: 1 }} />
                <Sparkline data={i.spark} color={i.sparkColor} w={120} h={28} gradient />
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: T.text, letterSpacing: '-0.01em', marginBottom: 6 }}>{i.title}</div>
              <div style={{ fontSize: 12, color: T.dim, lineHeight: 1.55 }}>{i.detail}</div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <Btn size="sm">Dig in</Btn>
                <Btn size="sm">Dismiss</Btn>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── Schedule ────────────────────────────────────────────────────────────────
function SchedulePage() {
  const a = A4();
  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Schedule']}
        title="Scheduled cycles"
        subtitle={<span><span className="af2-mono">{a.schedule.filter(s => s.enabled).length}</span> active · <span className="af2-mono">{a.schedule.length}</span> total</span>}
        actions={<Btn variant="purple" size="sm">+ New schedule</Btn>}
      />
      <Card noPad>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>{['Name', 'Cron', 'Pattern', 'Budget', 'Next run', 'Last run', 'Enabled', ''].map(h => (
              <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.dim, padding: '10px 14px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {a.schedule.map(s => (
              <tr key={s.id} className="af2-hover-row" style={{ borderBottom: `1px solid ${T.border}`, cursor: 'pointer', opacity: s.enabled ? 1 : 0.5 }}>
                <td style={{ padding: '10px 14px', fontWeight: 600 }}>{s.name}</td>
                <td style={{ padding: '10px 14px' }} className="af2-mono">{s.cron}</td>
                <td style={{ padding: '10px 14px', color: T.dim, fontSize: 11, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.pattern}</td>
                <td style={{ padding: '10px 14px' }} className="af2-mono">${s.budget}</td>
                <td style={{ padding: '10px 14px' }} className="af2-mono">
                  <span style={{ color: s.enabled ? T.purple : T.faint }}>{s.next}</span>
                </td>
                <td style={{ padding: '10px 14px', color: T.dim }}>{fmtRel(s.lastRun)}</td>
                <td style={{ padding: '10px 14px' }}>
                  <Toggle checked={s.enabled} onChange={() => {}} label="" />
                </td>
                <td style={{ padding: '10px 14px' }}><Btn size="sm">⋯</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ── Webhooks / Integrations ─────────────────────────────────────────────────
function WebhooksPage() {
  const a = A4();
  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Webhooks']}
        title="Webhooks & integrations"
        subtitle="Outbound deliveries to Slack, Linear, Datadog, and custom endpoints"
        actions={<Btn variant="purple" size="sm">+ New webhook</Btn>}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {a.webhooks.map(w => (
          <Card key={w.id} hover style={{ padding: '14px 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 14, alignItems: 'center' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: w.status === 'healthy' ? T.success : T.warning, ...(w.status === 'healthy' ? { boxShadow: `0 0 6px ${T.success}` } : {}) }} />
              <div>
                <div className="af2-mono" style={{ fontSize: 12, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.url}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  {w.events.map(e => <Badge key={e} variant="muted"><span className="af2-mono">{e}</span></Badge>)}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ textAlign: 'right' }}>
                  <Badge variant={w.status === 'healthy' ? 'success' : 'warning'}>{w.status}</Badge>
                  <div style={{ fontSize: 10, color: T.dim, marginTop: 4 }}>last delivery {fmtRel(w.lastDelivery)}</div>
                </div>
                <Btn size="sm">Test</Btn>
                <Btn size="sm">⋯</Btn>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Notifications inbox ─────────────────────────────────────────────────────
function NotificationsPage({ navigate }) {
  const a = A4();
  const [filter, setFilter] = useS4('all');
  const filtered = a.notifications.filter(n => filter === 'all' ? true : filter === 'unread' ? n.unread : true);
  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Notifications']}
        title="Notifications"
        subtitle={<><span className="af2-mono">{a.notifications.filter(n => n.unread).length}</span> unread</>}
        actions={<Btn size="sm">Mark all read</Btn>}
      />
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {['all', 'unread'].map(f => <ChipBtn key={f} active={filter === f} onClick={() => setFilter(f)}>{f}</ChipBtn>)}
      </div>
      <Card noPad>
        {filtered.map(n => {
          const sev = n.severity === 'warning' ? T.warning : n.severity === 'danger' ? T.danger : n.severity === 'success' ? T.success : T.purple;
          return (
            <div key={n.id} className="af2-hover-row" style={{
              display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, alignItems: 'center',
              padding: '14px 16px', borderBottom: `1px solid ${T.border}`, cursor: 'pointer',
              background: n.unread ? `${T.purple}05` : 'transparent',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: n.unread ? sev : 'transparent', border: n.unread ? 'none' : `1px solid ${T.border3}` }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: n.unread ? 600 : 400, color: T.text, marginBottom: 3 }}>{n.title}</div>
                <div style={{ fontSize: 12, color: T.dim }}>{n.body}</div>
              </div>
              <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>{fmtRel(n.at)}</span>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS for this file
// ═══════════════════════════════════════════════════════════════════════════
function KpiTile({ label, value, sub, delta, color, live }) {
  return (
    <Card hover style={{ padding: '10px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: 10, color: T.dim, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>{label}</span>
        {delta && <span className="af2-mono" style={{ fontSize: 10, color: T.success, padding: '1px 5px', borderRadius: 3, background: `${T.success}15` }}>{delta}</span>}
        {live && <PulseDot color={T.purple} size={5} />}
      </div>
      <div className="af2-mono" style={{ fontSize: 20, fontWeight: 600, color: color || T.text, marginTop: 4, letterSpacing: '-0.02em' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: T.dim, marginTop: 2 }} className="af2-mono">{sub}</div>}
    </Card>
  );
}

function ChipBtn({ active, onClick, children, color }) {
  const c = active ? (color || T.text) : T.dim;
  return (
    <button onClick={onClick} style={{
      padding: '4px 11px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
      background: active ? T.surface2 : 'transparent',
      border: `1px solid ${active ? (color ? color + '55' : T.border3) : T.border2}`,
      color: c, fontWeight: 500, textTransform: typeof children === 'string' && children.length > 1 ? 'none' : 'uppercase',
    }}>{children}</button>
  );
}

function DefMetric({ label, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: T.dim, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div className={mono ? 'af2-mono' : ''} style={{ fontSize: 14, color: T.text, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

Object.assign(window, {
  SessionsPage, CostPage, HealthPage, FlywheelPage, LiveFeedPage, RunnerPage,
  BranchesPage, ApprovalsPage, WorkspacesPage, JobsPage, SettingsPage,
  MemoryPage, AuditPage, InsightsPage, SchedulePage, WebhooksPage, NotificationsPage,
});
