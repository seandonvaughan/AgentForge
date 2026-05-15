// ── V2 Agents + Org Graph pages ───────────────────────────────────────────────
const { useState: useS3, useMemo: useM3 } = React;

// ── Agents Page ────────────────────────────────────────────────────────────────
function AgentsPage({ navigate }) {
  const a = window.AF2;
  const [search, setSearch] = useS3('');
  const [model, setModel] = useS3('all');
  const [team, setTeam] = useS3('all');

  const teams = ['all', ...new Set(a.agents.map(x => x.team).filter(Boolean))];

  const filtered = useM3(() => a.agents.filter(ag => {
    if (search && !ag.name.toLowerCase().includes(search.toLowerCase()) && !ag.id.toLowerCase().includes(search.toLowerCase())) return false;
    if (model !== 'all' && ag.model !== model) return false;
    if (team !== 'all' && ag.team !== team) return false;
    return true;
  }), [search, model, team, a.agents]);

  const modelCount = useM3(() => ({
    opus: a.agents.filter(x => x.model === 'opus').length,
    sonnet: a.agents.filter(x => x.model === 'sonnet').length,
    haiku: a.agents.filter(x => x.model === 'haiku').length,
  }), [a.agents]);
  const totalSpend = a.agents.reduce((s, x) => s + (x.spend || 0), 0);
  const topSpender = [...a.agents].sort((x, y) => y.spend - x.spend)[0];

  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Agents']}
        title="Agent fleet"
        subtitle={<span><span className="af2-mono">{a.agents.length}</span> agents registered · <span className="af2-mono">{a.counters.agentsActive}</span> active right now</span>}
        actions={<><Btn size="sm">Export CSV</Btn><Btn size="sm" variant="purple">+ Register agent</Btn></>}
      />

      {/* Stat strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 14 }}>
        <Card style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Total agents</div>
          <div className="af2-mono" style={{ fontSize: 22, fontWeight: 600, color: T.text }}>{a.agents.length}</div>
          <DistBar segments={[
            { value: modelCount.opus, color: T.opus },
            { value: modelCount.sonnet, color: T.sonnet },
            { value: modelCount.haiku, color: T.haiku },
          ]} h={4} />
          <div style={{ marginTop: 6, fontSize: 10, display: 'flex', justifyContent: 'space-between' }}>
            <span><span style={{ color: T.opus }}>●</span> <span className="af2-mono" style={{ color: T.muted }}>{modelCount.opus}</span></span>
            <span><span style={{ color: T.sonnet }}>●</span> <span className="af2-mono" style={{ color: T.muted }}>{modelCount.sonnet}</span></span>
            <span><span style={{ color: T.haiku }}>●</span> <span className="af2-mono" style={{ color: T.muted }}>{modelCount.haiku}</span></span>
          </div>
        </Card>
        <Card style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Teams</div>
          <div className="af2-mono" style={{ fontSize: 22, fontWeight: 600, color: T.text }}>{teams.length - 1}</div>
          <div style={{ fontSize: 10, color: T.dim, marginTop: 6 }}>+ <span className="af2-mono">{a.agents.filter(x => !x.team).length}</span> unassigned</div>
        </Card>
        <Card style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Live now</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PulseDot color={T.purple} size={6} />
            <span className="af2-mono" style={{ fontSize: 22, fontWeight: 600, color: T.text }}>{a.counters.agentsActive}</span>
            <span style={{ fontSize: 11, color: T.dim }}>active</span>
          </div>
          <div style={{ fontSize: 10, color: T.dim, marginTop: 6 }}><span className="af2-mono" style={{ color: T.muted }}>{a.counters.agentsQueued}</span> queued</div>
        </Card>
        <Card style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Total spend (cycle)</div>
          <div className="af2-mono" style={{ fontSize: 22, fontWeight: 600, color: T.text }}>${totalSpend.toFixed(2)}</div>
          <div style={{ fontSize: 10, color: T.dim, marginTop: 6 }}>avg <span className="af2-mono">${(totalSpend / a.agents.length).toFixed(3)}</span>/agent</div>
        </Card>
        <Card style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Top spender</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ModelChip model={topSpender.model} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>{topSpender.id}</span>
          </div>
          <div className="af2-mono" style={{ fontSize: 14, color: T.purple, marginTop: 6, fontWeight: 600 }}>${topSpender.spend.toFixed(3)}</div>
        </Card>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Input value={search} onChange={setSearch} placeholder="Search by name or id…" prefix="⌕" style={{ width: 280 }} />
        <span style={{ fontSize: 11, color: T.dim, marginLeft: 6 }}>MODEL</span>
        {['all', 'opus', 'sonnet', 'haiku'].map(m => (
          <button key={m} onClick={() => setModel(m)} style={{
            padding: '4px 12px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
            background: model === m ? T.surface2 : 'transparent',
            border: `1px solid ${model === m ? (m === 'all' ? T.border3 : m === 'opus' ? T.opus + '55' : m === 'sonnet' ? T.sonnet + '55' : T.haiku + '55') : T.border2}`,
            color: model === m ? (m === 'all' ? T.text : m === 'opus' ? T.opus : m === 'sonnet' ? T.sonnet : T.haiku) : T.dim,
            fontWeight: 500, textTransform: m === 'all' ? 'none' : 'uppercase', letterSpacing: m === 'all' ? 0 : '0.04em',
          }}>{m}</button>
        ))}
        <span style={{ width: 1, height: 18, background: T.border, margin: '0 4px' }} />
        <span style={{ fontSize: 11, color: T.dim }}>TEAM</span>
        <Select value={team} onChange={setTeam} options={teams.map(t => ({ value: t, label: t === 'all' ? 'All teams' : t }))} style={{ width: 180 }} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: T.dim }}>{filtered.length} of {a.agents.length}</span>
      </div>

      {/* Agent table */}
      <Card noPad>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['Name', 'Agent ID', 'Model', 'Team', 'Effort', 'Cycle spend', 'Description'].map(h => (
                <th key={h} style={{
                  textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: T.dim, padding: '10px 14px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(ag => (
              <tr key={ag.id} className="af2-hover-row" onClick={() => navigate(`/agents/${ag.id}`)} style={{ borderBottom: `1px solid ${T.border}`, cursor: 'pointer' }}>
                <td style={{ padding: '8px 14px', color: T.text, fontWeight: 500 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {ag.id === window.AF2.cycle.activeAgent && <PulseDot color={T.purple} size={5} />}
                    <span>{ag.name}</span>
                  </div>
                </td>
                <td style={{ padding: '8px 14px' }}>
                  <span className="af2-mono" style={{ fontSize: 11, color: T.muted }}>{ag.id}</span>
                </td>
                <td style={{ padding: '8px 14px' }}><ModelChip model={ag.model} /></td>
                <td style={{ padding: '8px 14px' }}>
                  {ag.team ? <Badge variant="muted">{ag.team}</Badge> : <span style={{ color: T.faint, fontSize: 11 }}>—</span>}
                </td>
                <td style={{ padding: '8px 14px' }}>
                  {ag.effort ? <Badge variant={ag.effort === 'HIGH' || ag.effort === 'MAX' ? 'warning' : ag.effort === 'MEDIUM' ? 'info' : 'muted'}>{ag.effort}</Badge> : <span style={{ color: T.faint, fontSize: 11 }}>—</span>}
                </td>
                <td style={{ padding: '8px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="af2-mono" style={{ fontSize: 11, color: T.text, minWidth: 50 }}>${ag.spend.toFixed(3)}</span>
                    <div style={{ width: 50, height: 3, background: T.border, borderRadius: 1, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.min(100, (ag.spend / topSpender.spend) * 100)}%`, background: 'var(--af-grad-h)' }} />
                    </div>
                  </div>
                </td>
                <td style={{ padding: '8px 14px', color: T.dim, fontSize: 11, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ag.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ── Org Graph Page ─────────────────────────────────────────────────────────────
function OrgGraphPage() {
  const a = window.AF2;
  const [view, setView] = useS3('tree');  // tree | graph
  const [expanded, setExpanded] = useS3({ ceo: true, cto: true, 'lead-arch': true, 'rd-lead': true, vpe: true, 'core-plat': true, 'runtime-plat': true });

  // Build tree
  const tree = useM3(() => {
    const map = new Map();
    a.org.forEach(n => map.set(n.id, { ...n, children: [] }));
    const roots = [];
    a.org.forEach(n => {
      const node = map.get(n.id);
      if (n.parent) {
        const p = map.get(n.parent);
        if (p) p.children.push(node);
        else roots.push(node);
      } else {
        roots.push(node);
      }
    });
    return roots;
  }, [a.org]);

  function toggle(id) { setExpanded(e => ({ ...e, [id]: !e[id] })); }
  function expandAll()   { setExpanded(Object.fromEntries(a.org.map(n => [n.id, true]))); }
  function collapseAll() { setExpanded({ ceo: true }); }

  const totalCost = a.org.reduce((s, n) => s + n.cost, 0);

  return (
    <div>
      <PageHeader
        crumbs={['Workspace', a.workspace.name, 'Org Graph']}
        title="Organization graph"
        subtitle={<span><span className="af2-mono">{a.org.length}</span> agents · <span className="af2-mono">{a.org.reduce((s,n) => s + n.dir, 0)}</span> delegation edges · total spend <span className="af2-mono">${totalCost.toFixed(2)}</span></span>}
        actions={
          <>
            <div style={{ display: 'flex', gap: 0, background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 6, padding: 2 }}>
              {[['tree', 'Tree'], ['graph', 'Graph']].map(([id, label]) => (
                <button key={id} onClick={() => setView(id)} style={{
                  padding: '4px 12px', borderRadius: 4, fontSize: 11, fontWeight: 500, cursor: 'pointer',
                  background: view === id ? T.surface2 : 'transparent',
                  border: 'none', color: view === id ? T.text : T.dim,
                }}>{label}</button>
              ))}
            </div>
            <Btn size="sm" onClick={expandAll}>Expand all</Btn>
            <Btn size="sm" onClick={collapseAll}>Collapse</Btn>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
        {/* Left: tree or graph */}
        {view === 'tree' ? (
          <Card style={{ padding: '14px 14px 14px 6px', minHeight: 600 }}>
            <SectionTitle right={
              <div style={{ display: 'flex', gap: 12, fontSize: 10 }}>
                <span><span style={{ color: T.opus }}>●</span> <span style={{ color: T.dim }}>opus</span></span>
                <span><span style={{ color: T.sonnet }}>●</span> <span style={{ color: T.dim }}>sonnet</span></span>
                <span><span style={{ color: T.haiku }}>●</span> <span style={{ color: T.dim }}>haiku</span></span>
              </div>
            }>HIERARCHY</SectionTitle>
            <div style={{ marginTop: 10 }}>
              {tree.map(node => <OrgNode key={node.id} node={node} depth={0} expanded={expanded} toggle={toggle} />)}
            </div>
          </Card>
        ) : (
          <Card style={{ padding: '14px', minHeight: 600 }}>
            <SectionTitle>GRAPH</SectionTitle>
            <OrgGraphSvg org={a.org} />
          </Card>
        )}

        {/* Right: stats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card>
            <SectionTitle>BY MODEL</SectionTitle>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { model: 'opus', color: T.opus, count: a.modelMix.opus },
                { model: 'sonnet', color: T.sonnet, count: a.modelMix.sonnet },
                { model: 'haiku', color: T.haiku, count: a.modelMix.haiku },
              ].map(m => {
                const total = a.modelMix.opus + a.modelMix.sonnet + a.modelMix.haiku;
                const pct = (m.count / total) * 100;
                return (
                  <div key={m.model}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color }} />
                        <span className="af2-mono" style={{ color: T.text, textTransform: 'uppercase' }}>{m.model}</span>
                      </span>
                      <span className="af2-mono" style={{ fontSize: 11, color: T.text }}>{m.count} <span style={{ color: T.dim }}>({pct.toFixed(0)}%)</span></span>
                    </div>
                    <div style={{ height: 4, background: T.border, borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: m.color, transition: 'width 500ms ease' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
          <Card>
            <SectionTitle>TOP COST CENTERS</SectionTitle>
            <div style={{ marginTop: 10 }}>
              {[...a.org].sort((x, y) => y.cost - x.cost).slice(0, 8).map(n => (
                <div key={n.id} style={{
                  display: 'grid', gridTemplateColumns: 'auto 1fr auto 80px', gap: 10, alignItems: 'center',
                  padding: '5px 0', borderBottom: `1px solid ${T.border}`,
                }}>
                  <span style={{ width: 4, height: 16, background: n.model === 'opus' ? T.opus : n.model === 'sonnet' ? T.sonnet : T.haiku, borderRadius: 2 }} />
                  <span style={{ fontSize: 12, color: T.text }}>{n.name}</span>
                  <ModelChip model={n.model} />
                  <div style={{ textAlign: 'right' }}>
                    <span className="af2-mono" style={{ fontSize: 11, color: T.text }}>${n.cost.toFixed(3)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function OrgNode({ node, depth, expanded, toggle }) {
  const hasChildren = node.children && node.children.length > 0;
  const isOpen = expanded[node.id];
  const colorBy = node.model === 'opus' ? T.opus : node.model === 'sonnet' ? T.sonnet : T.haiku;
  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'auto 1fr auto auto auto',
        alignItems: 'center', gap: 8,
        marginLeft: depth * 20, padding: '5px 12px',
        background: T.surface2, border: `1px solid ${T.border2}`,
        borderLeft: `3px solid ${colorBy}`,
        borderRadius: 5, marginBottom: 3, cursor: hasChildren ? 'pointer' : 'default',
        transition: 'background 150ms',
      }} className={hasChildren ? 'af2-hover-card' : ''} onClick={() => hasChildren && toggle(node.id)}>
        <span style={{ width: 12, color: T.dim, fontSize: 10 }}>{hasChildren ? (isOpen ? '▾' : '▸') : ''}</span>
        <span style={{ fontSize: 12, color: T.text, fontWeight: 500 }}>{node.name}</span>
        <ModelChip model={node.model} />
        {node.dir > 0 && (
          <span className="af2-mono" style={{ fontSize: 10, color: T.dim, background: T.surface, border: `1px solid ${T.border2}`, padding: '1px 6px', borderRadius: 3 }}>
            {node.dir} direct
          </span>
        )}
        <span className="af2-mono" style={{ fontSize: 11, color: T.muted, minWidth: 56, textAlign: 'right' }}>${node.cost.toFixed(3)}</span>
      </div>
      {isOpen && hasChildren && (
        <div>
          {node.children.map(c => <OrgNode key={c.id} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} />)}
        </div>
      )}
    </div>
  );
}

// ── Org Graph SVG view ────────────────────────────────────────────────────────
function OrgGraphSvg({ org }) {
  // Compute simple radial layout
  const W = 700, H = 540;
  const cx = W / 2, cy = H / 2;
  // Map node depth from root
  const depths = useM3(() => {
    const m = {};
    function setDepth(id, d) {
      if (m[id] != null && m[id] <= d) return;
      m[id] = d;
      org.filter(c => c.parent === id).forEach(c => setDepth(c.id, d + 1));
    }
    org.filter(n => !n.parent).forEach(r => setDepth(r.id, 0));
    return m;
  }, [org]);

  // Place nodes by depth + index
  const positions = useM3(() => {
    const byDepth = {};
    org.forEach(n => {
      const d = depths[n.id] ?? 0;
      if (!byDepth[d]) byDepth[d] = [];
      byDepth[d].push(n);
    });
    const pos = {};
    Object.entries(byDepth).forEach(([d, nodes]) => {
      const depth = parseInt(d);
      if (depth === 0) {
        nodes.forEach((n, i) => {
          pos[n.id] = { x: cx, y: cy - 220 };
        });
      } else {
        const r = depth * 110;
        nodes.forEach((n, i) => {
          const a = (i / nodes.length) * Math.PI * 2 + Math.PI / 2 + depth * 0.15;
          pos[n.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) * 0.7 };
        });
      }
    });
    return pos;
  }, [org, depths]);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="org-edge" x1="0" x2="1">
          <stop offset="0%" stopColor={T.accent} stopOpacity="0.5" />
          <stop offset="100%" stopColor={T.purple} stopOpacity="0.5" />
        </linearGradient>
      </defs>
      {/* Edges */}
      {org.filter(n => n.parent).map(n => {
        const p = positions[n.parent], c = positions[n.id];
        if (!p || !c) return null;
        return (
          <line key={n.id + '-edge'} x1={p.x} y1={p.y} x2={c.x} y2={c.y}
            stroke="url(#org-edge)" strokeWidth="1" opacity="0.5" />
        );
      })}
      {/* Nodes */}
      {org.map(n => {
        const p = positions[n.id];
        if (!p) return null;
        const color = n.model === 'opus' ? T.opus : n.model === 'sonnet' ? T.sonnet : T.haiku;
        const size = Math.max(6, Math.min(18, 6 + n.cost * 4));
        return (
          <g key={n.id}>
            <circle cx={p.x} cy={p.y} r={size + 2} fill={color} opacity="0.15" />
            <circle cx={p.x} cy={p.y} r={size} fill={T.bg} stroke={color} strokeWidth="2" />
            <circle cx={p.x} cy={p.y} r={size - 4} fill={color} opacity="0.7" />
            <text x={p.x} y={p.y + size + 12} fill={T.muted} fontSize="10" textAnchor="middle" fontFamily="Inter">{n.name}</text>
          </g>
        );
      })}
    </svg>
  );
}

Object.assign(window, { AgentsPage, OrgGraphPage, AgentDetailPage });

// ═════════════════════════════════════════════════════════════════════════════
// AGENT DETAIL PAGE
// ═════════════════════════════════════════════════════════════════════════════
function AgentDetailPage({ navigate, agentId }) {
  const a = window.AF2;
  const ag = a.agents.find(x => x.id === agentId);
  const [tab, setTab] = React.useState('overview');

  if (!ag) {
    return (
      <div>
        <PageHeader crumbs={['Workspace', a.workspace.name, 'Agents', agentId]} title="Agent not found"
          actions={<Btn size="sm" onClick={() => navigate('/agents')}>← Back to Agents</Btn>} />
        <Card>
          <div style={{ padding: '40px 20px', textAlign: 'center', color: T.dim }}>
            <div style={{ fontSize: 30, marginBottom: 10 }}>⊟</div>
            <div style={{ fontSize: 13 }}>No agent registered with id <code className="af2-mono">{agentId}</code></div>
          </div>
        </Card>
      </div>
    );
  }

  const isLive = ag.id === a.cycle.activeAgent;
  const recentSessions = a.sessions.filter(s => s.agent === ag.id);
  const orgNode = a.org.find(o => o.id === ag.id || o.name === ag.id || o.name === ag.name);
  const direct  = orgNode ? a.org.filter(o => o.parent === orgNode.id) : [];
  const manager = orgNode?.parent ? a.org.find(o => o.id === orgNode.parent) : null;
  const memoryEntries = a.memory.filter(m => m.agent === ag.id);
  const totalSpend = ag.spend;
  const sparkTrend = a.trend(20, totalSpend * 0.3, totalSpend, totalSpend * 0.2);
  const callsSpark = a.trend(20, 4, 14, 3);
  const passRateSpark = a.trend(20, 92, 99, 2);

  // Phase distribution (mocked from ag's role)
  const phaseDist = a.cycle.phases.filter(p => p.agent === ag.id).map(p => ({ phase: p.name, runs: 1, cost: p.costUsd, dur: p.durMs })) || [];

  const tabs = [
    { id: 'overview',  label: 'Overview' },
    { id: 'sessions',  label: 'Sessions', count: recentSessions.length },
    { id: 'memory',    label: 'Memory', count: memoryEntries.length },
    { id: 'config',    label: 'Config' },
  ];

  return (
    <div>
      {/* Breadcrumb / back */}
      <div style={{ marginBottom: 10 }}>
        <button onClick={() => navigate('/agents')} style={{
          background: 'none', border: 'none', color: T.dim, fontSize: 11, cursor: 'pointer', padding: 0,
        }}>← Agents</button>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14, flexShrink: 0,
            background: 'var(--af-grad)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em',
            boxShadow: `0 8px 24px ${T.purple}33`,
          }}>{ag.name.split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase()}</div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              {isLive && <PulseDot color={T.purple} size={7} />}
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: T.text }}>{ag.name}</h1>
              <ModelChip model={ag.model} />
              {isLive && <Badge variant="purple">EXECUTING NOW</Badge>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: T.dim }}>
              <span className="af2-mono">{ag.id}</span>
              {ag.team && <><span style={{ color: T.faint }}>·</span><Badge variant="muted">{ag.team}</Badge></>}
              {ag.effort && <><span style={{ color: T.faint }}>·</span><Badge variant={ag.effort === 'HIGH' || ag.effort === 'MAX' ? 'warning' : ag.effort === 'MEDIUM' ? 'info' : 'muted'}>effort: {ag.effort}</Badge></>}
              {manager && <><span style={{ color: T.faint }}>·</span><span>reports to <span className="af2-mono" style={{ color: T.muted }}>{manager.name}</span></span></>}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn size="sm" onClick={() => navigate('/runner')}>▶ Run</Btn>
          <Btn size="sm">Duplicate</Btn>
          <Btn size="sm">Edit</Btn>
          <Btn size="sm" variant="danger">⋯</Btn>
        </div>
      </div>

      {/* Description */}
      <Card style={{ marginBottom: 14, padding: '14px 16px', background: T.surface }}>
        <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.6 }}>{ag.desc}</div>
      </Card>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 14 }}>
        <AgentKpi label="Cycle spend"   value={'$' + totalSpend.toFixed(3)} sub="this cycle" color={T.purple} spark={sparkTrend} />
        <AgentKpi label="Runs · 14d"    value={recentSessions.length + 14} sub="across cycles" color={T.text} spark={callsSpark} />
        <AgentKpi label="Pass rate"     value="98.2%" sub="last 50 runs"  color={T.success} spark={passRateSpark} />
        <AgentKpi label="Avg duration"  value="3m 14s" sub="per session" color={T.sonnet} />
        <AgentKpi label="Direct reports" value={orgNode?.dir ?? 0} sub={direct.length > 0 ? direct.length + ' reports' : 'individual contributor'} color={T.warning} />
      </div>

      {/* Tabs */}
      <Tabs tabs={tabs} active={tab} onSelect={setTab} />

      {tab === 'overview' && <AgentOverview ag={ag} orgNode={orgNode} direct={direct} manager={manager} phaseDist={phaseDist} navigate={navigate} />}
      {tab === 'sessions' && <AgentSessions ag={ag} sessions={recentSessions} navigate={navigate} />}
      {tab === 'memory'   && <AgentMemory entries={memoryEntries} />}
      {tab === 'config'   && <AgentConfig ag={ag} />}
    </div>
  );
}

function AgentKpi({ label, value, sub, color, spark }) {
  return (
    <Card hover style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 10, color: T.dim, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div className="af2-mono" style={{ fontSize: 22, fontWeight: 600, color: color || T.text, letterSpacing: '-0.02em' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: T.dim, marginTop: 2 }}>{sub}</div>}
      {spark && <div style={{ marginTop: 8 }}><Sparkline data={spark} color={color || T.purple} w={200} h={22} gradient /></div>}
    </Card>
  );
}

function AgentOverview({ ag, orgNode, direct, manager, phaseDist, navigate }) {
  const a = window.AF2;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Activity timeline */}
        <Card>
          <SectionTitle right={<span style={{ fontSize: 10, color: T.dim }}>last 14d</span>}>ACTIVITY</SectionTitle>
          <div style={{ marginTop: 14, height: 120, position: 'relative' }}>
            <Sparkline data={a.trend(14, ag.spend * 0.2, ag.spend, ag.spend * 0.3)} color={T.purple} w={760} h={120} gradient strokeWidth={2} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10, color: T.faint }} className="af2-mono">
            <span>14d ago</span><span>7d ago</span><span>now</span>
          </div>
        </Card>

        {/* Phase distribution */}
        <Card>
          <SectionTitle right={<span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>this cycle</span>}>PHASE PARTICIPATION</SectionTitle>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {phaseDist.length === 0 ? (
              <div style={{ fontSize: 12, color: T.dim, padding: '20px 0', textAlign: 'center' }}>
                Not active in current cycle phases.
              </div>
            ) : phaseDist.map(p => (
              <div key={p.phase} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 90px 90px', alignItems: 'center', gap: 12 }}>
                <span className="af2-mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: T.muted }}>{p.phase}</span>
                <div style={{ height: 6, background: T.border, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, (p.cost / 5) * 100)}%`, background: 'var(--af-grad-h)' }} />
                </div>
                <span className="af2-mono" style={{ fontSize: 11, color: T.text, textAlign: 'right' }}>${p.cost?.toFixed(3)}</span>
                <span className="af2-mono" style={{ fontSize: 11, color: T.dim, textAlign: 'right' }}>{p.dur ? fmtDuration(p.dur) : '—'}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Recent cycles this agent was part of */}
        <Card noPad>
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${T.border}` }}>
            <SectionTitle right={<span style={{ fontSize: 10, color: T.dim }}>last 5</span>}>RECENT CYCLES</SectionTitle>
          </div>
          <div>
            {a.cycles.slice(0, 5).map(c => (
              <div key={c.id} className="af2-hover-row" onClick={() => navigate(`/cycles/${c.id}`)} style={{
                display: 'grid', gridTemplateColumns: 'auto auto 1fr auto auto', gap: 10, alignItems: 'center',
                padding: '8px 14px', borderBottom: `1px solid ${T.border}`, cursor: 'pointer',
              }}>
                <StageDots stages={c.stages} />
                <span className="af2-mono" style={{ fontSize: 11, fontWeight: 600, color: T.text, minWidth: 70 }}>{c.id}</span>
                <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>v{c.v || '—'}</span>
                <span className="af2-mono" style={{ fontSize: 10, color: T.muted }}>{c.elapsed}</span>
                <span className="af2-mono" style={{ fontSize: 11, color: T.text }}>${c.cost.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Reports to */}
        {manager && (
          <Card>
            <SectionTitle>REPORTS TO</SectionTitle>
            <div onClick={() => navigate(`/agents/${manager.id}`)} className="af2-hover-card" style={{
              marginTop: 10, padding: '10px 12px',
              background: T.surface2, border: `1px solid ${T.border2}`, borderLeft: `3px solid ${manager.model === 'opus' ? T.opus : manager.model === 'sonnet' ? T.sonnet : T.haiku}`,
              borderRadius: 6, cursor: 'pointer',
              display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8,
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{manager.name}</div>
                <div className="af2-mono" style={{ fontSize: 10, color: T.dim, marginTop: 2 }}>${manager.cost.toFixed(3)} this cycle</div>
              </div>
              <ModelChip model={manager.model} />
            </div>
          </Card>
        )}

        {/* Direct reports */}
        {direct.length > 0 && (
          <Card>
            <SectionTitle right={<span style={{ fontSize: 10, color: T.dim }}>{direct.length}</span>}>DIRECT REPORTS</SectionTitle>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {direct.map(d => (
                <div key={d.id} onClick={() => navigate(`/agents/${d.id}`)} className="af2-hover-card" style={{
                  display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10, alignItems: 'center',
                  padding: '7px 10px', background: T.surface2, border: `1px solid ${T.border2}`,
                  borderLeft: `2px solid ${d.model === 'opus' ? T.opus : d.model === 'sonnet' ? T.sonnet : T.haiku}`,
                  borderRadius: 6, cursor: 'pointer',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: d.model === 'opus' ? T.opus : d.model === 'sonnet' ? T.sonnet : T.haiku }} />
                  <span style={{ fontSize: 12, color: T.text }}>{d.name}</span>
                  <span className="af2-mono" style={{ fontSize: 10, color: T.muted }}>${d.cost.toFixed(3)}</span>
                  <ModelChip model={d.model} />
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Skills / capabilities */}
        <Card>
          <SectionTitle>CAPABILITIES</SectionTitle>
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['code-edit', 'file-create', 'shell', 'git', 'test-run', 'pr-create'].map(c => (
              <span key={c} className="af2-mono" style={{
                fontSize: 10, padding: '3px 8px', borderRadius: 4,
                background: T.surface2, border: `1px solid ${T.border2}`, color: T.muted,
              }}>{c}</span>
            ))}
          </div>
        </Card>

        {/* Tools / models tried */}
        <Card>
          <SectionTitle>TOOLS</SectionTitle>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch'].map((t, i) => (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ color: T.success }}>✓</span>
                <span className="af2-mono" style={{ color: T.muted, flex: 1 }}>{t}</span>
                <span className="af2-mono" style={{ fontSize: 10, color: T.dim }}>{(i + 3) * 17}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function AgentSessions({ ag, sessions, navigate }) {
  if (sessions.length === 0) {
    return (
      <Card>
        <div style={{ padding: '40px 20px', textAlign: 'center', color: T.dim }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>◷</div>
          <div style={{ fontSize: 13, color: T.text, fontWeight: 600 }}>No sessions yet for this agent.</div>
          <div style={{ fontSize: 11, marginTop: 6 }}>Run it from the Runner to get started.</div>
          <div style={{ marginTop: 16 }}>
            <Btn variant="purple" size="sm" onClick={() => navigate('/runner')}>▶ Run agent</Btn>
          </div>
        </div>
      </Card>
    );
  }
  return (
    <Card noPad>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            {['Status', 'Task', 'Model', 'Duration', 'Cost', 'Started'].map(h => (
              <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.dim, padding: '10px 14px', borderBottom: `1px solid ${T.border}` }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sessions.map((s, i) => (
            <tr key={i} className="af2-hover-row" style={{ borderBottom: `1px solid ${T.border}`, cursor: 'pointer' }}>
              <td style={{ padding: '8px 14px' }}>
                <Badge variant={s.status === 'running' ? 'purple' : 'success'}>{s.status}</Badge>
              </td>
              <td style={{ padding: '8px 14px', maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.text }}>{s.task}</td>
              <td style={{ padding: '8px 14px' }}>
                <ModelChip model={s.model.includes('opus') ? 'opus' : s.model.includes('sonnet') ? 'sonnet' : 'haiku'} />
              </td>
              <td style={{ padding: '8px 14px' }} className="af2-mono"><span style={{ fontSize: 11, color: T.dim }}>{s.dur || '—'}</span></td>
              <td style={{ padding: '8px 14px' }} className="af2-mono"><span style={{ fontSize: 11 }}>${s.cost.toFixed(4)}</span></td>
              <td style={{ padding: '8px 14px', color: T.dim, fontSize: 11 }}>{fmtRel(s.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function AgentMemory({ entries }) {
  if (entries.length === 0) {
    return (
      <Card>
        <div style={{ padding: '40px 20px', textAlign: 'center', color: T.dim }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>⚘</div>
          <div style={{ fontSize: 13, color: T.text, fontWeight: 600 }}>No memory entries from this agent yet.</div>
          <div style={{ fontSize: 11, marginTop: 6 }}>Entries appear when this agent extracts patterns, decisions, or learnings during cycles.</div>
        </div>
      </Card>
    );
  }
  const kindColor = { pattern: T.purple, failure: T.danger, decision: T.sonnet, metric: T.warning };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {entries.map(m => (
        <Card key={m.id} hover style={{ borderLeft: `3px solid ${kindColor[m.kind]}`, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Badge variant={m.kind === 'failure' ? 'danger' : m.kind === 'decision' ? 'info' : m.kind === 'metric' ? 'warning' : 'purple'}>{m.kind}</Badge>
            <span className="af2-mono" style={{ fontSize: 11, color: T.dim }}>from {m.source}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontSize: 10, color: T.dim }}>
              <span><span className="af2-mono" style={{ color: T.success }}>{m.hits}</span> hits</span>
              <span className="af2-mono">{fmtRel(m.createdAt)}</span>
            </span>
          </div>
          <div style={{ fontSize: 13, color: T.text, lineHeight: 1.55 }}>{m.text}</div>
        </Card>
      ))}
    </div>
  );
}

function AgentConfig({ ag }) {
  const yamlContent = `# ${ag.id}.yaml
id: ${ag.id}
name: "${ag.name}"
model: claude-${ag.model}-4-6
${ag.team ? `team: "${ag.team}"` : ''}
${ag.effort ? `effort: ${ag.effort.toLowerCase()}` : ''}

description: |
  ${ag.desc}

system_prompt: |
  You are ${ag.name}.
  ${ag.desc}

  Operate within the AgentForge cycle protocol:
  - Read the sprint plan from .agentforge/cycles/<id>/sprint.json
  - Write phase results to .agentforge/cycles/<id>/phases/<name>.json
  - Emit events via the SSE stream on completion

tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob

capabilities:
  - code-edit
  - file-create
  - test-run
  - pr-create

memory:
  inherit: true
  scope: per-workspace

budgets:
  per_run:    $1.50
  per_cycle:  $5.00
  per_day:    $25.00

retry:
  max_attempts: 2
  backoff_ms: 4000
`;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14, alignItems: 'start' }}>
      <Card noPad>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <SectionTitle>AGENT.YAML</SectionTitle>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn size="sm">Copy</Btn>
            <Btn size="sm">Edit</Btn>
          </div>
        </div>
        <pre className="af2-mono" style={{
          margin: 0, padding: '14px 18px', fontSize: 11, color: T.muted, lineHeight: 1.7,
          background: T.surface, overflow: 'auto', maxHeight: 540, whiteSpace: 'pre-wrap',
        }}>{yamlContent}</pre>
      </Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Card>
          <SectionTitle>SAFETY</SectionTitle>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
            {[
              { l: 'Approval required for commits', on: true },
              { l: 'Block network calls',           on: false },
              { l: 'Sandbox shell',                  on: true },
              { l: 'Auto-rollback on test failure',  on: true },
            ].map(s => (
              <div key={s.l} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: T.muted }}>{s.l}</span>
                <span style={{
                  width: 28, height: 16, borderRadius: 999, background: s.on ? T.accent : T.border3,
                  position: 'relative',
                }}>
                  <span style={{ position: 'absolute', top: 2, left: s.on ? 14 : 2, width: 12, height: 12, background: '#fff', borderRadius: '50%' }} />
                </span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <SectionTitle>OWNER</SectionTitle>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--af-grad)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 11 }}>SV</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Sean Vaughan</div>
              <div style={{ fontSize: 11, color: T.dim }}>created 2026-01-12</div>
            </div>
          </div>
        </Card>
        <Card style={{ borderColor: `${T.danger}33` }}>
          <SectionTitle>DANGER ZONE</SectionTitle>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Btn size="sm">Reset memory</Btn>
            <Btn size="sm" variant="danger">Delete agent</Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}
