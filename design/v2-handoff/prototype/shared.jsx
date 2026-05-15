// ── V2 Shared: layout, viz primitives, atoms ──────────────────────────────────
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── Tokens (referenced throughout) ────────────────────────────────────────────
const T = {
  bg:      '#0a0a0c',
  surface: '#0e0e10',
  surface2:'#131316',
  border:  '#18181b',
  border2: '#1f1f23',
  border3: '#27272a',
  text:    '#fafafa',
  muted:   '#a1a1aa',
  dim:     '#71717a',
  faint:   '#52525b',
  accent:  '#6366f1',
  accent2: '#818cf8',
  purple:  '#a78bfa',
  success: '#5bd394',
  warning: '#f5a623',
  danger:  '#ef4444',
  opus:    '#f5a623',
  sonnet:  '#7aa0f7',
  haiku:   '#5bd394',
};
window.T = T;

// ── Inject keyframes & global styles ──────────────────────────────────────────
(function injectStyles() {
  if (document.getElementById('af2-styles')) return;
  const s = document.createElement('style');
  s.id = 'af2-styles';
  s.textContent = `
    @keyframes af2pulse { 0% { transform: scale(1); opacity: 0.6; } 100% { transform: scale(2.4); opacity: 0; } }
    @keyframes af2flow { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
    @keyframes af2dash { to { stroke-dashoffset: -16; } }
    @keyframes af2spin { to { transform: rotate(360deg); } }
    @keyframes af2fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes af2wiggle { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
    @keyframes af2shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    main > * { animation: af2fade 200ms ease-out; }
    button { font-family: inherit; user-select: none; }
    input, textarea, select { font-family: inherit; outline: none; }
    input:focus, textarea:focus, select:focus {
      border-color: ${T.accent} !important;
      box-shadow: 0 0 0 3px rgba(99,102,241,0.15);
    }
    .af2-skeleton {
      background: linear-gradient(90deg, ${T.surface2} 25%, ${T.border3} 50%, ${T.surface2} 75%);
      background-size: 200% 100%;
      animation: af2shimmer 1.5s linear infinite;
    }
    .af2-mono { font-family: 'JetBrains Mono', monospace; font-feature-settings: 'tnum' 1, 'ss01' 1; }
    .af2-hover-card { transition: border-color 180ms ease, background 180ms ease, transform 180ms ease; }
    .af2-hover-card:hover { border-color: ${T.border3} !important; background: ${T.surface2} !important; }
    .af2-hover-row:hover { background: ${T.surface2} !important; }
    .af2-flow {
      background: linear-gradient(90deg, ${T.accent}, ${T.purple}, ${T.accent});
      background-size: 200% 100%;
      animation: af2flow 2.5s linear infinite;
    }
  `;
  document.head.appendChild(s);
})();

// ── Format helpers ─────────────────────────────────────────────────────────────
function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms/1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s/60);
  if (m < 60) return `${m}m ${s%60}s`;
  return `${Math.floor(m/60)}h ${m%60}m`;
}
function fmtRel(iso) {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s/60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}
function fmtDollar(n, d = 2) {
  if (n == null) return '—';
  return `$${n.toFixed(d)}`;
}

// ── Animated number ───────────────────────────────────────────────────────────
function AnimNum({ value, decimals = 0, duration = 600, prefix = '', suffix = '', mono = true }) {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);
  useEffect(() => {
    const from = prevRef.current ?? 0;
    const to = value;
    const start = performance.now();
    let raf;
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      const v = from + (to - from) * ease;
      setDisplay(v);
      if (t < 1) raf = requestAnimationFrame(step);
      else prevRef.current = to;
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return (
    <span className={mono ? 'af2-mono' : ''} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {prefix}{display.toFixed(decimals)}{suffix}
    </span>
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function Sparkline({ data, color = T.purple, w = 80, h = 24, gradient, strokeWidth = 1.4 }) {
  if (!data || data.length === 0) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [i / (data.length - 1) * w, h - ((v - min) / range) * (h - 2) - 1]);
  const line = pts.map(p => p.join(',')).join(' ');
  const area = `M0,${h} L${pts.map(p => p.join(',')).join(' L')} L${w},${h} Z`;
  const gid = useMemo(() => 'sg-' + Math.random().toString(36).slice(2, 8), []);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      {gradient && (
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {gradient && <path d={area} fill={`url(#${gid})`} />}
      <polyline points={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      {gradient && (
        <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="2" fill={color} />
      )}
    </svg>
  );
}

// ── Ring ──────────────────────────────────────────────────────────────────────
function Ring({ value = 0, max = 100, size = 44, stroke = 3, color = T.accent, track = T.border, label, sub }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value / max));
  const off = c * (1 - pct);
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke={color} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={off}
          strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: 'stroke-dashoffset 700ms cubic-bezier(.2,.7,.2,1)' }} />
      </svg>
      {label && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <span style={{ fontSize: size > 60 ? 14 : 10, fontWeight: 600, color: T.text, fontFamily: 'JetBrains Mono, monospace' }}>{label}</span>
          {sub && <span style={{ fontSize: 8, color: T.dim }}>{sub}</span>}
        </div>
      )}
    </div>
  );
}

