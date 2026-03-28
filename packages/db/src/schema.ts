// Master DB schema — workspaces, users, auth
export const MASTER_DDL = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    owner_id TEXT NOT NULL,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_workspaces (
    user_id TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, workspace_id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT REFERENCES workspaces(id),
    key_hash TEXT UNIQUE NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    label TEXT,
    last_used_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
`;

// Workspace DB schema — agents, sessions, costs, feedback, sprints
export const WORKSPACE_DDL = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    agent_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    team TEXT,
    system_prompt TEXT,
    skills_json TEXT NOT NULL DEFAULT '[]',
    autonomy_tier INTEGER NOT NULL DEFAULT 1,
    yaml_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    parent_session_id TEXT REFERENCES sessions(id),
    task TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    delegation_depth INTEGER NOT NULL DEFAULT 0,
    autonomy_tier INTEGER NOT NULL DEFAULT 1,
    resume_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS costs (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    agent_id TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    sentiment TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS promotions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    previous_tier INTEGER NOT NULL,
    new_tier INTEGER NOT NULL,
    promoted INTEGER NOT NULL DEFAULT 0,
    demoted INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sprints (
    id TEXT PRIMARY KEY,
    version TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'planning',
    budget_usd REAL,
    team_size INTEGER,
    items_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content TEXT NOT NULL,
    vector BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_type, source_id)
  );

  CREATE TABLE IF NOT EXISTS agent_scorecards (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    total_sessions INTEGER NOT NULL DEFAULT 0,
    completed_sessions INTEGER NOT NULL DEFAULT 0,
    failed_sessions INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    total_latency_ms INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scorecards_agent ON agent_scorecards(agent_id);

  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_costs_agent ON costs(agent_id);
  CREATE INDEX IF NOT EXISTS idx_costs_created ON costs(created_at);
  CREATE INDEX IF NOT EXISTS idx_feedback_agent ON feedback(agent_id);
  CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
`;
