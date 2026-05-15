// ── V2 Pages: Command Center, Cycles List, Launch ─────────────────────────────
const { useState: useS1, useEffect: useE1, useMemo: useM1 } = React;
const A = () => window.AF2;

// ── Command Center ─────────────────────────────────────────────────────────────
function CommandCenter({ navigate }) {
  const a = A();
  const c = a.cycle;
  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Command Center']}
        title="Today's operations"
        subtitle={
          <span>
            <span className="af2-mono">{a.counters.cyclesDay}</span> cycles today ·{' '}
            <span className="af2-mono">{a.counters.agents}</span> agents online ·{' '}
            spent <span className="af2-mono">{fmtDollar(a.counters.todaySpend)}</span> /{' '}
            <span style={{ color: T.success }}>healthy</span>
          </span>
        }
        actions={
          <>
            <Btn size="sm">Today ▾</Btn>
            <Btn variant="purple" onClick={() => navigate('/cycles/new')}>+ Launch cycle</Btn>
          </>
        }
      />

      {/* KPI ROW */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 12 }}>
        {[
          { l: 'Pass rate',    v: a.kpis.passRate.value,    u: '%',   d: '+0.4',  dn:true, spark: a.kpis.passRate.spark,    color: T.success, dec:1 },
          { l: 'Cost / cycle', v: a.kpis.costPerCycle.value,p: '$',   d: '-18%',  dn:true, spark: a.kpis.costPerCycle.spark,color: T.purple,  dec:2 },
          { l: 'Cycle time',   v: a.kpis.cycleTime.value,   u: 'min', d: '-6m',   dn:true, spark: a.kpis.cycleTime.spark,   color: T.sonnet,  dec:0 },
          { l: 'Autonomy',     v: a.kpis.autonomy.value,    u: '%',   d: '+5',    dn:true, spark: a.kpis.autonomy.spark,    color: T.warning, dec:0 },
          { l: 'Throughput',   v: a.kpis.throughput.value,  u: '/d',  d: '+2',    dn:true, spark: a.kpis.throughput.spark,  color: T.accent2, dec:0 },
          { l: 'MTTR',         v: a.kpis.mttr.value,        u: 'min', d: '-12m',  dn:true, spark: a.kpis.mttr.spark,        color: T.haiku,   dec:0 },
        ].map(k => <KpiCard key={k.l} {...k} />)}
      </div>

      {/* HERO + RIGHT COLUMN */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.7fr 1fr', gap: 12, marginBottom: 12 }}>
        <ActiveCyclePanel cycle={c} navigate={navigate} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <AgentActivityPanel />
          <EventStreamPanel />
        </div>
      </div>

      {/* BOTTOM ROW */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 }}>
        <RecentCyclesPanel navigate={navigate} />
        <FleetMixPanel />
      </div>
    </div>
  );
}

function KpiCard({ l, v, u, p, d, dn, spark, color, dec = 0 }) {
  return (
    <Card hover style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: T.dim, letterSpacing: '0.02em', textTransform: 'uppercase', fontWeight: 600 }}>{l}</span>
        <span className="af2-mono" style={{
          fontSize: 10, color: dn ? T.success : T.danger,
          padding: '1px 5px', borderRadius: 3, background: `${dn ? T.success : T.danger}15`,
        }}>{d}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, marginBottom: 6 }}>
        {p && <span className="af2-mono" style={{ fontSize: 14, color: T.dim }}>{p}</span>}
        <span className="af2-mono" style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: T.text }}>
          <AnimNum value={v} decimals={dec} mono={false} />
        </span>
        {u && <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>{u}</span>}
      </div>
      <Sparkline data={spark} color={color} w={200} h={26} gradient />
    </Card>
  );
}

