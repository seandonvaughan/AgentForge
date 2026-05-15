// ── V2 App Router + mount ─────────────────────────────────────────────────────
const { useState: useSA, useEffect: useEA, useCallback: useCA } = React;

function App() {
  const [path, setPath] = useSA(() => window.location.hash.replace('#', '') || '/');

  useEA(() => {
    const handler = () => setPath(window.location.hash.replace('#', '') || '/');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const navigate = useCA((to) => {
    // Use View Transitions API where available for smooth route changes
    if (document.startViewTransition) {
      document.startViewTransition(() => {
        window.location.hash = to;
      });
    } else {
      window.location.hash = to;
    }
  }, []);

  function render() {
    if (path === '/' || path === '')   return <CommandCenter navigate={navigate} />;
    if (path === '/cycles')            return <CyclesList navigate={navigate} />;
    if (path === '/cycles/new')        return <LaunchCycle navigate={navigate} />;
    if (path === '/agents')            return <AgentsPage navigate={navigate} />;
    if (path === '/org')               return <OrgGraphPage navigate={navigate} />;
    if (path === '/sessions')          return <SessionsPage navigate={navigate} />;
    if (path === '/cost')              return <CostPage navigate={navigate} />;
    if (path === '/health')            return <HealthPage navigate={navigate} />;
    if (path === '/flywheel')          return <FlywheelPage navigate={navigate} />;
    if (path === '/live')              return <LiveFeedPage navigate={navigate} />;
    if (path === '/runner')            return <RunnerPage navigate={navigate} />;
    if (path === '/branches')          return <BranchesPage navigate={navigate} />;
    if (path === '/approvals')         return <ApprovalsPage navigate={navigate} />;
    if (path === '/workspaces')        return <WorkspacesPage navigate={navigate} />;
    if (path === '/jobs')              return <JobsPage navigate={navigate} />;
    if (path === '/settings')          return <SettingsPage navigate={navigate} />;
    if (path === '/memory')            return <MemoryPage navigate={navigate} />;
    if (path === '/audit')             return <AuditPage navigate={navigate} />;
    if (path === '/insights')          return <InsightsPage navigate={navigate} />;
    if (path === '/schedule')          return <SchedulePage navigate={navigate} />;
    if (path === '/webhooks')          return <WebhooksPage navigate={navigate} />;
    if (path === '/notifications')     return <NotificationsPage navigate={navigate} />;
    const cm = path.match(/^\/cycles\/([^/]+)$/);
    if (cm) return <CycleDetail navigate={navigate} cycleId={cm[1]} />;
    const am = path.match(/^\/agents\/([^/]+)$/);
    if (am) return <AgentDetailPage navigate={navigate} agentId={am[1]} />;
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div className="af2-mono" style={{ fontSize: 56, fontWeight: 700, color: T.text, letterSpacing: '-0.04em' }}>404</div>
        <div style={{ fontSize: 13, color: T.dim, marginBottom: 20 }}>Page not found: <code style={{ background: T.surface2, padding: '2px 6px', borderRadius: 3 }} className="af2-mono">{path}</code></div>
        <Btn variant="purple" onClick={() => navigate('/')}>← Back to Command Center</Btn>
      </div>
    );
  }

  return (
    <Layout path={path} navigate={navigate}>
      {render()}
      <AFTweaksPanel />
    </Layout>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