// ── Mini bars ─────────────────────────────────────────────────────────────────
function MiniBars({ data, color = T.purple, w = 80, h = 24, gap = 1.5 }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data) || 1;
  const bw = (w - (data.length - 1) * gap) / data.length;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      {data.map((v, i) => {
        const bh = Math.max(1, (v / max) * (h - 1));
        return <rect key={i} x={i * (bw + gap)} y={h - bh} width={bw} height={bh} fill={color} rx="0.5" />;
      })}
    </svg>
  );
}

// ── Distribution bar ──────────────────────────────────────────────────────────
function DistBar({ segments, h = 6, label }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div style={{ display: 'flex', height: h, borderRadius: 999, overflow: 'hidden', background: T.border }}>
      {segments.map((s, i) => (
        <div key={i} title={s.label} style={{
          width: `${(s.value/total)*100}%`, background: s.color,
          transition: 'width 400ms ease',
        }} />
      ))}
    </div>
  );
}

// ── Pulse dot ─────────────────────────────────────────────────────────────────
function PulseDot({ color = T.success, size = 8, ring = true }) {
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size, height: size, flexShrink: 0 }}>
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color }} />
      {ring && <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%', background: color, opacity: 0.5,
        animation: 'af2pulse 1.6s ease-out infinite',
      }} />}
    </span>
  );
}

// ── Model chip ────────────────────────────────────────────────────────────────
function ModelChip({ model, size = 'sm' }) {
  if (!model) return <span style={{ color: T.faint }}>—</span>;
  const c = model === 'opus' ? T.opus : model === 'sonnet' ? T.sonnet : model === 'haiku' ? T.haiku : T.dim;
  return (
    <span className="af2-mono" style={{
      fontSize: size === 'sm' ? 9 : 10, fontWeight: 600, letterSpacing: '0.06em',
      padding: '2px 6px', borderRadius: 3,
      color: c, background: `${c}15`, border: `1px solid ${c}33`,
      textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center',
    }}>{model}</span>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────────────
function Badge({ variant = 'muted', children, style }) {
  const map = {
    success: { c: T.success, bg: `${T.success}15`, b: `${T.success}33` },
    warning: { c: T.warning, bg: `${T.warning}15`, b: `${T.warning}33` },
    danger:  { c: T.danger,  bg: `${T.danger}15`,  b: `${T.danger}33`  },
    info:    { c: T.accent2, bg: `${T.accent2}15`, b: `${T.accent2}33` },
    purple:  { c: T.purple,  bg: `${T.purple}15`,  b: `${T.purple}33`  },
    muted:   { c: T.dim,     bg: 'transparent',     b: T.border3        },
  };
  const v = map[variant] || map.muted;
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
      padding: '2px 7px', borderRadius: 4,
      color: v.c, background: v.bg, border: `1px solid ${v.b}`,
      textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center',
      ...style,
    }}>{children}</span>
  );
}