function ActiveCyclePanel({ cycle, navigate }) {
  const a = A();
  return (
    <Card noPad style={{ display: 'flex', flexDirection: 'column', minHeight: 480 }}>
      {/* Header strip */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <PulseDot color={T.purple} size={7} />
          <span style={{ fontSize: 10, color: T.purple, letterSpacing: '0.08em', fontWeight: 700 }}>ACTIVE CYCLE</span>
          <span className="af2-mono" style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{cycle.short}</span>
          <span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>v{cycle.sprintVersion}</span>
          <span style={{ fontSize: 11, color: T.faint }}>·</span>
          <span style={{ fontSize: 11, color: T.muted }}>{cycle.activePhase} phase</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="af2-mono" style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{cycle.elapsedDisplay}</span>
          <Btn size="sm">Logs</Btn>
          <Btn size="sm" variant="purple" onClick={() => navigate(`/cycles/${cycle.short}`)}>Open detail →</Btn>
        </div>
      </div>

      {/* Stage rail */}
      <div style={{ padding: '18px 16px 12px' }}>
        <StageRail stages={cycle.stages} phases={cycle.phases} showAgent />
      </div>

      {/* Quad stats */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, background: T.border,
        borderTop: `1px solid ${T.border}`,
      }}>
        {[
          { l: 'Budget', v: fmtDollar(cycle.costUsd), s: `of ${fmtDollar(cycle.budgetUsd)}`, bar: cycle.costUsd / cycle.budgetUsd, bc: 'var(--af-grad-h)' },
          { l: 'Items',  v: `${cycle.itemsDone}/${cycle.itemsTotal}`, s: `${cycle.itemsActive} in flight`, bar: cycle.itemsDone / cycle.itemsTotal, bc: T.success },
          { l: 'Tests',  v: cycle.testsPassed.toLocaleString(), s: `of ${cycle.testsTotal.toLocaleString()} pass`, bar: cycle.testsPassed / cycle.testsTotal, bc: T.success },
          { l: 'On now', v: cycle.activeAgent, s: `${cycle.activePhase} · ${cycle.activeModel}`, bar: null, agent: true },
        ].map(s => (
          <div key={s.l} style={{ padding: '12px 16px', background: T.surface }}>
            <div style={{ fontSize: 9, color: T.dim, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>{s.l}</div>
            <div className={s.agent ? '' : 'af2-mono'} style={{ fontSize: s.agent ? 14 : 16, fontWeight: 600, letterSpacing: '-0.02em', color: T.text, marginBottom: 3 }}>{s.v}</div>
            <div style={{ fontSize: 10, color: T.dim }}>{s.s}</div>
            {s.bar != null && (
              <div style={{ marginTop: 6, height: 2, background: T.border, borderRadius: 1, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${s.bar * 100}%`, background: s.bc, transition: 'width 600ms ease' }} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Items in flight */}
      <div style={{ padding: '12px 16px', flex: 1, overflow: 'auto', minHeight: 0 }}>
        <SectionTitle right={<span style={{ fontSize: 10, color: T.dim }}>{a.items.length} items</span>}>SPRINT ITEMS</SectionTitle>
        {a.items.map(it => <SprintItemRow key={it.id} it={it} />)}
      </div>
    </Card>
  );
}

function SprintItemRow({ it }) {
  const status = it.status;
  const dot = {
    completed:  { bg: `${T.success}20`, c: T.success, b: T.success, ic: '✓' },
    in_progress:{ bg: `${T.purple}24`,  c: T.purple,  b: T.purple,  ic: '⏵' },
    planned:    { bg: T.border,          c: T.faint,   b: T.border3, ic: '' },
    failed:     { bg: `${T.danger}20`,   c: T.danger,  b: T.danger,  ic: '✗' },
  }[status] || {};
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto auto 1fr auto auto', alignItems: 'center', gap: 10,
      padding: '6px 0', borderBottom: `1px solid ${T.border}`,
    }}>
      <span style={{
        width: 14, height: 14, borderRadius: 3,
        background: dot.bg, border: `1px solid ${dot.b}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 8, color: dot.c, fontWeight: 700,
      }}>{dot.ic}</span>
      <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>#{it.id}</span>
      <span style={{
        fontSize: 12,
        color: status === 'completed' ? T.dim : status === 'planned' ? T.dim : T.text,
        textDecoration: status === 'completed' ? 'line-through' : 'none',
        textDecorationColor: T.border3,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{it.title}</span>
      {it.assignee && (
        <span className="af2-mono" style={{
          fontSize: 10, color: T.muted, background: T.surface2, border: `1px solid ${T.border2}`,
          padding: '1px 6px', borderRadius: 3,
        }}>{it.assignee}</span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 100, justifyContent: 'flex-end' }}>
        {it.dur && <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>{it.dur}</span>}
        {it.cost != null && <span className="af2-mono" style={{ fontSize: 10, color: T.text }}>${it.cost.toFixed(3)}</span>}
      </div>
    </div>
  );
}

function AgentActivityPanel() {
  const a = A();
  return (
    <Card style={{ padding: '14px 16px' }}>
      <SectionTitle right={<PulseDot color={T.success} size={6} />}>LIVE AGENTS</SectionTitle>
      {a.agentsLive.map(ag => (
        <div key={ag.id} style={{
          display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', alignItems: 'center', gap: 8,
          padding: '6px 0', borderBottom: `1px solid ${T.border}`,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: ag.state === 'running' ? T.purple : ag.state === 'done' ? T.success : T.border3,
            ...(ag.state === 'running' ? { boxShadow: `0 0 6px ${T.purple}` } : {}),
          }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ag.id}</div>
            <div className="af2-mono" style={{ fontSize: 10, color: T.dim }}>{ag.phase} · ${ag.cost.toFixed(3)} · {ag.dur}</div>
          </div>
          <Sparkline data={ag.spark} color={ag.state === 'running' ? T.purple : T.faint} w={50} h={16} />
          <ModelChip model={ag.model} />
        </div>
      ))}
    </Card>
  );
}

function EventStreamPanel() {
  const a = A();
  return (
    <Card style={{ padding: '14px 16px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <SectionTitle right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <PulseDot color={T.success} size={5} />
          <span style={{ fontSize: 10, color: T.dim }}>{a.events.length}</span>
        </div>
      }>EVENT STREAM</SectionTitle>
      <div style={{ maxHeight: 200, overflow: 'auto' }}>
        {a.events.slice(0, 12).map((e, i) => {
          const cat = e.type.split('.')[0];
          const c = cat === 'agent' ? T.purple : cat === 'phase' ? T.sonnet : cat === 'tests' ? T.warning : cat === 'item' ? T.success : cat === 'file' ? T.dim : T.dim;
          return (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: 8, alignItems: 'baseline',
              padding: '3px 0', fontSize: 10,
            }}>
              <span className="af2-mono" style={{ color: T.faint, minWidth: 40 }}>{fmtRel(e.t)}</span>
              <span className="af2-mono" style={{ color: c, fontWeight: 600 }}>{e.type}</span>
              <span style={{ color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.agent && <span className="af2-mono" style={{ color: T.text }}>{e.agent}</span>}{e.agent && ' '}{e.msg}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function RecentCyclesPanel({ navigate }) {
  const a = A();
  return (
    <Card noPad>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderBottom: `1px solid ${T.border}`,
      }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: T.dim, textTransform: 'uppercase' }}>RECENT CYCLES</span>
        <button onClick={() => navigate('/cycles')} style={{ background: 'none', border: 'none', color: T.dim, fontSize: 11, cursor: 'pointer' }}>View all →</button>
      </div>
      <div>
        {a.cycles.slice(0, 7).map(r => (
          <div key={r.id} className="af2-hover-row" onClick={() => navigate(`/cycles/${r.id}`)} style={{
            display: 'grid',
            gridTemplateColumns: 'auto auto 1fr auto auto auto',
            gap: 12, alignItems: 'center',
            padding: '8px 16px', borderBottom: `1px solid ${T.border}`, cursor: 'pointer',
          }}>
            <StageDots stages={r.stages} />
            <span className="af2-mono" style={{ fontSize: 11, color: T.text, fontWeight: 600, minWidth: 70 }}>{r.id}</span>
            <span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>v{r.v || '—'}</span>
            <span className="af2-mono" style={{ fontSize: 10, color: T.dim, minWidth: 80, textAlign: 'right' }}>{r.elapsed}</span>
            <span className="af2-mono" style={{ fontSize: 11, color: T.text, minWidth: 60, textAlign: 'right' }}>${r.cost.toFixed(2)}</span>
            <span style={{
              fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 700, letterSpacing: '0.06em',
              background: r.stage === 'completed' ? `${T.success}15` : r.stage === 'failed' ? `${T.danger}15` : `${T.purple}15`,
              color:      r.stage === 'completed' ? T.success      : r.stage === 'failed' ? T.danger      : T.purple,
              minWidth: 70, textAlign: 'center',
            }}>{r.stage.toUpperCase()}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function FleetMixPanel() {
  const a = A();
  const md = a.modelMix;
  const total = md.opus + md.sonnet + md.haiku;
  return (
    <Card style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionTitle right={<span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>{total} agents</span>}>FLEET MIX</SectionTitle>

      {/* Model distribution */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 10, color: T.dim }}>
          <span>MODELS</span>
          <span className="af2-mono">{total}</span>
        </div>
        <DistBar segments={[
          { value: md.opus, color: T.opus, label: `opus ${md.opus}` },
          { value: md.sonnet, color: T.sonnet, label: `sonnet ${md.sonnet}` },
          { value: md.haiku, color: T.haiku, label: `haiku ${md.haiku}` },
        ]} h={6} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10 }}>
          <span><span style={{ color: T.opus }}>●</span> <span style={{ color: T.muted }}>opus</span> <span className="af2-mono" style={{ color: T.text }}>{md.opus}</span></span>
          <span><span style={{ color: T.sonnet }}>●</span> <span style={{ color: T.muted }}>sonnet</span> <span className="af2-mono" style={{ color: T.text }}>{md.sonnet}</span></span>
          <span><span style={{ color: T.haiku }}>●</span> <span style={{ color: T.muted }}>haiku</span> <span className="af2-mono" style={{ color: T.text }}>{md.haiku}</span></span>
        </div>
      </div>

      {/* Heatmap */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 10, color: T.dim }}>
          <span>CYCLES / HOUR · 24h</span>
          <span className="af2-mono">{a.heatmap.reduce((s,v)=>s+v,0).toFixed(0)} total</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 1.5, height: 28 }}>
          {a.heatmap.map((v, i) => {
            const intensity = Math.min(1, v / 10);
            return (
              <div key={i} title={`${i}:00 — ${v.toFixed(1)} cycles`} style={{
                background: `rgba(167,139,250,${0.1 + intensity * 0.7})`,
                borderRadius: 1,
              }} />
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 9, color: T.faint }} className="af2-mono">
          <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>now</span>
        </div>
      </div>

      {/* Utilization */}
      <div>
        <div style={{ fontSize: 10, color: T.dim, marginBottom: 8 }}>UTILIZATION</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {[
            { l: 'Runner', v: 42, c: T.purple },
            { l: 'Queue',  v: 18, c: T.sonnet },
            { l: 'Budget', v: Math.round(a.cycle.costUsd / a.cycle.budgetUsd * 100), c: T.warning },
          ].map(g => (
            <div key={g.l} style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <Ring value={g.v} size={48} stroke={3} color={g.c} label={g.v + '%'} />
              <span style={{ fontSize: 9, color: T.dim, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{g.l}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ── Cycles List ────────────────────────────────────────────────────────────────
function CyclesList({ navigate }) {
  const a = A();
  const [filter, setFilter] = useS1('all');
  const [sort, setSort] = useS1({ col: 'at', dir: 'desc' });
  const [selected, setSelected] = useS1([]);
  const [density, setDensity] = useS1('comfortable'); // comfortable | compact
  const [comparing, setComparing] = useS1(false);
  const [searchQ, setSearchQ] = useS1('');

  const filtered = useM1(() => {
    let rows = a.cycles.filter(c =>
      filter === 'all' ? true :
      filter === 'active' ? c.stage === 'active' :
      filter === 'success' ? c.stage === 'completed' :
      filter === 'failed' ? c.stage === 'failed' : true
    );
    if (searchQ) {
      const q = searchQ.toLowerCase();
      rows = rows.filter(c => c.id.toLowerCase().includes(q) || (c.v || '').toLowerCase().includes(q));
    }
    rows = [...rows].sort((x, y) => {
      const va = sortVal(x, sort.col), vb = sortVal(y, sort.col);
      if (va < vb) return sort.dir === 'asc' ? -1 : 1;
      if (va > vb) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }, [a.cycles, filter, sort, searchQ]);

  function sortVal(c, col) {
    if (col === 'at') return c.at;
    if (col === 'cost') return c.cost;
    if (col === 'elapsed') return c.elapsed.includes('h') ? parseFloat(c.elapsed) * 60 : parseFloat(c.elapsed);
    if (col === 'stage') return c.stage;
    if (col === 'tests') return c.tests ? parseFloat(c.tests.split('/')[0]) / parseFloat(c.tests.split('/')[1]) : 0;
    return c[col] || '';
  }
  function toggleSort(col) {
    setSort(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'desc' });
  }
  function toggleRow(id) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : s.length >= 3 ? [...s.slice(1), id] : [...s, id]);
  }

  // Stats strip data
  const stats = useM1(() => {
    const completed = a.cycles.filter(c => c.stage === 'completed');
    const failed = a.cycles.filter(c => c.stage === 'failed');
    const passRate = a.cycles.length > 0 ? (completed.length / a.cycles.length) * 100 : 0;
    const avgCost = completed.length > 0 ? completed.reduce((s, c) => s + c.cost, 0) / completed.length : 0;
    const totalSpend = a.cycles.reduce((s, c) => s + c.cost, 0);
    return { total: a.cycles.length, completed: completed.length, failed: failed.length, passRate, avgCost, totalSpend };
  }, [a.cycles]);

  const padCell = density === 'compact' ? '5px 12px' : '8px 14px';

  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Cycles']}
        title="Cycles"
        subtitle={<span><span className="af2-mono">{a.cycles.length}</span> total · autonomous sprint history</span>}
        actions={
          <>
            <div style={{ display: 'flex', gap: 0, background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 6, padding: 2 }}>
              {[['comfortable', '☰'], ['compact', '☷']].map(([id, ic]) => (
                <button key={id} title={id} onClick={() => setDensity(id)} style={{
                  padding: '4px 10px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
                  background: density === id ? T.surface2 : 'transparent', border: 'none',
                  color: density === id ? T.text : T.dim,
                }}>{ic}</button>
              ))}
            </div>
            <Btn size="sm">Export</Btn>
            <Btn size="sm">Refresh</Btn>
            <Btn variant="purple" onClick={() => navigate('/cycles/new')}>+ New Cycle</Btn>
          </>
        }
      />

      {/* Stats strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 12 }}>
        <CycleStat label="Total" value={stats.total} delta={null} color={T.text} spark={a.kpis.throughput.spark} />
        <CycleStat label="Pass rate" value={stats.passRate.toFixed(1) + '%'} delta="+2.4" color={T.success} spark={a.kpis.passRate.spark} />
        <CycleStat label="Avg cost" value={'$' + stats.avgCost.toFixed(2)} delta="-12%" color={T.purple} spark={a.kpis.costPerCycle.spark} />
        <CycleStat label="Avg time" value={a.kpis.cycleTime.value + 'm'} delta="-6m" color={T.sonnet} spark={a.kpis.cycleTime.spark} />
        <CycleStat label="Total spend" value={'$' + stats.totalSpend.toFixed(2)} delta="+$24" color={T.warning} spark={a.kpis.costPerCycle.spark} />
      </div>

      {/* Filter chips + search + selection */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {[
          { id:'all',     label:'All',       count:a.cycles.length, c:T.muted },
          { id:'active',  label:'Active',    count:a.cycles.filter(c=>c.stage==='active').length, c:T.purple },
          { id:'success', label:'Completed', count:a.cycles.filter(c=>c.stage==='completed').length, c:T.success },
          { id:'failed',  label:'Failed',    count:a.cycles.filter(c=>c.stage==='failed').length, c:T.danger },
        ].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 12px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
            background: filter === f.id ? T.surface2 : 'transparent',
            border: `1px solid ${filter === f.id ? T.border3 : T.border2}`,
            color: filter === f.id ? T.text : T.dim, fontWeight: 500, transition: 'all 150ms',
          }}>
            <span className="af2-mono" style={{ fontSize: 10, color: filter === f.id ? f.c : T.faint, fontWeight: 700 }}>{f.count}</span>
            {f.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <Input value={searchQ} onChange={setSearchQ} placeholder="Search cycle id, sprint…" prefix="⌕" style={{ width: 260, height: 30 }} />
      </div>

      {/* Table */}
      <Card noPad>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ padding: '8px 14px', borderBottom: `1px solid ${T.border}`, width: 32 }}>
                <input type="checkbox" checked={selected.length === filtered.length && filtered.length > 0}
                  onChange={() => setSelected(selected.length === filtered.length ? [] : filtered.slice(0, 3).map(c => c.id))}
                  style={{ accentColor: T.purple, cursor: 'pointer' }} />
              </th>
              {[
                ['stage', 'Stage', false], ['id', 'Cycle', true], ['v', 'Sprint', true],
                ['at', 'Started', true], ['elapsed', 'Elapsed', true], ['cost', 'Cost', true],
                ['tests', 'Tests', true], ['pr', 'PR', false],
              ].map(([key, label, sortable]) => (
                <th key={key} onClick={() => sortable && toggleSort(key)} style={{
                  textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
                  textTransform: 'uppercase', color: T.dim, padding: '10px 14px',
                  borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap',
                  cursor: sortable ? 'pointer' : 'default', userSelect: 'none',
                }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {label}
                    {sortable && sort.col === key && (
                      <span style={{ color: T.purple, fontSize: 9 }}>{sort.dir === 'asc' ? '▲' : '▼'}</span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((c, i) => {
              const isSelected = selected.includes(c.id);
              return (
                <tr key={c.id} className="af2-hover-row" onClick={() => navigate(`/cycles/${c.id}`)} style={{
                  cursor: 'pointer', borderBottom: `1px solid ${T.border}`,
                  background: isSelected ? `${T.purple}10` : c.stage === 'active' ? `${T.purple}06` : 'transparent',
                }}>
                  <td style={{ padding: padCell }} onClick={e => { e.stopPropagation(); toggleRow(c.id); }}>
                    <input type="checkbox" checked={isSelected} onChange={() => {}} style={{ accentColor: T.purple, cursor: 'pointer' }} />
                  </td>
                  <td style={{ padding: padCell }}>
                    <StageDots stages={c.stages} />
                  </td>
                  <td style={{ padding: padCell }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {c.stage === 'active' && <PulseDot color={T.purple} size={5} />}
                      <span className="af2-mono" style={{ fontWeight: 600, color: T.text }}>{c.id}</span>
                    </div>
                  </td>
                  <td style={{ padding: padCell }}>
                    <span className="af2-mono" style={{ color: T.muted }}>{c.v || '—'}</span>
                  </td>
                  <td style={{ padding: padCell, color: T.dim, fontSize: 11 }}>{fmtRel(c.at)}</td>
                  <td style={{ padding: padCell }}>
                    <span className="af2-mono" style={{ fontSize: 11 }}>{c.elapsed}</span>
                  </td>
                  <td style={{ padding: padCell, minWidth: 130 }}>
                    <div className="af2-mono" style={{ fontSize: 11, color: T.text }}>${c.cost.toFixed(2)} <span style={{ color: T.dim }}>/ ${c.budget}</span></div>
                    <div style={{ height: 2, width: 90, background: T.border, borderRadius: 1, marginTop: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.min(100, (c.cost/c.budget)*100)}%`, background: 'var(--af-grad-h)' }} />
                    </div>
                  </td>
                  <td style={{ padding: padCell }}>
                    {c.tests ? <span className="af2-mono" style={{ fontSize: 11 }}>{c.tests}</span> : <span style={{ color: T.faint }}>—</span>}
                  </td>
                  <td style={{ padding: padCell }}>
                    {c.pr ? <a href="#" style={{ color: T.accent2, fontSize: 11 }}>{c.pr} ↗</a> : <span style={{ color: T.faint }}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* Sticky compare bar */}
      {selected.length > 0 && (
        <div style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          background: T.surface, border: `1px solid ${T.purple}55`, borderRadius: 10,
          padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 14,
          boxShadow: '0 12px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(168,139,250,0.1)',
          zIndex: 80, animation: 'af2fade 200ms ease-out',
        }}>
          <span className="af2-mono" style={{ fontSize: 11, color: T.muted }}>
            <span style={{ color: T.purple, fontWeight: 700 }}>{selected.length}</span> selected
            <span style={{ color: T.faint, marginLeft: 6 }}>{selected.length < 2 ? '· select 2-3 to compare' : ''}</span>
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            {selected.map(id => (
              <span key={id} className="af2-mono" style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 4,
                background: T.surface2, border: `1px solid ${T.border2}`, color: T.text,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                {id}
                <button onClick={() => toggleRow(id)} style={{ background: 'none', border: 'none', color: T.dim, cursor: 'pointer', padding: 0, fontSize: 12 }}>×</button>
              </span>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <Btn size="sm" onClick={() => setSelected([])}>Clear</Btn>
          <Btn variant="purple" size="sm" disabled={selected.length < 2} onClick={() => setComparing(true)}>
            Compare {selected.length} →
          </Btn>
        </div>
      )}

      {/* Compare drawer */}
      {comparing && <CompareDrawer ids={selected} onClose={() => setComparing(false)} navigate={navigate} />}
    </div>
  );
}

function CycleStat({ label, value, delta, color, spark }) {
  return (
    <Card hover style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: 10, color: T.dim, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>{label}</span>
        {delta && <span className="af2-mono" style={{ fontSize: 10, color: delta.startsWith('-') ? T.success : T.success, padding: '1px 5px', borderRadius: 3, background: `${T.success}15` }}>{delta}</span>}
      </div>
      <div className="af2-mono" style={{ fontSize: 20, fontWeight: 600, color: color || T.text, marginTop: 6, letterSpacing: '-0.02em' }}>{value}</div>
      {spark && <div style={{ marginTop: 6 }}><Sparkline data={spark} color={color || T.purple} w={200} h={20} gradient /></div>}
    </Card>
  );
}

function CompareDrawer({ ids, onClose, navigate }) {
  const a = window.AF2;
  const cycles = ids.map(id => a.cycles.find(c => c.id === id)).filter(Boolean);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
      animation: 'af2fade 200ms ease-out',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(1200px, 92vw)', height: '100%', background: T.bg,
        borderLeft: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column',
        boxShadow: '-12px 0 60px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 24px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-0.015em' }}>Compare cycles</h2>
            <p style={{ margin: '3px 0 0', fontSize: 11, color: T.dim }}>{cycles.length} cycles side-by-side</p>
          </div>
          <button onClick={onClose} style={{
            width: 30, height: 30, borderRadius: 6, background: T.surface, border: `1px solid ${T.border2}`,
            color: T.muted, cursor: 'pointer', fontSize: 16,
          }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cycles.length}, 1fr)`, gap: 12 }}>
            {cycles.map(c => <CompareCard key={c.id} c={c} cycles={cycles} navigate={navigate} onClose={onClose} />)}
          </div>

          {/* Stage rail comparison */}
          <Card style={{ marginTop: 16 }}>
            <SectionTitle>STAGE COMPLETION</SectionTitle>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {['PLAN','STAGE','RUN','VERIFY','COMMIT','REVIEW'].map((name, idx) => (
                <div key={name} style={{ display: 'grid', gridTemplateColumns: `80px repeat(${cycles.length}, 1fr)`, gap: 12, alignItems: 'center' }}>
                  <span className="af2-mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: T.dim }}>{name}</span>
                  {cycles.map(c => {
                    const s = c.stages[idx];
                    return (
                      <div key={c.id} style={{
                        height: 26, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: s === 'done' ? `${T.accent}20` : s === 'active' ? `${T.purple}25` : s === 'failed' ? `${T.danger}20` : T.surface,
                        border: `1px solid ${s === 'done' ? T.accent + '55' : s === 'active' ? T.purple + '55' : s === 'failed' ? T.danger + '55' : T.border}`,
                        color: s === 'done' ? T.accent2 : s === 'active' ? T.purple : s === 'failed' ? T.danger : T.faint,
                        fontSize: 11, fontWeight: 600,
                      }}>{s === 'done' ? '✓ done' : s === 'active' ? '◐ active' : s === 'failed' ? '✗ failed' : 'pending'}</div>
                    );
                  })}
                </div>
              ))}
            </div>
          </Card>

          {/* KPI diff */}
          <Card style={{ marginTop: 12 }}>
            <SectionTitle>METRICS COMPARISON</SectionTitle>
            <div style={{ marginTop: 12 }}>
              {[
                { label: 'Cost', get: c => c.cost, fmt: v => '$' + v.toFixed(2), better: 'low' },
                { label: 'Budget', get: c => c.budget, fmt: v => '$' + v.toFixed(0), better: null },
                { label: 'Cost % of budget', get: c => (c.cost / c.budget) * 100, fmt: v => v.toFixed(0) + '%', better: 'low' },
                { label: 'Elapsed', get: c => c.elapsed, fmt: v => v, better: null },
                { label: 'Tests', get: c => c.tests || '—', fmt: v => v, better: null },
              ].map(metric => {
                const vals = cycles.map(c => metric.get(c));
                const numVals = vals.filter(v => typeof v === 'number');
                const best = metric.better === 'low' ? Math.min(...numVals) : metric.better === 'high' ? Math.max(...numVals) : null;
                return (
                  <div key={metric.label} style={{ display: 'grid', gridTemplateColumns: `120px repeat(${cycles.length}, 1fr)`, gap: 12, padding: '8px 0', borderBottom: `1px solid ${T.border}`, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: T.dim }}>{metric.label}</span>
                    {cycles.map((c, i) => {
                      const v = metric.get(c);
                      const isBest = best != null && v === best;
                      return (
                        <span key={c.id} className="af2-mono" style={{
                          fontSize: 12, color: isBest ? T.success : T.text, fontWeight: isBest ? 600 : 500,
                        }}>{metric.fmt(v)}{isBest && <span style={{ marginLeft: 4, fontSize: 9 }}>★</span>}</span>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function CompareCard({ c, cycles, navigate, onClose }) {
  return (
    <Card style={{ padding: 16, borderColor: `${T.purple}33` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {c.stage === 'active' && <PulseDot color={T.purple} size={5} />}
        <span className="af2-mono" style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{c.id}</span>
        <Badge variant={c.stage === 'completed' ? 'success' : c.stage === 'failed' ? 'danger' : 'purple'}>{c.stage.toUpperCase()}</Badge>
      </div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 12 }}>
        <span className="af2-mono">v{c.v || '—'}</span> · {fmtRel(c.at)}
      </div>
      <div style={{ marginBottom: 12 }}>
        <StageDots stages={c.stages} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Cost</div>
          <div className="af2-mono" style={{ fontSize: 16, fontWeight: 600, color: T.text, marginTop: 2 }}>${c.cost.toFixed(2)}</div>
          <div className="af2-mono" style={{ fontSize: 10, color: T.dim }}>of ${c.budget}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Elapsed</div>
          <div className="af2-mono" style={{ fontSize: 16, fontWeight: 600, color: T.text, marginTop: 2 }}>{c.elapsed}</div>
        </div>
      </div>
      <Btn size="sm" style={{ width: '100%', justifyContent: 'center' }} onClick={() => { onClose(); navigate('/cycles/' + c.id); }}>Open detail →</Btn>
    </Card>
  );
}

// ── Launch Cycle ───────────────────────────────────────────────────────────────
function LaunchCycle({ navigate }) {
  const a = A();
  const [budget, setBudget] = useS1('200');
  const [maxItems, setMaxItems] = useS1('5');
  const [prefix, setPrefix] = useS1('autonomous/');
  const [modelCap, setModelCap] = useS1('default');
  const [effortCap, setEffortCap] = useS1('default');
  const [dryRun, setDryRun] = useS1(false);
  const [fallback, setFallback] = useS1(true);
  const [comment, setComment] = useS1('');
  const [launching, setLaunching] = useS1(false);
  const [launched, setLaunched] = useS1(false);

  function handleLaunch() {
    setLaunching(true);
    setTimeout(() => { setLaunching(false); setLaunched(true); setTimeout(() => navigate('/cycles/b555cca4'), 1200); }, 1000);
  }

  // Estimate cost based on settings
  const estimate = useM1(() => {
    const base = parseInt(maxItems) * 1.2;
    const mult = modelCap === 'opus' ? 4 : modelCap === 'haiku' ? 0.25 : 1;
    return base * mult;
  }, [maxItems, modelCap]);

  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Cycles', 'Launch']}
        title="Launch autonomous cycle"
        subtitle="Plan → Stage → Run → Verify → Commit → Review via a detached Claude Code session"
        actions={<Btn size="sm" onClick={() => navigate('/cycles')}>← Cancel</Btn>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 14, alignItems: 'start' }}>
        {/* Form */}
        <Card>
          <SectionTitle>CYCLE CONFIGURATION</SectionTitle>

          {/* Row 1 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14, marginTop: 12, marginBottom: 14 }}>
            <Field label="Budget (USD)"><Input mono value={budget} onChange={setBudget} type="number" prefix="$" /></Field>
            <Field label="Max items / sprint"><Input mono value={maxItems} onChange={setMaxItems} type="number" /></Field>
            <Field label="Branch prefix"><Input mono value={prefix} onChange={setPrefix} /></Field>
            <Field label="Model cap">
              <Select value={modelCap} onChange={setModelCap} options={[
                {value:'default', label:'Default (per agent)'},
                {value:'haiku',   label:'Haiku — Fast'},
                {value:'sonnet',  label:'Sonnet — Balanced'},
                {value:'opus',    label:'Opus — Most capable'},
              ]} style={{ width: '100%' }} />
            </Field>
          </div>

          {/* Row 2 */}
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', marginBottom: 16 }}>
            <Field label="Effort cap" style={{ minWidth: 220 }}>
              <Select value={effortCap} onChange={setEffortCap} options={[
                {value:'default',label:'Default (per agent)'},
                {value:'low',    label:'Low'},
                {value:'medium', label:'Medium'},
                {value:'high',   label:'High'},
                {value:'max',    label:'Max'},
              ]} style={{ width: '100%' }} />
            </Field>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 6 }}>
              <Toggle checked={dryRun} onChange={setDryRun} label="Dry run" sub="(skip PR creation)" />
              <Toggle checked={fallback} onChange={setFallback} label="Enable model fallback" sub="(opus → sonnet → haiku on overload)" />
            </div>
          </div>

          <Field label="Cycle comment (optional)">
            <textarea value={comment} onChange={e => setComment(e.target.value)}
              placeholder="Why are you running this cycle? e.g. 'ship v14.1 dashboard refresh'"
              style={{
                width: '100%', background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 6,
                padding: '10px 12px', fontSize: 12, color: T.text, minHeight: 70, resize: 'vertical',
                fontFamily: 'inherit', boxSizing: 'border-box',
              }} />
          </Field>

          <div style={{
            display: 'flex', gap: 10, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${T.border}`,
            alignItems: 'center',
          }}>
            <span style={{ fontSize: 11, color: T.dim }}>Advanced overrides (per-agent budgets, model pinning) are future work.</span>
            <span style={{ flex: 1 }} />
            <Btn size="sm">Preview Cost</Btn>
            <Btn variant="purple" size="lg" onClick={handleLaunch} disabled={launching || launched}>
              {launched ? '✓ Launched, redirecting…' : launching ? 'Launching…' : '▶ Run Cycle'}
            </Btn>
          </div>
        </Card>

        {/* Preview / Estimate */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 0 }}>
          <Card>
            <SectionTitle>ESTIMATE</SectionTitle>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 10 }}>
              <span className="af2-mono" style={{ fontSize: 32, fontWeight: 600, color: T.text, letterSpacing: '-0.02em' }}>
                ${estimate.toFixed(2)}
              </span>
              <span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>est.</span>
              <span style={{ flex: 1 }} />
              <span className="af2-mono" style={{ fontSize: 10, color: T.success }}>
                {Math.round((1 - estimate/parseFloat(budget))*100)}% under budget
              </span>
            </div>
            <div style={{ marginTop: 12, height: 6, background: T.border, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${Math.min(100, (estimate/parseFloat(budget))*100)}%`,
                background: 'var(--af-grad-h)',
                transition: 'width 400ms ease',
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: T.dim }} className="af2-mono">
              <span>$0</span>
              <span>budget ${budget}</span>
            </div>
            <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11 }}>
              <div><div style={{ color: T.dim }}>Items</div><span className="af2-mono" style={{ color: T.text, fontWeight: 600 }}>~{maxItems}</span></div>
              <div><div style={{ color: T.dim }}>Avg duration</div><span className="af2-mono" style={{ color: T.text, fontWeight: 600 }}>~47m</span></div>
              <div><div style={{ color: T.dim }}>Likely model</div><span className="af2-mono" style={{ color: T.purple, fontWeight: 600 }}>{modelCap === 'default' ? 'sonnet' : modelCap}</span></div>
              <div><div style={{ color: T.dim }}>Branch</div><span className="af2-mono" style={{ color: T.text, fontWeight: 600 }}>{prefix}vX.Y.Z</span></div>
            </div>
          </Card>

          <Card>
            <SectionTitle>SIMILAR PAST CYCLES</SectionTitle>
            {a.cycles.filter(c => c.stage === 'completed').slice(0, 4).map(c => (
              <div key={c.id} style={{
                display: 'grid', gridTemplateColumns: 'auto auto 1fr auto', alignItems: 'center', gap: 8,
                padding: '5px 0', borderBottom: `1px solid ${T.border}`,
              }}>
                <StageDots stages={c.stages} size="sm" />
                <span className="af2-mono" style={{ fontSize: 11, color: T.text }}>{c.id}</span>
                <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>v{c.v}</span>
                <span className="af2-mono" style={{ fontSize: 10, color: T.muted }}>${c.cost.toFixed(2)}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, style }) {
  return (
    <div style={style}>
      <div style={{ fontSize: 10, color: T.dim, marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label, sub }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
      <span style={{
        width: 28, height: 16, borderRadius: 999, background: checked ? T.accent : T.border3,
        position: 'relative', transition: 'background 200ms ease', flexShrink: 0,
      }}>
        <span style={{
          position: 'absolute', top: 2, left: checked ? 14 : 2, width: 12, height: 12,
          background: '#fff', borderRadius: '50%', transition: 'left 200ms ease',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        }} />
      </span>
      <span style={{ fontSize: 12, color: T.text }}>{label}</span>
      {sub && <span style={{ fontSize: 11, color: T.dim }}>{sub}</span>}
    </label>
  );
}

Object.assign(window, { CommandCenter, CyclesList, LaunchCycle, Field, Toggle });