// ── Button ────────────────────────────────────────────────────────────────────
function Btn({ variant = 'ghost', size = 'md', onClick, disabled, children, href, style, leading, trailing }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    border: '1px solid', cursor: disabled ? 'not-allowed' : 'pointer',
    fontWeight: 500, letterSpacing: '-0.005em',
    transition: 'all 150ms ease', whiteSpace: 'nowrap',
    fontSize: size === 'sm' ? 11 : size === 'lg' ? 13 : 12,
    padding: size === 'sm' ? '4px 10px' : size === 'lg' ? '8px 18px' : '6px 12px',
    height: size === 'sm' ? 26 : size === 'lg' ? 36 : 30,
    borderRadius: 6,
    opacity: disabled ? 0.5 : 1,
    textDecoration: 'none',
  };
  const variants = {
    primary: { background: T.accent, borderColor: T.accent, color: '#fff' },
    purple:  { background: 'linear-gradient(135deg, #6366f1, #a855f7)', borderColor: 'transparent', color: '#fff' },
    ghost:   { background: T.surface, borderColor: T.border2, color: T.muted },
    danger:  { background: 'transparent', borderColor: `${T.danger}55`, color: T.danger },
  };
  const s = { ...base, ...variants[variant], ...style };
  const C = href ? 'a' : 'button';
  return (
    <C href={href} style={s} onClick={onClick} disabled={disabled}>
      {leading}{children}{trailing}
    </C>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────
function Card({ children, style, noPad, hover, accent, onClick, onMouseEnter, onMouseLeave }) {
  return (
    <div className={hover ? 'af2-hover-card' : ''}
      onClick={onClick} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
      style={{
        background: T.surface, border: '1px solid', borderColor: accent ? `${T.accent}40` : T.border,
        borderRadius: 10, padding: noPad ? 0 : 16, overflow: noPad ? 'hidden' : undefined,
        ...style,
      }}>{children}</div>
  );
}

// ── Section title ─────────────────────────────────────────────────────────────
function SectionTitle({ children, right, accent }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 10, paddingBottom: 8, borderBottom: `1px solid ${T.border}`,
    }}>
      <span style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: accent ? T.accent2 : T.dim, display: 'flex', alignItems: 'center', gap: 6,
      }}>{children}</span>
      {right}
    </div>
  );
}

// ── Cycle stage bar (horizontal pill rail) ────────────────────────────────────
function StageRail({ stages, phases, compact, showAgent }) {
  const NAMES = ['PLAN','STAGE','RUN','VERIFY','COMMIT','REVIEW'];
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, position: 'relative', flex: 1 }}>
      {NAMES.map((name, i) => {
        const s = stages?.[i] || 'pending';
        const p = phases?.[i];
        const isActive = s === 'active', isDone = s === 'done', isFailed = s === 'failed';
        return (
          <div key={name} style={{ flex: 1, position: 'relative' }}>
            {/* Track */}
            <div style={{
              height: 2, marginTop: 7,
              background: isDone ? T.accent : isActive ? 'transparent' : T.border,
              position: 'relative', overflow: 'hidden',
            }}>
              {isActive && <div className="af2-flow" style={{ position: 'absolute', inset: 0 }} />}
            </div>
            {/* Node */}
            <div style={{
              position: 'absolute', top: 0, left: i === 0 ? 0 : 'calc(50% - 8px)',
              width: 16, height: 16, borderRadius: '50%', boxSizing: 'border-box',
              background: isDone ? T.accent : isActive ? T.surface : T.surface,
              border: isActive ? `2px solid ${T.purple}`
                    : isFailed ? `2px solid ${T.danger}`
                    : isDone ? `2px solid ${T.accent}`
                    : `2px solid ${T.border3}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 9, fontWeight: 700,
              ...(isActive ? { boxShadow: `0 0 0 4px ${T.purple}22` } : {}),
            }}>
              {isDone ? '✓' : isFailed ? '✗' : isActive ? (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.purple }} />
              ) : ''}
            </div>
            {/* Label */}
            {!compact && (
              <div style={{ paddingTop: 14 }}>
                <div className="af2-mono" style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                  color: isActive ? T.purple : isDone ? T.text : isFailed ? T.danger : T.faint,
                }}>{name}</div>
                {p && (
                  <div className="af2-mono" style={{ fontSize: 9, color: T.dim, marginTop: 2, height: 12 }}>
                    {p.durMs ? fmtDuration(p.durMs) : ''}
                  </div>
                )}
                {showAgent && p?.agent && (
                  <div className="af2-mono" style={{ fontSize: 9, color: T.faint, marginTop: 1 }}>
                    {p.agent}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Compact stage dots (for lists) ────────────────────────────────────────────
function StageDots({ stages, size = 'sm' }) {
  const h = size === 'sm' ? 12 : 16;
  return (
    <div style={{ display: 'flex', gap: 1, alignItems: 'center' }}>
      {stages.map((s, i) => (
        <span key={i} style={{
          width: 7, height: h, borderRadius: 1,
          background: s === 'done' ? T.accent : s === 'active' ? T.purple : s === 'failed' ? T.danger : T.border2,
          ...(s === 'active' ? { boxShadow: `0 0 4px ${T.purple}` } : {}),
        }} />
      ))}
    </div>
  );
}

// ── Layout: Topbar + StatusLine + Sidebar + Main ──────────────────────────────
const NAV = [
  { section: 'Overview', items: [
    { i: '⌂', label: 'Command Center', href: '/' },
    { i: '⟳', label: 'Cycles',         href: '/cycles' },
    { i: '⊕', label: 'Launch',         href: '/cycles/new' },
  ]},
  { section: 'Organization', items: [
    { i: '⊞', label: 'Agents',         href: '/agents' },
    { i: '⊛', label: 'Org Graph',      href: '/org' },
    { i: '⎇', label: 'Branches',       href: '/branches' },
    { i: '✓', label: 'Approvals',      href: '/approvals', badgeKey: 'pendingApprovals' },
  ]},
  { section: 'Activity', items: [
    { i: '◷', label: 'Sessions',       href: '/sessions' },
    { i: '◫', label: 'Live Feed',      href: '/live' },
    { i: '▶', label: 'Runner',         href: '/runner' },
    { i: '☰', label: 'Jobs',           href: '/jobs' },
  ]},
  { section: 'Insights', items: [
    { i: '¤', label: 'Cost',           href: '/cost' },
    { i: '◎', label: 'Flywheel',       href: '/flywheel' },
    { i: '◆', label: 'Insights',       href: '/insights' },
    { i: '⚘', label: 'Memory',         href: '/memory' },
    { i: '♥', label: 'Health',         href: '/health' },
  ]},
  { section: 'System', items: [
    { i: '◔', label: 'Schedule',       href: '/schedule' },
    { i: '⚡', label: 'Webhooks',       href: '/webhooks' },
    { i: '✉', label: 'Notifications',  href: '/notifications' },
    { i: '▦', label: 'Audit log',      href: '/audit' },
  ]},
];

function Topbar({ navigate }) {
  const c = window.AF2.cycle;
  return (
    <div style={{
      gridColumn: '1/-1', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 18px', borderBottom: `1px solid ${T.border}`, background: T.bg, height: 44,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={() => navigate('/')} style={{
          display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 0,
        }}>
          <div style={{
            width: 22, height: 22, borderRadius: 5,
            background: 'var(--af-grad)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 800, fontSize: 11,
          }}>◣</div>
          <span style={{ fontWeight: 600, fontSize: 13, color: T.text, letterSpacing: '-0.005em' }}>AgentForge</span>
        </button>
        <span className="af2-mono" style={{ fontSize: 10, color: T.faint }}>{window.AF2.version}</span>

        {/* Search */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px 4px 10px', marginLeft: 16,
          background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 6,
          minWidth: 320, color: T.faint, fontSize: 12, cursor: 'pointer', height: 28,
        }}>
          <span style={{ fontSize: 11 }}>⌕</span>
          <span style={{ flex: 1 }}>Search cycles, agents, sessions…</span>
          <span className="af2-mono" style={{
            fontSize: 9, padding: '1px 5px', background: T.border, borderRadius: 3, color: T.dim,
          }}>⌘K</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <RunningCycleWidget cycle={c} navigate={navigate} />
        <button style={{
          width: 28, height: 28, borderRadius: 6, background: T.surface, border: `1px solid ${T.border2}`,
          color: T.dim, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>?</button>
        <div style={{
          width: 26, height: 26, borderRadius: '50%',
          background: 'var(--af-grad)',
          fontSize: 10, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
        }}>SV</div>
      </div>
    </div>
  );
}

function RunningCycleWidget({ cycle, navigate }) {
  return (
    <button onClick={() => navigate(`/cycles/${cycle.short}`)} style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '4px 4px 4px 10px',
      background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 7, height: 30,
      cursor: 'pointer',
    }}>
      <PulseDot color={T.purple} size={6} />
      <span className="af2-mono" style={{ fontSize: 10, color: T.purple, fontWeight: 700, letterSpacing: '0.04em' }}>RUN</span>
      <span className="af2-mono" style={{ fontSize: 11, color: T.text, fontWeight: 600 }}>{cycle.short}</span>
      <div style={{ display: 'flex', gap: 2 }}>
        {cycle.stages.map((s, i) => (
          <span key={i} style={{
            width: 12, height: 4, borderRadius: 1,
            background: s === 'done' ? T.accent : s === 'active' ? T.purple : s === 'failed' ? T.danger : T.border2,
            ...(s === 'active' ? { boxShadow: `0 0 4px ${T.purple}` } : {}),
          }} />
        ))}
      </div>
      <span className="af2-mono" style={{ fontSize: 11, color: T.muted }}>{cycle.elapsedDisplay}</span>
      <span style={{ width: 1, height: 14, background: T.border2 }} />
      <span className="af2-mono" style={{ fontSize: 11, color: T.text }}>${cycle.costUsd.toFixed(2)}</span>
      <span className="af2-mono" style={{ fontSize: 10, color: T.faint }}>/${cycle.budgetUsd}</span>
      <span style={{
        padding: '3px 8px', height: 22, background: T.border, borderRadius: 4,
        color: T.text, fontSize: 10, fontWeight: 500,
        display: 'flex', alignItems: 'center',
      }}>Open</span>
    </button>
  );
}

function StatusLine() {
  const k = window.AF2.counters;
  return (
    <div style={{
      gridColumn: '1/-1', display: 'flex', alignItems: 'center',
      borderBottom: `1px solid ${T.border}`, background: T.bg, height: 22,
      fontSize: 10, color: T.muted,
    }} className="af2-mono">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '0 14px', height: 22, flex: 1 }}>
        <span><span style={{ color: T.success }}>●</span> api</span>
        <span><span style={{ color: T.success }}>●</span> ws</span>
        <span><span style={{ color: T.success }}>●</span> sse</span>
        <span style={{ color: T.border3 }}>│</span>
        <span><span style={{ color: T.dim }}>agents</span> <span style={{ color: T.text }}>{k.agents}</span><span style={{ color: T.dim }}>/</span><span style={{ color: T.purple }}>{k.agentsActive}</span></span>
        <span><span style={{ color: T.dim }}>cycles</span> <span style={{ color: T.text }}>{k.cyclesDay}</span>d <span style={{ color: T.text }}>{k.cyclesWeek}</span>w <span style={{ color: T.text }}>{k.cyclesMonth}</span>m</span>
        <span><span style={{ color: T.dim }}>branches</span> <span style={{ color: T.text }}>{k.openBranches}</span></span>
        <span><span style={{ color: T.dim }}>approvals</span> <span style={{ color: T.text }}>{k.pendingApprovals}</span></span>
        <span><span style={{ color: T.dim }}>today</span> <span style={{ color: T.text }}>${k.todaySpend.toFixed(2)}</span></span>
        <span style={{ flex: 1 }} />
        <span><span style={{ color: T.dim }}>load</span> {k.load.join(' ')}</span>
        <span style={{ color: T.faint }}>2026-05-15 12:14</span>
      </div>
    </div>
  );
}

function Sidebar({ path, navigate, pinned, setPinned, hovered, setHovered }) {
  const k = window.AF2.counters;
  const expanded = pinned || hovered;
  return (
    <aside
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        gridRow: '3 / 4', gridColumn: '1 / 2',
        borderRight: `1px solid ${T.border}`, background: T.bg,
        display: 'flex', flexDirection: 'column', padding: '8px 0',
        width: expanded ? 220 : 48,
        position: pinned ? 'relative' : 'absolute',
        top: pinned ? 'auto' : 66, left: pinned ? 'auto' : 0, bottom: pinned ? 'auto' : 0,
        height: pinned ? 'auto' : 'calc(100vh - 66px)',
        zIndex: pinned ? 'auto' : 50,
        transition: 'width 200ms cubic-bezier(.2,.7,.2,1), box-shadow 200ms ease',
        boxShadow: !pinned && hovered ? '4px 0 24px rgba(0,0,0,0.4)' : 'none',
        overflow: 'hidden',
      }}>
      {/* Pin / collapse control at top */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: expanded ? 'space-between' : 'center', padding: expanded ? '0 12px 8px' : '0 0 8px', borderBottom: `1px solid ${T.border}`, marginBottom: 6, height: 28 }}>
        {expanded && <span style={{ fontSize: 10, color: T.faint, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600 }}>Navigation</span>}
        <button onClick={() => setPinned(p => !p)} title={pinned ? 'Collapse sidebar' : 'Pin sidebar'} style={{
          width: 22, height: 22, borderRadius: 4, background: 'transparent',
          border: `1px solid ${pinned ? T.purple + '55' : T.border2}`,
          color: pinned ? T.purple : T.dim,
          fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0, transition: 'all 150ms ease',
        }}>
          {pinned ? '◧' : '◨'}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: expanded ? '0 8px' : '0' }}>
        {NAV.map(group => (
          <div key={group.section} style={{ marginBottom: 8 }}>
            {expanded && (
              <div style={{ fontSize: 9, color: T.faint, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, padding: '6px 8px 4px' }}>
                {group.section}
              </div>
            )}
            {group.items.map(it => {
              const active = path === it.href || (it.href !== '/' && path.startsWith(it.href));
              const badge = it.badgeKey && k[it.badgeKey] > 0 ? k[it.badgeKey] : null;
              return (
                <button key={it.href} title={!expanded ? it.label : undefined} onClick={() => navigate(it.href)} style={{
                  width: '100%',
                  display: 'flex', alignItems: 'center', gap: expanded ? 10 : 0,
                  padding: expanded ? '6px 8px' : '6px 0',
                  justifyContent: expanded ? 'flex-start' : 'center',
                  borderRadius: 6,
                  background: active ? T.surface2 : 'transparent',
                  border: active ? `1px solid ${T.border3}` : '1px solid transparent',
                  color: active ? T.purple : T.faint,
                  cursor: 'pointer', position: 'relative', transition: 'all 150ms ease',
                  marginBottom: 1, textAlign: 'left',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.color = T.muted; e.currentTarget.style.background = T.surface; }}
                onMouseLeave={e => { e.currentTarget.style.color = active ? T.purple : T.faint; e.currentTarget.style.background = active ? T.surface2 : 'transparent'; }}>
                  <span style={{ width: 20, fontSize: 14, textAlign: 'center', flexShrink: 0 }}>{it.i}</span>
                  {expanded && <span style={{ flex: 1, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden' }}>{it.label}</span>}
                  {expanded && badge && (
                    <span className="af2-mono" style={{ fontSize: 9, padding: '1px 6px', borderRadius: 999, background: T.warning, color: '#000', fontWeight: 700 }}>{badge}</span>
                  )}
                  {active && <span style={{
                    position: 'absolute', left: expanded ? -8 : -7, top: 6, width: 2, height: 18, borderRadius: 2,
                    background: 'var(--af-grad-v)',
                  }} />}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Footer: settings + workspace summary when expanded */}
      <div style={{ borderTop: `1px solid ${T.border}`, padding: expanded ? 10 : '8px 0', display: 'flex', alignItems: 'center', gap: 8, justifyContent: expanded ? 'space-between' : 'center' }}>
        <button title="Settings" onClick={() => navigate('/settings')} style={{
          width: 32, height: 32, borderRadius: 6, background: 'transparent', border: '1px solid transparent',
          color: T.faint, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>⚙</button>
        {expanded && (
          <div style={{ flex: 1, fontSize: 10, color: T.dim, overflow: 'hidden' }}>
            <div style={{ fontWeight: 600, color: T.muted, fontSize: 11 }} className="af2-mono">{window.AF2.workspace.name}</div>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="af2-mono">{window.AF2.workspace.path}</div>
          </div>
        )}
      </div>
    </aside>
  );
}

function Layout({ path, navigate, children }) {
  const [pinned, setPinnedState] = useState(() => {
    try {
      const stored = localStorage.getItem('af2-sidebar-pinned');
      // Default to pinned/expanded so labels are visible on first load
      return stored === null ? true : stored === 'true';
    } catch (e) { return true; }
  });
  const [hovered, setHovered] = useState(false);
  const setPinned = (next) => {
    setPinnedState(prev => {
      const v = typeof next === 'function' ? next(prev) : next;
      try { localStorage.setItem('af2-sidebar-pinned', String(v)); } catch (e) {}
      return v;
    });
  };
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: pinned ? '220px 1fr' : '48px 1fr',
      gridTemplateRows: '44px 22px 1fr',
      height: '100vh', overflow: 'hidden', background: T.bg, color: T.text,
      fontFamily: 'Inter, system-ui, sans-serif',
      transition: 'grid-template-columns 200ms cubic-bezier(.2,.7,.2,1)',
    }}>
      <Topbar navigate={navigate} />
      <StatusLine />
      <Sidebar path={path} navigate={navigate} pinned={pinned} setPinned={setPinned} hovered={hovered} setHovered={setHovered} />
      <main style={{ overflow: 'auto', padding: '14px 18px 18px', background: T.bg, gridColumn: '2 / 3', gridRow: '3 / 4' }}>
        {children}
      </main>
    </div>
  );
}

// ── Page header ──────────────────────────────────────────────────────────────
function PageHeader({ crumbs, title, subtitle, actions }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {crumbs && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.dim, marginBottom: 4 }}>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ color: T.border3 }}>/</span>}
              <span style={{ color: i === crumbs.length - 1 ? T.muted : T.dim }}>{c}</span>
            </React.Fragment>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: T.text }}>{title}</h1>
          {subtitle && <p style={{ margin: '4px 0 0', fontSize: 12, color: T.dim }}>{subtitle}</p>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{actions}</div>}
      </div>
    </div>
  );
}

// ── Input / Select / Textarea ─────────────────────────────────────────────────
function Input({ value, onChange, placeholder, type = 'text', style, mono, prefix }) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      {prefix && <span style={{ position: 'absolute', left: 10, color: T.dim, fontSize: 11 }}>{prefix}</span>}
      <input
        type={type} value={value} onChange={e => onChange?.(e.target.value)} placeholder={placeholder}
        className={mono ? 'af2-mono' : ''}
        style={{
          width: '100%', background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 6,
          padding: prefix ? '7px 10px 7px 28px' : '7px 10px', fontSize: 12, color: T.text,
          boxSizing: 'border-box', ...style,
        }}
      />
    </div>
  );
}
function Select({ value, onChange, options, style }) {
  return (
    <select value={value} onChange={e => onChange?.(e.target.value)} style={{
      background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 6,
      padding: '7px 28px 7px 10px', fontSize: 12, color: T.text,
      cursor: 'pointer', appearance: 'none',
      backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='6' viewBox='0 0 8 6' fill='%23a1a1aa'><path d='M4 6L0 0h8z'/></svg>")`,
      backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center',
      ...style,
    }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function Tabs({ tabs, active, onSelect }) {
  const ref = useRef(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const btn = ref.current.querySelector(`[data-tab="${active}"]`);
    if (btn) {
      setIndicator({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
  }, [active]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', borderBottom: `1px solid ${T.border}`, marginBottom: 14, gap: 0 }}>
      {tabs.map(t => (
        <button key={t.id} data-tab={t.id} onClick={() => onSelect(t.id)} style={{
          background: 'none', border: 'none', color: active === t.id ? T.text : T.dim,
          fontSize: 12, fontWeight: 500, padding: '10px 16px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6, transition: 'color 150ms ease',
        }}
        onMouseEnter={e => { if (active !== t.id) e.currentTarget.style.color = T.muted; }}
        onMouseLeave={e => { if (active !== t.id) e.currentTarget.style.color = T.dim; }}>
          {t.label}
          {t.count != null && (
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 999,
              background: active === t.id ? `${T.accent2}20` : T.border,
              color: active === t.id ? T.accent2 : T.dim,
            }}>{t.count}</span>
          )}
        </button>
      ))}
      {/* Underline indicator */}
      <div style={{
        position: 'absolute', bottom: -1, left: indicator.left, width: indicator.width, height: 2,
        background: 'var(--af-grad-h)',
        borderRadius: 1, transition: 'all 250ms cubic-bezier(.2,.7,.2,1)',
      }} />
    </div>
  );
}

Object.assign(window, {
  T, fmtDuration, fmtRel, fmtDollar,
  AnimNum, Sparkline, Ring, MiniBars, DistBar, PulseDot, ModelChip, Badge,
  Btn, Card, SectionTitle, StageRail, StageDots,
  Topbar, StatusLine, Sidebar, Layout, PageHeader,
  Input, Select, Tabs, RunningCycleWidget,
  MarkdownView, DetailDrawer,
});

// ── Minimal markdown renderer ────────────────────────────────────────────────
function MarkdownView({ source }) {
  const html = useMemo(() => mdToHtml(source || ''), [source]);
  return (
    <div className="af2-md" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function mdToHtml(src) {
  // Light, dependency-free conversion. Order matters.
  // 1. Escape HTML
  let s = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // 2. Fenced code blocks ```lang\n…```
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) =>
    `<pre class="md-pre"><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`);
  // 3. Inline code `…`
  s = s.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
  // 4. Headings ###, ##, #
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 5. Bold **x** and italic *x*
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // 6. Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 7. Lists: collect contiguous "- " or "1. " lines into <ul>/<ol>
  s = s.replace(/(^|\n)((?:[-*] .+\n?)+)/g, (m, pre, block) => {
    const items = block.trim().split(/\n/).map(l => l.replace(/^[-*]\s+/, '').trim());
    return pre + '<ul>' + items.map(it => `<li>${it}</li>`).join('') + '</ul>';
  });
  s = s.replace(/(^|\n)((?:\d+\. .+\n?)+)/g, (m, pre, block) => {
    const items = block.trim().split(/\n/).map(l => l.replace(/^\d+\.\s+/, '').trim());
    return pre + '<ol>' + items.map(it => `<li>${it}</li>`).join('') + '</ol>';
  });
  // 8. Blockquote
  s = s.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  // 9. Horizontal rule
  s = s.replace(/^---+$/gm, '<hr />');
  // 10. Paragraphs — wrap remaining lines that aren't tags
  s = s.split(/\n\n+/).map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^<(h\d|ul|ol|pre|blockquote|hr|p|table|div)/.test(trimmed)) return trimmed;
    return '<p>' + trimmed.replace(/\n/g, '<br/>') + '</p>';
  }).join('\n');
  return s;
}

// Inject markdown styles once
if (typeof document !== 'undefined' && !document.getElementById('af2-md-styles')) {
  const s = document.createElement('style');
  s.id = 'af2-md-styles';
  s.textContent = `
    .af2-md { font-size: 13px; color: ${T.text}; line-height: 1.65; }
    .af2-md h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin: 18px 0 10px; color: ${T.text}; }
    .af2-md h2 { font-size: 16px; font-weight: 600; letter-spacing: -0.015em; margin: 16px 0 8px; color: ${T.text}; padding-bottom: 6px; border-bottom: 1px solid ${T.border}; }
    .af2-md h3 { font-size: 14px; font-weight: 600; margin: 14px 0 6px; color: ${T.text}; }
    .af2-md p  { margin: 8px 0; color: ${T.muted}; }
    .af2-md ul, .af2-md ol { margin: 8px 0 8px 18px; padding: 0; color: ${T.muted}; }
    .af2-md li { margin: 3px 0; line-height: 1.6; }
    .af2-md li::marker { color: ${T.faint}; }
    .af2-md a  { color: ${T.accent2}; text-decoration: none; border-bottom: 1px solid transparent; }
    .af2-md a:hover { border-bottom-color: ${T.accent2}; }
    .af2-md strong { color: ${T.text}; font-weight: 600; }
    .af2-md em { color: ${T.muted}; font-style: italic; }
    .af2-md hr { border: none; border-top: 1px solid ${T.border}; margin: 16px 0; }
    .af2-md blockquote {
      margin: 10px 0; padding: 6px 12px;
      border-left: 3px solid ${T.purple}; background: ${T.surface2};
      color: ${T.muted}; border-radius: 0 4px 4px 0;
    }
    .af2-md code.md-code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.88em;
      background: ${T.surface2}; color: ${T.purple};
      padding: 1px 6px; border-radius: 3px;
      border: 1px solid ${T.border2};
    }
    .af2-md pre.md-pre {
      margin: 12px 0; padding: 12px 14px;
      background: ${T.surface2}; border: 1px solid ${T.border2}; border-radius: 6px;
      overflow-x: auto;
    }
    .af2-md pre.md-pre code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11.5px; color: ${T.muted}; background: transparent;
      border: none; padding: 0; line-height: 1.65;
    }
  `;
  document.head.appendChild(s);
}

// ── Generic right-side detail drawer ──────────────────────────────────────────
function DetailDrawer({ open, onClose, title, subtitle, badge, kicker, actions, children, width = 720 }) {
  // Keyboard: Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 100,
      display: 'flex', justifyContent: 'flex-end',
      animation: 'af2fade 200ms ease-out',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: `min(${width}px, 94vw)`, height: '100%', background: T.bg,
        borderLeft: `1px solid ${T.border}`, boxShadow: '-12px 0 60px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '14px 20px', borderBottom: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {kicker && <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: T.purple, marginBottom: 4 }}>{kicker}</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: T.text }}>{title}</h3>
              {badge}
            </div>
            {subtitle && <div style={{ fontSize: 11, color: T.dim, marginTop: 3 }}>{subtitle}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {actions}
            <button onClick={onClose} title="Close (Esc)" style={{
              width: 30, height: 30, borderRadius: 6,
              background: T.surface, border: `1px solid ${T.border2}`,
              color: T.muted, cursor: 'pointer', fontSize: 16,
            }}>×</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
